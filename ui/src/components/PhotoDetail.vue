<template>
  <Teleport to="body">
    <div
      ref="dialogRef"
      :aria-label="`Photo ${photoFileName}`"
      aria-modal="true"
      class="fixed inset-0 z-1100 flex flex-col bg-black"
      role="dialog"
      tabindex="-1"
    >
      <header class="flex shrink-0 items-center justify-between gap-2 p-2 text-white">
        <div class="text-surface-400 min-w-0 text-sm" data-test-id="photo-index">
          ({{ selectedImageIndex + 1 }}/{{ photosInAlbum.length }})
        </div>
        <div class="flex shrink-0 items-center gap-1">
          <!--
            Pressed state is carried three ways, because `aria-pressed` alone is
            invisible: a filled icon, and the primary colour instead of the muted
            `secondary` the other header buttons use. `aria-label` stays constant -
            `aria-pressed` is what announces on/off, so varying the label too would
            make a screen reader read the state twice, in conflicting words.
          -->
          <Button
            v-tooltip.bottom="isInfoOpen ? 'Hide info' : 'Show info'"
            :aria-pressed="isInfoOpen"
            :severity="isInfoOpen ? undefined : 'secondary'"
            aria-label="Toggle photo information"
            data-test-id="photo-info-button"
            rounded
            text
            @click="toggleInfo"
          >
            <template #icon>
              <IconInfoCircleFilled v-if="isInfoOpen" :size="24" />
              <IconInfoCircle v-else :size="24" />
            </template>
          </Button>
          <!--
            Keyed off the committed frame, not `selectedImage`: during a
            navigation the latter has already advanced, so Delete/Move/Rename
            would act on a photo other than the one on screen.
          -->
          <EditPhotoButton v-if="isAdmin && displayedFrame" :photo-key="displayedFrame.key" />
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

      <!--
        Below `lg` this stacks: the stage column and the info sheet are siblings
        splitting the height, so opening the sheet *shrinks* the stage rather than
        covering it. At `lg+` it goes back to a row and the sheet is absolutely
        positioned as a side drawer (see the `<aside>` below).

        Except in landscape, where splitting the *height* is the wrong axis: a
        phone on its side is 844x390, so half the height leaves the photo about
        87px tall once the filmstrip has its 80. Wide-and-short wants the panel
        beside the photo, not below it, so landscape gets a row too. Every
        landscape rule here is scoped `max-lg:` so it cannot collide with the
        `lg:` rules - a desktop monitor is landscape as well.
      -->
      <div
        class="relative flex min-h-0 grow flex-col max-lg:landscape:flex-row lg:flex-row"
        data-test-id="photo-stage-row"
      >
        <div
          :class="['relative flex min-h-0 min-w-0 grow flex-col', { 'lg:mr-90': isInfoOpen }]"
        >
          <!--
            `overflow-hidden` clips the sliding frames to the stage - without it
            an entering photo is visible outside its bounds and rides over the
            caption and filmstrip on its way in.
          -->
          <div
            class="relative flex min-h-0 grow items-center justify-center overflow-hidden"
            data-test-id="photo-stage"
          >
            <!--
              Top-*right*: pannellum stacks its own zoom and fullscreen controls
              down the top-left corner, and this badge sat directly on the zoom
              `+`. The right corner is free - the next-photo chevron is centred
              vertically and the compass sits bottom-right.
            -->
            <div
              v-if="isPanoramaPhoto"
              class="bg-surface-900/60 absolute top-2 right-2 z-10 flex items-center rounded-full p-1 text-white"
              data-test-id="panorama-badge"
            >
              <IconView360Number aria-label="360 panorama photo" :size="20" role="img" />
            </div>

            <!--
              Keyed on the photo, so navigating swaps the whole frame and Vue runs
              a leave on the outgoing one and an enter on the incoming one *at the
              same time* - both are `absolute inset-0`, so they slide past each
              other rather than one collapsing the layout before the other appears.
              `displayedFrame` only changes once the next photo has decoded, so
              nothing ever slides in blank.
            -->
            <Transition
              :enter-active-class="slideClasses.enterActive"
              :enter-from-class="slideClasses.enterFrom"
              :leave-active-class="slideClasses.leaveActive"
              :leave-to-class="slideClasses.leaveTo"
            >
              <div
                v-if="displayedFrame"
                :key="displayedFrame.key"
                class="absolute inset-0 flex items-center justify-center"
                data-test-id="photo-frame"
              >
                <!--
                  Deliberately still natively draggable. `draggable="false"` was
                  needed here only while the main photo had its own swipe
                  gesture, which HTML5 image dragging cancelled; that gesture is
                  gone, and dragging a photo out to the desktop or another app is
                  a standard browser affordance worth keeping. The filmstrip
                  thumbnails do still need it - see `PhotoFilmstrip.vue`.
                -->
                <img
                  v-if="!displayedFrame.isPanorama"
                  :alt="displayedFrame.alt"
                  :src="displayedFrame.url"
                  class="max-h-full max-w-full object-contain"
                  @error="onImageError"
                  @load="onImageLoad"
                />
                <PanoramaViewer v-else :imageUrl="displayedFrame.url" />
              </div>
            </Transition>

            <ProgressSpinner v-if="loadImage" class="absolute" />

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

          <!--
            Hidden below `lg` while the sheet is open, purely to buy the photo back
            some height: half a phone viewport is not much to split between image,
            caption and filmstrip, and `PhotoInfoPanel` already shows the file name
            in its own `photo-info-file` block, so nothing is actually lost. A CSS
            breakpoint rather than a JS one, so it cannot disagree with `lg:flex-row`
            above.
          -->
          <p
            v-if="photoFileName"
            :class="[
              'shrink-0 truncate px-4 pt-2 text-center text-white',
              { 'hidden lg:block': isInfoOpen },
            ]"
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
        </div>

        <!--
          The sheet slides in from wherever it lives: up from the bottom when
          stacked, in from the right when it is a side drawer - which is `lg+`
          and, per the row container above, landscape below `lg` too.
        -->
        <transition
          enter-active-class="transition ease-out duration-200 motion-reduce:transition-none"
          enter-from-class="opacity-0 translate-y-full max-lg:landscape:translate-x-full max-lg:landscape:translate-y-0 lg:translate-x-full lg:translate-y-0"
          leave-active-class="transition ease-in duration-200 motion-reduce:transition-none"
          leave-to-class="opacity-0 translate-y-full max-lg:landscape:translate-x-full max-lg:landscape:translate-y-0 lg:translate-x-full lg:translate-y-0"
        >
          <aside
            v-if="isInfoOpen"
            aria-label="Photo information"
            class="dark:bg-surface-900 bg-surface-0 z-10 h-1/2 shrink-0 overflow-y-auto rounded-t-lg p-4 max-lg:landscape:h-full max-lg:landscape:w-2/5 max-lg:landscape:rounded-t-none max-lg:landscape:rounded-l-lg lg:absolute lg:top-0 lg:right-0 lg:h-full lg:w-90 lg:rounded-none"
            data-test-id="photo-info-panel"
          >
            <!--
              `photo`, `exif-tags` and `is-panorama` all come from one commit.
              Mixing in a live `selectedImage` made the panel describe two
              different photos at once - see `PhotoFrame`.

              `natural-*` is the exception: it arrives later, from the `<img>`'s
              own `load` event, which carries no frame identity - and this
              `<Transition>` has no `mode`, so two images are briefly mounted and
              both are wired to `onImageLoad`. It is frame-correct today only by
              ordering: a non-panorama frame is always committed *after*
              `preloadPhoto` resolved for the same URL, so the incoming `<img>`
              loads from cache and fires before the next commit can land. Narrow
              that preload and this loses its only protection, silently.
            -->
            <PhotoInfoPanel
              :exif-tags="exifTags"
              :is-panorama="isPanoramaPhoto"
              :natural-height="naturalHeight"
              :natural-width="naturalWidth"
              :photo="displayedFrame?.photo"
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
import type { ExifData, Photo } from '@/schema';
import { usePhotoStore, useUserConfigStore } from '@/stores';
import { stripExtension } from '@/utils/helper';
import { PHOTO_INFO_PANEL_OPEN } from '@/utils/local-storage-key';
import { photoFileName as getPhotoFileName, sharedPhotoUrl } from '@/utils/photo-url';
import {
  IconChevronLeft,
  IconChevronRight,
  IconInfoCircle,
  IconInfoCircleFilled,
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

/**
 * One photo's worth of everything the stage needs to render it, captured at the
 * moment it is committed rather than read from live refs.
 *
 * This is what makes the slide possible at all: during a transition two photos
 * are on screen at once, and a single `exifTags`/`photoFileName` pair cannot
 * describe both. An outgoing frame holding its own `isPanorama` cannot flip from
 * `<img>` to `PanoramaViewer` half-way through its own leave animation because
 * the *incoming* photo's EXIF happened to arrive.
 */
interface PhotoFrame {
  /** The photo's R2 key, used as the transition key. */
  key: string;
  /** Always `sharedPhotoUrl` - see the invariant in `photo-url.ts`. */
  url: string;
  isPanorama: boolean;
  alt: string;
  /**
   * The store record itself, so `PhotoInfoPanel` and the admin actions read the
   * same photo the stage is showing.
   *
   * Without this the panel mixed two photos: `exifTags` was committed with the
   * frame while `:photo` came straight off `selectedImage`, which
   * `goToPhotoIndex` advances synchronously. For the whole EXIF-fetch-plus-decode
   * window - a full download of the original on a cold cache - it showed the
   * *next* photo's file name and size above the *current* photo's capture date,
   * camera and GPS pin. Incomplete metadata is fine; metadata that confidently
   * attributes one photo's location to another is not.
   */
  photo: Photo;
}

const displayedFrame = ref<PhotoFrame | null>(null);

type SlideDirection = 'next' | 'prev' | 'none';

/** Which way the *next* committed frame should travel. */
const slideDirection = ref<SlideDirection>('none');

/**
 * Where each frame starts and ends, per direction. Following the usual carousel
 * convention: going to the next photo, content travels leftwards - the new photo
 * enters from the right edge while the old one leaves past the left.
 *
 * Written out as whole literal class strings because Tailwind scans source text;
 * building them by interpolation would leave the classes ungenerated.
 */
const SLIDE_CLASSES: Record<SlideDirection, { enterFrom: string; leaveTo: string }> = {
  next: { enterFrom: 'translate-x-full opacity-0', leaveTo: '-translate-x-full opacity-0' },
  prev: { enterFrom: '-translate-x-full opacity-0', leaveTo: 'translate-x-full opacity-0' },
  // Deep link, browser back/forward, or the first photo: there is no meaningful
  // direction, so cross-fade rather than inventing one.
  none: { enterFrom: 'opacity-0', leaveTo: 'opacity-0' },
};

const slideClasses = computed(() => {
  const { enterFrom, leaveTo } = SLIDE_CLASSES[slideDirection.value];
  return {
    // `motion-reduce:` honours prefers-reduced-motion, matching the info sheet's
    // transition - the photo still swaps, it just does not travel.
    enterActive: 'transition duration-300 ease-out motion-reduce:transition-none',
    leaveActive: 'transition duration-300 ease-in motion-reduce:transition-none',
    enterFrom,
    leaveTo,
  };
});

/**
 * How long a photo may take to decode before the spinner is worth showing.
 *
 * Long enough that two cached photos swap without a spinner flashing between
 * them, short enough that a slow one does not leave the stage looking inert.
 */
const SPINNER_DELAY_MS = 200;

/**
 * Monotonic id of the most recently started run of the `selectedImage` watcher.
 *
 * Distinct from the per-run `stale` flag, which only tells a run that it has
 * been superseded. Shared state such as the spinner needs the opposite question
 * answered - "am I still the newest?" - so a finishing run cannot clear a flag
 * its successor set.
 */
let latestWatcherRun = 0;

/*
 * Deliberately no drag-to-navigate on the main photo. It was built and removed:
 * releasing past the threshold snapped the photo back to centre and only then
 * navigated, because committing the next frame is async (EXIF, then decode), so
 * every successful drag read as bounce-back-then-jump.
 *
 * Doing it properly means a gesture-driven transition - the drag position
 * handing straight off to the leave animation, with no reset in between - which
 * the current commit-a-whole-frame model cannot express, since the outgoing
 * element only starts leaving once the incoming frame exists. That is a larger
 * change than the feature earns while the chevrons, arrow keys and filmstrip all
 * already navigate. Dragging the filmstrip is the gesture that was actually
 * missing, and that lives in `PhotoFilmstrip.vue`.
 */

/**
 * Resolves once `url` is decoded and painting it will not flash.
 *
 * `decode()` rather than an `onload` listener: it resolves after decoding, not
 * merely after the bytes arrive, which is the difference between a smooth slide
 * and one that stutters on the first frame. jsdom implements neither, so the
 * `typeof` guard makes every test resolve immediately instead of hanging on a
 * load event that environment never fires.
 *
 * The URL is the same `sharedPhotoUrl` the `<img>` and `ExifReader` use, so this
 * shares their cache entry rather than adding a third download.
 */
const preloadPhoto = async (url: string): Promise<ImageDimensions | null> => {
  if (typeof Image === 'undefined') return null;
  const image = new Image();
  image.src = url;
  if (typeof image.decode !== 'function') return null;
  try {
    await image.decode();
  } catch {
    // Broken or unsupported image: commit the frame anyway and let the `<img>`
    // fall through to `onImageError`, rather than stranding the viewer on the
    // previous photo with no way forward.
    return null;
  }
  return image.naturalWidth > 0
    ? { width: image.naturalWidth, height: image.naturalHeight }
    : null;
};

/**
 * Panorama detection, taking its inputs as arguments so it can be run against a
 * photo that is not on screen yet - the frame's `isPanorama` has to be decided
 * before that frame is committed. `isPanoramaPhoto` below keeps the old
 * behaviour of deriving from the current refs.
 */
/**
 * How far from a perfect 2:1 an image may be and still be treated as a full
 * equirectangular sphere. Real ones are exactly 2.000, so this is slack rather
 * than a real range: +/-0.04 on the ratio is about 2%, admitting 1.96:1 through
 * 2.04:1 (6000x2941 at the low end). Wide enough for an odd export, far too
 * narrow for the 2.638:1 crop this exists to reject.
 */
const SPHERE_ASPECT_RATIO = 2;
const SPHERE_ASPECT_TOLERANCE = 0.04;

interface ImageDimensions {
  width: number;
  height: number;
}

/**
 * Dimensions of the photo currently displayed, measured from the decoded image
 * rather than read out of its header. Committed with the frame.
 *
 * This exists because the header route is format-dependent in a way that is
 * invisible in development. ExifReader only produces `Image Width`/`Image
 * Height` for JPEG, PNG, GIF and JXL - `image-header-webp.js` returns no
 * `fileDataOffset`, so a WebP yields nothing, on every successful read, forever.
 * WebP is an accepted upload type (`ALLOWED_FILE_TYPE`), and more importantly
 * production serves photos through ImageKit, which negotiates format by default:
 * the very same URL that hands back a JPEG from the raw R2 bucket in dev can
 * hand back a WebP in production.
 *
 * Relying on header dimensions alone would therefore have denied every
 * filename-detected panorama in production while every local check passed.
 * A decoded `<img>` reports its size whatever the format.
 */
const measuredDimensions = ref<ImageDimensions | null>(null);

/**
 * Whether the image's own proportions are those of a full sphere.
 *
 * A full equirectangular projection covers 360 degrees across and 180 down, so
 * it is always exactly twice as wide as it is tall. Anything else is a partial
 * panorama: still 360 around, but cropped vertically, which pannellum has no way
 * to know about once the GPano tags describing the crop have been stripped - it
 * assumes a full 180 and stretches the image to fit.
 *
 * Dimensions come from the JPEG header via ExifReader's `file` group, so they
 * are available before the image element exists and survive EXIF being absent.
 * Returns `null` when they cannot be read, so callers can tell "not a sphere"
 * from "cannot tell".
 */
const hasSphereAspectRatio = (
  tags: Partial<ExifData>,
  measured: ImageDimensions | null = null,
): boolean | null => {
  let width = Number(tags['Image Width']?.value ?? 0);
  let height = Number(tags['Image Height']?.value ?? 0);

  // Fall back to the decoded image whenever the header gave us nothing, which is
  // every WebP and anything ImageKit converted on the way out. See
  // `measuredDimensions`.
  if (!(width > 0 && height > 0) && measured) {
    width = measured.width;
    height = measured.height;
  }

  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return null;
  }
  return Math.abs(width / height - SPHERE_ASPECT_RATIO) <= SPHERE_ASPECT_TOLERANCE;
};

