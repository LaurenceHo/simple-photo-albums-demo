import type { Album, Photo } from '@/schema';
import PhotoList from '@/views/PhotoList.vue';
import { mount } from '@vue/test-utils';
import PrimeVue from 'primevue/config';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { nextTick } from 'vue';
import { type RouteLocationNormalizedLoadedGeneric, useRoute } from 'vue-router';

/** Default route used by every test unless a test overrides it (see the grid/lightbox test below). */
const DEFAULT_ROUTE = { params: { albumId: 'album1', year: '2026' }, query: {} };

vi.mock('vue-router', async () => {
  const actual = (await vi.importActual('vue-router')) as Record<string, unknown>;
  return {
    ...actual,
    useRoute: vi.fn(() => ({ params: { albumId: 'album1', year: '2026' }, query: {} })),
    useRouter: vi.fn(() => ({ replace: vi.fn(), push: vi.fn(), back: vi.fn() })),
  };
});

vi.mock('primevue/usetoast', () => ({ useToast: vi.fn(() => ({ add: vi.fn() })) }));

vi.mock('exifreader', () => ({
  default: {
    load: vi.fn().mockResolvedValue({}),
  },
}));

/*
 * `@/stores` is mocked wholesale rather than via `createTestingPinia`, matching
 * the established pattern in `ui/src/components/__tests__/photo.spec.ts` (see
 * that file's comment for the full rationale: a pinia dual-package hazard plus
 * the fact that every real store PhotoList.vue/Photo.vue touch also call
 * `useQuery`/`useQueryClient`, which would need `VueQueryPlugin` wiring this
 * container-focused test has no need for). `vi.hoisted` is required because
 * `vi.mock` factories are hoisted above imports.
 */
const { mockUserConfigStore, mockAlbumStore, mockPhotoStore, mockDialogStore } = await vi.hoisted(
  async () => {
    const { ref } = await import('vue');
    const { vi } = await import('vitest');

    const albumStore = {
      currentAlbum: ref<Partial<Album>>({
        id: 'album1',
        year: '2026',
        albumName: 'Album 1',
        albumCover: '',
        description: '',
        tags: [],
        isPrivate: false,
      }),
      refetchAlbums: vi.fn(),
      isAlbumCover: vi.fn(() => false),
    };

    // `findPhotoByIndex`/`findPhotoIndex` are only exercised when `PhotoDetail` renders
    // as a child of `PhotoList` (see the grid/lightbox coexistence tests below) - it
    // shares this same mocked `@/stores` module, so it needs these two functions to
    // exist or destructuring them in its own setup throws. Built via an IIFE so both
    // functions can close over the same `photosInAlbum` ref rather than a fresh array.
    const photoStore = (() => {
      const photosInAlbum = ref<Photo[]>([]);
      return {
        isFetchingPhotos: ref(false),
        photosInAlbum,
        selectedPhotos: ref<string[]>([]),
        setSelectedPhotos: vi.fn(),
        fetchPhotos: vi.fn(),
        findPhotoByIndex: vi.fn((index: number) => photosInAlbum.value[index]),
        // Exact match, extension included - mirrors the real store's
        // `photo.key === `${currentAlbum.value.id}/${photoId}`` (see
        // `ui/src/stores/photo.ts`), reading the id from this same mocked
        // album store rather than stripping the extension off the key.
        findPhotoIndex: vi.fn((photoId: string) =>
          photosInAlbum.value.findIndex(
            (photo) => photo.key === `${albumStore.currentAlbum.value.id}/${photoId}`,
          ),
        ),
      };
    })();

    return {
      mockUserConfigStore: { isAdmin: ref(false) },
      mockAlbumStore: albumStore,
      mockPhotoStore: photoStore,
      mockDialogStore: {
        dialogStates: ref({ movePhoto: false, deletePhoto: false, renamePhoto: false }),
        setDialogState: vi.fn(),
      },
    };
  },
);

vi.mock('@/stores', () => ({
  useUserConfigStore: vi.fn(() => mockUserConfigStore),
  useAlbumStore: vi.fn(() => mockAlbumStore),
  usePhotoStore: vi.fn(() => mockPhotoStore),
  useDialogStore: vi.fn(() => mockDialogStore),
}));

/** 15 photos: enough to exceed EAGER_PHOTO_COUNT (12) and prove the cutoff lands there. */
const PHOTOS: Photo[] = Array.from({ length: 15 }, (_, i) => ({
  key: `album1/photo${i}.jpg`,
  url: `https://cdn.test/album1/photo${i}.jpg`,
  size: 1_234_567,
  lastModified: '2026-01-01T00:00:00.000Z',
}));

const mountPhotoList = () =>
  mount(PhotoList, {
    global: {
      plugins: [PrimeVue],
      // Popover's slot content (PhotoLocationMap) instantiates mapbox-gl, which needs a
      // real WebGL canvas jsdom cannot provide. This test never opens the popover, so
      // stubbing it out entirely sidesteps that concern rather than fighting it.
      // `teleport: true` keeps `PhotoDetail`'s dialog (which Teleports to `body`) inside
      // the wrapper's own tree so `wrapper.find(...)` below can see it alongside the grid.
      stubs: { Popover: true, teleport: true },
    },
  });

