<template>
  <template v-if="isFetchingPhotos">
    <SkeletonPhotoList />
  </template>
  <template v-else>
    <div v-if="!showPhotoUploader" class="py-4">
      <div class="flex flex-col items-start pb-4 sm:flex-row sm:items-center">
        <div class="flex w-full items-center sm:w-auto">
          <Button class="shrink-0" rounded @click="goBack">
            <template #icon>
              <IconArrowNarrowLeft :size="24" />
            </template>
          </Button>
          <SelectButton
            v-model="photoStyle"
            :options="photoStyleOptions"
            aria-labelledby="basic"
            class="ml-2 shrink-0"
            @update:model-value="
              (value) => router.replace({ query: { ...route.query, photoStyle: value } })
            "
          >
            <template #option="{ option }">
              <template v-if="option === 'grid'">
                <IconLayoutGrid :size="24" />
              </template>
              <template v-else-if="option === 'map'">
                <IconRoute :size="24" />
              </template>
              <template v-else>
                <IconList :size="24" />
              </template>
            </template>
          </SelectButton>
          <!-- The album's location used to live behind a popover button here, showing a
               250px map of a single point. The map view now always drops that same marker,
               so the popover was a worse version of the view sitting next to it. -->
          <!-- Eye-off, not a padlock: unlisted hides the album from the site, it does
               not make its photos confidential. A lock would imply otherwise. -->
          <IconEyeOff
            v-if="currentAlbum?.isUnlisted"
            v-tooltip="'This album is unlisted'"
            :size="24"
            aria-label="Unlisted album"
            class="text-surface-900 dark:text-surface-300 ml-2"
            role="img"
          />
          <IconStar
            v-else-if="currentAlbum?.isFeatured"
            v-tooltip="'This is a featured album'"
            :size="24"
            class="text-surface-900 dark:text-surface-300 ml-2"
          />
        </div>
        <p
          v-if="currentAlbum?.description"
          class="text-surface-900 dark:text-surface-300 mt-2 w-full py-2 text-lg sm:mt-0 sm:ml-2 sm:w-auto sm:min-w-0 sm:grow"
          data-test-id="album-desc"
        >
          {{ currentAlbum?.description }}
        </p>
      </div>
      <div
        v-if="currentAlbum?.tags?.length && currentAlbum?.tags?.length > 0"
        class="flex flex-wrap gap-2 pb-4"
      >
        <Tag
          v-for="(tag, i) in currentAlbum.tags"
          :key="i"
          :value="tag"
          data-test-id="album-tag"
          severity="success"
        />
      </div>
      <Toolbar
        v-if="isAdmin"
        class="dark:bg-surface-800/50 border-surface-200 dark:border-surface-800 mb-4 bg-gray-50/50 p-2"
        data-test-id="photo-manage-panel"
      >
        <template #start>
          <!-- Hidden rather than disabled at the cap: there is nothing the admin can do
               to this button to make it work, and the album has to be pruned first. The
               count is already in the store, so this costs no extra request. -->
          <Button
            v-if="!isAlbumFull"
            v-tooltip="'Upload photos'"
            aria-label="Upload photos"
            data-test-id="upload-photos-button"
            severity="secondary"
            text
            @click="showPhotoUploader = true"
          >
            <template #icon>
              <IconPhotoUp :size="24" />
            </template>
          </Button>
          <span
            v-else
            class="text-surface-500 dark:text-surface-400 px-2 text-sm"
            data-test-id="album-full-notice"
          >
            Album full ({{ MAX_PHOTOS_PER_ALBUM }} photos)
          </span>
          <!-- Admin-only: writes to every unscanned object in the album. -->
          <Button
            v-tooltip="'Scan photo locations'"
            aria-label="Scan photo locations"
            data-test-id="scan-photo-locations-button"
            severity="secondary"
            text
            @click="dialogStore.setDialogState('scanPhotoLocations', true)"
          >
            <template #icon>
              <IconMapPin :size="24" />
            </template>
          </Button>
          <!-- Until now the album could only be edited from the list page's ⋮ menu, so
               changing a name, tag or location meant navigating back out. A plain button
               rather than that menu: it also carries "Delete Album", which from inside
               the album would delete what you are looking at. GPS tracks are reached
               through this dialog, like every other piece of album metadata. -->
          <Button
            v-tooltip="'Edit album'"
            aria-label="Edit album"
            data-test-id="edit-album-button"
            severity="secondary"
            text
            @click="editAlbum"
          >
            <template #icon>
              <IconEdit :size="24" />
            </template>
          </Button>
        </template>
        <template #center>
          <Button
            v-if="selectedPhotos.length !== photoAmount && selectedPhotos.length < 50"
            v-tooltip="'Select all photos (maximum 50 photos)'"
            data-test-id="select-all-photos-button"
            severity="secondary"
            text
            @click="setSelectedPhotos(photoKeysList)"
          >
            <template #icon>
              <IconChecks :size="24" />
            </template>
          </Button>
          <Button
            v-if="selectedPhotos.length > 0"
            v-tooltip="'Unselect all photos'"
            data-test-id="unselect-all-photos-button"
            severity="secondary"
            text
            @click="setSelectedPhotos([])"
          >
            <template #icon>
              <IconX :size="24" />
            </template>
          </Button>
          <span v-if="selectedPhotos.length > 0" class="ml-2">
            {{ selectedPhotos.length }} selected
          </span>
        </template>
        <template #end>
          <Button
            v-if="selectedPhotos.length > 0"
            v-tooltip.left="'Delete selected photos'"
            severity="secondary"
            text
            @click="dialogStore.setDialogState('deletePhoto', true)"
          >
            <template #icon>
              <IconTrash :size="24" />
            </template>
          </Button>
          <Button
            v-if="selectedPhotos.length > 0"
            v-tooltip.left="'Move selected photos'"
            severity="secondary"
            text
            @click="dialogStore.setDialogState('movePhoto', true)"
          >
            <template #icon>
              <IconFileExport :size="24" />
            </template>
          </Button>
        </template>
      </Toolbar>
      <!-- Map mode replaces the photo list entirely. The grid is guarded on
           `photoStyle !== 'map'` rather than only on the two known list styles so that
           'map' can never reach Photo.vue, which branches on grid vs everything-else and
           would render the detail layout for it. -->
      <AlbumTrackMap v-if="photoStyle === 'map'" />
      <template v-else>
        <div
          v-if="photosInAlbum.length > 0"
          :class="
            photoStyle === 'grid'
              ? 'justified-grid'
              : 'grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4'
          "
        >
          <Photo
            v-for="(photo, index) in photosInAlbum"
            :key="photo.key"
            :eager="photoStyle === 'grid' && index < EAGER_PHOTO_COUNT"
            :photo="photo"
            :photo-style="photoStyle"
          />
          <!-- Keeps the final justified row at a normal height; see justified-grid.css -->
          <template v-if="photoStyle === 'grid'">
            <i v-for="n in 6" :key="`spacer-${n}`" aria-hidden="true" class="photo-cell-spacer" />
          </template>
        </div>
        <h2 v-if="photosInAlbum.length === 0">No results.</h2>
      </template>
      <ScrollTop />
    </div>
    <div v-if="showPhotoUploader && isAdmin" class="py-4">
      <UploadPhotos
        :album-id="currentAlbum?.id"
        @refresh-photo-list="refreshPhotoList"
        @close-photo-uploader="showPhotoUploader = false"
      />
    </div>

    <PhotoDetail
      v-if="photoId"
      @close-photo-detail="closePhotoDetail"
      @refresh-photo-list="refreshPhotoList"
    />
  </template>

  <CreateAlbum v-if="dialogStates.updateAlbum" />
  <ScanPhotoLocations
    v-if="dialogStates.scanPhotoLocations"
    @refresh-photo-list="refreshPhotoList"
  />
  <MovePhotos
    v-if="dialogStates.movePhoto"
    :album-id="currentAlbum?.id"
    @close-photo-detail="closePhotoDetail"
    @refresh-photo-list="refreshPhotoList"
  />
  <DeletePhotos
    v-if="dialogStates.deletePhoto"
    :album-id="currentAlbum?.id"
    @close-photo-detail="closePhotoDetail"
    @refresh-photo-list="refreshPhotoList"
  />
  <RenamePhoto
    v-if="dialogStates.renamePhoto"
    :album-id="currentAlbum?.id"
    @close-photo-detail="closePhotoDetail"
    @refresh-photo-list="refreshPhotoList"
  />
