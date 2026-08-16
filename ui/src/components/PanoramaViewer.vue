<template>
  <div ref="panoramaRef" class="rounded-md" style="width: 100%; height: 100%"></div>
</template>
<script lang="ts" setup>
import { computed, onBeforeUnmount, onMounted, ref, toRefs, watch } from 'vue';

interface PannellumViewer {
  destroy(): void;
  /**
   * Re-reads the container's size into the WebGL canvas. Pannellum's renderer
   * only samples `clientWidth`/`clientHeight` here - `render()` reuses the
   * drawing-buffer size from the previous `resize()` - and Pannellum binds this
   * to `window.resize` alone, so a container that changes size on its own never
   * triggers it. See `observeContainerResize` below.
   */
  resize(): void;
  [key: string]: unknown;
}

interface PannellumConfig {
  type: string;
  panorama: string;
  autoLoad?: boolean;
  autoRotate?: number;
  compass?: boolean;
  showFullscreenCtrl?: boolean;
  showZoomCtrl?: boolean;
}

interface Pannellum {
  viewer(container: string | HTMLElement, config: PannellumConfig): PannellumViewer;
}

declare global {
  interface Window {
    pannellum: Pannellum;
  }
  const pannellum: Pannellum;
}

const props = defineProps({
  imageUrl: {
    type: String,
    required: true,
  },
});

const { imageUrl } = toRefs(props);

/**
 * A template ref, not the `id="panorama"` + `document.getElementById` this used
 * to rely on. That only ever resolved to this component's own element because
 * exactly one instance is mounted at a time - and `observeContainerResize` below
 * attaches once and never re-attaches, so binding it to a foreign or
 * soon-to-be-removed `#panorama` would silently kill the resize fix for the rest
 * of this component's life, with no error.
 *
 * Nothing targets `#panorama` in CSS (checked here and in pannellum.css), and
 * `pannellum.viewer` resolves a string through `getElementById` but takes an
 * element directly, so the id bought nothing.
 */
const panoramaRef = ref<HTMLDivElement | null>(null);
const viewer = ref<PannellumViewer | null>(null);
const panoramaOptions = computed(() => ({
  type: 'equirectangular',
  panorama: imageUrl.value || '',
  autoLoad: true,
  autoRotate: -2,
  compass: true,
  showFullscreenCtrl: true,
  showZoomCtrl: true,
}));

/**
 * Keeps the WebGL canvas in step with the container, which resizes without the
 * window ever doing so: in `PhotoDetail`, opening the info sheet below `lg`
 * halves the stage's height, and at `lg+` the `lg:mr-90` drawer offset
 * narrows it. Pannellum only listens for `window.resize`, so neither reaches it
 * and the panorama would keep rendering at its old size until the next real
 * window resize.
 *
 * `ResizeObserver` is available in every browser this project targets; the guard
 * is for jsdom, which does not implement it and would otherwise throw here on
 * every test that mounts this component.
 */
let resizeObserver: ResizeObserver | null = null;

const observeContainerResize = (element: HTMLElement) => {
  if (typeof ResizeObserver === 'undefined') {
    return;
  }
  resizeObserver = new ResizeObserver(() => {
    // The viewer is rebuilt on every `imageUrl` change, so read the current one
    // rather than closing over whichever instance existed when this was set up.
    //
    // Guarded for the same reason the `pannellum.viewer(...)` call is: `observe()`
    // delivers one callback immediately, before any actual size change, so this
    // lands on a viewer constructed microseconds earlier whose equirectangular
    // image is still downloading (`autoLoad: true`). Pannellum is a CDN script
    // this project does not control, and an uncaught throw inside a
    // ResizeObserver callback would repeat on every subsequent resize.
    try {
      viewer.value?.resize();
    } catch (error) {
      console.error('Failed to resize panorama viewer:', error);
    }
  });
  resizeObserver.observe(element);
};

onMounted(() => {
  initViewer();
});

onBeforeUnmount(() => {
  resizeObserver?.disconnect();
  resizeObserver = null;

  if (viewer.value) {
    viewer.value.destroy();
    viewer.value = null;
  }
});

const initViewer = () => {
  if (viewer.value) {
    viewer.value.destroy();
    viewer.value = null;
  }

  const panoramaElement = panoramaRef.value;
  if (panoramaElement && imageUrl.value) {
    try {
      viewer.value = window.pannellum.viewer(panoramaElement, {
        ...panoramaOptions.value,
      });
    } catch (error) {
      console.error('Failed to initialize panorama viewer:', error);
    }

    // Attached once and kept across viewer rebuilds - the observed element is
    // this component's own `<div>`, which outlives each `pannellum.viewer(...)`.
    if (!resizeObserver) {
      observeContainerResize(panoramaElement);
    }
  }
};

watch(
  imageUrl,
  () => {
    initViewer();
  },
  { immediate: true },
);
</script>
