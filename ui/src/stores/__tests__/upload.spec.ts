import type { Photo } from '@/schema';
import { PhotoService } from '@/services/photo-service';
import { MAX_PHOTOS_PER_ALBUM } from '@/utils/photo-limits';
import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ref } from 'vue';
import { useUploadStore } from '../upload';

vi.mock('@/services/photo-service', () => ({
  PhotoService: {
    uploadPhotos: vi.fn(),
    extractPhotoMetadata: vi.fn(),
  },
}));

/** Album contents the upload store reads to work out remaining slots. */
const photosInAlbum = ref<Photo[]>([]);

vi.mock('@/stores/photo', () => ({
  usePhotoStore: vi.fn(() => ({
    findPhotoIndex: vi.fn().mockReturnValue(-1),
    photosInAlbum,
  })),
}));

/** `n` placeholder photos, enough to put the album at a given size. */
const albumOf = (n: number): Photo[] =>
  Array.from({ length: n }, (_, i) => ({ url: `u${i}`, key: `album/p${i}.jpg` }));

/**
 * Fresh Pinia, cleared mocks, an empty album and both photo-service calls succeeding.
 *
 * `photosInAlbum` is module-scoped so the mocked photo store can hand the same ref to
 * every `useUploadStore()`, which means it has to be reset between tests.
 */
const resetUploadState = () => {
  setActivePinia(createPinia());
  vi.clearAllMocks();
  photosInAlbum.value = [];
  vi.mocked(PhotoService.uploadPhotos).mockResolvedValue({
    code: 200,
    status: 'Success',
    message: 'ok',
  });
  vi.mocked(PhotoService.extractPhotoMetadata).mockResolvedValue({
    code: 200,
    status: 'Success',
    message: 'ok',
    data: { results: [] },
  });
  globalThis.URL.createObjectURL = vi.fn().mockReturnValue('mock-url');
  globalThis.URL.revokeObjectURL = vi.fn();
};

describe('UploadStore', () => {
  beforeEach(() => {
    resetUploadState();
  });

  const mockFile = new File([''], 'test.jpg', { type: 'image/jpeg' });

  it('should initialize with empty files', () => {
    const store = useUploadStore();
    expect(store.files).toEqual([]);
    expect(store.isUploading).toBe(false);
  });

  it('should add valid files', () => {
    const store = useUploadStore();
    store.addFiles([mockFile]);
    expect(store.files).toHaveLength(1);
    expect(store.files[0]?.fileValidation).toBe('valid');
  });

  it('should handle invalid file format', () => {
    const store = useUploadStore();
    const invalidFile = new File([''], 'test.txt', { type: 'text/plain' });
    store.addFiles([invalidFile]);
    expect(store.files[0]?.fileValidation).toBe('invalid_format');
  });

  it('should remove file', () => {
    const store = useUploadStore();
    store.addFiles([mockFile]);
    const fileToRemove = store.files[0];
    if (fileToRemove) {
      store.removeFile(fileToRemove);
    }
    expect(store.files).toHaveLength(0);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('mock-url');
  });

  it('should clear files', () => {
    const store = useUploadStore();
    store.addFiles([mockFile]);
    store.clearFiles();
    expect(store.files).toHaveLength(0);
    expect(store.isUploading).toBe(false);
  });

  describe('sanitiseFilename', () => {
    it('should allow spaces in filenames', () => {
      const store = useUploadStore();
      const filename = 'photo with spaces.jpg';
      expect(store.sanitiseFilename(filename)).toBe('photo with spaces.jpg');
    });

    it('should replace invalid characters with underscores', () => {
      const store = useUploadStore();
      const filename = 'photo@#%^.jpg';
      expect(store.sanitiseFilename(filename)).toBe('photo____.jpg');
    });

    it('should allow alphanumeric, dots, underscores, and hyphens', () => {
      const store = useUploadStore();
      const filename = 'my-photo_v1.0.jpg';
      expect(store.sanitiseFilename(filename)).toBe('my-photo_v1.0.jpg');
    });
  });
});

