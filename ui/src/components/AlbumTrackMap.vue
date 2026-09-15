<template>
  <div class="flex h-full w-full flex-col gap-3 lg:flex-row">
    <!--
      Ordered so the map container is created exactly once, when there is something to
      draw. Leading with the empty state meant that during the manifest fetch - when
      `hasTracks` is false but `isFetchingTracks` is true - the map branch rendered, built
      a Mapbox instance, and then had its container torn down the moment the fetch came
      back empty.
    -->
    <div
      v-if="isFetchingTracks && !hasTracks"
      class="h-64 w-full"
      data-test-id="track-map-loading"
    ></div>

    <!-- Empty only when there is nothing at all to draw. An album with geotagged photos
         but no tracks still has a map worth showing, so the guard is not `!hasTracks`. -->
    <div
      v-else-if="!hasTracks && !hasPinnedPhotos"
      class="text-surface-500 dark:text-surface-400 flex h-64 w-full items-center justify-center rounded-md border border-dashed border-surface-300 dark:border-surface-700 p-6 text-center"
      data-test-id="track-map-empty"
    >
      <p>
        Nothing to map for this album yet — no GPS tracks, and no photos with a location.<br />
        <!-- Only an admin can act on this, and telling a visitor to use a control they
             cannot see is worse than saying nothing. -->
        <span v-if="isAdmin" class="text-sm">
          Add a track from Edit album &rsaquo; GPS tracks, or use Scan photo locations.
        </span>
      </p>
    </div>

    <template v-else>
      <!-- A named `<section>` is a region landmark, so a screen reader can jump to the map
           and announce it. Previously a `div` with `role="group"`, which is weaker (group
           is not a landmark) and is the ARIA role semantic HTML already covers. -->
      <section
        :id="mapId"
        ref="mapContainer"
        aria-label="Album GPS track map"
        class="h-[60vh] w-full grow rounded-md lg:h-[70vh]"
        data-test-id="track-map"
      ></section>

      <ul
        v-if="legend.length || hasPinnedPhotos"
        class="dark:bg-surface-800/50 border-surface-200 dark:border-surface-800 flex w-full shrink-0 flex-col gap-1 rounded-md border bg-gray-50/50 p-2 lg:w-64"
        data-test-id="track-legend"
      >
        <!-- Same row shape as a track, so the two read as one list of things you can turn
             on and off rather than a track list with an unrelated checkbox bolted on. -->
        <li v-if="hasPinnedPhotos">
          <button
            :aria-pressed="showPhotoPins"
            :class="[
              'flex w-full items-center gap-2 rounded-md p-2 text-left',
              'hover:bg-surface-200/60 dark:hover:bg-surface-700/60',
              { 'opacity-50': !showPhotoPins },
            ]"
            data-test-id="photo-pins-legend-item"
            type="button"
            @click="showPhotoPins = !showPhotoPins"
          >
            <IconMapPin :size="12" aria-hidden="true" class="shrink-0 text-[#637A90]" />
            <span class="min-w-0 grow">
              <span class="text-surface-900 dark:text-surface-300 block truncate">Photos</span>
              <small class="text-surface-400">
                {{ pinnedPhotos.length }} with a location
              </small>
            </span>
          </button>
        </li>
        <li v-for="item in legend" :key="item.trackId">
          <button
            :aria-pressed="item.visible"
            :class="[
              'flex w-full items-center gap-2 rounded-md p-2 text-left',
              'hover:bg-surface-200/60 dark:hover:bg-surface-700/60',
              { 'opacity-50': !item.visible },
            ]"
            data-test-id="track-legend-item"
            type="button"
            @click="toggleTrack(item.trackId)"
          >
            <!-- aria-hidden: the swatch repeats the colour, which carries no meaning a
                 screen reader can use. Visibility is conveyed by aria-pressed instead. -->
            <span
              :style="{ backgroundColor: item.colour }"
              aria-hidden="true"
              class="h-3 w-3 shrink-0 rounded-full"
            ></span>
            <span class="min-w-0 grow">
              <span class="text-surface-900 dark:text-surface-300 block truncate">
                {{ item.label }}
              </span>
              <small v-if="item.isError" class="text-red-600">Could not load this track</small>
              <small v-else-if="item.isLoading" class="text-surface-400">Loading…</small>
              <small v-else-if="item.distanceKm !== undefined" class="text-surface-400">
                {{ item.distanceKm.toFixed(1) }} km
              </small>
            </span>
          </button>
        </li>
      </ul>
    </template>
  </div>