</template>

<script lang="ts" setup>
import {
  CreateAlbum,
  DeletePhotos,
  MovePhotos,
  RenamePhoto,
  ScanPhotoLocations,
} from '@/components/dialog';
import Photo from '@/components/Photo.vue';
import AlbumTrackMap from '@/components/AlbumTrackMap.vue';
import PhotoDetail from '@/components/PhotoDetail.vue';
import SkeletonPhotoList from '@/components/SkeletonPhotoList.vue';
import UploadPhotos from '@/components/UploadPhotos.vue';
import type { Album } from '@/schema';
import { AlbumService } from '@/services/album-service';
import {
  useAlbumStore,
  useDialogStore,
  useGpsTrackStore,
  usePhotoStore,
  useUserConfigStore,
} from '@/stores';
import {
  IconArrowNarrowLeft,
  IconChecks,
  IconFileExport,
  IconLayoutGrid,
  IconList,
  IconEyeOff,
  IconMapPin,
  IconEdit,
  IconPhotoUp,
  IconRoute,
  IconStar,
  IconTrash,
  IconX,
} from '@tabler/icons-vue';
import { MAX_PHOTOS_PER_ALBUM } from '@/utils/photo-limits';
import { storeToRefs } from 'pinia';
import { Button, ScrollTop, SelectButton, Tag, Toolbar } from 'primevue';
import { computed, onUnmounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';

/** The three list styles. Anything else in the query string falls back to grid. */
const PHOTO_STYLES = ['grid', 'detail', 'map'];

/** Cells loaded eagerly so the first screenful does not wait on the lazy-load observer. */
const EAGER_PHOTO_COUNT = 12;

const route = useRoute();
const router = useRouter();

const dialogStore = useDialogStore();
const { dialogStates } = storeToRefs(dialogStore);
const { isAdmin } = storeToRefs(useUserConfigStore());

const photoStore = usePhotoStore();
const { isFetchingPhotos, photosInAlbum, selectedPhotos } = storeToRefs(photoStore);
const { setSelectedPhotos, fetchPhotos } = photoStore;
const { refetchAlbums, setAlbumToBeUpdated } = useAlbumStore();
const { hasTracks, isFetchingTracks } = storeToRefs(useGpsTrackStore());
const { currentAlbum } = storeToRefs(useAlbumStore());

const albumId = computed(() => route.params['albumId'] as string);
const albumYear = computed(() => route.params['year'] as string);
const photoKeysList = computed(() => photosInAlbum.value.map((photo) => photo.key).slice(0, 50)); // Max 50 photos
const photoAmount = computed(() => photosInAlbum.value.length);

/** At or over the cap, so no more photos can be added until some are removed. */
const isAlbumFull = computed(() => photoAmount.value >= MAX_PHOTOS_PER_ALBUM);
const photoId = computed(() => route.query['photo'] as string);

const showPhotoUploader = ref(false);

/** Whether any photo in the album has coordinates to pin on the map. */
const hasPinnedPhotos = computed(() =>
  photosInAlbum.value.some(
    (photo) => typeof photo.latitude === 'number' && typeof photo.longitude === 'number',
  ),
);

/** Whether the album itself carries a location, independent of its photos. */
const hasPlace = computed(() => !!currentAlbum.value?.place);

/**
 * `map` is offered when the album has something to draw — a track, a geotagged photo, or
 * its own location — or to an admin who may be about to add the first of those. A visitor
 * looking at an album with none of them never sees the option.
 *
 * All three count, not just tracks. An album can be entirely geotagged photos with no GPX;
 * and since the album-`place` popover was removed, the map view is now the only way to see
 * the album's own location, so gating it on tracks would hide that from a visitor
 * completely.
 */
const photoStyleOptions = computed(() =>
  hasTracks.value || hasPinnedPhotos.value || hasPlace.value || isAdmin.value
    ? ['grid', 'detail', 'map']
    : ['grid', 'detail'],
);

/**
 * Grid is the default. The query value is checked against the known styles rather than
 * trusted: before `map` existed an unrecognised `?photoStyle=xyz` silently fell through
 * to the detail layout, and it would now fall through to the grid-vs-map branch instead.
 */
const photoStyle = ref(
  PHOTO_STYLES.includes(route.query['photoStyle'] as string)
    ? (route.query['photoStyle'] as string)
    : 'grid',
);

/**
 * Keep the selection to a style actually on offer.
 *
 * `map` is a known style but not always an available one, so a shared
 * `?photoStyle=map` link opened by a visitor on an album with no tracks left the
 * SelectButton bound to a value absent from its options - rendering with nothing
 * selected. `photoStyleOptions` is reactive, so this also covers the tracks arriving or
 * the last one being deleted while the page is open.
 *
 * **It must not run while the answer is still unknown.** Whether `map` is on offer
 * depends on the tracks, the photos and the viewer's role, and all three arrive
 * asynchronously. Running this on mount - when none of them have landed - reset every
 * `?photoStyle=map` deep link to the grid before the map could ever have been offered,
 * so a shared link to the map view never worked. Waiting until both fetches have settled
 * is what makes the deep link survive.
 */
watch(
  [photoStyleOptions, isFetchingPhotos, isFetchingTracks],
  ([options, fetchingPhotos, fetchingTracks]) => {
    if (fetchingPhotos || fetchingTracks) return;
    if (!options.includes(photoStyle.value)) photoStyle.value = 'grid';
  },
  { immediate: true },
);

onUnmounted(() => {
  showPhotoUploader.value = false;
  setSelectedPhotos([]);
});

/**
 * Open the album dialog on the album being viewed.
 *
 * The same two calls `EditAlbum.vue`'s `setAlbum` makes, so the dialog opens in edit
 * mode with `albumToBeUpdate.id` populated - which is also what enables its GPS tracks row.
 */
const editAlbum = () => {
  setAlbumToBeUpdated(currentAlbum.value as Album);
  dialogStore.setDialogState('updateAlbum', true);
};

const goBack = () => {
  if (window.history.state.back === null) {
    router.push({ name: 'albumsByYear', params: { year: albumYear.value } });
  } else {
    router.back();
  }
};

const closePhotoDetail = async () =>
  await router.replace({ query: { ...route.query, photo: undefined } });

const refreshPhotoList = async () => {
  const isPrevAlbumEmpty = photosInAlbum.value.length === 0;
  await fetchPhotos(albumId.value, albumYear.value, true);
  const isCurrentAlbumEmpty = photosInAlbum.value.length === 0;

  let albumToBeUpdated = null;
  if (isPrevAlbumEmpty) {
    // If album is empty before uploading photos, set the first photo as album cover.
    albumToBeUpdated = {
      ...(currentAlbum.value as Album),
      albumCover: photosInAlbum.value[0]?.key as string,
    };
  } else if (!isPrevAlbumEmpty && isCurrentAlbumEmpty) {
    albumToBeUpdated = { ...(currentAlbum.value as Album), albumCover: '' };
  }
  if (albumToBeUpdated) {
    const result = await AlbumService.updateAlbum(albumToBeUpdated);
    if (result.code === 200) {
      await refetchAlbums(albumToBeUpdated.year, true);
    }
  }

  setSelectedPhotos([]);
};

watch(
  albumId,
  (newValue) => {
    if (newValue) {
      fetchPhotos(newValue, albumYear.value);
      setSelectedPhotos([]);
    }
  },
  { immediate: true },
);
</script>
