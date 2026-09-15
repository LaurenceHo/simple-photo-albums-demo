import ScanPhotoLocations from '@/components/dialog/ScanPhotoLocations.vue';
import type { Photo, PhotoMetadataResult } from '@/schema';
import { PhotoService } from '@/services/photo-service';
import { flushPromises, mount } from '@vue/test-utils';
import PrimeVue from 'primevue/config';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockDialogStore, mockAlbumStore, mockPhotoStore } = await vi.hoisted(async () => {
  const { ref } = await import('vue');
  const { vi } = await import('vitest');
  return {
    mockDialogStore: {
      dialogStates: ref({ scanPhotoLocations: true }),
      setDialogState: vi.fn(),
    },
    mockAlbumStore: {
      currentAlbum: ref({ id: 'test-album', year: '2023' }),
    },
    mockPhotoStore: {
      photosInAlbum: ref([] as Photo[]),
    },
  };
});

vi.mock('@/stores', () => ({
  useAlbumStore: vi.fn(() => mockAlbumStore),
  usePhotoStore: vi.fn(() => mockPhotoStore),
  useDialogStore: vi.fn(() => mockDialogStore),
}));

vi.mock('@/services/photo-service', () => ({
  PhotoService: { extractPhotoMetadata: vi.fn() },
}));

/** A photo in the album, in one of the three scan states. */
const photo = (name: string, hasGps?: boolean): Photo => ({
  url: `https://cdn.example.com/test-album/${name}`,
  key: `test-album/${name}`,
  ...(hasGps === undefined ? {} : { hasGps }),
});

type ScanResponse = Awaited<ReturnType<typeof PhotoService.extractPhotoMetadata>>;

const okResponse = (results: PhotoMetadataResult[]) => ({
  code: 200,
  status: 'Success',
  message: 'ok',
  data: { results },
});

const mountDialog = async () => {
  const wrapper = mount(ScanPhotoLocations, {
    global: {
      plugins: [PrimeVue],
      stubs: { teleport: true },
    },
  });
  // PrimeVue's Dialog renders its footer on the next tick, so every test that reaches a
  // footer button has to let that happen first.
  await flushPromises();
  return wrapper;
};

/** The `photoKeys` array sent on the nth call. */
const keysSentOn = (call: number): string[] | undefined =>
  vi.mocked(PhotoService.extractPhotoMetadata).mock.calls[call]?.[1];

