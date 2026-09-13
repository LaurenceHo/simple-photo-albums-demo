import AlbumTrackMap from '@/components/AlbumTrackMap.vue';
import { mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { nextTick, type Ref } from 'vue';

/** Calls made against the map instance, so layer wiring can be asserted. */
const mapCalls = vi.hoisted(() => ({
  addSource: [] as Array<{ id: string; data: unknown }>,
  addLayer: [] as Array<Record<string, unknown>>,
  removeLayer: [] as string[],
  removeSource: [] as string[],
  fitBounds: [] as unknown[],
  setData: [] as unknown[],
  setPaintProperty: [] as Array<{ layer: string; property: string; value: unknown }>,
  removed: 0,
  /** Containers passed to each `new mapboxgl.Map(...)`, so re-creation can be asserted. */
  constructedFor: [] as unknown[],
}));

const existingSources = vi.hoisted(() => new Set<string>());
const existingLayers = vi.hoisted(() => new Set<string>());

vi.mock('mapbox-gl', () => ({
  default: {
    accessToken: '',
    Map: vi.fn(function (options: { container: unknown }) {
      mapCalls.constructedFor.push(options?.container);
      return {
        // Fire 'load' immediately so the component's layer setup actually runs; an inert
        // `on` would let a refactor drop it with every test still green.
        on: vi.fn((event: string, cb: () => void) => {
          if (event === 'load' || event === 'idle') cb();
        }),
        isStyleLoaded: () => true,
        addSource: vi.fn((id: string, spec: { data: unknown }) => {
          existingSources.add(id);
          mapCalls.addSource.push({ id, data: spec.data });
        }),
        addLayer: vi.fn((spec: Record<string, unknown>) => {
          existingLayers.add(spec['id'] as string);
          mapCalls.addLayer.push(spec);
        }),
        getSource: vi.fn((id: string) =>
          existingSources.has(id)
            ? { setData: vi.fn((data: unknown) => mapCalls.setData.push(data)) }
            : undefined,
        ),
        getLayer: vi.fn((id: string) => (existingLayers.has(id) ? { id } : undefined)),
        removeLayer: vi.fn((id: string) => {
          existingLayers.delete(id);
          mapCalls.removeLayer.push(id);
        }),
        removeSource: vi.fn((id: string) => {
          existingSources.delete(id);
          mapCalls.removeSource.push(id);
        }),
        fitBounds: vi.fn((bounds: unknown) => mapCalls.fitBounds.push(bounds)),
        setPaintProperty: vi.fn((layer: string, property: string, value: unknown) => {
          mapCalls.setPaintProperty.push({ layer, property, value });
        }),
        resize: vi.fn(),
        remove: vi.fn(() => {
          mapCalls.removed += 1;
        }),
      };
    }),
    // `function`, not an arrow: the component calls `new mapboxgl.Marker()`.
    Marker: vi.fn(function () {
      return { setLngLat: () => ({ addTo: vi.fn() }) };
    }),
  },
}));

const feature = (coordinates: number[][]) => ({
  type: 'Feature' as const,
  properties: { name: 'Day 1', distanceKm: 8.4, pointCount: 2, simplified: false },
  geometry: { type: 'LineString' as const, coordinates },
});

/**
 * Real refs, created inside the mock factory and shared with the spec.
 *
 * Handing out a fresh `ref(plainValue)` per call would make the store inert: the
 * component's watchers would never fire, so the layer-removal path could not be tested at
 * all. These are the same refs the component watches.
 */
const storeState = vi.hoisted(() => ({
  legend: null as unknown as Ref<unknown[]>,
  renderableTracks: null as unknown as Ref<unknown[]>,
  hasTracks: null as unknown as Ref<boolean>,
  isFetchingTracks: null as unknown as Ref<boolean>,
  isAdmin: null as unknown as Ref<boolean>,
  toggleTrack: vi.fn(),
}));

vi.mock('@/stores', async () => {
  const { ref: createRef } = await import('vue');
  storeState.legend = createRef<unknown[]>([]);
  storeState.renderableTracks = createRef<unknown[]>([]);
  storeState.hasTracks = createRef(false);
  storeState.isFetchingTracks = createRef(false);
  storeState.isAdmin = createRef(false);

  return {
    useGpsTrackStore: () => ({
      legend: storeState.legend,
      renderableTracks: storeState.renderableTracks,
      hasTracks: storeState.hasTracks,
      isFetchingTracks: storeState.isFetchingTracks,
      toggleTrack: storeState.toggleTrack,
    }),
    useAlbumStore: () => ({
      currentAlbum: createRef({ id: 'demo-album', year: '2026' }),
    }),
    useUserConfigStore: () => ({ isAdmin: storeState.isAdmin }),
  };
});

vi.mock('pinia', async (importOriginal) => {
  const original = await importOriginal<typeof import('pinia')>();
  return { ...original, storeToRefs: (store: Record<string, unknown>) => store };
});

/**
 * Mounted components, unmounted after each test.
 *
 * Necessary because the store refs are shared across the file: a component left mounted
 * keeps watching them, so the next test's store assignment would re-run its layer sync
 * too and inflate every call count.
 */
const mounted: Array<ReturnType<typeof mount>> = [];

const mountMap = async () => {
  const wrapper = mount(AlbumTrackMap);
  mounted.push(wrapper);
  await nextTick();
  await nextTick();
  return wrapper;
};

describe('AlbumTrackMap', () => {
  afterEach(() => {
    mounted.splice(0).forEach((wrapper) => wrapper.unmount());
  });

  beforeEach(() => {
    setActivePinia(createPinia());
    vi.clearAllMocks();
    existingSources.clear();
    existingLayers.clear();
    mapCalls.addSource = [];
    mapCalls.addLayer = [];
    mapCalls.removeLayer = [];
    mapCalls.removeSource = [];
    mapCalls.fitBounds = [];
    mapCalls.setData = [];
    mapCalls.setPaintProperty = [];
    mapCalls.removed = 0;
    mapCalls.constructedFor = [];
    storeState.legend.value = [];
    storeState.renderableTracks.value = [];
    storeState.hasTracks.value = false;
    storeState.isFetchingTracks.value = false;
    storeState.isAdmin.value = false;
  });

  describe('empty state', () => {
    it('shows a message instead of a blank map when the album has no tracks', async () => {
      const wrapper = await mountMap();

      expect(wrapper.find('[data-test-id="track-map-empty"]').exists()).toBe(true);
      expect(wrapper.find('[data-test-id="track-map"]').exists()).toBe(false);
    });

    it('carries no admin affordance — management lives in the album dialog', async () => {
      const wrapper = await mountMap();

      expect(wrapper.text()).not.toMatch(/manage/i);
      expect(wrapper.findAll('button')).toHaveLength(0);
    });

    /**
     * This pair used to contradict the test above: the "Add one from Edit album" line was
     * shown to everyone, so the empty state told a visitor to use a control that is inside
     * an admin-only toolbar and invisible to them.
     */
    it('tells a visitor nothing about adding tracks', async () => {
      const wrapper = await mountMap();

      expect(wrapper.text()).toContain('No GPS tracks for this album yet.');
      expect(wrapper.text()).not.toMatch(/Edit album/i);
    });

    it('points an admin at where tracks are managed', async () => {
      storeState.isAdmin.value = true;

      const wrapper = await mountMap();

      expect(wrapper.text()).toMatch(/Edit album/i);
    });
  });

  describe('rendering tracks', () => {
    beforeEach(() => {
      storeState.hasTracks.value = true;
      storeState.renderableTracks.value = [
        {
          trackId: 'day-1',
          colour: '#0072B2',
          feature: feature([
            [174.76, -36.85],
            [174.78, -36.87],
          ]),
        },
        {
          trackId: 'day-2',
          colour: '#D55E00',
          feature: feature([
            [174.9, -36.9],
            [174.95, -36.95],
          ]),
        },
      ];
    });

    it('adds one source and one layer per track', async () => {
      await mountMap();

      expect(mapCalls.addSource.map((call) => call.id)).toEqual(['track-day-1', 'track-day-2']);
      expect(mapCalls.addLayer.map((spec) => spec['id'])).toEqual([
        'track-line-day-1',
        'track-line-day-2',
      ]);
    });

    it('colours each line from the manifest, so it matches the legend swatch', async () => {
      await mountMap();

      const colours = mapCalls.addLayer.map(
        (spec) => (spec['paint'] as Record<string, unknown>)['line-color'],
      );
      expect(colours).toEqual(['#0072B2', '#D55E00']);
    });

    /**
     * Colours are assigned by position in the album's sorted track ids, so deleting a
     * track shifts the colour of every track after it. The test above only covers the
     * layer's creation, where `line-color` is read once - a reassignment afterwards used
     * to leave the line on its old colour while the legend swatch moved, which is exactly
     * the disagreement the server-assigned colour exists to prevent.
     */
    it('repaints a line whose manifest colour changed', async () => {
      await mountMap();

      const [first, second] = storeState.renderableTracks.value as Array<
        Record<string, unknown>
      >;
      // What the manifest returns after the track ahead of these two is deleted.
      storeState.renderableTracks.value = [
        { ...first, colour: '#009E73' },
        { ...second, colour: '#CC79A7' },
      ];
      await nextTick();

      expect(mapCalls.setPaintProperty).toEqual([
        { layer: 'track-line-day-1', property: 'line-color', value: '#009E73' },
        { layer: 'track-line-day-2', property: 'line-color', value: '#CC79A7' },
      ]);
      // Re-colouring must not rebuild the layer - that would drop the viewer's toggles.
      expect(mapCalls.addLayer).toHaveLength(2);
    });

    it('fits bounds once, across every visible track', async () => {
      await mountMap();

      expect(mapCalls.fitBounds).toHaveLength(1);
      // Bounding box spans both tracks, south-west corner first.
      expect(mapCalls.fitBounds[0]).toEqual([
        [174.76, -36.95],
        [174.95, -36.85],
      ]);
    });

    it('removes the layer and source for a track that is toggled off', async () => {
      await mountMap();

      // Drop day-2 from the renderable set, as toggling its legend row would.
      storeState.renderableTracks.value = [storeState.renderableTracks.value[0]];
      await nextTick();

      expect(mapCalls.removeLayer).toEqual(['track-line-day-2']);
      expect(mapCalls.removeSource).toEqual(['track-day-2']);
    });

    it('does not re-add a track that is still visible', async () => {
      await mountMap();
      mapCalls.addSource = [];

      storeState.renderableTracks.value = [storeState.renderableTracks.value[0]];
      await nextTick();

      // day-1's source already exists, so it is updated in place rather than recreated -
      // recreating it would make the line flicker every time a sibling is toggled.
      expect(mapCalls.addSource).toEqual([]);
      expect(mapCalls.setData).toHaveLength(1);
    });

    it('fits bounds only once, even as tracks change', async () => {
      await mountMap();

      storeState.renderableTracks.value = [storeState.renderableTracks.value[0]];
      await nextTick();

      // Refitting on every change would yank the viewport away from wherever the viewer
      // had panned to.
      expect(mapCalls.fitBounds).toHaveLength(1);
    });
  });

  describe('legend', () => {
    beforeEach(() => {
      storeState.hasTracks.value = true;
      storeState.legend.value = [
        {
          trackId: 'day-1',
          colour: '#0072B2',
          label: 'Day One',
          distanceKm: 8.4,
          isLoading: false,
          isError: false,
          visible: true,
        },
        {
          trackId: 'day-2',
          colour: '#D55E00',
          label: 'day-2',
          distanceKm: undefined,
          isLoading: false,
          isError: true,
          visible: false,
        },
      ];
    });

    it('renders a row per track with its label and distance', async () => {
      const wrapper = await mountMap();
      const items = wrapper.findAll('[data-test-id="track-legend-item"]');

      expect(items).toHaveLength(2);
      expect(items[0]?.text()).toContain('Day One');
      expect(items[0]?.text()).toContain('8.4 km');
    });

    it('shows an error on the failing row only', async () => {
      const wrapper = await mountMap();
      const items = wrapper.findAll('[data-test-id="track-legend-item"]');

      expect(items[1]?.text()).toContain('Could not load this track');
      expect(items[0]?.text()).not.toContain('Could not load');
    });

    it('uses real buttons carrying visibility in aria-pressed, not colour alone', async () => {
      const wrapper = await mountMap();
      const items = wrapper.findAll('[data-test-id="track-legend-item"]');

      expect(items[0]?.attributes('aria-pressed')).toBe('true');
      expect(items[1]?.attributes('aria-pressed')).toBe('false');
    });

    it('toggles a track when its row is clicked', async () => {
      const wrapper = await mountMap();

      await wrapper.findAll('[data-test-id="track-legend-item"]')[0]?.trigger('click');

      expect(storeState.toggleTrack).toHaveBeenCalledWith('day-1');
    });
  });

  describe('cleanup', () => {
    it('destroys the map on unmount', async () => {
      storeState.hasTracks.value = true;
      storeState.renderableTracks.value = [
        { trackId: 'day-1', colour: '#0072B2', feature: feature([[174.76, -36.85]]) },
      ];

      const wrapper = await mountMap();
      wrapper.unmount();

      expect(mapCalls.removed).toBe(1);
    });
  });
});

describe('AlbumTrackMap going from empty to having tracks', () => {
  afterEach(() => {
    mounted.splice(0).forEach((wrapper) => wrapper.unmount());
  });

  beforeEach(() => {
    setActivePinia(createPinia());
    vi.clearAllMocks();
    existingSources.clear();
    existingLayers.clear();
    mapCalls.addSource = [];
    mapCalls.addLayer = [];
    mapCalls.removeLayer = [];
    mapCalls.removeSource = [];
    mapCalls.fitBounds = [];
    mapCalls.setData = [];
    mapCalls.setPaintProperty = [];
    mapCalls.removed = 0;
    mapCalls.constructedFor = [];
    storeState.legend.value = [];
    storeState.renderableTracks.value = [];
    storeState.hasTracks.value = false;
    storeState.isFetchingTracks.value = false;
    storeState.isAdmin.value = false;
  });

  /**
   * Reproduces a reported bug: on the map view with no tracks, uploading one and closing
   * the dialog left the empty state on screen until a full page reload.
   *
   * The map container only exists in the `v-else` branch, so it appears for the first
   * time when `hasTracks` flips - the component has to initialise the map at that point,
   * not only on mount.
   */
  it('creates the map when the first track arrives, without a remount', async () => {
    storeState.hasTracks.value = false;
    storeState.renderableTracks.value = [];

    const wrapper = await mountMap();
    expect(wrapper.find('[data-test-id="track-map-empty"]').exists()).toBe(true);
    expect(mapCalls.addSource).toEqual([]);

    // What an upload does: the manifest refetches, then the geometry query resolves.
    storeState.hasTracks.value = true;
    await nextTick();
    storeState.renderableTracks.value = [
      {
        trackId: 'day-1',
        colour: '#0072B2',
        feature: feature([
          [174.76, -36.85],
          [174.78, -36.87],
        ]),
      },
    ];
    await nextTick();
    await nextTick();

    expect(wrapper.find('[data-test-id="track-map-empty"]').exists()).toBe(false);
    expect(wrapper.find('[data-test-id="track-map"]').exists()).toBe(true);
    expect(mapCalls.addSource.map((call) => call.id)).toEqual(['track-day-1']);
  });

  it('recovers when the container is destroyed and then re-created', async () => {
    // The real first-load sequence, which the test above skips. While the manifest is in
    // flight `isFetchingTracks` is true, so the empty state is suppressed and the map
    // branch renders straight away. The container therefore exists, is torn down when the
    // manifest comes back empty, and has to come back when a track is uploaded.
    storeState.isFetchingTracks.value = true;
    storeState.hasTracks.value = false;

    const wrapper = await mountMap();
    // No map container while the manifest is in flight. Rendering one here was the cause:
    // it was built, then torn down the moment the fetch came back empty.
    expect(wrapper.find('[data-test-id="track-map-loading"]').exists()).toBe(true);
    expect(wrapper.find('[data-test-id="track-map"]').exists()).toBe(false);
    expect(mapCalls.constructedFor).toEqual([]);

    // Manifest resolves empty.
    storeState.isFetchingTracks.value = false;
    storeState.isAdmin.value = false;
    await nextTick();
    expect(wrapper.find('[data-test-id="track-map-empty"]').exists()).toBe(true);

    // Upload: a track arrives and the container comes back.
    storeState.hasTracks.value = true;
    storeState.renderableTracks.value = [
      {
        trackId: 'day-1',
        colour: '#0072B2',
        feature: feature([
          [174.76, -36.85],
          [174.78, -36.87],
        ]),
      },
    ];
    await nextTick();
    await nextTick();

    expect(wrapper.find('[data-test-id="track-map"]').exists()).toBe(true);
    expect(mapCalls.addSource.map((call) => call.id)).toEqual(['track-day-1']);

    // The assertion that matters, and the one a call-recording mock hides: the map has to
    // be built for the container that is *currently* on screen. Syncing layers onto the
    // instance bound to the destroyed container records every call happily and renders
    // nothing, which is exactly how this reached a browser.
    const liveContainer = wrapper.find('[data-test-id="track-map"]').element;
    expect(mapCalls.constructedFor[mapCalls.constructedFor.length - 1]).toBe(liveContainer);
    // Exactly one map was ever built - for the live container.
    expect(mapCalls.constructedFor).toHaveLength(1);
  });

  it('disposes and rebuilds when the last track is deleted and another added', async () => {
    // Deleting the last track swaps the map back out for the empty state, so the instance
    // must be disposed rather than left pointing at a detached node - otherwise the next
    // upload finds a stale `map` and never builds one for the new container.
    const track = {
      trackId: 'day-1',
      colour: '#0072B2',
      feature: feature([
        [174.76, -36.85],
        [174.78, -36.87],
      ]),
    };
    storeState.hasTracks.value = true;
    storeState.renderableTracks.value = [track];

    const wrapper = await mountMap();
    expect(mapCalls.constructedFor).toHaveLength(1);

    storeState.hasTracks.value = false;
    storeState.renderableTracks.value = [];
    await nextTick();
    expect(wrapper.find('[data-test-id="track-map-empty"]').exists()).toBe(true);
    expect(mapCalls.removed).toBe(1);

    storeState.hasTracks.value = true;
    storeState.renderableTracks.value = [track];
    await nextTick();
    await nextTick();

    expect(mapCalls.constructedFor).toHaveLength(2);
    expect(mapCalls.constructedFor[mapCalls.constructedFor.length - 1]).toBe(
      wrapper.find('[data-test-id="track-map"]').element,
    );
  });
});
