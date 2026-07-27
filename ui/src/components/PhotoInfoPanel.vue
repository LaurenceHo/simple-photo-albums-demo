<template>
  <div>
    <div class="mx-4 flex justify-between">
      <span class="text-semibold text-surface-900 dark:text-surface-300 text-2xl">Details</span>
    </div>
    <Divider v-if="localDateTime" />
    <div v-if="localDateTime" data-test-id="photo-info-date" class="mx-4 flex items-center">
      <IconCalendarTime :size="24" class="mr-4" aria-hidden="true" />
      <span class="text-surface-900 dark:text-surface-300">{{ localDateTime }}</span>
    </div>
    <Divider v-if="(imageOriginalHeight && imageOriginalWidth) || photoFileName || fileSize" />
    <div
      v-if="(imageOriginalHeight && imageOriginalWidth) || photoFileName || fileSize"
      data-test-id="photo-info-file"
      class="mx-4 flex items-center"
    >
      <IconPhoto :size="24" class="mr-4" aria-hidden="true" />
      <div class="text-surface-900 dark:text-surface-300">
        <div v-if="photoFileName">{{ photoFileName }}</div>
        <div v-if="imageOriginalHeight && imageOriginalWidth">
          {{
            isPhotoLandscape || exifTags.Orientation?.value === 0
              ? `${imageOriginalWidth} x ${imageOriginalHeight}`
              : `${imageOriginalHeight} x ${imageOriginalWidth}`
          }}
        </div>
        <!--
          `block` on both: <small> is inline, and Vue's whitespace condensing drops
          the text node between two sibling elements, so without it these two run
          straight together as "3.35 MBf/1.8" instead of stacking.
        -->
        <small
          v-if="fileSummary"
          class="text-surface-400 dark:text-surface-500 block"
          data-test-id="photo-info-summary"
        >
          {{ fileSummary }}
        </small>
        <small
          v-if="imageOriginalHeight && imageOriginalWidth && cameraSettings"
          class="text-surface-400 dark:text-surface-500 block"
          data-test-id="photo-info-settings"
        >
          {{ cameraSettings }}
        </small>
      </div>
    </div>
    <Divider v-if="exifTags.Model" />
    <div v-if="exifTags.Model" data-test-id="photo-info-camera" class="mx-4 flex items-center">
      <IconCamera :size="24" class="mr-4" aria-hidden="true" />
      <div class="text-surface-900 dark:text-surface-300">
        <div>
          {{ exifTags.Make?.description }} {{ (exifTags.Model as StringArrayTag).value[0] }}
        </div>
        <small v-if="exifTags.LensModel" class="text-surface-400 dark:text-surface-500">
          {{ (exifTags.LensModel as StringArrayTag).value[0] }}
        </small>
      </div>
    </div>
    <Divider v-if="exifTags.GPSLatitudeRef && exifTags.GPSLongitudeRef" />
    <div
      v-if="
        exifTags.GPSLatitudeRef &&
        exifTags.GPSLongitudeRef &&
        longitude > -1000 &&
        latitude > -1000
      "
      data-test-id="photo-info-map"
      role="group"
      aria-label="Photo location map"
      class="mx-4"
    >
      <PhotoLocationMap :latitude="latitude" :longitude="longitude" />
    </div>
  </div>
</template>

<script lang="ts" setup>
import PhotoLocationMap from '@/components/PhotoLocationMap.vue';
import type { ExifData, Photo } from '@/schema';
import { formatFileSize } from '@/utils/helper';
import { photoFileName as getPhotoFileName } from '@/utils/photo-url';
import { IconCalendarTime, IconCamera, IconPhoto } from '@tabler/icons-vue';
import type { NumberTag, RationalTag, StringArrayTag } from 'exifreader';
import { Divider } from 'primevue';
import { computed } from 'vue';

const props = defineProps<{
  photo: Photo | undefined;
  exifTags: Partial<ExifData>;
  naturalWidth: number;
  naturalHeight: number;
  isPanorama: boolean;
}>();

const photoFileName = computed(() => (props.photo ? getPhotoFileName(props.photo.key) : ''));

/** Compute photo EXIF data begin */
const localDateTime = computed(() => {
  let dateTime = props.exifTags.DateTime?.description;
  const offsetTime = props.exifTags.OffsetTime?.value?.[0] ?? '';

  if (!dateTime && photoFileName.value) {
    // Try to parse from filename pattern: YYYY-MM-DD_HH.MM.SS or YYYY-MM-DD
    const match = photoFileName.value.match(
      /^(\d{4})-(\d{2})-(\d{2})(_(\d{2})\.(\d{2})\.(\d{2}))?/,
    );
    if (match) {
      const [, year, month, day, , hour, minute, second] = match;
      dateTime = `${year}:${month}:${day} ${hour || '00'}:${minute || '00'}:${second || '00'}`;
    }
  }

  if (dateTime) {
    // Validate format: "YYYY:MM:DD HH:MM:SS"
    if (!/^\d{4}:\d{2}:\d{2} \d{2}:\d{2}:\d{2}$/.test(dateTime)) {
      return null;
    }

    // Convert EXIF date format to ISO format
    const isoDateTime = dateTime.replace(/^(\d{4}):(\d{2}):(\d{2})/, '$1-$2-$3');
    const date = new Date(isoDateTime);

    // Validate parsed date
    if (Number.isNaN(date.getTime())) {
      return null;
    }
    return `${date.toLocaleString()} ${offsetTime}`;
  }
  return null;
});

const latitude = computed(() => {
  if (props.exifTags.GPSLatitude?.description) {
    if (props.exifTags.GPSLatitudeRef?.value[0] === 'S') {
      return Number(props.exifTags.GPSLatitude?.description) * -1;
    }
    return Number(props.exifTags.GPSLatitude?.description);
  }
  return -1000;
});