</template>

<script lang="ts" setup>
import type { Photo } from '@/schema';
import type { RenderableTrack } from '@/stores/gps-track';
import { useAlbumStore, useGpsTrackStore, usePhotoStore, useUserConfigStore } from '@/stores';
import { photoFileName, thumbnailUrl } from '@/utils/photo-url';
import { IconMapPin } from '@tabler/icons-vue';
import type { FeatureCollection, Point } from 'geojson';
import { storeToRefs } from 'pinia';
import mapboxgl, { type GeoJSONSource, type LngLatBoundsLike, type Map } from 'mapbox-gl';
import { computed, onUnmounted, ref, useId, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';

const gpsTrackStore = useGpsTrackStore();
const { legend, renderableTracks, hasTracks, isFetchingTracks } = storeToRefs(gpsTrackStore);
const { toggleTrack } = gpsTrackStore;
const { currentAlbum } = storeToRefs(useAlbumStore());
const { photosInAlbum } = storeToRefs(usePhotoStore());
const { isAdmin } = storeToRefs(useUserConfigStore());
const router = useRouter();
const route = useRoute();

/**
 * Ids for the photo-pin source and its three layers.
 *
 * `PIN_ANCHOR_LAYER` is the lowest of the three, so anchoring the track lines before it
 * puts them beneath every part of the pin rendering rather than just the topmost part.
 */
const PIN_SOURCE = 'photo-pins';
const PIN_CLUSTER_LAYER = 'photo-pin-clusters';
const PIN_CLUSTER_COUNT_LAYER = 'photo-pin-cluster-count';
const PIN_POINT_LAYER = 'photo-pin-unclustered';
const PIN_ANCHOR_LAYER = PIN_CLUSTER_LAYER;

/** Viewer toggle for the pin layer, alongside the per-track toggles. */
const showPhotoPins = ref(true);

/**
 * The current toggle state as Mapbox's `visibility` value.
 *
 * Stamped onto every pin layer as it is created, as well as applied by the watcher. The
 * watcher alone is not enough: it fires only on a change and only touches layers that
 * already exist, so a layer created *after* the viewer switched pins off — the
 * asynchronously-added marker layer, or any layer on a rebuilt map, since the toggle
 * survives `destroyMap` — would otherwise come up visible.
 */
const pinVisibility = (): 'visible' | 'none' => (showPhotoPins.value ? 'visible' : 'none');

/**
 * Photos that can actually be placed.
 *
 * Both coordinates are required — the API only ever sends the pair together, and a photo
 * with one would otherwise be drawn at a longitude of 0.
 */
const pinnedPhotos = computed(() =>
  photosInAlbum.value.filter(
    (photo): photo is Photo & { latitude: number; longitude: number } =>
      typeof photo.latitude === 'number' && typeof photo.longitude === 'number',
  ),
);

const hasPinnedPhotos = computed(() => pinnedPhotos.value.length > 0);

/**
 * The pin layer's data.
 *
 * `photoKey` rides along in the feature properties because a Mapbox click event hands
 * back the feature, not the photo — that is what lets a click resolve to a `?photo=` id.
 */
const photoGeoJson = computed<FeatureCollection<Point>>(() => ({
  type: 'FeatureCollection',
  features: pinnedPhotos.value.map((photo) => ({
    type: 'Feature',
    geometry: { type: 'Point', coordinates: [photo.longitude, photo.latitude] },
    properties: {
      photoKey: photoFileName(photo.key),
      thumbnail: thumbnailUrl(photo.url),
    },
  })),
}));

/**
 * Unique per instance. `PhotoLocationMap` already takes this precaution because the
 * album popover and the lightbox map can be mounted together; the same applies here.
 */
const mapId = useId();
const mapContainer = ref<HTMLElement | null>(null);

let map: Map | undefined;
/**
 * Whether the map has fired `load` and can accept sources and layers.
 *
 * Deliberately not `map.isStyleLoaded()`. That returns false whenever *any* source cache,
 * style fragment or pending image is still settling, which the Standard style and the
 * track sources added moments earlier both cause — so a pin update arriving in that window
 * would be skipped, and nothing would retry it. `addSource` and `addLayer` are legal any
 * time after `load`, which is the only thing actually being asked here.
 */
let isMapReady = false;
/** Source/layer ids currently on the map, so removals can be exact. */
let renderedTrackIds: string[] = [];
/** Bounds are fitted once, after the first tracks arrive, so the map never jumps. */
let hasFittedBounds = false;

const sourceId = (trackId: string) => `track-${trackId}`;
const layerId = (trackId: string) => `track-line-${trackId}`;

const place = computed(() => currentAlbum.value.place);

/**
 * Bounds covering every track line **and** every photo pin.
 *
 * Both, not either: an album whose photos sit outside its track would otherwise open with
 * half its pins off-screen. It also means an album with pins and no tracks still gets a
 * sensible viewport instead of falling back to the world view.
 */
const boundsOf = (tracks: RenderableTrack[]): LngLatBoundsLike | null => {
  let west = Infinity;
  let south = Infinity;
  let east = -Infinity;
  let north = -Infinity;

  const include = (longitude: number, latitude: number) => {
    west = Math.min(west, longitude);
    east = Math.max(east, longitude);
    south = Math.min(south, latitude);
    north = Math.max(north, latitude);
  };

  for (const { feature } of tracks) {
    // A track whose geometry did not come back in the expected shape is skipped rather
    // than allowed to throw. This runs inside a watcher, so an exception here escapes as
    // an unhandled component error and leaves the map half-built — one bad track would
    // cost the viewer every other track *and* every photo pin.
    const geometry = feature?.geometry;
    if (!geometry) continue;

    const lines =
      geometry.type === 'LineString' ? [geometry.coordinates] : geometry.coordinates;

    for (const line of lines) {
      for (const position of line) {
        const [longitude, latitude] = position;
        include(longitude, latitude);
      }
    }
  }

  for (const photo of pinnedPhotos.value) {
    include(photo.longitude, photo.latitude);
  }

  if (!Number.isFinite(west) || !Number.isFinite(south)) return null;
  return [
    [west, south],
    [east, north],
  ];
};

/**
 * Frame everything the album has to show, once.
 *
 * Called from both sync functions because either can be the one that brings the first
 * thing worth framing: an album may have pins and no tracks, tracks and no pins, or the
 * two may arrive in either order. `hasFittedBounds` keeps it to a single fit, so the map
 * never jumps under a viewer who has already panned.
 */
const fitBoundsOnce = (mapInstance: Map) => {
  const tracks = renderableTracks.value;
  if (hasFittedBounds || (tracks.length === 0 && !hasPinnedPhotos.value)) return;

  const bounds = boundsOf(tracks);
  if (bounds) {
    mapInstance.fitBounds(bounds, { padding: 48, duration: 0, maxZoom: 15 });
    hasFittedBounds = true;
  }
};

/**
 * One source and one layer per track, reconciled against `renderableTracks`.
 *
 * A track the viewer has toggled off leaves that set, so its layer and source are removed
 * here and rebuilt when it comes back. That is simpler than a data-driven filter over a
 * merged collection, and it means a track that has not loaded yet simply has no layer
 * rather than an empty entry in a shared source. Rebuilding costs nothing worth avoiding:
 * the geometry is already in the query cache, so no request is made.
 *
 * **Ordering: track lines are anchored beneath the photo pins.** Every `addLayer` here
 * passes `beforeId: PIN_ANCHOR_LAYER` once that layer exists, which is what keeps pins
 * drawn above the lines. Adding the pins last is *not* sufficient on its own: a track
 * toggled off and back on is removed and re-added here, and a re-add with no `beforeId`
 * would land on top of the base style - and so on top of the pins that were already
 * there. The anchor is conditional because tracks can render before the pin layer exists;
 * pins wait on the photo list, and Mapbox refuses an `addLayer` naming a `beforeId` that
 * is not on the map yet.
 */
const syncTrackLayers = (mapInstance: Map) => {
  const wanted = renderableTracks.value;
  const wantedIds = wanted.map((track) => track.trackId);
  const anchor = mapInstance.getLayer(PIN_ANCHOR_LAYER) ? PIN_ANCHOR_LAYER : undefined;

  for (const trackId of renderedTrackIds) {
    if (!wantedIds.includes(trackId)) removeTrack(mapInstance, trackId);
  }
  for (const track of wanted) {
    drawTrack(mapInstance, track, anchor);
  }

  renderedTrackIds = wantedIds;
  fitBoundsOnce(mapInstance);
};

/** Drop one track's layer and source, tolerating either already being gone. */
const removeTrack = (mapInstance: Map, trackId: string) => {
  if (mapInstance.getLayer(layerId(trackId))) mapInstance.removeLayer(layerId(trackId));
  if (mapInstance.getSource(sourceId(trackId))) mapInstance.removeSource(sourceId(trackId));
};

/**
 * Draw one track, or update the line already drawn for it.
 *
 * @param mapInstance The live Mapbox map.
 * @param track The track to draw, from `renderableTracks`.
 * @param anchor Layer to insert beneath, or `undefined` when the pins are not up yet.
 */
const drawTrack = (mapInstance: Map, track: RenderableTrack, anchor: string | undefined) => {
  const { trackId, colour, feature } = track;

  // Same reasoning as `boundsOf`: a track missing its id, colour or geometry would make
  // Mapbox throw out of a watcher and abandon the rest of the sync, taking the other
  // tracks and the photo pins with it. Skipping it costs that one line only.
  if (!trackId || !colour || !feature?.geometry) return;

  const existing = mapInstance.getSource(sourceId(trackId)) as GeoJSONSource | undefined;

  if (existing) {
    existing.setData(feature);
    // Colours are assigned by position in the album's sorted track ids, so deleting a
    // track shifts every later track's colour. `line-color` is only read when the layer is
    // created, so without this the legend swatch and the line would disagree - the exact
    // thing the manifest's server-assigned colour exists to prevent.
    mapInstance.setPaintProperty(layerId(trackId), 'line-color', colour);
    return;
  }

  mapInstance.addSource(sourceId(trackId), { type: 'geojson', data: feature });
  mapInstance.addLayer(
    {
      id: layerId(trackId),
      type: 'line',
      source: sourceId(trackId),
      layout: { 'line-join': 'round', 'line-cap': 'round' },
      paint: {
        'line-color': colour,
        'line-width': ['interpolate', ['linear'], ['zoom'], 6, 2, 12, 3.5, 16, 5],
        'line-opacity': 0.85,
      },
    },
    anchor,
  );
};

/**
 * The clustered photo-pin layer, reconciled against `pinnedPhotos`.
 *
 * Same three-layer cluster arrangement `AlbumMap.vue` uses: circles for clusters, a count
 * label on top of them, and a marker icon for single photos. A pin is the shared
 * `/marker-icon.png`, not the photo itself — a Mapbox `symbol` layer can only draw images
 * registered up front with `addImage`, so per-photo icons would mean loading and
 * registering up to a thousand of them. The thumbnail appears in the hover popup instead.
 *
 * Added with no `beforeId`, so it sits on top of whatever is already on the map;
 * `syncTrackLayers` then anchors the lines beneath it.
 */
const syncPhotoPins = (mapInstance: Map) => {
  const existing = mapInstance.getSource(PIN_SOURCE) as GeoJSONSource | undefined;

  if (existing) {
    existing.setData(photoGeoJson.value);
    fitBoundsOnce(mapInstance);
    return;
  }

  if (!hasPinnedPhotos.value) return;

  mapInstance.addSource(PIN_SOURCE, {
    type: 'geojson',
    data: photoGeoJson.value,
    cluster: true,
    clusterMaxZoom: 14,
    clusterRadius: 50,
  });

  mapInstance.addLayer({
    id: PIN_CLUSTER_LAYER,
    type: 'circle',
    source: PIN_SOURCE,
    filter: ['has', 'point_count'],
    layout: { visibility: pinVisibility() },
    paint: { 'circle-color': '#637A90', 'circle-radius': 20 },
  });

  mapInstance.addLayer({
    id: PIN_CLUSTER_COUNT_LAYER,
    type: 'symbol',
    source: PIN_SOURCE,
    filter: ['has', 'point_count'],
    layout: {
      visibility: pinVisibility(),
      'text-field': ['get', 'point_count_abbreviated'],
      'text-font': ['DIN Offc Pro Medium', 'Arial Unicode MS Bold'],
      'text-size': 12,
    },
    paint: { 'text-color': 'white' },
  });

  mapInstance.loadImage('/marker-icon.png', (error, image) => {
    if (error || !image) {
      console.error('Error loading marker image:', error);
      return;
    }
    if (!mapInstance.hasImage('photo-pin-marker')) {
      mapInstance.addImage('photo-pin-marker', image);
    }
    if (!mapInstance.getLayer(PIN_POINT_LAYER)) {
      mapInstance.addLayer({
        id: PIN_POINT_LAYER,
        type: 'symbol',
        source: PIN_SOURCE,
        filter: ['!', ['has', 'point_count']],
        layout: {
          // Read here, not captured above: this callback is asynchronous, so the viewer
          // may have switched the pins off while the marker image was loading. Without
          // this the individual pins would come up visible under a legend row that says
          // they are hidden.
          visibility: pinVisibility(),
          'icon-image': 'photo-pin-marker',
          'icon-size': 0.25,
          'icon-allow-overlap': true,
        },
      });
    }
  });

  // The lines were added before the pins existed, so nothing anchored them. Re-running the
  // sync now that the anchor is on the map is what actually puts them underneath.
  restackTrackLayers(mapInstance);
  bindPinInteractions(mapInstance);
  fitBoundsOnce(mapInstance);
};

/**
 * Move every existing track line beneath the pin anchor.
 *
 * `moveLayer(id, beforeId)` rather than a remove-and-re-add: the sources and their data
 * stay exactly as they are, so this costs nothing and cannot drop a track.
 */
const restackTrackLayers = (mapInstance: Map) => {
  if (!mapInstance.getLayer(PIN_ANCHOR_LAYER)) return;

  for (const trackId of renderedTrackIds) {
    if (mapInstance.getLayer(layerId(trackId))) {
      mapInstance.moveLayer(layerId(trackId), PIN_ANCHOR_LAYER);
    }
  }
};

/**
 * Click and hover behaviour for the pins.
 *
 * **Touch opens the photo, it does not show a popup.** `AlbumMap.vue` wires `touchstart`
 * to a popup because its popup carries the only link to the album. Here the tap target is
 * the photo itself and the lightbox is one tap away, so a popup on touch would mean one
 * tap doing two things at once.
 */
const bindPinInteractions = (mapInstance: Map) => {
  const popup = new mapboxgl.Popup({ closeButton: false, offset: 12 });

  mapInstance.on('click', PIN_CLUSTER_LAYER, (event) => {
    const feature = event.features?.[0];
    const clusterId = feature?.properties?.['cluster_id'];
    const source = mapInstance.getSource(PIN_SOURCE) as GeoJSONSource | undefined;
    if (!source || clusterId === undefined) return;

    source.getClusterExpansionZoom(clusterId, (error, zoom) => {
      if (error || zoom === null || zoom === undefined) return;
      mapInstance.easeTo({
        center: (feature?.geometry as Point).coordinates as [number, number],
        zoom,
      });
    });
  });

  mapInstance.on('click', PIN_POINT_LAYER, (event) => {
    const photoKey = event.features?.[0]?.properties?.['photoKey'];
    if (typeof photoKey !== 'string') return;
    // The same `?photo=` param the grid uses, so the lightbox opens over the map and
    // closing it returns here rather than to the grid.
    void router.replace({ query: { ...route.query, photo: photoKey } });
  });

  mapInstance.on('mouseenter', PIN_POINT_LAYER, (event) => {
    const feature = event.features?.[0];
    if (!feature) return;

    mapInstance.getCanvas().style.cursor = 'pointer';

    const coordinates = (feature.geometry as Point).coordinates.slice() as [number, number];
    // Keep the popup on the copy of the world the cursor is over, rather than jumping
    // across the antimeridian.
    while (Math.abs(event.lngLat.lng - coordinates[0]) > 180) {
      coordinates[0] += event.lngLat.lng > coordinates[0] ? 360 : -360;
    }

    const thumbnail = feature.properties?.['thumbnail'];
    const photoKey = feature.properties?.['photoKey'];
    if (typeof thumbnail !== 'string' || typeof photoKey !== 'string') return;

    // `textContent` on a detached element, so a filename containing markup cannot become
    // markup here.
    const container = document.createElement('div');
    const image = document.createElement('img');
    image.src = thumbnail;
    image.alt = photoKey;
    image.className = 'w-[200px] rounded';
    const caption = document.createElement('div');
    caption.textContent = photoKey;
    caption.className = 'mt-1 max-w-[200px] truncate text-xs';
    container.append(image, caption);

    popup.setLngLat(coordinates).setDOMContent(container).addTo(mapInstance);
  });

  mapInstance.on('mouseleave', PIN_POINT_LAYER, () => {
    mapInstance.getCanvas().style.cursor = '';
    popup.remove();
  });

  for (const event of ['mouseenter', 'mouseleave'] as const) {
    mapInstance.on(event, PIN_CLUSTER_LAYER, () => {
      mapInstance.getCanvas().style.cursor = event === 'mouseenter' ? 'pointer' : '';
    });
  }
};

const initialiseMap = () => {
  if (map || !mapContainer.value) return;

  const accessToken = import.meta.env.VITE_MAPBOX_API_KEY;
  if (!accessToken) {
    console.error('Mapbox API key is not set');
    return;
  }
  mapboxgl.accessToken = accessToken;

  const centre = place.value
    ? ([place.value.location.longitude, place.value.location.latitude] as [number, number])
    : ([
        Number(import.meta.env.VITE_MAP_CENTRE_LNG ?? 174.7633),
        Number(import.meta.env.VITE_MAP_CENTRE_LAT ?? -36.8484),
      ] as [number, number]);

  const mapInstance = new mapboxgl.Map({
    container: mapContainer.value,
    style: 'mapbox://styles/mapbox/standard',
    center: centre,
    zoom: place.value ? 9 : 4,
  });
  map = mapInstance;

  mapInstance.on('idle', () => mapInstance.resize());

  mapInstance.on('load', () => {
    isMapReady = true;
    if (place.value) {
      new mapboxgl.Marker()
        .setLngLat([place.value.location.longitude, place.value.location.latitude])
        .addTo(mapInstance);
    }
    syncTrackLayers(mapInstance);
    // Pins after the lines, so the first `addLayer` for the anchor lands on top of them.
    syncPhotoPins(mapInstance);
  });
};

/**
 * Dispose the map and forget everything derived from it.
 *
 * `renderedTrackIds` and `hasFittedBounds` describe the state of a specific Mapbox
 * instance, so carrying them past its disposal would make the next one skip layers it has
 * not actually added.
 */
const destroyMap = () => {
  map?.remove();
  map = undefined;
  isMapReady = false;
  renderedTrackIds = [];
  hasFittedBounds = false;
};

/**
 * The container comes and goes with the `v-if` above, so the map is bound to its
 * appearance rather than to `onMounted`.
 *
 * **The `else` matters.** A Mapbox instance is tied to the DOM node it was constructed
 * with; once that node is gone the instance is inert, and `initialiseMap`'s `if (map)`
 * guard would then decline to build one for the *new* container. Layer calls kept
 * succeeding against the dead instance while the visible map stayed blank until a page
 * reload - which is exactly how this was reported.
 */
watch(mapContainer, (container) => {
  if (container) {
    initialiseMap();
  } else {
    destroyMap();
  }
});

// No `deep`: `renderableTracks` is a computed `flatMap`, so every recomputation is a new
// array and the identity check already fires. Deep traversal would walk up to 20 x 5000
// nested coordinate pairs per trigger to detect a mutation TanStack Query never makes -
// it replaces cached features rather than editing them in place.
watch(renderableTracks, () => {
  if (map && isMapReady) syncTrackLayers(map);
});

// New coordinates arrive whenever the photo list is refetched - which is what puts pins on
// the map straight after an upload or a scan, with no page reload.
watch(pinnedPhotos, () => {
  if (map && isMapReady) syncPhotoPins(map);
});

/**
 * Visibility rather than removing the layers, so toggling back costs no rebuild.
 *
 * This only covers layers that already exist and only fires on a *change*, which is why
 * `pinVisibility()` also stamps the current state onto every layer as it is created.
 */
watch(showPhotoPins, () => {
  if (!map || !isMapReady) return;
  for (const id of [PIN_CLUSTER_LAYER, PIN_CLUSTER_COUNT_LAYER, PIN_POINT_LAYER]) {
    if (map.getLayer(id)) {
      map.setLayoutProperty(id, 'visibility', pinVisibility());
    }
  }
});

// A different album means different tracks; refit rather than keeping the old viewport.
watch(
  () => currentAlbum.value.id,
  () => {
    hasFittedBounds = false;
  },
);

onUnmounted(destroyMap);
</script>
