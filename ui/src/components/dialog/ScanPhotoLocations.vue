<template>
  <Dialog
    :closable="!isScanning"
    :draggable="false"
    :breakpoints="{ '640px': '92vw' }"
    :style="{ width: '32rem' }"
    :visible="true"
    header="Scan photo locations"
    modal
    @update:visible="close"
  >
    <div class="flex flex-col gap-4">
      <p class="text-surface-600 dark:text-surface-300">
        Reads the GPS coordinates saved in each photo by the camera, so the photos can be
        pinned on the album map. Photos are read on the server — nothing is downloaded to
        this browser.
      </p>

      <Message v-if="unscannedCount === 0 && !hasFinished" severity="info">
        Every photo in this album has already been scanned.
      </Message>

      <p v-else-if="!hasStarted" data-test-id="scan-summary">
        {{ unscannedCount }} {{ unscannedCount === 1 ? 'photo has' : 'photos have' }} not been
        scanned yet.
      </p>

      <!-- `aria-live="polite"` so a screen reader hears the count climb without the
           progress bar itself having to be focusable. -->
      <div v-if="hasStarted" aria-live="polite" class="flex flex-col gap-2">
        <ProgressBar :value="percentComplete" data-test-id="scan-progress" />
        <p class="text-surface-600 dark:text-surface-300 text-sm">
          {{ processedCount }} of {{ totalToScan }} scanned
          <span v-if="locatedCount > 0"> · {{ locatedCount }} with a location</span>
          <span v-if="noGpsCount > 0"> · {{ noGpsCount }} without</span>
          <span v-if="failedCount > 0" class="text-red-600"> · {{ failedCount }} failed</span>
        </p>
      </div>

      <Message v-if="errorMessage" data-test-id="scan-error" severity="error">
        {{ errorMessage }}
      </Message>

      <Message v-else-if="hasFinished && wasCancelled" data-test-id="scan-cancelled" severity="warn">
        Scan stopped. {{ locatedCount }} of {{ processedCount }} scanned photos had a location;
        the rest of the album is unchanged.
      </Message>

      <Message v-else-if="hasFinished" data-test-id="scan-complete" severity="success">
        Finished. {{ locatedCount }}
        {{ locatedCount === 1 ? 'photo has' : 'photos have' }} a location.
      </Message>
    </div>

    <template #footer>
      <Button
        v-if="isScanning"
        data-test-id="scan-cancel-button"
        label="Stop"
        outlined
        severity="secondary"
        @click="cancel"
      />
      <Button v-else data-test-id="scan-close-button" label="Close" outlined @click="close" />
      <!-- Offered whenever there is still something to scan, rather than hidden once the
           run ends: stopping a backfill part-way is a normal thing to do, and hiding this
           meant closing and reopening the dialog to pick it up again. -->
      <Button
        v-if="!isScanning"
        :disabled="unscannedCount === 0"
        :label="hasStarted ? 'Resume scan' : 'Start scan'"
        data-test-id="scan-start-button"
        @click="start"
      />
    </template>
  </Dialog>
</template>

<script lang="ts" setup>
import type { PhotoMetadataResult } from '@/schema';
import { PhotoService } from '@/services/photo-service';
import { useAlbumStore, useDialogStore, usePhotoStore } from '@/stores';
import { photoFileName } from '@/utils/photo-url';
import { storeToRefs } from 'pinia';
import { Button, Dialog, Message, ProgressBar } from 'primevue';
import { computed, ref } from 'vue';

/**
 * How many photos go in one request. The server rejects more than this, so it is a
 * contract rather than a tuning knob.
 */
const BATCH_SIZE = 50;

const emits = defineEmits(['refreshPhotoList']);

const dialogStore = useDialogStore();
const { photosInAlbum } = storeToRefs(usePhotoStore());
const { currentAlbum } = storeToRefs(useAlbumStore());

const isScanning = ref(false);
const hasStarted = ref(false);
const hasFinished = ref(false);
const wasCancelled = ref(false);
const errorMessage = ref('');
const totalToScan = ref(0);
const results = ref<PhotoMetadataResult[]>([]);

/**
 * Set when the viewer presses Stop.
 *
 * Read between batches rather than aborting a request in flight: a batch the server has
 * already started will finish and write its metadata either way, so tearing the
 * connection down would only lose the results of work that still happened.
 */
let cancelRequested = false;

/**
 * Photos that have never been scanned.
 *
 * `hasGps` is three-valued on purpose — `true` and `false` both mean "already scanned",
 * and only its absence means "not yet". Filtering on missing coordinates instead would
 * re-read every photo that genuinely has no GPS on every run, forever.
 */
const unscannedPhotos = computed(() =>
  photosInAlbum.value.filter((photo) => photo.hasGps === undefined),
);

const unscannedCount = computed(() => unscannedPhotos.value.length);
const processedCount = computed(() => results.value.length);

const countOf = (status: PhotoMetadataResult['status']) =>
  results.value.filter((result) => result.status === status).length;

const locatedCount = computed(() => countOf('located'));
const noGpsCount = computed(() => countOf('noGps'));
const failedCount = computed(() => countOf('failed') + countOf('notFound'));

const percentComplete = computed(() =>
  totalToScan.value === 0 ? 0 : Math.round((processedCount.value / totalToScan.value) * 100),
);

const start = async () => {
  const keys = unscannedPhotos.value.map((photo) => photoFileName(photo.key));
  const albumId = currentAlbum.value.id;

  if (keys.length === 0 || !albumId) {
    return;
  }

  cancelRequested = false;
  wasCancelled.value = false;
  errorMessage.value = '';
  results.value = [];
  totalToScan.value = keys.length;
  hasStarted.value = true;
  isScanning.value = true;

  try {
    for (let index = 0; index < keys.length; index += BATCH_SIZE) {
      if (cancelRequested) {
        wasCancelled.value = true;
        break;
      }

      const batch = keys.slice(index, index + BATCH_SIZE);
      const { data, code } = await PhotoService.extractPhotoMetadata(albumId, batch);

      // The API envelope reports failure in `code`, not in the HTTP status.
      if (code !== 200 || !data) {
        errorMessage.value = 'The scan failed. Photos scanned so far have been saved.';
        break;
      }

      results.value = results.value.concat(data.results);
    }
  } catch (error) {
    console.error('Failed to scan photo locations:', error);
    errorMessage.value = 'The scan failed. Photos scanned so far have been saved.';
  } finally {
    isScanning.value = false;
    hasFinished.value = true;
    // Whatever was written is already in R2, so the list is refreshed even after a stop
    // or an error - that is what puts the new pins on the map without a page reload.
    if (results.value.length > 0) {
      emits('refreshPhotoList');
    }
  }
};

const cancel = () => {
  cancelRequested = true;
};

const close = () => {
  if (isScanning.value) {
    return;
  }
  dialogStore.setDialogState('scanPhotoLocations', false);
};
</script>
