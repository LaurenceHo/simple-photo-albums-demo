import PanoramaViewer from '@/components/PanoramaViewer.vue';
import { mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Pannellum is loaded from a CDN `<script>` in `index.html`, so `window.pannellum`
 * simply does not exist under test - the component's own try/catch swallows that,
 * but then `viewer` stays null and there is nothing to assert `resize()` against.
 * A stub gives the component a viewer to hold without pulling in WebGL, which
 * jsdom has no implementation of either.
 */
const createViewerStub = () => ({
  destroy: vi.fn(),
  resize: vi.fn(),
});

/**
 * jsdom does not implement `ResizeObserver`. The component guards on that and
 * skips observing entirely, so a stub is required to exercise the path at all -
 * this one captures the callback so a resize can be fired by hand.
 *
 * `observe()` invokes the callback once, immediately. That is not stub
 * convenience - it is what the Resize Observer spec requires (the target is
 * recorded with a last-reported size of 0x0, so the first observation cycle
 * always reports a change) and what Chrome, Safari and Firefox all do. Modelling
 * it matters here: it means the very first `resize()` lands on a viewer built
 * microseconds earlier, which is the case the component's try/catch covers.
 */
class ResizeObserverStub {
  static callbacks: (() => void)[] = [];
  static observed: Element[] = [];
  static disconnectCount = 0;

  private readonly callback: () => void;

  constructor(callback: () => void) {
    this.callback = callback;
    ResizeObserverStub.callbacks.push(callback);
  }

  observe = vi.fn((element: Element) => {
    ResizeObserverStub.observed.push(element);
    this.callback();
  });
  unobserve = vi.fn();
  disconnect = vi.fn(() => {
    ResizeObserverStub.disconnectCount += 1;
    ResizeObserverStub.callbacks = ResizeObserverStub.callbacks.filter(
      (entry) => entry !== this.callback,
    );
  });
}

/**
 * `attachTo` is no longer strictly required - the component resolves its
 * container through a template ref, so a detached mount would find it too. Kept
 * because pannellum measures and renders into a live element in a real browser,
 * and a test that mounts it detached would be exercising a state production
 * never sees.
 */
const mountViewer = (imageUrl = 'https://example.com/pano.jpg') =>
  mount(PanoramaViewer, { props: { imageUrl }, attachTo: document.body });

describe('PanoramaViewer.vue', () => {
  let viewerStub: ReturnType<typeof createViewerStub>;

  beforeEach(() => {
    viewerStub = createViewerStub();
    ResizeObserverStub.callbacks = [];
    ResizeObserverStub.observed = [];
    ResizeObserverStub.disconnectCount = 0;

    vi.stubGlobal('ResizeObserver', ResizeObserverStub);
    // `stubGlobal` rather than a direct assignment, so `unstubAllGlobals` below
    // actually restores it - a plain `window.pannellum = ...` would leak past
    // teardown, which only goes unnoticed because Vitest isolates per file.
    vi.stubGlobal('pannellum', { viewer: vi.fn(() => viewerStub) });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('resizes the viewer when its container changes size without the window doing so', async () => {
    // The regression this exists for: opening the info sheet in `PhotoDetail`
    // halves the stage height below `lg` (and narrows it at `lg+`) without any
    // window resize. Pannellum only re-reads the container inside `resize()`,
    // which it binds to `window.resize` alone, so the panorama would keep
    // rendering at its pre-toggle size.
    const wrapper = mountViewer();

    expect(ResizeObserverStub.callbacks).toHaveLength(1);
    // Observing this component's own root element. This is what the template ref
    // buys over the previous `document.getElementById('panorama')`: with the
    // observer attached once and never re-attached, binding it to the wrong
    // element would kill the fix silently rather than throwing.
    expect(ResizeObserverStub.observed).toEqual([wrapper.element]);

    // One from `observe()` itself, per the spec note on the stub above.
    expect(viewerStub.resize).toHaveBeenCalledTimes(1);

    ResizeObserverStub.callbacks[0]?.();
    expect(viewerStub.resize).toHaveBeenCalledTimes(2);

    wrapper.unmount();
  });

  it('swallows a resize() throw so it cannot repeat on every later resize', () => {
    // `observe()` fires immediately, landing on a viewer built microseconds
    // earlier whose image is still downloading - and pannellum is a CDN script
    // this project does not control. An uncaught throw inside a ResizeObserver
    // callback would come back on every subsequent resize.
    viewerStub.resize.mockImplementation(() => {
      throw new Error('renderer not ready');
    });
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    expect(() => mountViewer().unmount()).not.toThrow();
    expect(consoleError).toHaveBeenCalled();

    consoleError.mockRestore();
  });

  it('keeps one observer across viewer rebuilds and points it at the current viewer', async () => {
    // `initViewer` destroys and recreates the pannellum viewer on every
    // `imageUrl` change, but the observed element is the component's own `<div>`,
    // which outlives them - so the observer must be attached once, and its
    // callback must reach whichever viewer is current rather than a destroyed one.
    const wrapper = mountViewer('https://example.com/one.jpg');
    expect(ResizeObserverStub.callbacks).toHaveLength(1);

    const secondViewer = createViewerStub();
    vi.mocked(window.pannellum.viewer).mockReturnValue(secondViewer);
    viewerStub.resize.mockClear();
    await wrapper.setProps({ imageUrl: 'https://example.com/two.jpg' });

    expect(viewerStub.destroy).toHaveBeenCalled();
    // Still one observer, still on the same element - not re-attached per rebuild.
    expect(ResizeObserverStub.callbacks).toHaveLength(1);
    expect(ResizeObserverStub.observed).toHaveLength(1);

    ResizeObserverStub.callbacks[0]?.();
    expect(secondViewer.resize).toHaveBeenCalledTimes(1);
    expect(viewerStub.resize).not.toHaveBeenCalled();

    wrapper.unmount();
  });

  it('fills its container rather than half of it', () => {
    // Shipped as `height: 50%` since the 360 support commit, which left the
    // panorama occupying the top half of the lightbox stage with a black gap
    // below it, and pushed pannellum's own controls into the prev/next chevrons.
    // Measured in Edge at 390x844: the container went from 157px to 676px, and
    // every control collision resolved as a side effect.
    const wrapper = mountViewer();

    expect(wrapper.element.getAttribute('style')).toContain('height: 100%');
    expect(wrapper.element.getAttribute('style')).not.toContain('height: 50%');

    wrapper.unmount();
  });

  it('disconnects the observer on unmount so it does not outlive the component', () => {
    const wrapper = mountViewer();
    wrapper.unmount();

    expect(ResizeObserverStub.disconnectCount).toBe(1);
    expect(viewerStub.destroy).toHaveBeenCalled();
  });

  it('mounts without throwing where ResizeObserver is unavailable', () => {
    // Safari private mode is not the concern here - every target browser has
    // `ResizeObserver`. The guard exists so the component stays mountable in
    // environments that lack it, jsdom included.
    vi.stubGlobal('ResizeObserver', undefined);

    const wrapper = mountViewer();
    expect(wrapper.element.tagName).toBe('DIV');

    wrapper.unmount();
  });
});
