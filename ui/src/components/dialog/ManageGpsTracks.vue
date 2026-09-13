<template>
  <Dialog
    v-model:visible="visible"
    :breakpoints="{ '960px': '75vw', '641px': '90vw' }"
    class="w-[520px]"
    modal
  >
    <template #header>
      <span class="text-lg font-semibold" data-test-id="manage-tracks-title">GPS tracks</span>
    </template>

    <div class="mb-4">
      <p
        v-if="legend.length === 0"
        class="text-surface-500 dark:text-surface-400 py-4 text-center"
        data-test-id="no-tracks-message"
      >
        No GPS tracks yet.
      </p>

      <ul v-else class="flex flex-col gap-1" data-test-id="track-list">
        <li
          v-for="item in legend"
          :key="item.trackId"
          class="border-surface-200 dark:border-surface-800 flex items-center gap-2 rounded-md border p-2"
          data-test-id="track-row"
        >
          <span
            :style="{ backgroundColor: item.colour }"
            aria-hidden="true"
            class="h-3 w-3 shrink-0 rounded-full"
          ></span>
          <span class="min-w-0 grow">
            <span class="text-surface-900 dark:text-surface-300 block truncate">
              {{ item.label }}
            </span>
            <small v-if="item.distanceKm !== undefined" class="text-surface-400">
              {{ item.distanceKm.toFixed(1) }} km
            </small>
          </span>
          <Button
            :disabled="pendingDeleteId === item.trackId"
            :loading="pendingDeleteId === item.trackId"
            :aria-label="`Delete track ${item.label}`"
            data-test-id="delete-track-button"
            severity="danger"
            text
            @click="confirmDelete(item.trackId, item.label)"
          >
            <template #icon>
              <IconTrash :size="20" />
            </template>
          </Button>
        </li>
      </ul>
    </div>

    <Message v-if="errorMessage" class="mb-4" severity="error" data-test-id="track-error">
      {{ errorMessage }}
    </Message>

    <div class="border-surface-200 dark:border-surface-800 border-t pt-4">
      <input
        id="gpx-input"
        ref="fileInput"
        :disabled="isUploading"
        accept=".gpx,application/gpx+xml"
        class="hidden"
        multiple
        type="file"
        @change="onFilesPicked"
      />
      <label
        class="text-surface-900 dark:text-surface-300 block cursor-pointer text-center"
        for="gpx-input"
      >
        <span class="underline">Choose .gpx files</span>
        <small class="text-surface-400 block">Max {{ MAX_GPX_MB }}MB each</small>
      </label>

      <ul v-if="uploads.length" class="mt-3 flex flex-col gap-1" data-test-id="upload-status-list">
        <li
          v-for="upload in uploads"
          :key="upload.filename"
          class="flex items-center justify-between gap-2 text-sm"
          data-test-id="upload-status"
        >
          <span class="min-w-0 truncate">{{ upload.filename }}</span>
          <span
            :class="{
              'text-surface-400': upload.status === 'loading',
              'text-green-600': upload.status === true,
              'text-red-600': upload.status === false,
            }"
            class="shrink-0"
          >
            {{ upload.status === 'loading' ? 'Uploading…' : upload.status ? 'Done' : 'Failed' }}
          </span>
        </li>
      </ul>
    </div>

    <template #footer>
      <Button data-test-id="close-tracks-button" label="Done" @click="close" />
    </template>
  </Dialog>

  <Dialog
    v-model:visible="showDeleteConfirm"
    class="w-[420px]"
    data-test-id="confirm-delete-track-dialog"
    modal
  >
    <template #header>
      <div class="flex">
        <IconAlertCircle :size="40" class="shrink-0 pr-2 text-red-400" />
        <span class="text-lg font-semibold">Delete "{{ trackPendingDelete?.label }}"?</span>
      </div>
    </template>
    <div class="mb-4">
      This removes the uploaded GPX. There is no undo — the only way back is to upload the file
      again.
    </div>
    <template #footer>
      <Button label="Cancel" text @click="showDeleteConfirm = false" />
      <Button data-test-id="confirm-delete-track-button" label="Delete" @click="runDelete" />
    </template>
  </Dialog>
</template>

<script lang="ts" setup>
import { useDialogStore, useGpsTrackStore } from '@/stores';
import { IconAlertCircle, IconTrash } from '@tabler/icons-vue';
import { storeToRefs } from 'pinia';
import { Button, Dialog, Message } from 'primevue';
import { computed, ref } from 'vue';

