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

    <div
      v-else-if="!hasTracks"
      class="text-surface-500 dark:text-surface-400 flex h-64 w-full items-center justify-center rounded-md border border-dashed border-surface-300 dark:border-surface-700 p-6 text-center"
      data-test-id="track-map-empty"
    >
      <p>
        No GPS tracks for this album yet.<br />
        <!-- Only an admin can act on this, and telling a visitor to use a control they
             cannot see is worse than saying nothing. -->
        <span v-if="isAdmin" class="text-sm">Add one from Edit album &rsaquo; GPS tracks.</span>
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
        v-if="legend.length"
        class="dark:bg-surface-800/50 border-surface-200 dark:border-surface-800 flex w-full shrink-0 flex-col gap-1 rounded-md border bg-gray-50/50 p-2 lg:w-64"
        data-test-id="track-legend"
      >
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
import type { RenderableTrack } from '@/stores/gps-track';
import { useAlbumStore, useGpsTrackStore, useUserConfigStore } from '@/stores';
import { storeToRefs } from 'pinia';
import mapboxgl, { type GeoJSONSource, type LngLatBoundsLike, type Map } from 'mapbox-gl';
import { computed, onUnmounted, ref, useId, watch } from 'vue';

const gpsTrackStore = useGpsTrackStore();
const { legend, renderableTracks, hasTracks, isFetchingTracks } = storeToRefs(gpsTrackStore);
const { toggleTrack } = gpsTrackStore;
const { currentAlbum } = storeToRefs(useAlbumStore());
const { isAdmin } = storeToRefs(useUserConfigStore());

/**
 * Unique per instance. `PhotoLocationMap` already takes this precaution because the
 * album popover and the lightbox map can be mounted together; the same applies here.
 */
const mapId = useId();
const mapContainer = ref<HTMLElement | null>(null);

let map: Map | undefined;
/** Source/layer ids currently on the map, so removals can be exact. */
let renderedTrackIds: string[] = [];
/** Bounds are fitted once, after the first tracks arrive, so the map never jumps. */
let hasFittedBounds = false;

const sourceId = (trackId: string) => `track-${trackId}`;
const layerId = (trackId: string) => `track-line-${trackId}`;

const place = computed(() => currentAlbum.value.place);

const boundsOf = (tracks: RenderableTrack[]): LngLatBoundsLike | null => {
  let west = Infinity;
  let south = Infinity;
  let east = -Infinity;
  let north = -Infinity;

  for (const { feature } of tracks) {
    const lines =
      feature.geometry.type === 'LineString'
        ? [feature.geometry.coordinates]
        : feature.geometry.coordinates;

    for (const line of lines) {
      for (const position of line) {
        const [longitude, latitude] = position;
        west = Math.min(west, longitude);
        east = Math.max(east, longitude);
        south = Math.min(south, latitude);
        north = Math.max(north, latitude);
      }
    }
  }

  if (!Number.isFinite(west) || !Number.isFinite(south)) return null;
  return [
    [west, south],
    [east, north],
  ];
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
 * **Ordering contract for the photo-pin layer in the follow-on plan.** Track layers are
 * added with no `beforeId`, so each one goes on top of the base style in manifest order.
 * Pins must therefore be added *after* these to draw above them - unlike `AlbumMap.vue`,
 * which anchors its layers with an explicit `beforeId` because it has its own cluster
 * layers to sit against. There is no such anchor here.
 */
const syncTrackLayers = (mapInstance: Map) => {
  const wanted = renderableTracks.value;
  const wantedIds = wanted.map((track) => track.trackId);

  for (const trackId of renderedTrackIds) {
    if (wantedIds.includes(trackId)) continue;
    if (mapInstance.getLayer(layerId(trackId))) mapInstance.removeLayer(layerId(trackId));
    if (mapInstance.getSource(sourceId(trackId))) mapInstance.removeSource(sourceId(trackId));
  }

  for (const { trackId, colour, feature } of wanted) {
    const existing = mapInstance.getSource(sourceId(trackId)) as GeoJSONSource | undefined;

    if (existing) {
      existing.setData(feature);
      // Colours are assigned by position in the album's sorted track ids, so deleting a
      // track shifts every later track's colour. `line-color` is only read when the layer
      // is created, so without this the legend swatch and the line would disagree - the
      // exact thing the manifest's server-assigned colour exists to prevent.
      mapInstance.setPaintProperty(layerId(trackId), 'line-color', colour);
    } else {
      mapInstance.addSource(sourceId(trackId), { type: 'geojson', data: feature });
      mapInstance.addLayer({
        id: layerId(trackId),
        type: 'line',
        source: sourceId(trackId),
        layout: { 'line-join': 'round', 'line-cap': 'round' },
        paint: {
          'line-color': colour,
          'line-width': ['interpolate', ['linear'], ['zoom'], 6, 2, 12, 3.5, 16, 5],
          'line-opacity': 0.85,
        },
      });
    }
  }

  renderedTrackIds = wantedIds;

  if (!hasFittedBounds && wanted.length > 0) {
    const bounds = boundsOf(wanted);
    if (bounds) {
      mapInstance.fitBounds(bounds, { padding: 48, duration: 0 });
      hasFittedBounds = true;
    }
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
    if (place.value) {
      new mapboxgl.Marker()
        .setLngLat([place.value.location.longitude, place.value.location.latitude])
        .addTo(mapInstance);
    }
    syncTrackLayers(mapInstance);
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
  if (map?.isStyleLoaded()) syncTrackLayers(map);
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
