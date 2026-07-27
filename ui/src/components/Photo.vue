<template>
  <div
    v-if="photoStyle === 'grid'"
    :style="{ '--ratio': aspectRatio }"
    :class="['photo-item photo-cell relative', { 'photo-selected rounded-md': isPhotoSelected }]"
    data-test-id="photo-item"
  >
    <!--
      A real <button>, not a click-handling <img>: the image alone is not
      focusable and ignores Enter/Space, which made the lightbox mouse-only. It
      wraps only the image and stays a *sibling* of the admin overlay below -
      that overlay contains buttons of its own, and a <button> inside a <button>
      is invalid HTML that browsers reparent, dropping the inner control out of
      the tab order.
    -->
    <button
      :aria-label="`View ${photoId}`"
      class="focus-visible:outline-primary-400 block h-full w-full cursor-pointer rounded-md focus-visible:outline-2 focus-visible:outline-offset-2"
      data-test-id="open-photo-button"
      type="button"
      @click="goToPhotoDetail"
    >
      <img
        :id="`photo-image-${photo['key']}`"
        :alt="photoAltText"
        :src="thumbnailUrl(photo['url'])"
        :srcset="thumbnailSrcSet(photo['url'])"
        :loading="eager ? 'eager' : 'lazy'"
        :fetchpriority="eager ? 'high' : 'auto'"
        class="bg-surface-200 dark:bg-surface-800 h-full w-full rounded-md object-cover"
        decoding="async"
        @load="onThumbnailLoad"
      />
    </button>
    <div
      v-if="isAdmin"
      class="photo-top-button-container absolute top-0 right-0 left-0 flex justify-between"
    >
      <Button
        v-tooltip="'Select Photo'"
        :severity="`${isPhotoSelected ? 'primary' : 'secondary'}`"
        aria-label="Select photo"
        data-test-id="select-photo-button"
        rounded
        text
        @click="selectPhoto(photo['key'])"
      >
        <template #icon>
          <IconCircleCheckFilled :size="24" />
        </template>
      </Button>
      <EditPhotoButton :photo-key="photo['key']" extra-class="text-white" />
    </div>
    <IconInfoCircle
      v-if="isAlbumCover(photo['key'])"
      v-tooltip="'Album cover'"
      :size="24"
      class="text-primary-600 absolute bottom-1 left-1"
    />
  </div>
  <div
    v-else
    :class="[
      'border-surface-200 hover:border-surface-200 dark:border-surface-800 dark:hover:border-surface-600 dark:bg-surface-800/50 flex h-26 cursor-pointer items-center rounded-md border p-2 hover:shadow-xs sm:h-32 sm:p-3',
      { 'border-primary-400!': isPhotoSelected },
    ]"
    data-test-id="detail-photo-item"
  >
    <!-- A button for the same reason as the grid cell above: the list view is
         the other way into the lightbox, so leaving it a click-handling <div>
         would keep that route mouse-only. -->
    <button
      :aria-label="`View ${photoId}`"
      class="focus-visible:outline-primary-400 relative shrink-0 cursor-pointer rounded-md focus-visible:outline-2 focus-visible:outline-offset-2"
      data-test-id="open-photo-button"
      type="button"
      @click="goToPhotoDetail"
    >
      <SquareImage
        :id="`photo-image-${photo['key']}`"
        :alt="photoAltText"
        :size="thumbnailSize"
        :src="detailThumbnailUrl(photo['url'], thumbnailSize)"
      />
    </button>
    <div class="ml-3 min-w-0 grow" @click="selectPhoto(photo['key'])">
      <div class="text-surface-900 dark:text-surface-300 truncate text-lg">{{ photoId }}</div>
      <div class="text-surface-400 dark:text-surface-500 text-sm">{{ lastModified }}</div>
      <div class="text-surface-400 dark:text-surface-500 text-sm">{{ fileSize }}</div>
    </div>
    <div v-if="isAdmin" class="ml-2 shrink-0">
      <EditPhotoButton :photo-key="photo['key']" />
    </div>
  </div>
