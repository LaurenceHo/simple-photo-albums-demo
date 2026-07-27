import PhotoFilmstrip from '@/components/PhotoFilmstrip.vue';
import type { Photo } from '@/schema';
import { flushPromises, mount } from '@vue/test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const PHOTOS: Photo[] = [
  { key: 'album/photo1.jpg', url: 'https://cdn.test/album/photo1.jpg' },
  { key: 'album/photo2.jpg', url: 'https://cdn.test/album/photo2.jpg' },
  { key: 'album/photo3.jpg', url: 'https://cdn.test/album/photo3.jpg' },
];

const SINGLE_PHOTO: Photo[] = [{ key: 'album/photo1.jpg', url: 'https://cdn.test/album/photo1.jpg' }];

const mountFilmstrip = (photos: Photo[] = PHOTOS, activeIndex = 0) =>
  mount(PhotoFilmstrip, {
    props: { photos, activeIndex },
  });

/** Build a matchMedia mock whose `(prefers-reduced-motion: reduce)` query resolves to `matches`. */
const mockPrefersReducedMotion = (matches: boolean) => {
  vi.stubGlobal(
    'matchMedia',
    vi.fn().mockImplementation((query: string) => ({
      matches: query === '(prefers-reduced-motion: reduce)' && matches,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  );
};

describe('PhotoFilmstrip.vue', () => {
  beforeEach(() => {
    // jsdom does not implement scrollIntoView at all - without this, the
    // activeIndex watcher throws a "not implemented" error the moment it fires.
    Element.prototype.scrollIntoView = vi.fn();
  });

  it('renders one thumbnail button per photo, in order', () => {
    const wrapper = mountFilmstrip();
    const buttons = wrapper.findAll('[data-test-id="filmstrip-thumbnail"]');

    expect(buttons).toHaveLength(3);
    buttons.forEach((button, index) => {
      expect(button.find('img').attributes('src')).toContain(`photo${index + 1}.jpg`);
    });
  });

  it('gives only the active thumbnail tabindex 0, and every other -1', () => {
    const wrapper = mountFilmstrip(PHOTOS, 1);
    const buttons = wrapper.findAll('[data-test-id="filmstrip-thumbnail"]');

    expect(buttons[0]?.attributes('tabindex')).toBe('-1');
    expect(buttons[1]?.attributes('tabindex')).toBe('0');
    expect(buttons[2]?.attributes('tabindex')).toBe('-1');
  });

  it('marks only the active thumbnail with aria-current, and no other', () => {
    const wrapper = mountFilmstrip(PHOTOS, 2);
    const buttons = wrapper.findAll('[data-test-id="filmstrip-thumbnail"]');

    expect(buttons[0]?.attributes('aria-current')).toBeUndefined();
    expect(buttons[1]?.attributes('aria-current')).toBeUndefined();
    expect(buttons[2]?.attributes('aria-current')).toBe('true');
  });

  // CodeRabbit fix: dragging with a mouse used to select surrounding page text,
  // since neither pointer handler calls preventDefault (deliberately - see the
  // handlers' own comments: that would break native touch scrolling). `select-none`
  // is the CSS-only fix instead.
  it('never lets drag-to-scroll select surrounding page text', () => {
    const wrapper = mountFilmstrip();
    expect(wrapper.find('[data-test-id="photo-filmstrip"]').classes()).toContain('select-none');
  });

  it('emits select with the clicked thumbnail index', async () => {
    const wrapper = mountFilmstrip();
    const buttons = wrapper.findAll('[data-test-id="filmstrip-thumbnail"]');

    await buttons[2]?.trigger('click');

    expect(wrapper.emitted('select')).toEqual([[2]]);
  });

  it('requests a small, lazy-loaded thumbnail so hundreds of photos do not all fetch at once', () => {
    const wrapper = mountFilmstrip();
    const img = wrapper.find('[data-test-id="filmstrip-thumbnail"] img');

    expect(img.attributes('src')).toBe('https://cdn.test/album/photo1.jpg?tr=w-288,h-192');
    expect(img.attributes('loading')).toBe('lazy');
    expect(img.attributes('decoding')).toBe('async');
  });

  it('requests both width and height in the CDN transform, so ImageKit centre-crops instead of preserving aspect ratio', () => {
    const wrapper = mountFilmstrip();
    const img = wrapper.find('[data-test-id="filmstrip-thumbnail"] img');

    expect(img.attributes('src') ?? '').toMatch(/tr=w-\d+,h-\d+/);
  });

  it('gives every thumbnail the same fixed box, never an aspect-preserving one', () => {
    // A portrait and a landscape photo must render at the identical size - the
    // filmstrip is a uniform index, not a justified layout. `w-auto`/`h-full`
    // (the main grid's aspect-preserving recipe) would let a panorama render
    // several times wider than its neighbours.
    const wrapper = mountFilmstrip();
    const buttons = wrapper.findAll('[data-test-id="filmstrip-thumbnail"]');

    expect(buttons).toHaveLength(3);
    buttons.forEach((button) => {
      expect(button.classes()).toEqual(
        expect.arrayContaining(['h-16', 'w-24', 'sm:h-24', 'sm:w-36']),
      );
      expect(button.classes()).not.toContain('w-auto');
      expect(button.classes()).not.toContain('h-full');
    });
  });

  it('reserves the active ring\'s space on every thumbnail, so activating one does not shift the layout', () => {
    // Every button carries the same ring + ring-offset classes (reserving the
    // space); only the ring's *colour* differs, transparent vs the accent -
    // opacity alone must never be what distinguishes active from inactive.
    const wrapper = mountFilmstrip(PHOTOS, 1);
    const buttons = wrapper.findAll('[data-test-id="filmstrip-thumbnail"]');

    buttons.forEach((button) => {
      expect(button.classes()).toEqual(
        expect.arrayContaining(['ring-2', 'ring-offset-2', 'ring-offset-black']),
      );
    });

    expect(buttons[1]?.classes()).toContain('ring-primary-400');
    expect(buttons[0]?.classes()).toContain('ring-transparent');
    expect(buttons[2]?.classes()).toContain('ring-transparent');
  });

  it('renders nothing and does not throw for an empty photos array', () => {
    let wrapper: ReturnType<typeof mountFilmstrip> | undefined;

    expect(() => {
      wrapper = mountFilmstrip([], 0);
    }).not.toThrow();

    expect(wrapper?.find('[data-test-id="photo-filmstrip"]').exists()).toBe(false);
    expect(wrapper?.findAll('[data-test-id="filmstrip-thumbnail"]')).toHaveLength(0);
  });

  it('hides the strip entirely for a single-photo album, matching the prev/next chevrons', () => {
    const wrapper = mountFilmstrip(SINGLE_PHOTO, 0);

    expect(wrapper.find('[data-test-id="photo-filmstrip"]').exists()).toBe(false);
  });

  it.each([-1, 3, 99])(
    'renders without throwing and marks nothing active when activeIndex (%i) is out of range',
    (activeIndex) => {
      let wrapper: ReturnType<typeof mountFilmstrip> | undefined;

      expect(() => {
        wrapper = mountFilmstrip(PHOTOS, activeIndex);
      }).not.toThrow();

      const buttons = wrapper?.findAll('[data-test-id="filmstrip-thumbnail"]') ?? [];
      expect(buttons).toHaveLength(3);
      buttons.forEach((button) => {
        expect(button.attributes('aria-current')).toBeUndefined();
        expect(button.attributes('tabindex')).toBe('-1');
      });
    },
  );

  it('scrolls the active thumbnail into view when activeIndex changes', async () => {
    const wrapper = mountFilmstrip(PHOTOS, 0);
    const scrollSpy = vi.mocked(Element.prototype.scrollIntoView);
    scrollSpy.mockClear();

    await wrapper.setProps({ activeIndex: 2 });
    await flushPromises();

    expect(scrollSpy).toHaveBeenCalledWith(
      expect.objectContaining({ inline: 'center', block: 'nearest', behavior: 'smooth' }),
    );
  });

  it('does not scroll when activeIndex changes to an out-of-range value', async () => {
    const wrapper = mountFilmstrip(PHOTOS, 0);
    const scrollSpy = vi.mocked(Element.prototype.scrollIntoView);
    scrollSpy.mockClear();

    await wrapper.setProps({ activeIndex: 99 });
    await flushPromises();

    expect(scrollSpy).not.toHaveBeenCalled();
  });

  it('uses behavior "auto" instead of "smooth" when prefers-reduced-motion matches', async () => {
    // The repo-wide matchMedia mock in `vitest.setup.ts` always returns
    // `matches: false`; this test overrides it to simulate the opposite.
    mockPrefersReducedMotion(true);

    const wrapper = mountFilmstrip(PHOTOS, 0);
    const scrollSpy = vi.mocked(Element.prototype.scrollIntoView);
    scrollSpy.mockClear();

    await wrapper.setProps({ activeIndex: 1 });
    await flushPromises();

    expect(scrollSpy).toHaveBeenCalledWith(expect.objectContaining({ behavior: 'auto' }));

    vi.unstubAllGlobals();
  });

  it('uses behavior "smooth" when prefers-reduced-motion does not match', async () => {
    mockPrefersReducedMotion(false);

    const wrapper = mountFilmstrip(PHOTOS, 0);
    const scrollSpy = vi.mocked(Element.prototype.scrollIntoView);
    scrollSpy.mockClear();

    await wrapper.setProps({ activeIndex: 1 });
    await flushPromises();

    expect(scrollSpy).toHaveBeenCalledWith(expect.objectContaining({ behavior: 'smooth' }));

    vi.unstubAllGlobals();
  });

  it('scrolls the active thumbnail into view on mount, so a deep link into a large album is not left scrolled to the start', () => {
    const scrollSpy = vi.mocked(Element.prototype.scrollIntoView);

    mountFilmstrip(PHOTOS, 2);

    // 'auto', not reduced-motion-dependent: animating a jump on first paint is
    // just noise, not a user preference question.
    expect(scrollSpy).toHaveBeenCalledWith(
      expect.objectContaining({ inline: 'center', block: 'nearest', behavior: 'auto' }),
    );
  });

  describe('drag-to-scroll', () => {
    /**
     * `@vue/test-utils`'s `.trigger()` sugar tries to assign `clientX` etc. onto
     * the constructed event *after* the fact, and throws ("...which has only a
     * getter") because `clientX` is only settable via the constructor's init
     * dict, not by direct assignment post-construction. Dispatching the event
     * manually sidesteps that VTU quirk entirely - the constructor itself
     * accepts `clientX`/`pointerId` correctly.
     */
    const dispatchPointer = (element: Element, type: string, init: PointerEventInit) => {
      element.dispatchEvent(new PointerEvent(type, { bubbles: true, ...init }));
    };

    it('scrolls via drag: scrollLeft changes by the negated pointer delta', async () => {
      const wrapper = mountFilmstrip();
      const stripElement = wrapper.find('[data-test-id="photo-filmstrip"]').element as HTMLDivElement;
      stripElement.scrollLeft = 50;

      dispatchPointer(stripElement, 'pointerdown', { clientX: 100, pointerId: 1 });
      dispatchPointer(stripElement, 'pointermove', { clientX: 70, pointerId: 1 });
      await wrapper.vm.$nextTick();

      // delta = clientX(70) - startX(100) = -30
      // scrollLeft = startScrollLeft(50) - delta(-30) = 80
      expect(stripElement.scrollLeft).toBe(80);
    });

    it('shows a grabbing cursor while dragging, and a grab cursor otherwise', async () => {
      const wrapper = mountFilmstrip();
      const strip = wrapper.find('[data-test-id="photo-filmstrip"]');
      const stripElement = strip.element as HTMLDivElement;

      expect(strip.classes()).toContain('cursor-grab');
      expect(strip.classes()).not.toContain('cursor-grabbing');

      dispatchPointer(stripElement, 'pointerdown', { clientX: 100, pointerId: 1 });
      await wrapper.vm.$nextTick();
      expect(strip.classes()).toContain('cursor-grabbing');

      dispatchPointer(stripElement, 'pointerup', { pointerId: 1 });
      await wrapper.vm.$nextTick();
      expect(strip.classes()).toContain('cursor-grab');
      expect(strip.classes()).not.toContain('cursor-grabbing');
    });

    it('does not emit select when a drag exceeds the click-suppression threshold', async () => {
      const wrapper = mountFilmstrip();
      const stripElement = wrapper.find('[data-test-id="photo-filmstrip"]').element as HTMLDivElement;
      const thumbnail = wrapper.findAll('[data-test-id="filmstrip-thumbnail"]')[1];

      // 20px of movement, comfortably past the ~5px threshold.
      dispatchPointer(stripElement, 'pointerdown', { clientX: 100, pointerId: 1 });
      dispatchPointer(stripElement, 'pointermove', { clientX: 80, pointerId: 1 });
      dispatchPointer(stripElement, 'pointerup', { pointerId: 1 });
      await thumbnail?.trigger('click');

      expect(wrapper.emitted('select')).toBeUndefined();
    });

    it('still emits select for a plain click with no preceding pointer movement', async () => {
      const wrapper = mountFilmstrip();
      const thumbnail = wrapper.findAll('[data-test-id="filmstrip-thumbnail"]')[1];

      await thumbnail?.trigger('click');

      expect(wrapper.emitted('select')).toEqual([[1]]);
    });

    it('clears the dragging state on pointercancel, so a later pointermove no longer scrolls', async () => {
      const wrapper = mountFilmstrip();
      const strip = wrapper.find('[data-test-id="photo-filmstrip"]');
      const stripElement = strip.element as HTMLDivElement;
      stripElement.scrollLeft = 10;

      dispatchPointer(stripElement, 'pointerdown', { clientX: 100, pointerId: 1 });
      await wrapper.vm.$nextTick();
      expect(strip.classes()).toContain('cursor-grabbing');

      dispatchPointer(stripElement, 'pointercancel', { pointerId: 1 });
      await wrapper.vm.$nextTick();
      expect(strip.classes()).toContain('cursor-grab');
      expect(strip.classes()).not.toContain('cursor-grabbing');

      // Dragging state is cleared, not just the cursor class: a pointermove
      // that arrives after the cancel must be a no-op.
      dispatchPointer(stripElement, 'pointermove', { clientX: 250, pointerId: 1 });
      expect(stripElement.scrollLeft).toBe(10);
    });

    it('ends the drag via a window-level fallback when pointerup never reaches the strip', async () => {
      // Simulates pointer capture being unavailable (or the pointer having left
      // the strip's bounds despite it): pointerup is dispatched on `document.body`,
      // never on the strip element itself. `setPointerCapture` guarantees this
      // cannot happen in a browser that supports it, but without a window-level
      // fallback, an environment where it silently fails would leave `isDragging`
      // stuck `true` forever - cursor wedged on `cursor-grabbing`, and every
      // future click on the strip incorrectly suppressed.
      const wrapper = mountFilmstrip();
      const strip = wrapper.find('[data-test-id="photo-filmstrip"]');
      const stripElement = strip.element as HTMLDivElement;

      dispatchPointer(stripElement, 'pointerdown', { clientX: 100, pointerId: 1 });
      await wrapper.vm.$nextTick();
      expect(strip.classes()).toContain('cursor-grabbing');

      document.body.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 1 }));
      await wrapper.vm.$nextTick();

      expect(strip.classes()).toContain('cursor-grab');
      expect(strip.classes()).not.toContain('cursor-grabbing');
    });

    describe('lazy pointer capture (regression: plain clicks were not navigating)', () => {
      // Capturing the pointer unconditionally on pointerdown made the browser
      // retarget the compatibility `click` event to the *capturing* element
      // (the strip) instead of whatever was actually under the pointer (a
      // thumbnail button) - so `@click` never fired on the button and clicking
      // a thumbnail silently did nothing. jsdom does not implement
      // setPointerCapture at all, so the retargeting bug itself cannot be
      // reproduced here; these tests instead pin the property that prevents
      // it: capture is taken lazily, only once a real drag is confirmed.

      it('does not take pointer capture on a plain pointerdown', async () => {
        const wrapper = mountFilmstrip();
        const stripElement = wrapper.find('[data-test-id="photo-filmstrip"]')
          .element as HTMLDivElement;
        const captureSpy = vi.fn();
        stripElement.setPointerCapture = captureSpy;

        dispatchPointer(stripElement, 'pointerdown', { clientX: 100, pointerId: 1 });
        await wrapper.vm.$nextTick();

        expect(captureSpy).not.toHaveBeenCalled();
      });

      it('takes pointer capture exactly once movement crosses the drag threshold', async () => {
        const wrapper = mountFilmstrip();
        const stripElement = wrapper.find('[data-test-id="photo-filmstrip"]')
          .element as HTMLDivElement;
        const captureSpy = vi.fn();
        stripElement.setPointerCapture = captureSpy;

        dispatchPointer(stripElement, 'pointerdown', { clientX: 100, pointerId: 1 });
        dispatchPointer(stripElement, 'pointermove', { clientX: 80, pointerId: 1 }); // 20px > 5px
        await wrapper.vm.$nextTick();

        expect(captureSpy).toHaveBeenCalledTimes(1);
        expect(captureSpy).toHaveBeenCalledWith(1);
      });

      it('does not capture again on further pointermove once already captured', async () => {
        const wrapper = mountFilmstrip();
        const stripElement = wrapper.find('[data-test-id="photo-filmstrip"]')
          .element as HTMLDivElement;
        const captureSpy = vi.fn();
        stripElement.setPointerCapture = captureSpy;

        dispatchPointer(stripElement, 'pointerdown', { clientX: 100, pointerId: 1 });
        dispatchPointer(stripElement, 'pointermove', { clientX: 80, pointerId: 1 });
        dispatchPointer(stripElement, 'pointermove', { clientX: 60, pointerId: 1 });
        dispatchPointer(stripElement, 'pointermove', { clientX: 40, pointerId: 1 });
        await wrapper.vm.$nextTick();

        expect(captureSpy).toHaveBeenCalledTimes(1);
      });

      it('still emits select for a full pointerdown -> pointerup -> click gesture with no movement', async () => {
        // This is the exact shape of a real click in a browser: it always
        // starts and ends with a pointerdown/pointerup pair. The bug this
        // round fixes made precisely this sequence stop navigating.
        const wrapper = mountFilmstrip();
        const stripElement = wrapper.find('[data-test-id="photo-filmstrip"]')
          .element as HTMLDivElement;
        const thumbnail = wrapper.findAll('[data-test-id="filmstrip-thumbnail"]')[1];

        dispatchPointer(stripElement, 'pointerdown', { clientX: 100, pointerId: 1 });
        dispatchPointer(stripElement, 'pointerup', { pointerId: 1 });
        await thumbnail?.trigger('click');

        expect(wrapper.emitted('select')).toEqual([[1]]);
      });

      it('does not let a completed drag suppress a later keyboard activation on a thumbnail', async () => {
        // Regression test: a real drag takes pointer capture, which retargets the
        // browser's compatibility `click` event to the strip - so `onThumbnailClick`
        // (bound on the individual button) never runs to consume
        // `dragExceededThreshold` itself. Without `endDrag`'s deferred clear, that
        // flag would still be `true` when a keyboard Enter/Space activation (which
        // dispatches `click` straight at the focused button, no pointer sequence of
        // its own) comes along, silently swallowing the *first* such press.
        const wrapper = mountFilmstrip();
        const stripElement = wrapper.find('[data-test-id="photo-filmstrip"]')
          .element as HTMLDivElement;
        const thumbnail = wrapper.findAll('[data-test-id="filmstrip-thumbnail"]')[1];

        dispatchPointer(stripElement, 'pointerdown', { clientX: 100, pointerId: 1 });
        dispatchPointer(stripElement, 'pointermove', { clientX: 70, pointerId: 1 });
        dispatchPointer(stripElement, 'pointerup', { pointerId: 1 });

        // Let `endDrag`'s 0ms reset timer fire before the keyboard press - a real
        // keyboard press necessarily happens well after the same-tick compatibility
        // click a real drag's `pointerup` is followed by.
        await new Promise((resolve) => setTimeout(resolve, 0));

        // A keyboard activation dispatches `click` directly on the focused button -
        // no preceding pointerdown/pointerup of its own.
        await thumbnail?.trigger('click');

        expect(wrapper.emitted('select')).toEqual([[1]]);
      });

      it('does not let a completed drag suppress a later, unrelated zero-movement click', async () => {
        // Simulates a keyboard Enter/Space activation arriving sometime after
        // an earlier mouse drag: that later click has no preceding pointerdown
        // of its own, so it must not be swallowed by state left over from the
        // drag above it.
        const wrapper = mountFilmstrip();
        const stripElement = wrapper.find('[data-test-id="photo-filmstrip"]')
          .element as HTMLDivElement;
        const thumbnails = wrapper.findAll('[data-test-id="filmstrip-thumbnail"]');

        // A real drag: its own click is correctly suppressed.
        dispatchPointer(stripElement, 'pointerdown', { clientX: 100, pointerId: 1 });
        dispatchPointer(stripElement, 'pointermove', { clientX: 70, pointerId: 1 });
        dispatchPointer(stripElement, 'pointerup', { pointerId: 1 });
        await thumbnails[0]?.trigger('click');
        expect(wrapper.emitted('select')).toBeUndefined();

        // A later, separate, zero-movement click - no preceding pointerdown at
        // all - must still navigate.
        await thumbnails[1]?.trigger('click');
        expect(wrapper.emitted('select')).toEqual([[1]]);
      });
    });

    it('removes the window-level pointerup/pointercancel listeners on unmount, even mid-drag', async () => {
      const addSpy = vi.spyOn(window, 'addEventListener');
      const removeSpy = vi.spyOn(window, 'removeEventListener');

      const wrapper = mountFilmstrip();
      const stripElement = wrapper.find('[data-test-id="photo-filmstrip"]').element as HTMLDivElement;

      dispatchPointer(stripElement, 'pointerdown', { clientX: 100, pointerId: 1 });
      await wrapper.vm.$nextTick();

      const addedPointerUpHandler = addSpy.mock.calls.find(([type]) => type === 'pointerup')?.[1];
      expect(addedPointerUpHandler).toBeDefined();

      wrapper.unmount();

      expect(removeSpy).toHaveBeenCalledWith('pointerup', addedPointerUpHandler);
      expect(removeSpy).toHaveBeenCalledWith('pointercancel', addedPointerUpHandler);

      addSpy.mockRestore();
      removeSpy.mockRestore();
    });

    it('clears the pending dragResetTimer on unmount, so no timer outlives the component', async () => {
      // `onUnmounted` calls `endDrag` (see the test above), which - if `isDragging`
      // was still `true` - schedules a fresh `dragResetTimer` rather than clearing
      // one, since that is `endDrag`'s normal job on every drag end. Left
      // unmounted, that timer would fire after the component is torn down.
      // Harmless (its callback only touches two closure-local variables, no DOM
      // or store), but nothing should outlive the component if it doesn't have to.
      const setSpy = vi.spyOn(globalThis, 'setTimeout');
      const clearSpy = vi.spyOn(globalThis, 'clearTimeout');

      const wrapper = mountFilmstrip();
      const stripElement = wrapper.find('[data-test-id="photo-filmstrip"]').element as HTMLDivElement;

      // Cross the drag threshold so `endDrag` (on unmount) has an
      // `isDragging === true` gesture in progress to end, mirroring the
      // mid-drag unmount scenario the surrounding tests already cover.
      // No `pointerup` here - the drag must still be in progress (`isDragging`
      // still `true`) when `unmount()` below runs, so `onUnmounted`'s own
      // `endDrag()` call is the one that schedules this timer, not a normal
      // drag-end beforehand.
      dispatchPointer(stripElement, 'pointerdown', { clientX: 100, pointerId: 1 });
      dispatchPointer(stripElement, 'pointermove', { clientX: 70, pointerId: 1 });
      await wrapper.vm.$nextTick();

      setSpy.mockClear();
      clearSpy.mockClear();
      wrapper.unmount();

      // `onUnmounted`'s own `endDrag()` call is what schedules this specific
      // timer (see above) - assert the exact id it returned was cleared, not
      // just that *some* `clearTimeout` call happened to occur.
      const results = setSpy.mock.results;
      const timerId = results[results.length - 1]?.value;
      expect(timerId).toBeDefined();
      expect(clearSpy).toHaveBeenCalledWith(timerId);

      setSpy.mockRestore();
      clearSpy.mockRestore();
    });
  });
});