describe('PhotoList.vue photo grid container', () => {
  beforeEach(() => {
    // jsdom does not implement scrollIntoView at all. Now that the grid/lightbox
    // coexistence tests below resolve `?photo=` to a real index (see the corrected
    // `findPhotoIndex` mock above), `PhotoDetail` renders `PhotoFilmstrip`, which calls
    // `scrollIntoView` on mount to pre-scroll to the active thumbnail. Mirrors the same
    // mock in `ui/src/components/__tests__/photo-detail.spec.ts`.
    Element.prototype.scrollIntoView = vi.fn();

    vi.clearAllMocks();
    mockPhotoStore.isFetchingPhotos.value = false;
    mockPhotoStore.photosInAlbum.value = PHOTOS;
    mockPhotoStore.selectedPhotos.value = [];
    // Reset to the no-photo-selected default every test, so a test that overrides this
    // (see the grid/lightbox coexistence test below) can never leak into a later one
    // regardless of run order - `vi.clearAllMocks()` above clears call history but not
    // an implementation set via `mockReturnValue`.
    vi.mocked(useRoute).mockReturnValue(
      DEFAULT_ROUTE as unknown as RouteLocationNormalizedLoadedGeneric,
    );
  });

  it('renders the justified-grid container in grid mode', () => {
    const wrapper = mountPhotoList();
    expect(wrapper.find('.justified-grid').exists()).toBe(true);
    expect(wrapper.find('.grid-cols-1').exists()).toBe(false);
  });

  it('renders the old grid-cols classes in list (detail) mode', async () => {
    const wrapper = mountPhotoList();
    (wrapper.vm as unknown as { photoStyle: string }).photoStyle = 'detail';
    await nextTick();

    expect(wrapper.find('.grid-cols-1').exists()).toBe(true);
    expect(wrapper.find('.justified-grid').exists()).toBe(false);
  });

  it('renders exactly 6 aria-hidden spacers in grid mode', () => {
    const wrapper = mountPhotoList();
    const spacers = wrapper.findAll('.photo-cell-spacer');
    expect(spacers).toHaveLength(6);
    spacers.forEach((spacer) => expect(spacer.attributes('aria-hidden')).toBe('true'));
  });

  it('renders no spacers in list (detail) mode', async () => {
    const wrapper = mountPhotoList();
    (wrapper.vm as unknown as { photoStyle: string }).photoStyle = 'detail';
    await nextTick();

    expect(wrapper.findAll('.photo-cell-spacer')).toHaveLength(0);
  });

  it('marks only the first 12 photos eager in grid mode', () => {
    const wrapper = mountPhotoList();
    const images = wrapper.findAll('[data-test-id="photo-item"] img');
    expect(images).toHaveLength(15);
    images.forEach((img, index) => {
      expect(img.attributes('loading')).toBe(index < 12 ? 'eager' : 'lazy');
    });
  });

  it('renders no eager photos in list (detail) mode', async () => {
    const wrapper = mountPhotoList();
    (wrapper.vm as unknown as { photoStyle: string }).photoStyle = 'detail';
    await nextTick();

    expect(wrapper.findAll('[data-test-id="photo-item"]')).toHaveLength(0);
    expect(wrapper.findAll('[data-test-id="detail-photo-item"]')).toHaveLength(15);
  });

  it('still shows "No results." for an empty album, with no container at all', () => {
    mockPhotoStore.photosInAlbum.value = [];
    const wrapper = mountPhotoList();

    expect(wrapper.text()).toContain('No results.');
    expect(wrapper.find('.justified-grid').exists()).toBe(false);
    expect(wrapper.find('.photo-cell-spacer').exists()).toBe(false);
  });

  it('keeps the grid mounted underneath the lightbox when a photo is selected', () => {
    // This is the headline behaviour of the lightbox task: the grid used to unmount
    // (`v-if="!photoId && !showPhotoUploader"`) whenever `?photo=` was set. Now only
    // `showPhotoUploader` gates it, so the grid and the lightbox coexist.
    //
    // `photo0.jpg` resolves against `PHOTOS[0]` (`album1/photo0.jpg`) via the mocked
    // `findPhotoIndex` above, so this exercises the happy path: the lightbox actually
    // finds the photo the URL names, rather than merely rendering while stuck on the
    // "not found" placeholder. The `(1/15)` counter is what proves resolution succeeded -
    // see the sibling not-found test below for the failure case.
    vi.mocked(useRoute).mockReturnValue({
      params: { albumId: 'album1', year: '2026' },
      query: { photo: 'photo0.jpg' },
    } as unknown as RouteLocationNormalizedLoadedGeneric);

    const wrapper = mountPhotoList();

    expect(wrapper.findAll('[data-test-id="photo-item"]')).toHaveLength(15);
    expect(wrapper.find('[role="dialog"]').exists()).toBe(true);
    expect(wrapper.find('[data-test-id="photo-index"]').text()).toBe('(1/15)');

    wrapper.unmount();
  });

  it('keeps the grid mounted underneath the lightbox even when the ?photo= id matches no photo', () => {
    // Companion to the happy-path test above: an unresolvable `?photo=` must not tear
    // down the grid/lightbox coexistence either. The lightbox falls back to its "not
    // found" state (`(0/15)`, since `selectedImageIndex` stays -1) rather than crashing
    // or unmounting the grid underneath it.
    vi.mocked(useRoute).mockReturnValue({
      params: { albumId: 'album1', year: '2026' },
      query: { photo: 'does-not-exist.jpg' },
    } as unknown as RouteLocationNormalizedLoadedGeneric);

    const wrapper = mountPhotoList();

    expect(wrapper.findAll('[data-test-id="photo-item"]')).toHaveLength(15);
    expect(wrapper.find('[role="dialog"]').exists()).toBe(true);
    expect(wrapper.find('[data-test-id="photo-index"]').text()).toBe('(0/15)');

    wrapper.unmount();
  });
});
