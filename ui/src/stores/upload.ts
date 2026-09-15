import type { UploadFile as IUploadFile } from '@/schema';
import type { FileValidationStatus } from '@/schema/upload-file';
import { PhotoService } from '@/services/photo-service';
import { usePhotoStore } from '@/stores/photo';
import { remainingPhotoSlots } from '@/utils/photo-limits';
import { defineStore, storeToRefs } from 'pinia';
import { computed, ref } from 'vue';

export const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB in bytes
export const ALLOWED_FILE_TYPE = ['image/png', 'image/jpeg', 'image/webp'];

/**
 * How many photos the EXIF scan accepts per request.
 *
 * Matches the server's cap on `photoKeys`, so a batch of uploads larger than this is split
 * rather than rejected.
 */
const METADATA_BATCH_SIZE = 50;

class UploadFile implements IUploadFile {
  id: string;
  file: File;
  url: string;
  status: 'loading' | boolean | null;
  exists: boolean;
  fileValidation: FileValidationStatus;

  constructor(file: File, fileValidation: FileValidationStatus) {
    this.file = file;
    this.id = `${file.name}-${file.size}-${file.lastModified}-${file.type}`;
    this.url = URL.createObjectURL(file);
    this.status = null;
    this.exists = false;
    this.fileValidation = fileValidation;
  }
}

export const useUploadStore = defineStore('upload', () => {
  const files = ref<IUploadFile[]>([]);
  const isUploading = ref(false);
  const isCompleteUploading = ref(false);
  const overwrite = ref(false);
  const photoStore = usePhotoStore();
  const { findPhotoIndex } = photoStore;
  const { photosInAlbum } = storeToRefs(photoStore);

  const fileExists = (otherId: string) => files.value.some(({ id }) => id === otherId);

  /** Files that would actually be sent — invalid ones are never uploaded. */
  const validFiles = computed(() =>
    files.value.filter((file) => file.fileValidation === 'valid'),
  );

  /**
   * Free slots left in the album.
   *
   * `photosInAlbum` is already in the photo store, so the cap costs no extra request.
   */
  const remainingSlots = computed(() => remainingPhotoSlots(photosInAlbum.value.length));

  /** Whether this batch would take the album past the cap. */
  const exceedsAlbumCap = computed(() => validFiles.value.length > remainingSlots.value);

  /**
   * Why the batch is refused, or an empty string when it is fine.
   *
   * Names the number of free slots rather than just saying "too many": an admin who has
   * selected 60 photos needs to know how many to remove, not that something is wrong.
   */
  const capMessage = computed(() => {
    if (!exceedsAlbumCap.value) {
      return '';
    }
    if (remainingSlots.value === 0) {
      return 'This album is full. Delete or move some photos before adding more.';
    }
    const slotWord = remainingSlots.value === 1 ? 'photo' : 'photos';
    return `Only ${remainingSlots.value} more ${slotWord} can be added to this album. Remove ${validFiles.value.length - remainingSlots.value} from this batch to continue.`;
  });

  const addFiles = (newFiles: File[]) => {
    const newUploadFiles = [...newFiles]
      .filter((file) => !fileExists(`${file.name}-${file.size}-${file.lastModified}-${file.type}`))
      .map((file) => {
        let validationStatus: FileValidationStatus = 'valid';

        if (!ALLOWED_FILE_TYPE.includes(file.type)) {
          validationStatus = 'invalid_format';
          return new UploadFile(file, validationStatus);
        }

        if (file.size > MAX_FILE_SIZE) {
          validationStatus = 'invalid_size';
          return new UploadFile(file, validationStatus);
        }

        return new UploadFile(file, validationStatus);
      });
    files.value = files.value.concat(newUploadFiles);
  };

  const removeFile = (file: IUploadFile) => {
    const index = files.value.indexOf(file);

    if (index > -1) {
      if (file.url) {
        URL.revokeObjectURL(file.url);
        file.url = '';
      }
      files.value.splice(index, 1);
    }
  };

  const clearFiles = () => {
    files.value.forEach((file) => {
      if (file.url) {
        URL.revokeObjectURL(file.url);
        file.url = '';
      }
    });
    files.value = [];
    isCompleteUploading.value = false;
    isUploading.value = false;
    overwrite.value = false;
  };

  const setIsCompleteUploading = (state: boolean) => {
    isCompleteUploading.value = state;
  };

  const sanitiseFilename = (filename: string) => {
    return filename.replaceAll(/[^a-zA-Z0-9._\- ]/g, '_');
  };

  const uploadFile = async (file: IUploadFile, albumId: string) => {
    if (file.fileValidation !== 'valid') {
      file.status = false;
      return;
    }

    file.exists = findPhotoIndex(file.file.name) !== -1;
    file.status = 'loading';
    let response;

    if (file.id.includes('image') && (overwrite.value || (!overwrite.value && !file.exists))) {
      try {
        const uniqueFileName = sanitiseFilename(file.file.name);
        response = await PhotoService.uploadPhotos(file.file, albumId, uniqueFileName);
        file.status = response.status === 'Success';
      } catch (error) {
        console.error(error);
        file.status = false;
      }
    } else {
      file.status = false;
    }

    return response;
  };

  /**
   * Ask the server to read EXIF GPS out of the photos that just landed in R2.
   *
   * Deliberately isolated from the upload's own success. The photo *is* in the bucket by
   * this point, and a failed scan only means it has no pin yet — which the admin backfill
   * can fix later. Marking the upload failed here would tell the admin to re-upload a file
   * that uploaded perfectly well.
   *
   * @param albumId Album the photos were uploaded to.
   */
  const extractMetadataForUploaded = async (albumId: string) => {
    const uploadedKeys = files.value
      .filter((file) => file.status === true)
      .map((file) => sanitiseFilename(file.file.name));

    if (uploadedKeys.length === 0) {
      return;
    }

    for (let index = 0; index < uploadedKeys.length; index += METADATA_BATCH_SIZE) {
      const batch = uploadedKeys.slice(index, index + METADATA_BATCH_SIZE);
      try {
        await PhotoService.extractPhotoMetadata(albumId, batch);
      } catch (error) {
        // Logged, never surfaced as an upload failure - see this function's note.
        console.error('Failed to extract photo metadata after upload:', error);
      }
    }
  };

  const uploadFiles = async (albumId: string) => {
    // Checked before any request is made: the upload endpoint mints one presigned URL per
    // file in parallel, so by the time the server could object, most of the batch is
    // already on its way.
    if (exceedsAlbumCap.value) {
      return;
    }

    isUploading.value = true;
    isCompleteUploading.value = false;

    await Promise.all(files.value.map((file: IUploadFile) => uploadFile(file, albumId)));
    await extractMetadataForUploaded(albumId);

    isUploading.value = false;
    isCompleteUploading.value = true;
  };

  return {
    files,
    isUploading,
    isCompleteUploading,
    overwrite,
    validFiles,
    remainingSlots,
    exceedsAlbumCap,
    capMessage,
    addFiles,
    removeFile,
    clearFiles,
    setIsCompleteUploading, // Kept for compatibility if manually needed, or just let uploadFiles handle it
    uploadFiles,
    sanitiseFilename,
  };
});