const longitude = computed(() => {
  if (props.exifTags.GPSLongitude?.description) {
    if (props.exifTags.GPSLongitudeRef?.value[0] === 'W') {
      return Number(props.exifTags.GPSLongitude?.description) * -1;
    }
    return Number(props.exifTags.GPSLongitude?.description);
  }
  return -1000;
});

/**
 * Aperture, formatted for an `f/` prefix — or `null` when there is nothing worth
 * showing.
 *
 * `null` rather than a formatted-string sentinel: this used to return `'0.0'` for
 * "absent" and callers compared against that literal, which quietly rendered
 * `f/NaN` whenever a description was non-numeric (`parseFloat` gives `NaN`,
 * `toFixed` turns that into the *string* `'NaN'`, which is not `'0.0'`).
 * `Number.isFinite` covers both cases. No lens reports f/0, so a parsed zero
 * means the tag was missing or unusable.
 */
const aperture = computed<string | null>(() => {
  const value = Number.parseFloat(
    props.exifTags.ApertureValue?.description ?? props.exifTags.MaxApertureValue?.description ?? '',
  );
  return Number.isFinite(value) && value > 0 ? value.toFixed(1) : null;
});

/**
 * Exposure bias, formatted for an `EV` prefix — or `null` when there is nothing
 * worth showing. Zero is a real, valid reading, but it is also the default and
 * tells the user nothing, so it is hidden exactly like an absent tag.
 * See `aperture` above for why this is `null` and not a sentinel string.
 */
const exposureBias = computed<string | null>(() => {
  const value = Number.parseFloat(props.exifTags.ExposureBiasValue?.description ?? '');
  // Below half of the last displayed decimal, `toFixed(2)` renders "0.00" anyway,
  // so treat that as nothing to show rather than printing "EV0.00".
  return Number.isFinite(value) && Math.abs(value) >= 0.005 ? value.toFixed(2) : null;
});

/**
 * `naturalWidth`/`naturalHeight` come straight from the lightbox `<img>` in
 * `PhotoDetail.vue`, which loads via `sharedPhotoUrl()` - no dimension
 * transform, so these are the true original resolution. They are `0` before
 * the `<img>` fires `load` (or if it fails, or for a panorama where no `<img>`
 * ever mounts), so the EXIF `Image Width`/`Image Height` fallback below covers
 * those cases - parsed from the same `sharedPhotoUrl()` file's own header, so
 * it agrees with `naturalWidth`/`naturalHeight` rather than describing a
 * differently-sized copy.
 */
const imageOriginalWidth = computed(
  () => props.naturalWidth || Number(props.exifTags['Image Width']?.value ?? 0),
);
const imageOriginalHeight = computed(
  () => props.naturalHeight || Number(props.exifTags['Image Height']?.value ?? 0),
);
const isPhotoLandscape = computed(
  () =>
    (props.isPanorama ||
      !props.exifTags.Orientation ||
      props.exifTags.Orientation?.value === 0 ||
      props.exifTags.Orientation?.value === 1 ||
      props.exifTags.Orientation?.value === 3) &&
    imageOriginalWidth.value > imageOriginalHeight.value,
);
/** Compute photo EXIF data end */

/**
 * Megapixels, matching how Google Photos labels a file.
 *
 * Derived from `imageOriginalWidth`/`imageOriginalHeight` - the same resolved
 * values the `W x H` dimensions line above uses - rather than the raw
 * `naturalWidth`/`naturalHeight` props directly. Those props are 0 whenever
 * dimensions are known only from the EXIF `Image Width`/`Image Height`
 * fallback (the image itself never loaded, or failed to), which used to mean
 * the dimensions line rendered while this line silently vanished.
 */
const megaPixels = computed(() => {
  const pixels = imageOriginalWidth.value * imageOriginalHeight.value;
  // `!Number.isFinite` also guards a malformed EXIF fallback (e.g. a multi-value
  // tag coercing to NaN via `Number(...)`) from ever rendering "NaN MP".
  if (!Number.isFinite(pixels) || pixels <= 0) {
    return '';
  }
  const mp = pixels / 1_000_000;
  // Below 1MP an integer round yields a meaningless "0 MP", so use one decimal.
  return mp < 1 ? `${mp.toFixed(1)} MP` : `${Math.round(mp)} MP`;
});

/** Human-readable file size. */
const fileSize = computed(() => formatFileSize(props.photo?.size));

/** Joins the parts that have a value, so an absent one leaves no stray separator. */
const joinDetails = (parts: (string | null | undefined)[]): string =>
  parts.filter((part): part is string => Boolean(part)).join(' | ');

/** Megapixels and file size, either of which may be unknown on its own. */
const fileSummary = computed(() => joinDetails([megaPixels.value, fileSize.value]));

/**
 * Camera settings, in capture order: aperture, shutter, focal length, ISO,
 * exposure bias. Only the ones actually present appear.
 *
 * Assembled here rather than as sibling `<span>`s in the template, where each
 * one's leading separator was gated on a cumulative OR of every setting before
 * it — five conditions deep by the last, and adding a sixth setting would have
 * meant editing every condition after it. Position no longer affects the markup.
 */
const cameraSettings = computed(() =>
  joinDetails([
    aperture.value && `f/${aperture.value}`,
    (props.exifTags.ExposureTime as RationalTag | undefined)?.description,
    (props.exifTags.FocalLength as RationalTag | undefined)?.description,
    props.exifTags.ISOSpeedRatings &&
      `ISO${(props.exifTags.ISOSpeedRatings as NumberTag).description}`,
    exposureBias.value && `EV${exposureBias.value}`,
  ]),
);
</script>