</template>

<script lang="ts" setup>
import { EditPhotoButton } from '@/components/button';
import SquareImage from '@/components/SquareImage.vue';
import { useDevice, usePhotoAspectRatios } from '@/composables';
import type { Photo } from '@/schema';
import { useAlbumStore, usePhotoStore, useUserConfigStore } from '@/stores';
import { formatFileSize, stripExtension } from '@/utils/helper';
import { detailThumbnailUrl, photoFileName, thumbnailSrcSet, thumbnailUrl } from '@/utils/photo-url';
import { IconCircleCheckFilled, IconInfoCircle } from '@tabler/icons-vue';
import { storeToRefs } from 'pinia';
import Button from 'primevue/button';
import { useToast } from 'primevue/usetoast';
import { computed, toRefs, type PropType } from 'vue';
import { useRoute, useRouter } from 'vue-router';

const props = defineProps({
  photoStyle: {
    type: String,
    required: true,
  },
  photo: {
    type: Object as PropType<Photo>,
    required: true,
    default: () => ({ key: '', url: '' }),
  },
  eager: {
    type: Boolean,
    default: false,
  },
});

const { photo } = toRefs(props);

const { getRatio, setRatio } = usePhotoAspectRatios();

const route = useRoute();
const router = useRouter();

const { isAdmin } = storeToRefs(useUserConfigStore());
const { isAlbumCover } = useAlbumStore();
const photoStore = usePhotoStore();
const { selectedPhotos } = storeToRefs(photoStore);
const { setSelectedPhotos } = photoStore;
const { isXSmallDevice } = useDevice();
const toast = useToast();

const MAX_SELECTED_PHOTOS = 50;

const photoId = computed(() => photoFileName(photo.value['key']));
const thumbnailSize = computed(() => (isXSmallDevice.value ? 80 : 100));
const aspectRatio = computed(() => getRatio(photo.value['key']));

/** File name without its extension — far more useful to a screen reader than the key. */
const photoAltText = computed(() => stripExtension(photoId.value, ''));
const lastModified = computed(() => new Date(photo.value['lastModified'] ?? '').toLocaleString());
const fileSize = computed(() => formatFileSize(photo.value['size']));
const isPhotoSelected = computed(() => selectedPhotos.value.includes(photo.value['key']));

const goToPhotoDetail = async () => {
  await router.replace({ query: { ...route.query, photo: photoId.value } });
};

const selectPhoto = (key: string) => {
  if (!isAdmin.value) {
    goToPhotoDetail();
    return;
  }
  if (!isPhotoSelected.value && selectedPhotos.value.length >= MAX_SELECTED_PHOTOS) {
    toast.add({
      severity: 'warn',
      summary: 'Selection limit reached',
      detail: `You can select up to ${MAX_SELECTED_PHOTOS} photos at a time.`,
      life: 3000,
    });
    return;
  }
  const newSelectedPhotos = isPhotoSelected.value
    ? selectedPhotos.value.filter((photo) => photo !== key)
    : [...selectedPhotos.value, key];
  setSelectedPhotos(newSelectedPhotos);
};

const onThumbnailLoad = (event: Event) => {
  const img = event.target as HTMLImageElement;
  setRatio(photo.value['key'], img.naturalWidth, img.naturalHeight);
};
</script>

<style lang="scss" scoped>
.photo-item {
  .photo-top-button-container {
    opacity: 0;
    transition: opacity 0.3s ease;

    &:hover {
      cursor: pointer;
      background: rgba(0, 0, 0, 0.2);
      opacity: 1;
      border-radius: 8px 8px 0 0;
    }
  }

  &:hover .photo-top-button-container {
    opacity: 1;
  }
}

.photo-selected {
  .photo-top-button-container {
    opacity: 1;
  }
}
</style>
