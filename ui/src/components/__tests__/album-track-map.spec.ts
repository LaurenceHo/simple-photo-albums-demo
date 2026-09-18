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
  /** `addLayer` calls with the `beforeId` they were anchored to, if any. */
  addLayerAnchors: [] as Array<{ id: string; beforeId?: string }>,
  moveLayer: [] as Array<{ id: string; beforeId?: string }>,
  setLayoutProperty: [] as Array<{ layer: string; property: string; value: unknown }>,
  /** Handlers registered per `(event, layer)`, so pin clicks can be driven directly. */
  handlers: new Map<string, (event: unknown) => void>(),
  /** When true, `loadImage` holds its callback until `resolveImage` is called. */
  deferImage: false,
  resolveImage: null as (() => void) | null,
  /** Coordinates each `new mapboxgl.Marker()` was placed at. */
  markers: [] as Array<[number, number]>,
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
        // `on` would let a refactor drop it with every test still green. Layer-scoped
        // handlers are kept so a test can invoke a pin click without a real map.
        on: vi.fn((event: string, layerOrCb: unknown, maybeCb?: (e: unknown) => void) => {
          if (typeof layerOrCb === 'function') {
            if (event === 'load' || event === 'idle') (layerOrCb as () => void)();
            return;
          }
          if (maybeCb) mapCalls.handlers.set(`${event}:${layerOrCb as string}`, maybeCb);
        }),
        // Deliberately false. `Style.loaded()` reports false whenever any source cache,
        // style fragment or pending image is still settling, which adding track sources
        // routinely causes — so the component must not gate layer work on it. Pinning it
        // false here means any reintroduction of that guard fails these tests instead of
        // silently dropping a pin update in production.
        isStyleLoaded: () => false,
        addSource: vi.fn((id: string, spec: { data: unknown }) => {
          existingSources.add(id);
          mapCalls.addSource.push({ id, data: spec.data });
        }),
        // The second argument is the `beforeId` anchor, and it is the whole point of the
        // stacking tests - capture it rather than only the spec.
        addLayer: vi.fn((spec: Record<string, unknown>, beforeId?: string) => {
          existingLayers.add(spec['id'] as string);
          mapCalls.addLayer.push(spec);
          mapCalls.addLayerAnchors.push({ id: spec['id'] as string, beforeId });
        }),
        moveLayer: vi.fn((id: string, beforeId?: string) => {
          mapCalls.moveLayer.push({ id, beforeId });
        }),
        getSource: vi.fn((id: string) =>
          existingSources.has(id)
            ? {
                setData: vi.fn((data: unknown) => mapCalls.setData.push(data)),
                getClusterExpansionZoom: vi.fn(),
              }
            : undefined,
        ),
        // Mapbox loads the marker image asynchronously, and the pin layer is added in this
        // callback. Tests default to resolving it immediately, but `mapCalls.deferImage`
        // holds it open so a test can assert what happens when the viewer acts while the
        // image is still in flight - a window a synchronous stub would hide entirely.
        loadImage: vi.fn((_url: string, cb: (e: unknown, img: unknown) => void) => {
          if (mapCalls.deferImage) {
            mapCalls.resolveImage = () => cb(null, {});
            return;
          }
          cb(null, {});
        }),
        hasImage: vi.fn(() => false),
        addImage: vi.fn(),
        getCanvas: vi.fn(() => ({ style: {} })),
        easeTo: vi.fn(),
        setLayoutProperty: vi.fn((layer: string, property: string, value: unknown) => {
          mapCalls.setLayoutProperty.push({ layer, property, value });
        }),
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
    // `function`, not an arrow: the component calls `new mapboxgl.Marker()`. Records where
    // each one was placed, so the album-location pin can be asserted.
    Marker: vi.fn(function () {
      return {
        setLngLat: (coordinates: [number, number]) => {
          mapCalls.markers.push(coordinates);
          return { addTo: vi.fn() };
        },
      };
    }),
    Popup: vi.fn(function () {
      return {
        setLngLat: vi.fn().mockReturnThis(),
        setDOMContent: vi.fn().mockReturnThis(),
        addTo: vi.fn().mockReturnThis(),
        remove: vi.fn(),
      };
    }),
  },
}));

