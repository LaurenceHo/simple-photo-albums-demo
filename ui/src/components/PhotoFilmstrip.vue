<template>
  <div
    v-if="photos.length > 1"
    ref="stripRef"
    :class="[
      'flex w-full shrink-0 items-center gap-2 overflow-x-auto overflow-y-hidden px-2 py-2 select-none',
      isDragging ? 'cursor-grabbing' : 'cursor-grab',
    ]"
    aria-label="Photo thumbnails"
    data-test-id="photo-filmstrip"
    role="group"
    @pointercancel="endDrag"
    @pointerdown="onPointerDown"
    @pointermove="onPointerMove"
    @pointerup="endDrag"
  >
    <button
      v-for="(photo, index) in photos"
      :key="photo.key"
      :ref="(el) => setThumbnailRef(el, index)"
      :aria-current="index === activeIndex ? 'true' : undefined"
      :aria-label="`View ${photoFileName(photo.key)}`"
      :class="[
        'h-16 w-24 shrink-0 overflow-hidden rounded ring-2 ring-offset-2 ring-offset-black transition-opacity sm:h-24 sm:w-36',
        index === activeIndex
          ? 'ring-primary-400'
          : 'ring-transparent opacity-60 hover:opacity-100',
      ]"
      :tabindex="index === activeIndex ? 0 : -1"
      data-test-id="filmstrip-thumbnail"
      type="button"
      @click="onThumbnailClick(index)"
    >
      <img
        :src="filmstripThumbnailUrl(photo.url)"
        alt=""
        class="h-full w-full object-cover"
        decoding="async"
        loading="lazy"
      />
    </button>
  </div>
</template>

<script lang="ts" setup>
import type { Photo } from '@/schema';
import { filmstripThumbnailUrl, photoFileName } from '@/utils/photo-url';
import type { ComponentPublicInstance } from 'vue';
import { onMounted, onUnmounted, ref, watch } from 'vue';

const props = defineProps<{
  /** Every photo in the album, in display order. */
  photos: Photo[];
  /** Index of the currently displayed photo within `photos`. */
  activeIndex: number;
}>();

const emits = defineEmits<{
  /** The user picked thumbnail `index`; navigation is the caller's job. */
  select: [index: number];
}>();

/**
 * Keyed explicitly by index rather than relying on Vue's `ref="x"` array form:
 * that form does not guarantee its array stays in the same order as the
 * source array, which this component depends on to scroll the right
 * thumbnail into view.
 */
const thumbnailRefs = ref<(HTMLButtonElement | null)[]>([]);

const setThumbnailRef = (el: Element | ComponentPublicInstance | null, index: number) => {
  thumbnailRefs.value[index] = el instanceof HTMLButtonElement ? el : null;
};

const scrollThumbnailIntoView = (index: number, behavior: ScrollBehavior) => {
  const target = thumbnailRefs.value[index];
  target?.scrollIntoView({ inline: 'center', block: 'nearest', behavior });
};

// Deep links (`?photo=200` into a 500-photo album) mount this component with a
// non-zero `activeIndex` already - the watch below only fires on *change*, so
// without this the strip would sit at its start with the active thumbnail
// off-screen until the next arrow press. `behavior: 'auto'` regardless of
// reduced-motion: animating a jump on first paint is just noise, not a user
// preference question.
onMounted(() => {
  scrollThumbnailIntoView(props.activeIndex, 'auto');
});

watch(
  () => props.activeIndex,
  (index) => {
    const prefersReducedMotion =
      globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
    scrollThumbnailIntoView(index, prefersReducedMotion ? 'auto' : 'smooth');
  },
);

/*
 * Drag-to-scroll for mouse users. Pointer events (not mouse events) so pen and
 * touch share this one path, but touch never actually needs it: native touch
 * scrolling already works, which is why `pointerdown` never calls
 * `preventDefault` and the strip never sets `touch-action: none`.
 */
const stripRef = ref<HTMLDivElement | null>(null);
const isDragging = ref(false);

/** Non-reactive: read only inside the pointer handlers below, every frame. */
let dragStartX = 0;
let dragStartScrollLeft = 0;
let dragDistance = 0;
let capturedPointerId: number | null = null;

/**
 * Set once per gesture, the moment `dragDistance` crosses the threshold.
 *
 * Deliberately separate from `dragDistance` rather than reading that directly:
 * `endDrag` runs on `pointerup`, which fires *before* `click`, so clearing
 * `dragDistance` there would zero it before the click it exists to suppress
 * could check it.
 *
 * It also cannot be left for `onThumbnailClick` to consume. Crossing the
 * threshold takes pointer capture, which retargets `click` to the strip rather
 * than the thumbnail under the pointer - so after a real drag that handler
 * usually never runs, and an uncleared flag would swallow the next click that
 * does reach a thumbnail (a keyboard Enter/Space, say). Hence `endDrag`'s
 * deferred clear.
 */