const detectPanorama = (
  tags: Partial<ExifData>,
  fileName: string,
  measured: ImageDimensions | null = null,
): boolean => {
  if (tags.ProjectionType?.description === 'equirectangular') return true;

  // Check for common 360 camera indicators
  const make = tags.Make?.description?.toLowerCase() || '';
  const model = tags.Model?.description?.toLowerCase() || '';

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

  const lowerName = fileName.toLowerCase();
  // `360` must not sit inside a longer number: batch_bird-8360220.jpg is not a panorama.
  const has360 = /(?:^|\D)360(?:\D|$)/.test(lowerName);
  // `pano` must start a word, so "japanophile" does not match.
  const hasPano = /(?:^|[^a-z])pano/.test(lowerName);
  if (!has360 && !hasPano) {
    return false;
  }

  // The file name is the weakest signal here - a guess about intent, not a
  // statement about the pixels - so it alone must not hand a photo to a sphere
  // viewer. Require the image to actually be shaped like a full sphere.
  //
  // This is what a 8192x3105 (2.638:1) aerial panorama tripped: genuinely 360
  // around, verified by its left and right edges joining, but cropped top and
  // bottom to about 136 degrees of vertical coverage. Pannellum assumes a full
  // 180 and stretched it, so it read as a broken 360 rather than the wide flat
  // photo it is better shown as. Rendering it as an ordinary image is honest
  // about what can actually be reconstructed once GPano has been stripped.
  //
  // Deliberately only gating the file-name path. `ProjectionType` and a known
  // 360 camera are statements about how the photo was made, and pannellum reads
  // GPano's crop tags itself, so a partial sphere that still carries its
  // metadata is projected correctly and must not be rejected here.
  // `null` now means neither the header nor a decoded image could supply
  // dimensions - the fetch failed outright, rather than merely being a format
  // ExifReader has no file-tag reader for. Deny in that case, because the two
  // failure modes are not symmetric: a real sphere shown flat is still perfectly
  // viewable, just not pannable, whereas a non-sphere handed to pannellum is
  // visibly wrong. Uncertainty should land on the cheaper mistake.
  return hasSphereAspectRatio(tags, measured) ?? false;
};

