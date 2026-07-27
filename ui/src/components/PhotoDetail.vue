<template>
  <Teleport to="body">
    <div
      ref="dialogRef"
      :aria-label="`Photo ${photoFileName}`"
      aria-modal="true"
      class="fixed inset-0 z-[1100] flex flex-col bg-black/95"
      role="dialog"
      tabindex="-1"
    >
      <header class="flex shrink-0 items-center justify-between gap-2 p-2 text-white">
        <div class="text-surface-400 min-w-0 text-sm" data-test-id="photo-index">
          ({{ selectedImageIndex + 1 }}/{{ photosInAlbum.length }})
        </div>
        <div class="flex shrink-0 items-center gap-1">
          <Button
            v-tooltip.bottom="'Info'"
            :aria-pressed="isInfoOpen"
            aria-label="Toggle photo information"
            data-test-id="photo-info-button"
            rounded
            severity="secondary"
            text
            @click="toggleInfo"
          >
            <template #icon>
              <IconInfoCircle :size="24" />
            </template>
          </Button>
          <EditPhotoButton v-if="isAdmin && selectedImage" :photo-key="selectedImage.key" />
          <Button
            aria-label="Close photo"
            data-test-id="close-button"
            rounded
            severity="secondary"
            text
            @click="emits('closePhotoDetail')"
          >
            <template #icon>
              <IconX :size="24" />
            </template>
          </Button>
        </div>
      </header>

      <div class="relative flex min-h-0 grow">
        <div
          :class="['relative flex min-h-0 min-w-0 grow flex-col', { 'lg:mr-[360px]': isInfoOpen }]"
        >
          <div class="relative flex min-h-0 grow items-center justify-center">
            <div
              v-if="isPanoramaPhoto"
              class="bg-surface-900/60 absolute top-2 left-2 z-10 flex items-center rounded-full p-1 text-white"
              data-test-id="panorama-badge"
            >
              <IconView360Number aria-label="360 panorama photo" :size="20" role="img" />
            </div>

            <ProgressSpinner v-if="loadImage" />
            <template v-else>
              <img
                v-if="!isPanoramaPhoto"
                :alt="photoAltText"
                :src="sharedPhotoUrl(selectedImage?.url ?? '')"
                class="max-h-full max-w-full object-contain"
                @error="onImageError"
                @load="onImageLoad"
              />
              <PanoramaViewer v-else :imageUrl="sharedPhotoUrl(selectedImage?.url ?? '')" />
            </template>

            <Button
              v-if="photosInAlbum.length > 1"
              aria-label="Previous photo"
              class="absolute! top-1/2! left-2! h-11! min-w-11! -translate-y-1/2!"
              data-test-id="previous-photo-button"
              rounded
              @click="nextPhoto(-1)"
            >
              <template #icon>
                <IconChevronLeft :size="24" />
              </template>
            </Button>
            <Button
              v-if="photosInAlbum.length > 1"
              aria-label="Next photo"
              class="absolute! top-1/2! right-2! h-11! min-w-11! -translate-y-1/2!"
              data-test-id="next-photo-button"
              rounded
              @click="nextPhoto(1)"
            >
              <template #icon>
                <IconChevronRight :size="24" />
              </template>
            </Button>
          </div>

          <template v-if="showCaptionAndFilmstrip">
            <p
              v-if="photoFileName"
              class="shrink-0 truncate px-4 pt-2 text-center text-white"
              data-test-id="photo-file-name"
            >
              {{ photoFileName }}
            </p>

            <PhotoFilmstrip
              :active-index="selectedImageIndex"
              :photos="photosInAlbum"
              class="shrink-0"
              @select="goToPhotoIndex"
            />
          </template>
        </div>

        <transition
          enter-active-class="transition ease-out duration-200 motion-reduce:transition-none"
          enter-from-class="opacity-0 translate-y-full lg:translate-y-0 lg:translate-x-full"
          leave-active-class="transition ease-in duration-200 motion-reduce:transition-none"
          leave-to-class="opacity-0 translate-y-full lg:translate-y-0 lg:translate-x-full"
        >
          <aside
            v-if="isInfoOpen"
            aria-label="Photo information"
            class="dark:bg-surface-900 bg-surface-0 absolute right-0 bottom-0 left-0 z-10 h-1/2 overflow-y-auto rounded-t-lg p-4 lg:top-0 lg:left-auto lg:h-full lg:w-[360px] lg:rounded-none"
            data-test-id="photo-info-panel"
          >
            <PhotoInfoPanel
              :exif-tags="exifTags"
              :is-panorama="isPanoramaPhoto"
              :natural-height="naturalHeight"
              :natural-width="naturalWidth"
              :photo="selectedImage"
            />
          </aside>
        </transition>
      </div>
    </div>
  </Teleport>
</template>

