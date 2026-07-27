import PhotoLocationMap from '@/components/PhotoLocationMap.vue';
import { mount } from '@vue/test-utils';
import { describe, expect, it, vi } from 'vitest';

const mapInstances: { container: unknown }[] = [];
const mapRemoves: ReturnType<typeof vi.fn>[] = [];
const mapResizes: ReturnType<typeof vi.fn>[] = [];

vi.mock('mapbox-gl', () => ({
  default: {
    accessToken: '',
    Map: vi.fn(function (options: { container: unknown }) {
      mapInstances.push(options);
      const remove = vi.fn();
      const resize = vi.fn();
      mapRemoves.push(remove);
      mapResizes.push(resize);
      return {
        // Actually invoke the 'idle' callback, so the component's `map.on('idle', () =>
        // map?.resize())` handler runs for real. That resize call is the one behaviour
        // the requirements call out by name (the map is often mounted inside a Popover
        // that has no size until it opens) — an inert `on: vi.fn()` would let a future
        // refactor silently drop it with every test still green.
        on: vi.fn((event: string, cb: () => void) => {
          if (event === 'idle') {
            cb();
          }
        }),
        remove,
        resize,
      };
    }),
    // `function`, not an arrow: `new mapboxgl.Marker()` is called with `new` by the
    // component, and vitest's mock cannot construct from an arrow-function
    // implementation (`TypeError: ... is not a constructor`) — that failure is a
    // mock-authoring defect, not the container/id bug this spec exists to catch.
    Marker: vi.fn(function () {
      return { setLngLat: vi.fn().mockReturnThis(), addTo: vi.fn() };
    }),
  },
}));

describe('PhotoLocationMap.vue', () => {
  it('binds Mapbox to its own element, so two maps can coexist', () => {
    mapInstances.length = 0;

    const first = mount(PhotoLocationMap, {
      props: { latitude: -33.85, longitude: 151.21 },
      attachTo: document.body,
    });
    const second = mount(PhotoLocationMap, {
      props: { latitude: 51.5, longitude: -0.12 },
      attachTo: document.body,
    });

    expect(mapInstances).toHaveLength(2);
    expect(mapInstances[0]?.container).toBe(first.element);
    expect(mapInstances[1]?.container).toBe(second.element);
    expect(mapInstances[0]?.container).not.toBe(mapInstances[1]?.container);

    first.unmount();
    second.unmount();
  });

  /**
   * The real scenario Task 7 introduces: the album Popover map and the lightbox
   * photo map mounted as siblings under the *same* running app (this SPA only ever
   * has one `createApp()` call).
   *
   * A cross-app comparison (two separate `mount()` calls) cannot prove this: `useId()`
   * counts up per Vue *app* instance, not globally — it returns `(idPrefix || 'v') +
   * '-' + instance.ids[0] + instance.ids[1]++`, and each `mount()` call from
   * `@vue/test-utils` creates its own fresh `createApp()`, so two independent apps each
   * restart their counter at 0 and both instances get `v-0`. Mounting both instances as
   * siblings under one shared app, as below, is the only way to prove the fix actually
   * matters: distinct ids **and** each Mapbox `container` bound to that child's own
   * element.
   */
  it('gives each sibling instance a unique id and its own Mapbox container within the same app', () => {
    mapInstances.length = 0;

    const Host = {
      components: { PhotoLocationMap },
      template: `
        <div>
          <PhotoLocationMap :latitude="1" :longitude="2" />
          <PhotoLocationMap :latitude="3" :longitude="4" />
        </div>
      `,
    };

    const wrapper = mount(Host, { attachTo: document.body });
    const children = wrapper.findAllComponents(PhotoLocationMap);
    const ids = children.map((c) => c.attributes('id'));

    expect(ids).toHaveLength(2);
    expect(ids[0]).toBeTruthy();
    expect(ids[1]).toBeTruthy();
    expect(new Set(ids).size).toBe(2);

    expect(mapInstances).toHaveLength(2);
    expect(mapInstances[0]?.container).toBe(children[0]?.element);
    expect(mapInstances[1]?.container).toBe(children[1]?.element);
    expect(mapInstances[0]?.container).not.toBe(mapInstances[1]?.container);

    wrapper.unmount();
  });

  it('removes the map instance on unmount, so no map leaks behind', () => {
    mapRemoves.length = 0;

    const wrapper = mount(PhotoLocationMap, {
      props: { latitude: 1, longitude: 2 },
      attachTo: document.body,
    });

    expect(mapRemoves).toHaveLength(1);
    expect(mapRemoves[0]).not.toHaveBeenCalled();

    wrapper.unmount();

    expect(mapRemoves[0]).toHaveBeenCalledTimes(1);
  });

  /**
   * The map is often mounted inside a Popover that has no size until it opens, so the
   * component calls `map.resize()` once Mapbox reports 'idle'. Proven here by having
   * the mock actually invoke the 'idle' callback (see the `on` mock above) rather than
   * leaving it inert.
   */
  it('resizes the map once Mapbox reports idle', () => {
    mapResizes.length = 0;

    const wrapper = mount(PhotoLocationMap, {
      props: { latitude: 1, longitude: 2 },
      attachTo: document.body,
    });

    expect(mapResizes).toHaveLength(1);
    expect(mapResizes[0]).toHaveBeenCalledTimes(1);

    wrapper.unmount();
  });

  /**
   * The `!mapContainer.value` guard in `onMounted` is unreachable through the public
   * component API: Vue's renderer binds template refs during the patch phase, before
   * `mounted` hooks are flushed (see `setRef` in
   * `@vue/runtime-core/dist/runtime-core.cjs.js`, ~line 1743), so `mapContainer.value`
   * is always populated by the time this component's `onMounted` runs. Forcing the
   * branch would mean faking Vue's reactivity internals (`isRef`/`canSetSetupRef`)
   * rather than testing this component, which is a maintenance trap the moment Vue's
   * internals shift — this repo alone hoists nine different 3.5.x builds.
   *
   * What the guard protects in practice is that Mapbox is only ever handed a real
   * element — never the string literal the old `getElementById('photo-location-map')`
   * code passed, and never `null`. That is what this test asserts.
   */
  it('only ever constructs the map with a real element as its container', () => {
    mapInstances.length = 0;

    const wrapper = mount(PhotoLocationMap, {
      props: { latitude: 1, longitude: 2 },
      attachTo: document.body,
    });

    expect(mapInstances).toHaveLength(1);
    expect(mapInstances[0]?.container).toBeInstanceOf(HTMLElement);
    expect(typeof mapInstances[0]?.container).not.toBe('string');

    wrapper.unmount();
  });
});