let dragExceededThreshold = false;

/** Pending "clear `dragExceededThreshold`" timer scheduled by `endDrag`; see there. */
let dragResetTimer: ReturnType<typeof setTimeout> | null = null;

/** Past this many pixels of movement, the click that follows the drag is swallowed. */
const DRAG_CLICK_THRESHOLD_PX = 5;

const onPointerDown = (event: PointerEvent) => {
  if (!stripRef.value) {
    return;
  }

  isDragging.value = true;
  dragDistance = 0;
  dragExceededThreshold = false;
  // A pending clear from a *previous* gesture's `endDrag` must not land
  // mid-way through this new one - if this drag also crosses the threshold
  // before that timer fires, its callback would zero out this gesture's flag
  // instead of the one it was scheduled for.
  if (dragResetTimer !== null) {
    clearTimeout(dragResetTimer);
    dragResetTimer = null;
  }
  dragStartX = event.clientX;
  dragStartScrollLeft = stripRef.value.scrollLeft;

  // Do NOT take pointer capture here. A plain click is also a
  // pointerdown/pointerup pair, and capturing retargets the compatibility `click`
  // to the capturing element (the strip) instead of the thumbnail under the
  // pointer - which silently breaks every click, so no thumbnail navigates.
  // `onPointerMove` takes it lazily, once movement proves this is a real drag.
  globalThis.addEventListener('pointerup', endDrag);
  globalThis.addEventListener('pointercancel', endDrag);
};

const onPointerMove = (event: PointerEvent) => {
  if (!isDragging.value || !stripRef.value) {
    return;
  }

  const delta = event.clientX - dragStartX;
  dragDistance = Math.max(dragDistance, Math.abs(delta));
  stripRef.value.scrollLeft = dragStartScrollLeft - delta;

  if (capturedPointerId === null && dragDistance > DRAG_CLICK_THRESHOLD_PX) {
    dragExceededThreshold = true;
    capturedPointerId = event.pointerId;
    // Keeps the drag tracking even if the pointer leaves the strip's bounds.
    // Not implemented in every environment (notably jsdom), hence the guard.
    stripRef.value.setPointerCapture?.(event.pointerId);
  }
};

const endDrag = () => {
  if (!isDragging.value) {
    return;
  }

  isDragging.value = false;
  dragDistance = 0;

  // The flag clears on a deferred timer, never synchronously. `pointerup ->
  // mouseup -> click` all dispatch within one input-handling task, so clearing it
  // here would zero it before that click - on any environment that doesn't
  // retarget it away from the button - could check it, and dragging would again
  // navigate to whatever ends up under the pointer. A macrotask cannot run until
  // that task finishes, so the flag survives a same-gesture click and is gone well
  // before any later one. A pending timer is replaced, not stacked.
  if (dragResetTimer !== null) {
    clearTimeout(dragResetTimer);
  }
  dragResetTimer = setTimeout(() => {
    dragExceededThreshold = false;
    dragResetTimer = null;
  }, 0);

  globalThis.removeEventListener('pointerup', endDrag);
  globalThis.removeEventListener('pointercancel', endDrag);
  // Capture is only ever taken once a drag is confirmed (see `onPointerMove`),
  // so a plain click never sets `capturedPointerId` and this is a no-op then.
  if (capturedPointerId !== null) {
    stripRef.value?.releasePointerCapture?.(capturedPointerId);
    capturedPointerId = null;
  }
};

// The strip unmounts mid-drag whenever the info sheet opens below `lg`
// (PhotoDetail hides it while occluded) - without this, a drag in progress at
// that moment would leave the window-level listeners above dangling,
// referencing a torn-down component.
onUnmounted(() => {
  endDrag();
  // `endDrag` schedules `dragResetTimer` rather than clearing it, so unmounting
  // mid-drag would leave it pending with no component left to clear it. Harmless
  // in practice (its callback touches only closure-local `let`s), but no timer
  // should outlive the component.
  if (dragResetTimer !== null) {
    clearTimeout(dragResetTimer);
    dragResetTimer = null;
  }
});

/**
 * Swallows the `click` that still reaches a thumbnail after a drag, on
 * environments where pointer capture does not retarget it away. Without this,
 * dragging the strip navigates to whichever thumbnail is under the pointer on
 * release - the detail that makes drag-scroll feel broken. Capture usually does
 * retarget it, so this often never runs; `endDrag`'s timer clears the flag for
 * that case.
 */
const onThumbnailClick = (index: number) => {
  if (dragExceededThreshold) {
    dragExceededThreshold = false;
    return;
  }
  emits('select', index);
};
</script>