/**
 * Matches the server's `MAX_GPX_LENGTH`, rejected here so an oversized file never leaves.
 *
 * The server comment explains the number: a GPX DOM costs far more memory than the file,
 * and past ~20,000 points simplification thins the track anyway, so a bigger upload buys
 * no fidelity.
 */
const MAX_GPX_MB = 2;
const MAX_GPX_BYTES = MAX_GPX_MB * 1024 * 1024;

interface UploadStatus {
  filename: string;
  status: 'loading' | boolean | null;
}

const dialogStore = useDialogStore();
const { dialogStates } = storeToRefs(dialogStore);

const gpsTrackStore = useGpsTrackStore();
const { legend } = storeToRefs(gpsTrackStore);
const { uploadTrack, deleteTrack } = gpsTrackStore;

const visible = computed({
  get: () => !!dialogStates.value?.manageGpsTracks,
  set: (value) => dialogStore.setDialogState('manageGpsTracks', value),
});

const fileInput = ref<HTMLInputElement | null>(null);
const uploads = ref<UploadStatus[]>([]);
const isUploading = ref(false);
const errorMessage = ref('');
const pendingDeleteId = ref('');
const showDeleteConfirm = ref(false);
const trackPendingDelete = ref<{ trackId: string; label: string } | null>(null);

/**
 * `trackId` is the filename stem, sanitised the same way photo filenames are.
 *
 * That makes re-uploading the same file a replace rather than a second track, which is
 * why the cap on the server counts only creates.
 */
const toTrackId = (filename: string): string =>
  filename.replace(/\.gpx$/i, '').replaceAll(/[^a-zA-Z0-9._\- ]/g, '_');

const setStatus = (filename: string, status: UploadStatus['status']) => {
  const entry = uploads.value.find((upload) => upload.filename === filename);
  if (entry) entry.status = status;
};

const uploadOne = async (file: File) => {
  if (!file.name.toLowerCase().endsWith('.gpx')) {
    setStatus(file.name, false);
    errorMessage.value = 'Only .gpx files can be uploaded.';
    return;
  }
  if (file.size > MAX_GPX_BYTES) {
    setStatus(file.name, false);
    errorMessage.value = `"${file.name}" is larger than ${MAX_GPX_MB}MB.`;
    return;
  }

  try {
    const gpx = await file.text();
    const result = await uploadTrack(toTrackId(file.name), gpx);

    if (result.code === 200) {
      setStatus(file.name, true);
    } else {
      setStatus(file.name, false);
      // The server's message is the useful one - it names the parse failure or the cap.
      errorMessage.value = result.message ?? 'Upload failed.';
    }
  } catch (error) {
    console.error('Failed to upload GPS track:', error);
    setStatus(file.name, false);
    errorMessage.value = `Could not upload "${file.name}".`;
  }
};

const onFilesPicked = async (event: Event) => {
  const target = event.target as HTMLInputElement;
  const files = [...(target.files ?? [])];
  // Reset immediately, so picking the same file again still fires a change event.
  target.value = '';
  if (files.length === 0) return;

  errorMessage.value = '';
  uploads.value = files.map((file) => ({ filename: file.name, status: 'loading' as const }));
  isUploading.value = true;

  // Sequential rather than Promise.all: each upload reports its own outcome, and one
  // failure must not abandon the rest.
  for (const file of files) {
    await uploadOne(file);
  }

  isUploading.value = false;
};

const confirmDelete = (trackId: string, label: string) => {
  trackPendingDelete.value = { trackId, label };
  showDeleteConfirm.value = true;
};

const runDelete = async () => {
  const pending = trackPendingDelete.value;
  if (!pending) return;

  showDeleteConfirm.value = false;
  pendingDeleteId.value = pending.trackId;
  errorMessage.value = '';

  try {
    const result = await deleteTrack(pending.trackId);
    if (result.code !== 200) {
      errorMessage.value = result.message ?? 'Could not delete the track.';
    }
  } catch (error) {
    console.error('Failed to delete GPS track:', error);
    errorMessage.value = 'Could not delete the track.';
  } finally {
    pendingDeleteId.value = '';
    trackPendingDelete.value = null;
  }
};

const close = () => {
  uploads.value = [];
  errorMessage.value = '';
  visible.value = false;
};
</script>