/**
 * Whether the photo currently on screen is a panorama. Drives the 360 badge and
 * `PhotoInfoPanel`, both of which sit outside the transition and so describe the
 * current photo rather than a frame. Kept deriving from the live refs, which are
 * committed together with `displayedFrame`, so the two cannot disagree.
 */
const isPanoramaPhoto = computed(() =>
  detectPanorama(exifTags.value, photoFileName.value, measuredDimensions.value),
);

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
const goToPhotoIndex = (index: number, direction?: SlideDirection) => {
  const photoListLength = photosInAlbum.value.length;
  if (photoListLength === 0 || index < 0 || index >= photoListLength) {
    return;
  }

  // `exifTags` is deliberately *not* cleared here any more. The outgoing photo
  // stays on screen for the length of the slide, so blanking its metadata now
  // would empty the info panel and drop the 360 badge while the photo they
  // describe is still visible. The watcher below commits the next photo's tags -
  // `{}` if the read failed - at the same moment it commits the frame.
  // The filmstrip jumps to an arbitrary index, so infer travel from the jump.
  // The chevrons and arrow keys pass `direction` explicitly instead, because at
  // the ends of the album their index movement contradicts the travel: "next"
  // from the last photo wraps to index 0, which looks backwards but is not.
  const inferred: SlideDirection = index > selectedImageIndex.value ? 'next' : 'prev';
  slideDirection.value = direction ?? (index === selectedImageIndex.value ? 'none' : inferred);

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
  // Pass the direction rather than letting it be inferred: wrapping past either
  // end moves the index the opposite way to the travel the user asked for.
  goToPhotoIndex(newIndex, dir > 0 ? 'next' : 'prev');
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
      const nextIndex = findPhotoIndex(newId);

      // This watcher fires on two very different paths. `goToPhotoIndex` has
      // already set the index before its `router.replace` lands here, so
      // `nextIndex` matches and the direction it chose must survive. A genuinely
      // external change - an edited URL, or history navigation - moves the index
      // here for the first time, and carries no gesture to infer a direction
      // from, so it cross-fades rather than inheriting the last chevron's travel.
      if (nextIndex !== selectedImageIndex.value) {
        slideDirection.value = 'none';
      }
      selectedImageIndex.value = nextIndex;

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
    // Identifies this run among any that overlap it. `stale` alone cannot tell
    // "I am obsolete" from "I am the current run": a superseded run reaching its
    // end must not switch the spinner off underneath the run that replaced it.
    const runId = ++latestWatcherRun;

    if (!newValue?.key) {
      // Nothing to load, so nothing may claim to be loading. Covers the
      // `?photo=` not-found path, where `selectedImage` becomes `undefined` and
      // the body below never runs.
      //
      // Unconditional on purpose: there is no `await` between taking `runId` and
      // here, so this run is necessarily still the newest. A `runId ===
      // latestWatcherRun` guard would read as protection against a race that
      // cannot occur at this point.
      loadImage.value = false;
      return;
    }

    {
      // Remove album id for displaying photo file name
      const nextFileName = getPhotoFileName(newValue.key);

      // Rapid navigation (held arrow keys, or the filmstrip) can re-fire this
      // watcher before an earlier `ExifReader.load` settles. Without this guard the
      // last response to resolve wins rather than the photo actually on screen, so
      // `exifTags` - and the date/camera/map and `isPanoramaPhoto` it drives -
      // could describe a different photo. `onCleanup` runs just before the next
      // fire (or on unmount), so a late response is discarded instead of applied.
      // It also gates the frame commit below, which is what keeps a held arrow
      // key from queueing a slide per keypress.
      let stale = false;
      onCleanup(() => {
        stale = true;
      });

      // Must stay `sharedPhotoUrl` - the same builder as the `<img>` `src` and
      // `PanoramaViewer`'s `imageUrl` above, or this becomes a second cache key
      // and a second full download. See its doc comment in `photo-url.ts`.
      const url = sharedPhotoUrl(newValue.url);

      // The very first photo has nothing to look at, so the spinner shows at
      // once. Replacing a photo keeps the old one up and only admits to loading
      // if it drags on - otherwise every navigation would flash a spinner
      // between two photos that are both ready.
      let spinnerTimer: ReturnType<typeof setTimeout> | null = null;
      if (displayedFrame.value === null) {
        loadImage.value = true;
      } else {
        spinnerTimer = setTimeout(() => {
          if (!stale) loadImage.value = true;
        }, SPINNER_DELAY_MS);
      }

      // Always resolves to something committable: `{}` on failure, so a photo
      // whose EXIF cannot be read still replaces the previous photo's metadata
      // rather than inheriting it.
      let nextTags: Partial<ExifData> = {};
      try {
        nextTags = (await ExifReader.load(url)) as ExifData;
      } catch (error) {
        console.error(error);
      }

      // Decided in two passes, because the header cannot always answer it.
      //
      // The first pass uses header dimensions alone. If that says "not a
      // panorama" *only* because the dimensions were missing - a WebP, or
      // anything ImageKit converted - the photo is decoded and the question
      // re-asked with its real size. Decoding it is not wasted work either way:
      // a non-panorama needs the decode anyway to slide in without stuttering,
      // and the bytes are already cached from the EXIF read above.
      let measured: ImageDimensions | null = null;
      let nextIsPanorama = detectPanorama(nextTags, nextFileName, null);

      // Skipped entirely when superseded, so rapid navigation does not decode
      // every photo it passes through only to discard it.
      if (!nextIsPanorama && !stale) {
        measured = await preloadPhoto(url);
        if (hasSphereAspectRatio(nextTags) === null && measured) {
          nextIsPanorama = detectPanorama(nextTags, nextFileName, measured);
        }
      }

      if (spinnerTimer !== null) {
        clearTimeout(spinnerTimer);
      }
      // Only the newest run may clear the spinner. Clearing it unconditionally -
      // as this did - let a superseded run switch it off while its replacement
      // was still fetching, leaving a black stage with no feedback at all for as
      // long as that took.
      if (runId === latestWatcherRun) {
        loadImage.value = false;
      }
      if (stale) return;

      // Committed together, in one tick: the frame the transition keys on, and
      // the metadata the badge and info panel read. Staggering these is what
      // would let an outgoing photo be described by the incoming photo's EXIF
      // part-way through its own leave animation.
      //
      // Reset only when the photo actually changes. The `<img>` is keyed on
      // `displayedFrame.key`, so a re-run for the same key (the album refetching
      // beneath an open lightbox) does not remount it, and nothing would fire
      // `@load` again to restore these.
      if (displayedFrame.value?.key !== newValue.key) {
        naturalWidth.value = 0;
        naturalHeight.value = 0;
      }
      photoFileName.value = nextFileName;
      exifTags.value = nextTags;
      measuredDimensions.value = measured;
      displayedFrame.value = {
        key: newValue.key,
        url,
        isPanorama: nextIsPanorama,
        alt: stripExtension(nextFileName, 'Photo'),
        photo: newValue,
      };
    }
  },
  { deep: true, immediate: true },
);
</script>