describe('UploadStore - post-upload EXIF scan', () => {
  beforeEach(() => {
    resetUploadState();
  });

  it('should ask the server to read EXIF from the photos it uploaded', async () => {
    const store = useUploadStore();
    store.addFiles([new File([''], 'holiday.jpg', { type: 'image/jpeg' })]);

    await store.uploadFiles('album-1');

    expect(PhotoService.extractPhotoMetadata).toHaveBeenCalledWith('album-1', ['holiday.jpg']);
  });

  // The key sent has to match the key the photo was stored under, or the scan looks for an
  // object that is not there.
  it('should send the sanitised filename, matching what was uploaded', async () => {
    const store = useUploadStore();
    store.addFiles([new File([''], 'my photo (1)!.jpg', { type: 'image/jpeg' })]);

    await store.uploadFiles('album-1');

    expect(PhotoService.extractPhotoMetadata).toHaveBeenCalledWith('album-1', [
      store.sanitiseFilename('my photo (1)!.jpg'),
    ]);
  });

  it('should not include a photo whose upload failed', async () => {
    vi.mocked(PhotoService.uploadPhotos)
      .mockResolvedValueOnce({ code: 200, status: 'Success', message: 'ok' })
      .mockRejectedValueOnce(new Error('upload failed'));
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const store = useUploadStore();
    store.addFiles([
      new File([''], 'good.jpg', { type: 'image/jpeg' }),
      new File([''], 'bad.jpg', { type: 'image/jpeg' }),
    ]);

    await store.uploadFiles('album-1');

    const keys = vi.mocked(PhotoService.extractPhotoMetadata).mock.calls[0]?.[1];
    expect(keys).toEqual(['good.jpg']);
  });

  it('should not call the scan at all when nothing uploaded', async () => {
    vi.mocked(PhotoService.uploadPhotos).mockRejectedValue(new Error('upload failed'));
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const store = useUploadStore();
    store.addFiles([new File([''], 'bad.jpg', { type: 'image/jpeg' })]);

    await store.uploadFiles('album-1');

    expect(PhotoService.extractPhotoMetadata).not.toHaveBeenCalled();
  });

  // The photo is in R2 by this point. Reporting the upload as failed would tell the admin
  // to re-upload a file that uploaded perfectly well; the backfill scan can fix the pin.
  it('should not mark an upload failed when the scan call fails', async () => {
    vi.mocked(PhotoService.extractPhotoMetadata).mockRejectedValue(new Error('scan exploded'));
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const store = useUploadStore();
    store.addFiles([new File([''], 'holiday.jpg', { type: 'image/jpeg' })]);

    await store.uploadFiles('album-1');

    expect(store.files[0]?.status).toBe(true);
    expect(store.isCompleteUploading).toBe(true);
  });

  // The server rejects more than 50 keys, so a larger upload has to be split rather than
  // sent and refused.
  it('should split more than 50 uploaded photos into batches', async () => {
    const store = useUploadStore();
    store.addFiles(
      Array.from(
        { length: 51 },
        (_, i) => new File([''], `photo-${i}.jpg`, { type: 'image/jpeg' }),
      ),
    );

    await store.uploadFiles('album-1');

    expect(PhotoService.extractPhotoMetadata).toHaveBeenCalledTimes(2);
    expect(vi.mocked(PhotoService.extractPhotoMetadata).mock.calls[0]?.[1]).toHaveLength(50);
    expect(vi.mocked(PhotoService.extractPhotoMetadata).mock.calls[1]?.[1]).toHaveLength(1);
  });
});

describe('UploadStore - album photo cap', () => {
  beforeEach(() => {
    resetUploadState();
  });

  it('should report the slots left in the album', () => {
    photosInAlbum.value = albumOf(MAX_PHOTOS_PER_ALBUM - 3);
    const store = useUploadStore();

    expect(store.remainingSlots).toBe(3);
  });

  it('should never report negative slots for an album already over the cap', () => {
    photosInAlbum.value = albumOf(MAX_PHOTOS_PER_ALBUM + 10);
    const store = useUploadStore();

    expect(store.remainingSlots).toBe(0);
  });

  it('should accept a batch that exactly fills the album', () => {
    photosInAlbum.value = albumOf(MAX_PHOTOS_PER_ALBUM - 2);
    const store = useUploadStore();
    store.addFiles([
      new File([''], 'a.jpg', { type: 'image/jpeg' }),
      new File([''], 'b.jpg', { type: 'image/jpeg' }),
    ]);

    expect(store.exceedsAlbumCap).toBe(false);
  });

  it('should refuse a batch one photo over the cap', () => {
    photosInAlbum.value = albumOf(MAX_PHOTOS_PER_ALBUM - 1);
    const store = useUploadStore();
    store.addFiles([
      new File([''], 'a.jpg', { type: 'image/jpeg' }),
      new File([''], 'b.jpg', { type: 'image/jpeg' }),
    ]);

    expect(store.exceedsAlbumCap).toBe(true);
  });

  // Invalid files are never sent, so counting them towards the cap would refuse batches
  // that would actually fit.
  it('should not count files that would never be uploaded', () => {
    photosInAlbum.value = albumOf(MAX_PHOTOS_PER_ALBUM - 1);
    const store = useUploadStore();
    store.addFiles([
      new File([''], 'a.jpg', { type: 'image/jpeg' }),
      new File([''], 'notes.txt', { type: 'text/plain' }),
    ]);

    expect(store.exceedsAlbumCap).toBe(false);
  });

  // "Too many" does not tell an admin how many to remove from a selection of sixty.
  it('should say how many slots remain and how many to remove', () => {
    photosInAlbum.value = albumOf(MAX_PHOTOS_PER_ALBUM - 2);
    const store = useUploadStore();
    store.addFiles(
      Array.from({ length: 5 }, (_, i) => new File([''], `p${i}.jpg`, { type: 'image/jpeg' })),
    );

    expect(store.capMessage).toContain('2 more photos');
    expect(store.capMessage).toContain('Remove 3');
  });

  it('should tell an admin to prune a full album rather than offer a count', () => {
    photosInAlbum.value = albumOf(MAX_PHOTOS_PER_ALBUM);
    const store = useUploadStore();
    store.addFiles([new File([''], 'a.jpg', { type: 'image/jpeg' })]);

    expect(store.capMessage).toContain('album is full');
  });

  // Before any request: the upload endpoint is per-file and fires in parallel, so a server
  // refusal would arrive after most of the batch had already gone out.
  it('should upload nothing when the batch would exceed the cap', async () => {
    photosInAlbum.value = albumOf(MAX_PHOTOS_PER_ALBUM);
    const store = useUploadStore();
    store.addFiles([new File([''], 'a.jpg', { type: 'image/jpeg' })]);

    await store.uploadFiles('album-1');

    expect(PhotoService.uploadPhotos).not.toHaveBeenCalled();
    expect(store.isUploading).toBe(false);
  });
});
