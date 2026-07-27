<template>
  <div :id="mapId" ref="mapContainer" :style="`width: ${width}; height: ${height};`" class="rounded-md"></div>
</template>

<script lang="ts" setup>
import mapboxgl from 'mapbox-gl';
import { onMounted, onUnmounted, ref, toRefs, useId } from 'vue';

const props = defineProps({
  latitude: {
    type: Number,
    default: () => 0,
  },
  longitude: {
    type: Number,
    default: () => 0,
  },
  width: {
    type: String,
    default: () => '100%',
  },
  height: {
    type: String,
    default: () => '300px',
  },
});

const { latitude, longitude, width, height } = toRefs(props);

/**
 * A unique id per instance. The album Popover map and the lightbox photo map can
 * be mounted at the same time, so a shared literal id would make Mapbox bind to
 * the wrong element.
 */
const mapId = useId();
const mapContainer = ref<HTMLDivElement | null>(null);

let map: mapboxgl.Map | undefined;

onMounted(() => {
  mapboxgl.accessToken = import.meta.env.VITE_MAPBOX_API_KEY as string;

  if (!mapContainer.value) {
    return;
  }

  map = new mapboxgl.Map({
    container: mapContainer.value,
    style: 'mapbox://styles/mapbox/standard',
    center: [longitude.value, latitude.value],
    zoom: 11,
  });

  new mapboxgl.Marker().setLngLat([longitude.value, latitude.value]).addTo(map);

  map.on('idle', () => {
    map?.resize();
  });
});

onUnmounted(() => {
  map?.remove();
  map = undefined;
});
</script>