<script lang="ts" setup>
import { EditPhotoButton } from '@/components/button';
import PanoramaViewer from '@/components/PanoramaViewer.vue';
import PhotoFilmstrip from '@/components/PhotoFilmstrip.vue';
import PhotoInfoPanel from '@/components/PhotoInfoPanel.vue';
import { useDevice } from '@/composables';
import type { ExifData } from '@/schema';
import { usePhotoStore, useUserConfigStore } from '@/stores';
import { stripExtension } from '@/utils/helper';
import { PHOTO_INFO_PANEL_OPEN } from '@/utils/local-storage-key';
import { photoFileName as getPhotoFileName, sharedPhotoUrl } from '@/utils/photo-url';
import {
  IconChevronLeft,
  IconChevronRight,
  IconInfoCircle,
  IconView360Number,
  IconX,
} from '@tabler/icons-vue';
import ExifReader from 'exifreader';
import { storeToRefs } from 'pinia';
import { Button, ProgressSpinner } from 'primevue';
import { useToast } from 'primevue/usetoast';
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';

const emits = defineEmits(['refreshPhotoList', 'closePhotoDetail']);

const toast = useToast();
const router = useRouter();
const route = useRoute();

const userConfigStore = useUserConfigStore();
const { isAdmin } = storeToRefs(userConfigStore);
const photoStore = usePhotoStore();
const { photosInAlbum, isFetchingPhotos } = storeToRefs(photoStore);
const { findPhotoByIndex, findPhotoIndex } = photoStore;

const { isLargeDevice } = useDevice();

const selectedImageIndex = ref(-1);
const photoFileName = ref('');
const exifTags = ref<Partial<ExifData>>({});
const loadImage = ref(false);
const naturalWidth = ref(0);
const naturalHeight = ref(0);

const selectedImage = computed(() => findPhotoByIndex(selectedImageIndex.value));
const albumId = computed(() => route.params['albumId'] as string);
const albumYear = computed(() => route.params['year'] as string);
const photoId = computed(() => route.query['photo'] as string);

/** File name without its extension, for screen readers. */
const photoAltText = computed(() => stripExtension(photoFileName.value, 'Photo'));

const isPanoramaPhoto = computed(() => {
  if (exifTags.value.ProjectionType?.description === 'equirectangular') return true;

  // Check for common 360 camera indicators
  const make = exifTags.value.Make?.description?.toLowerCase() || '';
  const model = exifTags.value.Model?.description?.toLowerCase() || '';

  // Check for common 360 cameras
  const panoramaCameras = [
    { make: 'ricoh', model: 'theta' },
    { make: 'samsung', model: 'gear 360' },
    { make: 'insta360', model: '' },
    { make: 'gopro', model: 'fusion' },
    { make: 'gopro', model: 'max' },
    { make: 'xiaomi', model: 'mijia' },
  ];

  if (
    panoramaCameras.some(
      (camera) =>
        make.includes(camera.make) && (camera.model === '' || model.includes(camera.model)),
    )
  ) {
    return true;
  }

  const fileName = photoFileName.value.toLowerCase();
  // `360` must not sit inside a longer number: batch_bird-8360220.jpg is not a panorama.
  const has360 = /(?:^|\D)360(?:\D|$)/.test(fileName);
  // `pano` must start a word, so "japanophile" does not match.
  const hasPano = /(?:^|[^a-z])pano/.test(fileName);
  return has360 || hasPano;
});

const dialogRef = ref<HTMLDivElement | null>(null);

/**
 * Read the persisted info-panel preference. Unguarded, this read throws in Safari
 * private mode (or with storage disabled entirely) - and since it runs during
 * `setup()`, an uncaught throw here would fail the whole component's mount, not
 * just this one preference. Defaults closed on any failure, matching `toggleInfo`'s
 * existing write-side try/catch below.
 */
const readInfoOpenPreference = (): boolean => {
  try {
    return localStorage.getItem(PHOTO_INFO_PANEL_OPEN) === 'true';
  } catch {
    return false;
  }
};

const isInfoOpen = ref(readInfoOpenPreference());

/**
 * True when a PrimeVue popup is stacked above the lightbox. Shared by
 * `onHandleKeydown` and `onTrapFocus` so both bail out identically: whichever one
 * kept running would fight the popup's own Tab trap and Escape handling, and keep
 * driving the photo underneath it.
 *
 * Matched on ARIA roles rather than PrimeVue's `.p-dialog-mask`/`.p-menu` classes,
 * since roles are the public contract and survive a version bump. All four are
 * needed: `Dialog` is `dialog`, `ConfirmDialog` is `alertdialog`, the photo-actions
 * `Menu` is `menu`, and a `Select` popup is `listbox`. Do not narrow this - missing
 * `menu` let ArrowRight keep changing the photo while the actions menu stayed open,
 * so Delete acted on the wrong one.
 *
 * **Known gap.** This assumes every element carrying these roles is `v-if`-rendered,
 * which holds for all current usages but not for the roles themselves - a `multiple`
 * `AutoComplete` or an inline `Listbox` is always mounted. Adding one to
 * `PhotoList.vue`/`App.vue` would pin this to `true` and silently kill lightbox
 * keyboard navigation. Left as-is because telling "popup above the lightbox" from
 * "unrelated mounted listbox" needs a signal this has no access to (DOM
 * position/z-index, or a marker PrimeVue does not provide), and dropping `listbox`
 * to dodge it would reopen the wrong-photo-deletion bug above.
 */
