import Photo from '@/components/Photo.vue';
import { __resetAspectRatioCache } from '@/composables/use-photo-aspect-ratios';
import { usePhotoAspectRatios } from '@/composables';
import { mount } from '@vue/test-utils';
import PrimeVue from 'primevue/config';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * A single shared `replace` spy. `useRouter: vi.fn(() => ({ replace: vi.fn() }))`
 * would hand every call a fresh spy, leaving nothing for a test to assert against.
 */
const { mockRouterReplace } = vi.hoisted(() => ({ mockRouterReplace: vi.fn() }));

vi.mock('vue-router', async () => {
  const actual = (await vi.importActual('vue-router')) as Record<string, unknown>;
  return {
    ...actual,
    useRoute: vi.fn(() => ({ params: { albumId: 'album', year: '2026' }, query: {} })),
    useRouter: vi.fn(() => ({ replace: mockRouterReplace, push: vi.fn() })),
  };
});

vi.mock('primevue/usetoast', () => ({ useToast: vi.fn(() => ({ add: vi.fn() })) }));

/*
 * `@/stores` is mocked rather than relying on `createTestingPinia`, as the brief's
 * literal test code does. In this repo/dependency state, `createTestingPinia`'s
 * internal `setActivePinia` call lands on a physically different in-memory copy of
 * the `pinia` module than the one `@/stores`'s `defineStore` calls resolve to (a
 * dual-package-hazard from the workspace's node_modules layout) — confirmed by a
 * throwaway repro where `getActivePinia()` read via a plain `import ... from 'pinia'`
 * came back `undefined` immediately after `createTestingPinia()` supposedly set it.
 * This is the exact same root cause, and the exact same error
 * (`getActivePinia() was called but there was no active Pinia`), as the five
 * pre-existing failing spec files noted in the task brief; it is not new. Every real
 * store Photo.vue touches (`useUserConfigStore`, `useAlbumStore`, `usePhotoStore`)
 * also calls `useQuery`/`useQueryClient` internally, so even a manually activated
 * real Pinia instance would additionally require `VueQueryPlugin` wiring the brief's
 * test omits. Mocking `@/stores` sidesteps both problems and matches this repo's own
 * established working pattern for exactly this situation
 * (`ui/src/components/dialog/__tests__/rename-photo.spec.ts`, 7/7 passing). Using
 * `vi.hoisted` because `vi.mock` factories are hoisted above imports.
 */
const { mockUserConfigStore, mockAlbumStore, mockPhotoStore, mockDialogStore } = await vi.hoisted(
  async () => {
    const { ref } = await import('vue');
    const { vi } = await import('vitest');
    return {
      mockUserConfigStore: { isAdmin: ref(false) },
      mockAlbumStore: { isAlbumCover: vi.fn(() => false) },
      mockPhotoStore: { selectedPhotos: ref<string[]>([]), setSelectedPhotos: vi.fn() },
      mockDialogStore: { dialogStates: ref({}), setDialogState: vi.fn() },
    };
  },
);

vi.mock('@/stores', () => ({
  useUserConfigStore: vi.fn(() => mockUserConfigStore),
  useAlbumStore: vi.fn(() => mockAlbumStore),
  usePhotoStore: vi.fn(() => mockPhotoStore),
  useDialogStore: vi.fn(() => mockDialogStore),
}));

const PHOTO = {
  key: 'album/photo1.jpg',
  url: 'https://cdn.test/album/photo1.jpg',
  size: 1_234_567,
  lastModified: '2026-01-01T00:00:00.000Z',
};

/**
 * `EditPhotoButton` is stubbed and `v-tooltip` registered as a no-op because both
 * only appear on the admin path, and mounting the real one would drag in
 * `AlbumService`/`useMutation`/the dialog store - none of which these tests are
 * about. It is stubbed under `EditPhoto`, the `<script setup>` filename Vue
 * resolves it by, with the import alias listed too so a rename cannot silently
 * un-stub it.
 */
const GLOBAL = {
  plugins: [PrimeVue],
  directives: { tooltip: {} },
  stubs: { EditPhoto: true, EditPhotoButton: true },
};

const mountPhoto = (eager = false) =>
  mount(Photo, {
    props: { photoStyle: 'grid', photo: PHOTO, eager },
    global: GLOBAL,
  });