const feature = (coordinates: number[][]) => ({
  type: 'Feature' as const,
  properties: { name: 'Day 1', distanceKm: 8.4, pointCount: 2, simplified: false },
  geometry: { type: 'LineString' as const, coordinates },
});

/** One renderable track with a short line, for tests that only need it to exist. */
const renderable = (trackId: string, colour = '#0072B2') => ({
  trackId,
  colour,
  feature: feature([
    [174.76, -36.85],
    [174.78, -36.87],
  ]),
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
  photosInAlbum: null as unknown as Ref<unknown[]>,
  /** Mutable so a test can give the album a `place`, which keeps the map alive alone. */
  currentAlbum: null as unknown as Ref<Record<string, unknown>>,
  toggleTrack: vi.fn(),
}));

/** Captures `router.replace` so pin clicks can be asserted against `?photo=`. */
const routerCalls = vi.hoisted(() => ({ replace: vi.fn() }));

vi.mock('vue-router', () => ({
  useRouter: () => ({ replace: routerCalls.replace }),
  useRoute: () => ({ query: { photoStyle: 'map' } }),
}));

vi.mock('@/stores', async () => {
  const { ref: createRef } = await import('vue');
  storeState.legend = createRef<unknown[]>([]);
  storeState.renderableTracks = createRef<unknown[]>([]);
  storeState.hasTracks = createRef(false);
  storeState.isFetchingTracks = createRef(false);
  storeState.isAdmin = createRef(false);
  storeState.photosInAlbum = createRef<unknown[]>([]);
  storeState.currentAlbum = createRef<Record<string, unknown>>({
    id: 'demo-album',
    year: '2026',
  });

  return {
    useGpsTrackStore: () => ({
      legend: storeState.legend,
      renderableTracks: storeState.renderableTracks,
      hasTracks: storeState.hasTracks,
      isFetchingTracks: storeState.isFetchingTracks,
      toggleTrack: storeState.toggleTrack,
    }),
    useAlbumStore: () => ({ currentAlbum: storeState.currentAlbum }),
    usePhotoStore: () => ({ photosInAlbum: storeState.photosInAlbum }),
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

/**
 * Clear every recorded map call and reset the shared store refs.
 *
 * The refs and the call log live at module scope so the component can watch them, which
 * means state leaks between tests unless it is cleared. Each `describe` below runs this in
 * its own `beforeEach`.
 */
const resetMapState = () => {
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
  mapCalls.addLayerAnchors = [];
  mapCalls.moveLayer = [];
  mapCalls.setLayoutProperty = [];
  mapCalls.handlers.clear();
  mapCalls.deferImage = false;
  mapCalls.resolveImage = null;
  mapCalls.markers = [];
  storeState.currentAlbum.value = { id: 'demo-album', year: '2026' };
  routerCalls.replace.mockReset();
  storeState.photosInAlbum.value = [];
  storeState.legend.value = [];
  storeState.renderableTracks.value = [];
  storeState.hasTracks.value = false;
  storeState.isFetchingTracks.value = false;
  storeState.isAdmin.value = false;
};

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
    resetMapState();
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

      // The copy names both reasons the map is empty, since photo pins can fill it too.
      expect(wrapper.text()).toContain('Nothing to map for this album yet');
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
    resetMapState();
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

describe('AlbumTrackMap photo pins', () => {
  const PIN_SOURCE = 'photo-pins';
  const PIN_CLUSTER_LAYER = 'photo-pin-clusters';
  const PIN_POINT_LAYER = 'photo-pin-unclustered';

  const pinnedPhoto = (name: string, latitude: number, longitude: number) => ({
    url: `https://cdn.example.com/demo-album/${name}`,
    key: `demo-album/${name}`,
    latitude,
    longitude,
    hasGps: true,
  });

  afterEach(() => {
    mounted.splice(0).forEach((wrapper) => wrapper.unmount());
  });

  beforeEach(() => {
    resetMapState();
  });

  describe('building the layer', () => {
    it('adds a clustered source built from photos that have coordinates', async () => {
      storeState.photosInAlbum.value = [
        pinnedPhoto('one.jpg', -36.85, 174.76),
        pinnedPhoto('two.jpg', -36.86, 174.77),
      ];

      await mountMap();

      const source = mapCalls.addSource.find((entry) => entry.id === PIN_SOURCE);
      expect(source).toBeDefined();
      const data = source?.data as { features: unknown[] };
      expect(data.features).toHaveLength(2);
      expect(mapCalls.addLayer.map((layer) => layer['id'])).toEqual(
        expect.arrayContaining([PIN_CLUSTER_LAYER, 'photo-pin-cluster-count', PIN_POINT_LAYER]),
      );
    });

    // A photo with no coordinates has nothing to place; one with a single coordinate would
    // otherwise be drawn at a longitude of 0, which is a real spot in the Gulf of Guinea.
    it('leaves out photos with no coordinates or only one of the pair', async () => {
      storeState.photosInAlbum.value = [
        pinnedPhoto('good.jpg', -36.85, 174.76),
        { url: 'u', key: 'demo-album/none.jpg' },
        { url: 'u', key: 'demo-album/half.jpg', latitude: -36.85 },
      ];

      await mountMap();

      const source = mapCalls.addSource.find((entry) => entry.id === PIN_SOURCE);
      expect((source?.data as { features: unknown[] }).features).toHaveLength(1);
    });

    it('builds no pin source at all for an album with no located photos', async () => {
      storeState.hasTracks.value = true;
      storeState.renderableTracks.value = [renderable('day-1')];

      await mountMap();

      expect(mapCalls.addSource.find((entry) => entry.id === PIN_SOURCE)).toBeUndefined();
    });

    // The lightbox is opened by key, so the key has to travel with the feature - a click
    // event hands back the feature, not the photo.
    it('carries the photo key and a resized thumbnail in the feature properties', async () => {
      storeState.photosInAlbum.value = [pinnedPhoto('holiday.jpg', -36.85, 174.76)];

      await mountMap();

      const source = mapCalls.addSource.find((entry) => entry.id === PIN_SOURCE);
      const feature = (source?.data as { features: Array<{ properties: Record<string, string> }> })
        .features[0];
      expect(feature?.properties['photoKey']).toBe('holiday.jpg');
      // Resized, not the full-resolution original: a hover must not pull a 10 MB photo.
      expect(feature?.properties['thumbnail']).toContain('tr=h-');
    });

    it('updates the existing source rather than rebuilding it when photos change', async () => {
      storeState.photosInAlbum.value = [pinnedPhoto('one.jpg', -36.85, 174.76)];
      await mountMap();
      const sourcesAfterMount = mapCalls.addSource.length;

      storeState.photosInAlbum.value = [
        pinnedPhoto('one.jpg', -36.85, 174.76),
        pinnedPhoto('two.jpg', -36.86, 174.77),
      ];
      await nextTick();

      expect(mapCalls.addSource).toHaveLength(sourcesAfterMount);
      expect(mapCalls.setData.length).toBeGreaterThan(0);
    });
  });

  /**
   * The stacking rule, and the reason it is not simply "add the pins last".
   *
   * A track toggled off and back on is removed and re-added by `syncTrackLayers`. An
   * `addLayer` with no `beforeId` goes on top of everything already on the map — so
   * without an anchor, toggling a track would draw its line over the pins. The plan for
   * this work asserted that tracks were already added with an explicit `beforeId`; they
   * were not, which is exactly the gap these tests close.
   */
  describe('stacking pins above the track lines', () => {
    it('moves existing track lines beneath the pins once the pin layer exists', async () => {
      storeState.hasTracks.value = true;
      storeState.renderableTracks.value = [renderable('day-1')];
      storeState.photosInAlbum.value = [pinnedPhoto('one.jpg', -36.85, 174.76)];

      await mountMap();

      expect(mapCalls.moveLayer).toContainEqual({
        id: 'track-line-day-1',
        beforeId: PIN_CLUSTER_LAYER,
      });
    });

    it('anchors a track re-added after the pins beneath them', async () => {
      storeState.hasTracks.value = true;
      storeState.renderableTracks.value = [renderable('day-1'), renderable('day-2')];
      storeState.photosInAlbum.value = [pinnedPhoto('one.jpg', -36.85, 174.76)];
      await mountMap();

      // Toggle day-2 off, then back on: the re-add is the call that used to land on top.
      storeState.renderableTracks.value = [renderable('day-1')];
      await nextTick();
      mapCalls.addLayerAnchors = [];
      storeState.renderableTracks.value = [renderable('day-1'), renderable('day-2')];
      await nextTick();

      expect(mapCalls.addLayerAnchors).toContainEqual({
        id: 'track-line-day-2',
        beforeId: PIN_CLUSTER_LAYER,
      });
    });

    it('still adds a track with no anchor when the album has no pins', async () => {
      storeState.hasTracks.value = true;
      storeState.renderableTracks.value = [renderable('day-1')];

      await mountMap();

      expect(mapCalls.addLayerAnchors).toContainEqual({
        id: 'track-line-day-1',
        beforeId: undefined,
      });
    });
  });

  describe('interaction', () => {
    it('opens the photo in the lightbox through the ?photo= param', async () => {
      storeState.photosInAlbum.value = [pinnedPhoto('holiday.jpg', -36.85, 174.76)];
      await mountMap();

      mapCalls.handlers.get(`click:${PIN_POINT_LAYER}`)?.({
        features: [{ properties: { photoKey: 'holiday.jpg' }, geometry: { coordinates: [1, 2] } }],
      });

      expect(routerCalls.replace).toHaveBeenCalledWith({
        query: { photoStyle: 'map', photo: 'holiday.jpg' },
      });
    });

    // Losing `photoStyle` would drop the viewer back to the grid when they close the
    // lightbox, rather than back to the map they clicked from.
    it('keeps the rest of the query string when opening a photo', async () => {
      storeState.photosInAlbum.value = [pinnedPhoto('holiday.jpg', -36.85, 174.76)];
      await mountMap();

      mapCalls.handlers.get(`click:${PIN_POINT_LAYER}`)?.({
        features: [{ properties: { photoKey: 'holiday.jpg' }, geometry: { coordinates: [1, 2] } }],
      });

      const query = routerCalls.replace.mock.calls[0]?.[0]?.query;
      expect(query).toMatchObject({ photoStyle: 'map' });
    });

    it('navigates nowhere when a click carries no photo key', async () => {
      storeState.photosInAlbum.value = [pinnedPhoto('holiday.jpg', -36.85, 174.76)];
      await mountMap();

      mapCalls.handlers.get(`click:${PIN_POINT_LAYER}`)?.({ features: [] });

      expect(routerCalls.replace).not.toHaveBeenCalled();
    });
  });

  describe('bounds and legend', () => {
    // Without pins in the calculation an album with photos but no tracks would open on the
    // world view.
    it('fits bounds to the pins for an album with no tracks', async () => {
      storeState.photosInAlbum.value = [
        pinnedPhoto('one.jpg', -36.85, 174.76),
        pinnedPhoto('two.jpg', -36.95, 174.9),
      ];

      await mountMap();

      expect(mapCalls.fitBounds[0]).toEqual([
        [174.76, -36.95],
        [174.9, -36.85],
      ]);
    });

    it('shows the map rather than the empty state when pins exist without tracks', async () => {
      storeState.photosInAlbum.value = [pinnedPhoto('one.jpg', -36.85, 174.76)];

      const wrapper = await mountMap();

      expect(wrapper.find('[data-test-id="track-map"]').exists()).toBe(true);
      expect(wrapper.find('[data-test-id="track-map-empty"]').exists()).toBe(false);
    });

    it('offers a pins toggle in the legend, alongside the tracks', async () => {
      storeState.photosInAlbum.value = [pinnedPhoto('one.jpg', -36.85, 174.76)];

      const wrapper = await mountMap();
      const toggle = wrapper.find('[data-test-id="photo-pins-legend-item"]');

      expect(toggle.exists()).toBe(true);
      expect(toggle.attributes('aria-pressed')).toBe('true');
    });

    it('hides every pin layer when the toggle is switched off', async () => {
      storeState.photosInAlbum.value = [pinnedPhoto('one.jpg', -36.85, 174.76)];
      const wrapper = await mountMap();

      await wrapper.find('[data-test-id="photo-pins-legend-item"]').trigger('click');
      await nextTick();

      expect(mapCalls.setLayoutProperty.filter((call) => call.value === 'none')).toHaveLength(3);
      expect(wrapper.find('[data-test-id="photo-pins-legend-item"]').attributes('aria-pressed')).toBe(
        'false',
      );
    });

    it('offers no pins toggle for an album whose photos have no coordinates', async () => {
      storeState.hasTracks.value = true;
      storeState.renderableTracks.value = [renderable('day-1')];
      storeState.legend.value = [
        { trackId: 'day-1', label: 'Day 1', colour: '#0072B2', visible: true },
      ];

      const wrapper = await mountMap();

      expect(wrapper.find('[data-test-id="photo-pins-legend-item"]').exists()).toBe(false);
    });
  });
});

/**
 * The pin layers are not all created at the same moment: the marker layer waits on
 * `loadImage`, and a rebuilt map recreates all three. `showPhotoPins` is a plain ref that
 * outlives the map, and its watcher fires only on a *change* and only touches layers that
 * already exist — so whether a newly created layer respects the toggle depends on the
 * layer spec, not the watcher. These tests hold the image load open to make that window
 * real, which a synchronously-resolving stub would hide.
 */
describe('AlbumTrackMap photo pins respect the toggle as they are created', () => {
  const PIN_POINT_LAYER = 'photo-pin-unclustered';

  const pinnedPhoto = (name: string, latitude: number, longitude: number) => ({
    url: `https://cdn.example.com/demo-album/${name}`,
    key: `demo-album/${name}`,
    latitude,
    longitude,
    hasGps: true,
  });

  /** The `layout.visibility` the named layer was created with. */
  const visibilityOf = (layerId: string) =>
    (mapCalls.addLayer.find((layer) => layer['id'] === layerId)?.['layout'] as
      | Record<string, unknown>
      | undefined)?.['visibility'];

  afterEach(() => {
    mounted.splice(0).forEach((wrapper) => wrapper.unmount());
  });

  beforeEach(() => {
    resetMapState();
  });

  it('creates every pin layer visible while the toggle is on', async () => {
    storeState.photosInAlbum.value = [pinnedPhoto('one.jpg', -36.85, 174.76)];

    await mountMap();

    expect(visibilityOf('photo-pin-clusters')).toBe('visible');
    expect(visibilityOf('photo-pin-cluster-count')).toBe('visible');
    expect(visibilityOf(PIN_POINT_LAYER)).toBe('visible');
  });

  // The bug this guards: the marker layer is added in an async callback, so a viewer can
  // switch pins off while the image is still loading. The watcher has already run by then
  // and only touched the two layers that existed, so the marker layer arrives afterwards
  // and renders pins under a legend row that says they are hidden.
  it('creates the marker layer hidden when pins were switched off while it loaded', async () => {
    mapCalls.deferImage = true;
    storeState.photosInAlbum.value = [pinnedPhoto('one.jpg', -36.85, 174.76)];
    const wrapper = await mountMap();

    expect(mapCalls.addLayer.find((layer) => layer['id'] === PIN_POINT_LAYER)).toBeUndefined();

    await wrapper.find('[data-test-id="photo-pins-legend-item"]').trigger('click');
    await nextTick();

    // The marker image now finishes loading, after the toggle was already switched off.
    mapCalls.resolveImage?.();

    expect(visibilityOf(PIN_POINT_LAYER)).toBe('none');
  });

  // `showPhotoPins` is created once at setup and survives `destroyMap`, so a map rebuilt
  // after the viewer switched pins off must not bring them back.
  it('creates pin layers hidden on a map rebuilt while pins are off', async () => {
    storeState.photosInAlbum.value = [pinnedPhoto('one.jpg', -36.85, 174.76)];
    const wrapper = await mountMap();

    await wrapper.find('[data-test-id="photo-pins-legend-item"]').trigger('click');
    await nextTick();

    // Drop everything drawable, which tears the map container down, then bring it back.
    storeState.photosInAlbum.value = [];
    await nextTick();
    mapCalls.addLayer = [];
    existingLayers.clear();
    existingSources.clear();
    storeState.photosInAlbum.value = [pinnedPhoto('one.jpg', -36.85, 174.76)];
    await nextTick();
    await nextTick();

    expect(visibilityOf('photo-pin-clusters')).toBe('none');
    expect(visibilityOf(PIN_POINT_LAYER)).toBe('none');
  });

  // `isStyleLoaded()` is false whenever any source cache or style fragment is settling,
  // which the track sources added moments earlier routinely cause. Gating on it dropped
  // the pin update with nothing to retry it, leaving the album with no pins until reload.
  it('draws pins that arrive after the map has loaded but while the style is settling', async () => {
    storeState.hasTracks.value = true;
    storeState.renderableTracks.value = [renderable('day-1')];
    await mountMap();

    // Photos resolve a moment after the map, which is the ordering that used to lose them.
    storeState.photosInAlbum.value = [pinnedPhoto('late.jpg', -36.85, 174.76)];
    await nextTick();

    expect(mapCalls.addSource.some((entry) => entry.id === 'photo-pins')).toBe(true);
  });
});

/**
 * An album whose only mappable thing is its own location.
 *
 * The toolbar popover that used to show this was removed, so the map panel is now the only
 * place the album's location appears. That means the panel has to render for a place
 * alone — and say why it is otherwise bare, rather than replacing the map with a message
 * and hiding the very pin the viewer came for.
 */
describe('AlbumTrackMap with only an album location', () => {
  const PLACE = {
    displayName: 'Ubud',
    formattedAddress: 'Ubud, Bali, Indonesia',
    location: { latitude: -8.5069, longitude: 115.2625 },
  };

  const withPlace = () => {
    storeState.currentAlbum.value = { id: 'demo-album', year: '2026', place: PLACE };
  };

  afterEach(() => {
    mounted.splice(0).forEach((wrapper) => wrapper.unmount());
  });

  beforeEach(() => {
    resetMapState();
  });

  it('renders the map for an album with a location but no tracks and no pins', async () => {
    withPlace();

    const wrapper = await mountMap();

    expect(wrapper.find('[data-test-id="track-map"]').exists()).toBe(true);
    expect(wrapper.find('[data-test-id="track-map-empty"]').exists()).toBe(false);
  });

  it('drops the album location marker on that map', async () => {
    withPlace();

    await mountMap();

    expect(mapCalls.markers).toContainEqual([115.2625, -8.5069]);
  });

  // Above the map, not instead of it - replacing the map would hide the pin.
  it('explains the bare map above it rather than in place of it', async () => {
    withPlace();

    const wrapper = await mountMap();
    const notice = wrapper.find('[data-test-id="track-map-place-only"]');

    expect(notice.exists()).toBe(true);
    expect(notice.text()).toContain("the pin is the album's own location");
    expect(wrapper.find('[data-test-id="track-map"]').exists()).toBe(true);
  });

  it('drops the notice once the album has a track to draw', async () => {
    withPlace();
    storeState.hasTracks.value = true;
    storeState.renderableTracks.value = [renderable('day-1')];

    const wrapper = await mountMap();

    expect(wrapper.find('[data-test-id="track-map-place-only"]').exists()).toBe(false);
  });

  it('drops the notice once a photo has coordinates', async () => {
    withPlace();
    storeState.photosInAlbum.value = [
      {
        url: 'https://cdn.example.com/demo-album/one.jpg',
        key: 'demo-album/one.jpg',
        latitude: -8.5,
        longitude: 115.26,
        hasGps: true,
      },
    ];

    const wrapper = await mountMap();

    expect(wrapper.find('[data-test-id="track-map-place-only"]').exists()).toBe(false);
  });

  // No track, no located photo, and no album location: there is genuinely nothing to put
  // on a map, so the panel stays empty rather than showing a world view of nothing.
  it('shows the empty state and no map when the album has no location either', async () => {
    const wrapper = await mountMap();

    expect(wrapper.find('[data-test-id="track-map-empty"]').exists()).toBe(true);
    expect(wrapper.find('[data-test-id="track-map"]').exists()).toBe(false);
    expect(wrapper.find('[data-test-id="track-map-place-only"]').exists()).toBe(false);
  });

  it('tells a visitor nothing about controls they cannot see', async () => {
    const wrapper = await mountMap();

    expect(wrapper.find('[data-test-id="track-map-empty"]').text()).not.toMatch(/Edit album/i);
  });
});