const hasNestedDialog = (): boolean =>
  Array.from(
    document.querySelectorAll('[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"]'),
  ).some((element) => element !== dialogRef.value);

/**
 * Below `lg`, the info panel is a bottom sheet covering the lower half of the
 * screen - directly on top of the caption and filmstrip. Unmounting them while
 * fully occluded avoids wasting layout and keeps unreachable controls out of the
 * accessibility tree. At `lg+` the panel is a side drawer instead, so both stay
 * and simply shift over with the rest of the stage (`lg:mr-[360px]`).
 */
const showCaptionAndFilmstrip = computed(() => !isInfoOpen.value || isLargeDevice.value);

const toggleInfo = () => {
  isInfoOpen.value = !isInfoOpen.value;
  try {
    localStorage.setItem(PHOTO_INFO_PANEL_OPEN, String(isInfoOpen.value));
  } catch {
    // Storage disabled: the preference simply does not survive the session.
  }
};

/**
 * Navigate to the photo at absolute `index`, updating the `?photo=` query
 * param - the single source of truth for which photo is displayed. Both
 * `nextPhoto` (prev/next chevrons, arrow keys) and the filmstrip's `select`
 * event route through this, so there is exactly one navigation path.
 */
const goToPhotoIndex = (index: number) => {
  const photoListLength = photosInAlbum.value.length;
  if (photoListLength === 0 || index < 0 || index >= photoListLength) {
    return;
  }

  // Reset only once the index is known valid - resetting first (as this used to)
  // blanked the info panel and could flip `isPanoramaPhoto` even for a rejected,
  // out-of-bounds index that never actually navigates anywhere.
  exifTags.value = {};

  selectedImageIndex.value = index;

  if (selectedImage.value) {
    const photoId = getPhotoFileName(selectedImage.value.key);
    router.replace({ query: { ...route.query, photo: photoId } });
  }
};

const nextPhoto = (dir: number) => {
  const photoListLength = photosInAlbum.value.length;
  if (photoListLength === 0) {
    return;
  }

  const newIndex =
    (selectedImageIndex.value + (dir % photoListLength) + photoListLength) % photoListLength;
  goToPhotoIndex(newIndex);
};

const onHandleKeydown = (event: KeyboardEvent) => {
  const target = event.target as HTMLElement;
  if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable) {
    return;
  }

  // A nested dialog (Move/Delete/Rename, etc.) owns keyboard input while it is open -
  // without this bailout, arrow keys and `i` would keep driving the photo underneath
  // it instead of being inert while the nested dialog is focused.
  if (hasNestedDialog()) {
    return;
  }

  switch (event.key) {
    case 'ArrowLeft':
      nextPhoto(-1);
      break;
    case 'ArrowRight':
      nextPhoto(1);
      break;
    case 'Escape':
      emits('closePhotoDetail');
      break;
    case 'i':
      toggleInfo();
      break;
  }
};

/**
 * `img.naturalWidth/Height` describe the actual bytes the `<img>` loaded via
 * `sharedPhotoUrl`, which applies no dimension transform - so these are the
 * true original resolution, not a downscaled copy. `PhotoInfoPanel`'s "W x H"
 * line and its derived megapixels figure rely on that.
 */
const onImageLoad = (event: Event) => {
  const img = event.target as HTMLImageElement;
  naturalWidth.value = img.naturalWidth;
  naturalHeight.value = img.naturalHeight;
  loadImage.value = false;
};

const onImageError = () => {
  naturalWidth.value = 0;
  naturalHeight.value = 0;
  loadImage.value = false;
};

/** Element focused before the lightbox opened, so focus can be handed back. */
let previouslyFocused: HTMLElement | null = null;

/**
 * Every term needs its own `:not([tabindex="-1"])`, not one trailing term - CSS
 * would otherwise bind it to the last selector only. That exclusion is what keeps
 * the filmstrip's inactive thumbnails (roving tabindex: all `-1` but the active
 * one) out of the result, so `onTrapFocus` re-running this on every Tab keypress
 * materialises a handful of nodes rather than a 500-photo album's worth.
 */