describe('Photo.vue justified grid cell', () => {
  beforeEach(() => {
    localStorage.clear();
    __resetAspectRatioCache();
    mockRouterReplace.mockClear();
    mockUserConfigStore.isAdmin.value = false;
  });

  it('falls back to the 3:2 default ratio before the image loads', () => {
    const cell = mountPhoto().find('[data-test-id="photo-item"]');
    // Anchored so it cannot also match --ratio: 1.55 or --ratio: 15.
    expect(cell.attributes('style')).toMatch(/--ratio:\s*1\.5\b/);
  });

  it('requests a height-only thumbnail so the aspect ratio survives', () => {
    const img = mountPhoto().find('img');
    expect(img.attributes('src')).toBe('https://cdn.test/album/photo1.jpg?tr=h-320');
    expect(img.attributes('srcset')).toContain('?tr=h-640 2x');
  });

  it('writes the measured ratio back to the cache on load', async () => {
    const wrapper = mountPhoto();
    const img = wrapper.find('img');

    // jsdom never loads images, so naturalWidth/Height must be defined by hand
    // and the load event dispatched synthetically.
    Object.defineProperty(img.element, 'naturalWidth', { value: 4000, configurable: true });
    Object.defineProperty(img.element, 'naturalHeight', { value: 2000, configurable: true });
    await img.trigger('load');
    await wrapper.vm.$nextTick();

    expect(wrapper.find('[data-test-id="photo-item"]').attributes('style')).toMatch(
      /--ratio:\s*2\b/,
    );
  });

  it('lazy-loads by default and eager-loads when told to', () => {
    expect(mountPhoto(false).find('img').attributes('loading')).toBe('lazy');
    expect(mountPhoto(true).find('img').attributes('loading')).toBe('eager');
    expect(mountPhoto(true).find('img').attributes('fetchpriority')).toBe('high');
  });

  it('uses the file name as alt text rather than the raw key', () => {
    expect(mountPhoto().find('img').attributes('alt')).toBe('photo1');
  });

  // Sonar fix: the list/detail branch used to hand SquareImage a raw
  // `photo image ${key}` alt - "photo image" is redundant (screen readers already
  // announce "image") and the raw storage key is noise. Matches the grid branch's
  // photoAltText above.
  it('uses the file name as alt text in the detail/list view too, not the raw key', () => {
    const wrapper = mount(Photo, {
      props: { photoStyle: 'detail', photo: PHOTO },
      global: GLOBAL,
    });
    expect(wrapper.find('img').attributes('alt')).toBe('photo1');
  });

  it('renders an already-cached ratio immediately, without waiting for a load event', () => {
    // Simulates revisiting an album: the composable's cache (backed by localStorage)
    // already has a measured ratio for this key before the component ever mounts.
    const { setRatio } = usePhotoAspectRatios();
    setRatio(PHOTO.key, 4000, 2000); // 2:1

    const cell = mountPhoto().find('[data-test-id="photo-item"]');
    expect(cell.attributes('style')).toMatch(/--ratio:\s*2\b/);
  });

  // --- Keyboard access: the cell must be operable without a mouse ---
  //
  // The opener used to be a bare `<img @click>`: not focusable, not in the tab
  // order, and inert to Enter/Space, so the lightbox was mouse-only and
  // `PhotoDetail`'s focus-restore-on-close had nothing to restore to.

  it('exposes the grid opener as a real button element, not a click-handling img', () => {
    const opener = mountPhoto().find('[data-test-id="open-photo-button"]');
    expect(opener.exists()).toBe(true);
    expect(opener.element.tagName).toBe('BUTTON');
    // Without type="button" a button inside a future <form> would submit it.
    expect(opener.attributes('type')).toBe('button');
  });

  it('keeps the grid opener in the natural tab order', () => {
    // A negative tabindex would make it focusable only programmatically, which
    // is exactly the gap this change closes.
    expect(
      mountPhoto().find('[data-test-id="open-photo-button"]').attributes('tabindex'),
    ).toBeUndefined();
  });

  it('navigates to the photo when the opener is activated', async () => {
    await mountPhoto().find('[data-test-id="open-photo-button"]').trigger('click');
    expect(mockRouterReplace).toHaveBeenCalledWith({ query: { photo: 'photo1.jpg' } });
  });

  it('names the opener as an action rather than leaving the raw key to be read out', () => {
    expect(mountPhoto().find('[data-test-id="open-photo-button"]').attributes('aria-label')).toBe(
      'View photo1.jpg',
    );
  });

  it('never nests the admin controls inside the opener button', () => {
    // A <button> inside a <button> is invalid HTML: browsers reparent it, which
    // drops the inner control out of the tab order and can detach its listener.
    // The admin overlay must stay a sibling of the opener, not a child.
    mockUserConfigStore.isAdmin.value = true;
    const wrapper = mountPhoto();

    expect(wrapper.find('[data-test-id="select-photo-button"]').exists()).toBe(true);
    expect(wrapper.findAll('button button')).toHaveLength(0);
    expect(wrapper.findAll('[data-test-id="open-photo-button"] button')).toHaveLength(0);
  });

  it('does not fire navigation when an admin selects the photo instead of opening it', async () => {
    mockUserConfigStore.isAdmin.value = true;
    const wrapper = mountPhoto();

    await wrapper.find('[data-test-id="select-photo-button"]').trigger('click');

    expect(mockPhotoStore.setSelectedPhotos).toHaveBeenCalledWith([PHOTO.key]);
    expect(mockRouterReplace).not.toHaveBeenCalled();
  });

  it('exposes the detail/list thumbnail as a button too, so that view is not mouse-only either', async () => {
    const wrapper = mount(Photo, {
      props: { photoStyle: 'detail', photo: PHOTO },
      global: GLOBAL,
    });
    const opener = wrapper.find('[data-test-id="open-photo-button"]');

    expect(opener.exists()).toBe(true);
    expect(opener.element.tagName).toBe('BUTTON');

    await opener.trigger('click');
    expect(mockRouterReplace).toHaveBeenCalledWith({ query: { photo: 'photo1.jpg' } });
  });

  it('ignores a synthetic load event reporting zero natural dimensions', async () => {
    // A thumbnail that fails to decode can still fire `load` in some browsers with
    // naturalWidth/naturalHeight both 0. setRatio's own guard should reject that,
    // so the cell must keep the 3:2 fallback rather than collapsing to 0 height.
    const wrapper = mountPhoto();
    const img = wrapper.find('img');

    Object.defineProperty(img.element, 'naturalWidth', { value: 0, configurable: true });
    Object.defineProperty(img.element, 'naturalHeight', { value: 0, configurable: true });
    await img.trigger('load');
    await wrapper.vm.$nextTick();

    expect(wrapper.find('[data-test-id="photo-item"]').attributes('style')).toMatch(
      /--ratio:\s*1\.5\b/,
    );
  });
});