describe('ScanPhotoLocations.vue', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPhotoStore.photosInAlbum.value = [];
    vi.mocked(PhotoService.extractPhotoMetadata).mockResolvedValue(okResponse([]));
  });

  describe('choosing what to scan', () => {
    // `hasGps` is three-valued: true and false both mean "already scanned", only its
    // absence means "not yet". Filtering on missing coordinates instead would re-read
    // every photo that genuinely has no GPS on every single run.
    it('should offer only photos that have never been scanned', async () => {
      mockPhotoStore.photosInAlbum.value = [
        photo('located.jpg', true),
        photo('no-gps.jpg', false),
        photo('fresh.jpg'),
      ];

      const wrapper = await mountDialog();
      await flushPromises();

      expect(wrapper.find('[data-test-id="scan-summary"]').text()).toContain('1 photo');
    });

    it('should send only the unscanned photos, stripped of the album prefix', async () => {
      mockPhotoStore.photosInAlbum.value = [
        photo('already.jpg', false),
        photo('one.jpg'),
        photo('two.jpg'),
      ];

      const wrapper = await mountDialog();
      await wrapper.find('[data-test-id="scan-start-button"]').trigger('click');
      await flushPromises();

      expect(PhotoService.extractPhotoMetadata).toHaveBeenCalledTimes(1);
      expect(keysSentOn(0)).toEqual(['one.jpg', 'two.jpg']);
    });

    // Re-running on an album that is fully scanned must be a no-op, not another pass over
    // every object.
    it('should say there is nothing to do, and disable the start button', async () => {
      mockPhotoStore.photosInAlbum.value = [photo('a.jpg', true), photo('b.jpg', false)];

      const wrapper = await mountDialog();
      await flushPromises();

      expect(wrapper.text()).toContain('already been scanned');
      expect(
        wrapper.find('[data-test-id="scan-start-button"]').attributes('disabled'),
      ).toBeDefined();
      expect(PhotoService.extractPhotoMetadata).not.toHaveBeenCalled();
    });
  });

  describe('batching', () => {
    // The server rejects more than 50 keys per request.
    it('should split the album into batches of 50', async () => {
      mockPhotoStore.photosInAlbum.value = Array.from({ length: 120 }, (_, i) =>
        photo(`photo-${i}.jpg`),
      );

      const wrapper = await mountDialog();
      await wrapper.find('[data-test-id="scan-start-button"]').trigger('click');
      await flushPromises();

      expect(PhotoService.extractPhotoMetadata).toHaveBeenCalledTimes(3);
      expect(keysSentOn(0)).toHaveLength(50);
      expect(keysSentOn(1)).toHaveLength(50);
      expect(keysSentOn(2)).toHaveLength(20);
    });

    it('should stop sending batches once cancelled', async () => {
      mockPhotoStore.photosInAlbum.value = Array.from({ length: 120 }, (_, i) =>
        photo(`photo-${i}.jpg`),
      );

      let resolveFirst: ((value: ScanResponse) => void) | undefined;
      vi.mocked(PhotoService.extractPhotoMetadata).mockReturnValueOnce(
        new Promise<ScanResponse>((resolve) => {
          resolveFirst = resolve;
        }),
      );

      const wrapper = await mountDialog();
      await wrapper.find('[data-test-id="scan-start-button"]').trigger('click');
      await wrapper.find('[data-test-id="scan-cancel-button"]').trigger('click');

      resolveFirst?.(okResponse([]));
      await flushPromises();

      // The in-flight batch finishes - the server has already done that work - but no
      // further batch is sent.
      expect(PhotoService.extractPhotoMetadata).toHaveBeenCalledTimes(1);
      expect(wrapper.find('[data-test-id="scan-cancelled"]').exists()).toBe(true);
    });

    // Stopping a long backfill part-way is normal. Hiding the start button afterwards
    // meant closing and reopening the dialog just to pick it up again.
    it('should let a stopped scan be started again', async () => {
      mockPhotoStore.photosInAlbum.value = Array.from({ length: 60 }, (_, i) =>
        photo(`photo-${i}.jpg`),
      );

      let resolveFirst: ((value: ScanResponse) => void) | undefined;
      vi.mocked(PhotoService.extractPhotoMetadata).mockReturnValueOnce(
        new Promise<ScanResponse>((resolve) => {
          resolveFirst = resolve;
        }),
      );

      const wrapper = await mountDialog();
      await wrapper.find('[data-test-id="scan-start-button"]').trigger('click');
      await wrapper.find('[data-test-id="scan-cancel-button"]').trigger('click');
      resolveFirst?.(okResponse([]));
      await flushPromises();

      const restart = wrapper.find('[data-test-id="scan-start-button"]');
      expect(restart.exists()).toBe(true);
      expect(restart.attributes('disabled')).toBeUndefined();
      expect(restart.text()).toContain('Resume');

      await restart.trigger('click');
      await flushPromises();

      expect(PhotoService.extractPhotoMetadata).toHaveBeenCalledTimes(3);
    });
  });

  describe('reporting', () => {
    it('should summarise how many photos were located', async () => {
      mockPhotoStore.photosInAlbum.value = [photo('a.jpg'), photo('b.jpg'), photo('c.jpg')];
      vi.mocked(PhotoService.extractPhotoMetadata).mockResolvedValue(
        okResponse([
          { photoKey: 'a.jpg', status: 'located', latitude: 1, longitude: 2 },
          { photoKey: 'b.jpg', status: 'noGps' },
          { photoKey: 'c.jpg', status: 'failed' },
        ]),
      );

      const wrapper = await mountDialog();
      await wrapper.find('[data-test-id="scan-start-button"]').trigger('click');
      await flushPromises();

      expect(wrapper.find('[data-test-id="scan-complete"]').text()).toContain('1');
      expect(wrapper.find('[data-test-id="scan-progress"]').exists()).toBe(true);
    });

    // Whatever was written is in R2 already, so the list has to be refetched or the new
    // pins do not appear until a page reload.
    it('should ask for a photo-list refresh so new pins appear without a reload', async () => {
      mockPhotoStore.photosInAlbum.value = [photo('a.jpg')];
      vi.mocked(PhotoService.extractPhotoMetadata).mockResolvedValue(
        okResponse([{ photoKey: 'a.jpg', status: 'located', latitude: 1, longitude: 2 }]),
      );

      const wrapper = await mountDialog();
      await wrapper.find('[data-test-id="scan-start-button"]').trigger('click');
      await flushPromises();

      expect(wrapper.emitted()).toHaveProperty('refreshPhotoList');
    });

    // The API reports failure in the envelope's `code`, not in the HTTP status, so a
    // component branching on `response.ok` would treat this as a success.
    it('should surface a non-200 envelope as an error', async () => {
      mockPhotoStore.photosInAlbum.value = [photo('a.jpg')];
      vi.mocked(PhotoService.extractPhotoMetadata).mockResolvedValue({
        code: 500,
        status: 'Error',
        message: 'boom',
      });

      const wrapper = await mountDialog();
      await wrapper.find('[data-test-id="scan-start-button"]').trigger('click');
      await flushPromises();

      expect(wrapper.find('[data-test-id="scan-error"]').exists()).toBe(true);
    });

    it('should surface a thrown request as an error rather than hanging', async () => {
      mockPhotoStore.photosInAlbum.value = [photo('a.jpg')];
      vi.mocked(PhotoService.extractPhotoMetadata).mockRejectedValue(new Error('network down'));
      vi.spyOn(console, 'error').mockImplementation(() => {});

      const wrapper = await mountDialog();
      await wrapper.find('[data-test-id="scan-start-button"]').trigger('click');
      await flushPromises();

      expect(wrapper.find('[data-test-id="scan-error"]').exists()).toBe(true);
      expect(wrapper.find('[data-test-id="scan-close-button"]').exists()).toBe(true);
    });
  });
});