const FOCUSABLE_SELECTOR = ['button', '[href]', 'input', 'select', 'textarea', '[tabindex]']
  .map((selector) => `${selector}:not([tabindex="-1"])`)
  .join(', ');

/** Keep Tab inside the dialog while it is modal. */
const onTrapFocus = (event: KeyboardEvent) => {
  if (event.key !== 'Tab' || !dialogRef.value) {
    return;
  }

  // A PrimeVue dialog stacked above the lightbox (Move/Delete/Rename, or the album's
  // "Manage Tags"/"Travel Records" dialogs) owns focus while it is open - PrimeVue
  // gives every modal Dialog its own focus trap via `v-focustrap`, so trapping here
  // too would fight it for Tab.
  if (hasNestedDialog()) {
    return;
  }

  // Both checks catch something the selector cannot. A `<button disabled>` still
  // reports `tabIndex === 0` (verified), so if one ever landed first or last here,
  // `.focus()` would no-op and Tab would escape the modal. And `:not([tabindex="-1"])`
  // matches only that exact string, so `tabIndex >= 0` is what excludes any other
  // negative value. Neither case exists today; both are cheap insurance on a list
  // the selector has already cut to a handful of elements.
  const focusable = Array.from(
    dialogRef.value.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR),
  ).filter((element) => element.tabIndex >= 0 && !element.hasAttribute('disabled'));
  if (focusable.length === 0) {
    return;
  }
  const first = focusable[0] as HTMLElement;
  const last = focusable[focusable.length - 1] as HTMLElement;
  const active = document.activeElement;

  // Focus outside the dialog (including the container itself on open) must be pulled
  // back in, or Tab silently escapes to the grid behind an aria-modal overlay.
  if (!dialogRef.value.contains(active) || active === dialogRef.value) {
    event.preventDefault();
    (event.shiftKey ? last : first).focus();
    return;
  }
  if (event.shiftKey && active === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && active === last) {
    event.preventDefault();
    first.focus();
  }
};

onMounted(() => {
  previouslyFocused = document.activeElement as HTMLElement | null;
  document.body.classList.add('overflow-hidden');
  globalThis.addEventListener('keydown', onHandleKeydown);
  globalThis.addEventListener('keydown', onTrapFocus);
  dialogRef.value?.focus();
});

onUnmounted(() => {
  document.body.classList.remove('overflow-hidden');
  globalThis.removeEventListener('keydown', onHandleKeydown);
  globalThis.removeEventListener('keydown', onTrapFocus);
  previouslyFocused?.focus();
});

// When photo id changes, verify if it exists first
watch(
  photoId,
  (newId) => {
    if (isFetchingPhotos.value) return;

    if (newId) {
      selectedImageIndex.value = findPhotoIndex(newId);

      if (selectedImageIndex.value === -1) {
        toast.add({
          severity: 'error',
          summary: 'Error',
          detail: 'Photo does not exist',
          life: 3000,
        });
        setTimeout(() => router.push(`/album/${albumYear.value}/${albumId.value}`), 3000);
      }
    }
  },
  { deep: true, immediate: true },
);

// If photo exists based on URL, get EXIF data from photo
watch(
  selectedImage,
  async (newValue, _oldValue, onCleanup) => {
    if (newValue?.key) {
      // Remove album id for displaying photo file name
      photoFileName.value = getPhotoFileName(newValue.key);
      naturalWidth.value = 0;
      naturalHeight.value = 0;
      loadImage.value = true;

      // Rapid navigation (held arrow keys, or the filmstrip) can re-fire this
      // watcher before an earlier `ExifReader.load` settles. Without this guard the
      // last response to resolve wins rather than the photo actually on screen, so
      // `exifTags` - and the date/camera/map and `isPanoramaPhoto` it drives -
      // could describe a different photo. `onCleanup` runs just before the next
      // fire (or on unmount), so a late response is discarded instead of applied.
      let stale = false;
      onCleanup(() => {
        stale = true;
      });

      try {
        // Must stay `sharedPhotoUrl` - the same builder as the `<img>` `src` and
        // `PanoramaViewer`'s `imageUrl` above, or this becomes a second cache key
        // and a second full download. See its doc comment in `photo-url.ts`.
        const tags = (await ExifReader.load(sharedPhotoUrl(newValue.url))) as ExifData;
        // Only the `exifTags` write is guarded. `loadImage` must reset
        // unconditionally in `finally`: the image loads independently of EXIF, and
        // returning early past it wedged the spinner on screen forever whenever a
        // later run skipped its body entirely (`selectedImage` becoming `undefined`
        // on the `?photo=` not-found path).
        if (stale) return;
        exifTags.value = tags;
      } catch (error) {
        console.error(error);
      } finally {
        loadImage.value = false;
      }
    }
  },
  { deep: true, immediate: true },
);
</script>
