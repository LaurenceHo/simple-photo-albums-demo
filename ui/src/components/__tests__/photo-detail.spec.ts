import PanoramaViewer from '@/components/PanoramaViewer.vue';
import PhotoDetail from '@/components/PhotoDetail.vue';
import router from '@/router';
import { PHOTO_INFO_PANEL_OPEN } from '@/utils/local-storage-key';
import { createTestingPinia } from '@pinia/testing';
import { QueryClient, VueQueryPlugin, type VueQueryPluginOptions } from '@tanstack/vue-query';
import { flushPromises, mount } from '@vue/test-utils';
import PrimeVue from 'primevue/config';
import ToastService from 'primevue/toastservice';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/*
 * Hoisted so every test - and the "selecting a filmstrip thumbnail" test in
 * particular - asserts against the exact same mock the component's single
 * `useRouter()` call received, rather than a fresh `vi.fn()` per call that
 * nothing outside the component could ever observe.
 */
const { mockRouterReplace, mockRouterPush } = await vi.hoisted(async () => {
  const { vi } = await import('vitest');
  return { mockRouterReplace: vi.fn(), mockRouterPush: vi.fn() };
});

// Mock vue-router
vi.mock('vue-router', async () => {
  const actual = (await vi.importActual('vue-router')) as Record<string, unknown>;
  return {
    ...actual,
    useRoute: vi.fn(() => ({
      params: { albumId: 'album', year: '2023' },
      query: { photo: 'photo1.jpg' },
      path: '/album/2023/photo1.jpg',
      fullPath: '/album/2023/photo1.jpg',
    })),
    useRouter: vi.fn(() => ({
      replace: mockRouterReplace,
      push: mockRouterPush,
    })),
  };
});

/*
 * Hoisted so the toast spy the tests assert on is the same object the mocked
 * `useToast()` hands the component - `vi.mock` factories are hoisted above
 * imports, so pulling `vi` in via `vi.hoisted` is required (mirrors the
 * pattern below for the photo store, and the one already used in
 * `ui/src/views/__tests__/photo-list.spec.ts`).
 */
const { mockToastAdd } = await vi.hoisted(async () => {
  const { vi } = await import('vitest');
  return { mockToastAdd: vi.fn() };
});

vi.mock('primevue/usetoast', () => ({
  useToast: vi.fn(() => ({ add: mockToastAdd })),
}));

/*
 * Hoisted and shared across every test, matching the pattern in
 * `ui/src/views/__tests__/photo-list.spec.ts`: a store mock built with `vi.hoisted`
 * exposes a `photosInAlbum` ref tests can mutate (single-photo album,
 * photo-not-found) rather than a fresh literal handed out on every call.
 * `findPhotoByIndex`/`findPhotoIndex` read from that same ref, so mutating it
 * changes what a freshly-mounted component sees.
 */
const { mockPhotoStore, DEFAULT_PHOTOS } = await vi.hoisted(async () => {
  const { ref } = await import('vue');
  const { vi } = await import('vitest');

  const defaultPhotos = [
    { key: 'album/photo1.jpg', url: 'https://example.com/photo1.jpg' },
    { key: 'album/photo2.jpg', url: 'https://example.com/photo2.jpg' },
  ];

  // Matches the mocked route's `params.albumId` above and the `album/` prefix
  // baked into every fixture key below - mirroring the real store's
  // `${currentAlbum.value.id}/${photoId}`, just with the album store swapped
  // for the fixed id this file's route mock always returns.
  const albumId = 'album';

  const photoStore = {
    photosInAlbum: ref(defaultPhotos),
    isFetchingPhotos: ref(false),
    findPhotoByIndex: vi.fn((index: number) => photoStore.photosInAlbum.value[index]),
    // Exact match, extension included - identical semantics to
    // `ui/src/stores/photo.ts`'s real `findPhotoIndex`. Do not reintroduce
    // extension-stripping here: the real store never strips it, so a mock
    // that does silently hides a regression where `?photo=` ids and stored
    // keys stop matching.
    findPhotoIndex: vi.fn((photoId: string) =>
      photoStore.photosInAlbum.value.findIndex(
        (photo: { key: string }) => photo.key === `${albumId}/${photoId}`,
      ),
    ),
  };

  return { mockPhotoStore: photoStore, DEFAULT_PHOTOS: defaultPhotos };
});

vi.mock('../../stores/photo', () => ({
  usePhotoStore: vi.fn(() => mockPhotoStore),
}));

/*
 * `useUserConfigStore`'s `isAdmin` is a computed getter derived from an internal
 * `userState` ref, not a plain piece of state - `createTestingPinia`'s `initialState`
 * can only patch a setup store's actual state, not its computed return values, so
 * `initialState: { userConfig: { isAdmin: true } }` is silently a no-op (it happens to
 * match the store's real default of `false`, which is why this went unnoticed). Mock
 * the module outright so the one admin-only test below can flip a plain ref instead.
 */
const { mockUserConfigStore } = await vi.hoisted(async () => {
  const { ref } = await import('vue');
  return { mockUserConfigStore: { isAdmin: ref(false) } };
});

vi.mock('../../stores/user-config', () => ({
  useUserConfigStore: vi.fn(() => mockUserConfigStore),
}));

vi.mock('exifreader', () => ({
  default: {
    load: vi.fn().mockResolvedValue({}),
  },
}));

// `PhotoLocationMap` (rendered here once GPS EXIF tags are present) now binds Mapbox
// via a template ref rather than `document.getElementById`, so it constructs a real
// `mapboxgl.Map` even when this wrapper is never attached to `document.body`. jsdom
// has no WebGL, so the unmocked constructor throws and corrupts later tests in this
// file. Mock the library the same way `ui/src/components/__tests__/photo-location-map.spec.ts`
// does.
vi.mock('mapbox-gl', () => ({
  default: {
    accessToken: '',
    // `function`, not an arrow: the component calls `new mapboxgl.Map()` and
    // `new mapboxgl.Marker()`, and arrow functions have no [[Construct]] slot,
    // so an arrow mock throws `TypeError: ... is not a constructor`.
    Map: vi.fn(function () {
      return { on: vi.fn(), remove: vi.fn(), resize: vi.fn() };
    }),
    Marker: vi.fn(function () {
      return { setLngLat: vi.fn().mockReturnThis(), addTo: vi.fn() };
    }),
  },
}));

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: false,
    },
  },
});

describe('PhotoDetail.vue', () => {
  let wrapper: ReturnType<typeof mount>;
  const options: VueQueryPluginOptions = {
    queryClient,
  };

  // `attachTo` is only needed for the focus-management tests: `dialogRef.value.focus()`
  // and `document.activeElement` tracking both require the element to actually be in
  // `document`, which a detached VTU mount never is.
  const mountPhotoDetail = (mountOverrides: { attachTo?: HTMLElement } = {}) =>
    mount(PhotoDetail, {
      ...mountOverrides,
      global: {
        plugins: [
          router,
          PrimeVue,
          ToastService,
          [VueQueryPlugin, options],
          createTestingPinia({ createSpy: vi.fn }),
        ],
        // Teleported content leaves the wrapper entirely, so stub it out to keep
        // every selector below working against the wrapper as before.
        stubs: { teleport: true },
      },
    });

  /**
   * Every `<button>` still in the Tab order, in DOM order - i.e. excluding the
   * filmstrip's inactive thumbnails, which carry an explicit `tabindex="-1"`
   * (roving tabindex). `element.tabIndex` reflects the *effective* tabindex
   * (0 for a plain `<button>`, -1 when the attribute overrides it), which is
   * exactly what `onTrapFocus` itself now filters on - a raw `findAll('button')`
   * would include the inactive thumbnails and silently point "last" at one of
   * them instead of the last real Tab stop.
   */
  const getTabbableButtons = (target: ReturnType<typeof mount>) =>
    target.findAll('button').filter((button) => (button.element as HTMLButtonElement).tabIndex >= 0);

  /**
   * `useDevice()` reads `window.innerWidth` once, synchronously, when
   * `PhotoDetail` is set up - so this must run *before* mounting, not after.
   * jsdom's `innerWidth` is a plain own property (default 1024, exactly the
   * `lg` breakpoint), so a plain assignment is enough; no `Object.defineProperty`
   * needed.
   */
  const setViewportWidth = (width: number) => {
    window.innerWidth = width;
  };

  beforeEach(() => {
    // jsdom does not implement scrollIntoView at all - PhotoFilmstrip now calls
    // it on mount (so a deep link into a large album starts pre-scrolled to the
    // active thumbnail), and every test here mounts PhotoDetail, which mounts
    // the filmstrip.
    Element.prototype.scrollIntoView = vi.fn();

    localStorage.clear();
    mockToastAdd.mockClear();
    mockRouterReplace.mockClear();
    mockRouterPush.mockClear();
    mockPhotoStore.photosInAlbum.value = DEFAULT_PHOTOS;
    mockUserConfigStore.isAdmin.value = false;
    wrapper = mountPhotoDetail();
  });

  afterEach(() => {
    wrapper.unmount();
    mockPhotoStore.photosInAlbum.value = DEFAULT_PHOTOS;
    mockUserConfigStore.isAdmin.value = false;
    // jsdom's default; a couple of tests below override it to simulate a small
    // or large viewport for the drawer/filmstrip collision, and must not leak
    // into whichever test runs next.
    setViewportWidth(1024);
  });

  it('renders correctly', () => {
    expect(wrapper.exists()).toBe(true);
    expect(wrapper.find('img').exists()).toBe(true);
  });

  it('displays the correct photo index and total', async () => {
    await wrapper.vm.$nextTick();
    expect(wrapper.find('[data-test-id="photo-index"]').text()).toBe('(1/2)');
  });

  it('displays correct photo file name', async () => {
    await wrapper.vm.$nextTick();
    expect(wrapper.find('[data-test-id="photo-file-name"]').text()).toBe('photo1.jpg');
  });

  it('calls nextPhoto with correct arguments', async () => {
    const vm = wrapper.vm as unknown as {
      nextPhoto: (dir: number) => void;
    };

    const spy = vi.spyOn(vm, 'nextPhoto');
    await wrapper.find('[data-test-id="next-photo-button"]').trigger('click');
    expect(spy).toHaveBeenCalledWith(1);
    await wrapper.find('[data-test-id="previous-photo-button"]').trigger('click');
    expect(spy).toHaveBeenCalledWith(-1);
  });

  // Sonar/CodeRabbit fix: `top-1/2!` alone puts the button's TOP edge at the
  // midpoint rather than its centre. jsdom has no layout engine, so this can only
  // assert the corrective class reaches the rendered button - it does not (and
  // cannot) prove visual centering; that needs a real browser.
  it('applies -translate-y-1/2! to both nav chevrons so top-1/2! actually centres them', () => {
    expect(wrapper.find('[data-test-id="previous-photo-button"]').classes()).toContain(
      '-translate-y-1/2!',
    );
    expect(wrapper.find('[data-test-id="next-photo-button"]').classes()).toContain(
      '-translate-y-1/2!',
    );
  });

  it('emits closePhotoDetail event', async () => {
    await wrapper.find('[data-test-id="close-button"]').trigger('click');
    expect(wrapper.emitted('closePhotoDetail')).toBeTruthy();
  });

  it('handles photo navigation correctly', async () => {
    const vm = wrapper.vm as unknown as {
      selectedImageIndex: number;
      nextPhoto: (dir: number) => void;
    };

    vm.selectedImageIndex = 0;
    vm.nextPhoto(1);
    expect(vm.selectedImageIndex).toBe(1);
    vm.nextPhoto(1);
    expect(vm.selectedImageIndex).toBe(0);
    vm.nextPhoto(-1);
    expect(vm.selectedImageIndex).toBe(1);
  });

  it('computes isPanoramaPhoto correctly', async () => {
    const vm = wrapper.vm as unknown as {
      exifTags: Record<string, unknown>;
      isPanoramaPhoto: boolean;
      photoFileName: string;
    };

    // Test UsePanoramaViewer flag
    vm.exifTags = {
      ProjectionType: { description: 'equirectangular' },
    };
    await wrapper.vm.$nextTick();
    expect(vm.isPanoramaPhoto).toBe(true);

    // Test RICOH THETA detection
    vm.exifTags = {
      Make: { description: 'RICOH' },
      Model: { description: 'THETA Z1' },
    };
    expect(vm.isPanoramaPhoto).toBe(true);

    // Test Samsung Gear 360 detection
    vm.exifTags = {
      Make: { description: 'SAMSUNG' },
      Model: { description: 'GEAR 360' },
    };
    expect(vm.isPanoramaPhoto).toBe(true);

    // Test filename with '360'
    vm.exifTags = {};
    vm.photoFileName = 'photo360.jpg';
    expect(vm.isPanoramaPhoto).toBe(true);

    // Test filename with 'pano'
    vm.photoFileName = 'panorama.jpg';
    expect(vm.isPanoramaPhoto).toBe(true);

    // Test non-panorama case
    vm.exifTags = {
      'Image Width': { value: 1920 },
      'Image Height': { value: 1080 },
    };
    vm.photoFileName = 'regular.jpg';
    expect(vm.isPanoramaPhoto).toBe(false);
  });

  describe('isPanoramaPhoto filename fallback', () => {
    /**
     * Sets `photoFileName` with `exifTags` cleared, so only the filename fallback
     * (never the EXIF checks that run ahead of it) can influence the result -
     * exactly what each case below is targeting.
     */
    const setFileNameOnly = (fileName: string) => {
      const vm = wrapper.vm as unknown as {
        exifTags: Record<string, unknown>;
        photoFileName: string;
        isPanoramaPhoto: boolean;
      };
      vm.exifTags = {};
      vm.photoFileName = fileName;
      return vm;
    };

    // Regression test for the user report: `8360220` contains the substring
    // "360", but it is a digit run, not the token "360" - a bare `.includes('360')`
    // matched it and wrongly rendered this 720x480 ordinary photo in
    // PanoramaViewer, while the identically-sized batch_castle-8033915.jpg (no
    // "360" substring at all) rendered normally.
    it.each(['batch_bird-8360220.jpg', 'batch_castle-8033915.jpg', 'japanophile.jpg'])(
      'does not treat "%s" as a panorama',
      (fileName) => {
        expect(setFileNameOnly(fileName).isPanoramaPhoto).toBe(false);
      },
    );

    it.each([
      'hornsby 360.jpg',
      'IMG_360.jpg',
      '360_view.jpg',
      'photo-360.jpg',
      'panorama.jpg',
      'IMG_pano.jpg',
    ])('detects "%s" as a panorama', (fileName) => {
      expect(setFileNameOnly(fileName).isPanoramaPhoto).toBe(true);
    });

    it('still detects a panorama via EXIF ProjectionType even when the filename looks like an ordinary photo', async () => {
      const vm = setFileNameOnly('batch_bird-8360220.jpg');
      vm.exifTags = { ProjectionType: { description: 'equirectangular' } };
      await wrapper.vm.$nextTick();
      expect(vm.isPanoramaPhoto).toBe(true);
    });

    it('still detects a panorama via a known 360 camera Make/Model even when the filename looks like an ordinary photo', async () => {
      const vm = setFileNameOnly('batch_bird-8360220.jpg');
      vm.exifTags = { Make: { description: 'RICOH' }, Model: { description: 'THETA Z1' } };
      await wrapper.vm.$nextTick();
      expect(vm.isPanoramaPhoto).toBe(true);
    });
  });

  it('does not clear exifTags for a rejected, out-of-bounds photo index', async () => {
    const vm = wrapper.vm as unknown as {
      exifTags: Record<string, unknown>;
      goToPhotoIndex: (index: number) => void;
    };

    vm.exifTags = { Make: { description: 'RICOH' } };
    await wrapper.vm.$nextTick();

    // DEFAULT_PHOTOS has 2 entries, so 99 is out of bounds and must be a no-op -
    // including leaving exifTags (and anything derived from it, like
    // isPanoramaPhoto) untouched. Resetting it before this bounds check blanked
    // the info panel even though no navigation actually happened.
    vm.goToPhotoIndex(99);
    await wrapper.vm.$nextTick();

    expect(vm.exifTags).toEqual({ Make: { description: 'RICOH' } });
  });

  it('renders as a modal dialog over the grid', () => {
    const dialog = wrapper.find('[role="dialog"]');
    expect(dialog.exists()).toBe(true);
    expect(dialog.attributes('aria-modal')).toBe('true');
  });

  it('stacks above PrimeVue overlays at the fixed z-1100 the config in primevue-config.ts assumes', () => {
    // `ui/src/primevue-config.ts` raises PrimeVue's overlay/menu z-index band (1200)
    // above its modal band (1100) specifically so a menu opened from inside this
    // lightbox renders above it, not behind it. That fix is only correct as long as
    // this dialog stays at z-1100 - if someone raises it later without also raising
    // the config, the admin Move/Delete/Rename menu goes invisible behind the
    // backdrop again, while `primevue-config.spec.ts`'s ordering test stays green
    // (it only checks that `overlay`/`menu` > `modal`, not that `modal` still matches
    // this dialog).
    const dialog = wrapper.find('[role="dialog"]');
    expect(dialog.classes()).toContain('z-[1100]');
  });

  it('loads the lightbox image via ?tr=md-true, at full resolution with metadata preserved', () => {
    // No dimension transform (`h-`/`w-`) is applied. A downscaling transform was
    // tried here and reverted (see `sharedPhotoUrl`'s doc comment in
    // `photo-url.ts`): it shrank the download, but made `naturalWidth`/
    // `naturalHeight` - and PhotoInfoPanel's "W x H" line/megapixels derived from
    // them - describe the downscaled copy instead of the true original
    // resolution, a worse defect than the bytes it saved.
    const src = wrapper.find('img').attributes('src');
    expect(src).toBe('https://example.com/photo1.jpg?tr=md-true');
  });

  it('reads EXIF with md-true, or ImageKit strips GPS and camera tags', async () => {
    const ExifReader = (await import('exifreader')).default;
    expect(ExifReader.load).toHaveBeenCalledWith(expect.stringContaining('?tr=md-true'));
  });

  it('uses the exact same URL for the <img> src and the EXIF read, so the second is a cache hit rather than a second download', async () => {
    // This is the property that actually prevents the regression from returning:
    // two different query strings are two different browser cache keys, so even
    // if both individually requested `md-true`, building them from two separate
    // call sites could drift apart again later and silently reintroduce the
    // double-download. Pinning them as the identical string - both built via
    // `sharedPhotoUrl` - is what guarantees they can never diverge.
    //
    // Asserts against the *most recent* call specifically, not
    // `toHaveBeenCalledWith` - the mock's call history is never cleared between
    // tests in this file, so `toHaveBeenCalledWith` would also pass if some
    // earlier test's call happened to match `imgSrc`, without actually proving
    // *this* mount's EXIF read used the same URL as *this* mount's `<img>`.
    await wrapper.vm.$nextTick();
    const ExifReader = (await import('exifreader')).default;
    const imgSrc = wrapper.find('img').attributes('src');
    expect(imgSrc).toBeTruthy();
    const exifCalls = vi.mocked(ExifReader.load).mock.calls;
    const lastExifCall = exifCalls[exifCalls.length - 1]?.[0];
    expect(lastExifCall).toBe(imgSrc);
  });

  it('passes PanoramaViewer the same shared URL as the EXIF read, so a panorama photo is not downloaded twice either', async () => {
    // Mirrors the `<img>`/EXIF assertion above for the panorama branch: before
    // this fix, `PanoramaViewer` received the plain `selectedImage.url` while the
    // EXIF watcher read `sharedPhotoUrl(...)` - two different query strings, so a
    // panorama photo downloaded twice for the same reason the `<img>` case did.
    const vm = wrapper.vm as unknown as { exifTags: Record<string, unknown> };
    vm.exifTags = { ProjectionType: { description: 'equirectangular' } };
    await wrapper.vm.$nextTick();

    const ExifReader = (await import('exifreader')).default;
    const exifCalls = vi.mocked(ExifReader.load).mock.calls;
    const lastExifCall = exifCalls[exifCalls.length - 1]?.[0];
    expect(lastExifCall).toBeTruthy();

    const panoramaViewer = wrapper.findComponent(PanoramaViewer);
    expect(panoramaViewer.exists()).toBe(true);
    expect(panoramaViewer.props('imageUrl')).toBe(lastExifCall);
  });

  it('locks body scroll while open and releases it on close', () => {
    expect(document.body.classList.contains('overflow-hidden')).toBe(true);
    wrapper.unmount();
    expect(document.body.classList.contains('overflow-hidden')).toBe(false);
  });

  it('hides the info panel until the info button is pressed', async () => {
    expect(wrapper.find('[data-test-id="photo-info-panel"]').exists()).toBe(false);

    await wrapper.find('[data-test-id="photo-info-button"]').trigger('click');

    expect(wrapper.find('[data-test-id="photo-info-panel"]').exists()).toBe(true);
  });

  it('toggles the info panel with the i key', async () => {
    globalThis.dispatchEvent(new KeyboardEvent('keydown', { key: 'i' }));
    await wrapper.vm.$nextTick();
    expect(wrapper.find('[data-test-id="photo-info-panel"]').exists()).toBe(true);
  });

  it('reports dimensions through the info panel', async () => {
    // The info panel reads `naturalWidth`/`naturalHeight`, which only populate
    // once the real `<img>` fires `load` - jsdom never fires it, so set them
    // directly, exactly as the deleted `imageStyles` test used to.
    const vm = wrapper.vm as unknown as { naturalWidth: number; naturalHeight: number };
    vm.naturalWidth = 1000;
    vm.naturalHeight = 1000;
    await wrapper.vm.$nextTick();

    await wrapper.find('[data-test-id="photo-info-button"]').trigger('click');
    expect(wrapper.find('[data-test-id="photo-info-panel"]').text()).toContain('1000 x 1000');
  });

  // The synthetic `trigger` below stands in for the real opener: `Photo.vue`'s
  // `[data-test-id="open-photo-button"]`, covered in `photo.spec.ts`. Until that
  // became a real `<button>`, this restore path could not fire in the app at all -
  // the grid opener was a bare `<img @click>`, so `document.activeElement` at mount
  // was always `<body>` and `previouslyFocused?.focus()` had nothing to return to.
  it('moves focus into the dialog on open and restores it on close', () => {
    const trigger = document.createElement('button');
    document.body.appendChild(trigger);
    trigger.focus();
    expect(document.activeElement).toBe(trigger);

    wrapper.unmount();
    wrapper = mountPhotoDetail({ attachTo: document.body });

    const dialog = wrapper.find('[role="dialog"]');
    expect(dialog.element.isConnected).toBe(true);
    expect(document.activeElement).toBe(dialog.element);

    wrapper.unmount();
    expect(document.activeElement).toBe(trigger);

    trigger.remove();
  });

  it('wraps Tab from the last focusable element back to the first', () => {
    wrapper.unmount();
    wrapper = mountPhotoDetail({ attachTo: document.body });

    const buttons = getTabbableButtons(wrapper);
    const first = buttons[0]?.element as HTMLElement;
    const last = buttons[buttons.length - 1]?.element as HTMLElement;
    last.focus();
    expect(document.activeElement).toBe(last);

    last.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));

    expect(document.activeElement).toBe(first);
  });

  it('wraps Shift+Tab from the first focusable element back to the last', () => {
    wrapper.unmount();
    wrapper = mountPhotoDetail({ attachTo: document.body });

    const buttons = getTabbableButtons(wrapper);
    const first = buttons[0]?.element as HTMLElement;
    const last = buttons[buttons.length - 1]?.element as HTMLElement;
    first.focus();
    expect(document.activeElement).toBe(first);

    first.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true }),
    );

    expect(document.activeElement).toBe(last);
  });

  it('pulls Shift+Tab back into the dialog when focus is still on the dialog container itself', () => {
    // On open, focus lands on the dialog container (`dialogRef.value.focus()`), which is
    // neither the first nor the last focusable element inside it. Without special-casing
    // this, Shift+Tab from there is not intercepted, and because Teleport places the
    // dialog last in <body>, focus escapes to the grid behind an aria-modal overlay -
    // silently defeating the modal for a screen-reader user.
    wrapper.unmount();
    wrapper = mountPhotoDetail({ attachTo: document.body });

    const dialog = wrapper.find('[role="dialog"]').element as HTMLElement;
    expect(document.activeElement).toBe(dialog);

    const buttons = getTabbableButtons(wrapper);
    const last = buttons[buttons.length - 1]?.element as HTMLElement;

    dialog.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true }),
    );

    expect(document.activeElement).toBe(last);
  });

  it('keeps the Tab cycle bounded when a filmstrip renders: only the active thumbnail counts as a stop', () => {
    // Guards against a regression the filmstrip's roving tabindex could easily
    // reintroduce: if `onTrapFocus` ever went back to treating every `<button>`
    // as focusable regardless of its `tabindex`, this dialog's "last focusable
    // element" would silently become one of the *inactive* thumbnails (all
    // `tabindex="-1"`) instead of the true last Tab stop, and Tab from the real
    // last stop would escape the modal instead of wrapping.
    wrapper.unmount();
    wrapper = mountPhotoDetail({ attachTo: document.body });

    const activeThumbnail = wrapper
      .find('[data-test-id="filmstrip-thumbnail"][tabindex="0"]')
      .element as HTMLElement;
    const inactiveThumbnails = wrapper
      .findAll('[data-test-id="filmstrip-thumbnail"][tabindex="-1"]')
      .map((button) => button.element);
    expect(inactiveThumbnails.length).toBeGreaterThan(0);

    const first = getTabbableButtons(wrapper)[0]?.element as HTMLElement;

    activeThumbnail.focus();
    expect(document.activeElement).toBe(activeThumbnail);

    activeThumbnail.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));

    expect(document.activeElement).toBe(first);
    expect(inactiveThumbnails).not.toContain(document.activeElement);
  });

  it('excludes a disabled control from the focus trap so Tab still wraps to a real focusable element', () => {
    // A `<button disabled>` still reports `.tabIndex === 0` (verified: jsdom agrees
    // with real browsers here), so `element.tabIndex >= 0` alone does not exclude
    // it. If it lands last in DOM order, `onTrapFocus` would compute IT as `last`;
    // calling `.focus()` on a disabled element is a no-op, so Tab would never
    // land back on a real element at all - the trap would silently stop wrapping.
    wrapper.unmount();
    wrapper = mountPhotoDetail({ attachTo: document.body });

    const dialog = wrapper.find('[role="dialog"]').element as HTMLElement;

    // Captured before the disabled control is added, so `originalLast` is the
    // true last *real* Tab stop rather than the disabled control itself.
    const buttons = getTabbableButtons(wrapper);
    const first = buttons[0]?.element as HTMLElement;
    const originalLast = buttons[buttons.length - 1]?.element as HTMLElement;

    const disabledControl = document.createElement('button');
    disabledControl.disabled = true;
    disabledControl.textContent = 'disabled control';
    dialog.appendChild(disabledControl);

    originalLast.focus();
    expect(document.activeElement).toBe(originalLast);

    originalLast.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));

    expect(document.activeElement).toBe(first);

    disabledControl.remove();
  });

  it('pulls Tab back into the dialog when focus has already escaped to the page behind', () => {
    // Simulates the reported bug's second half: once focus is outside the dialog
    // entirely (e.g. after the container-focus escape below), every later Tab must
    // still be intercepted rather than leaving focus roaming the grid indefinitely.
    const outside = document.createElement('button');
    document.body.appendChild(outside);

    wrapper.unmount();
    wrapper = mountPhotoDetail({ attachTo: document.body });

    const first = wrapper.findAll('button')[0]?.element as HTMLElement;
    outside.focus();
    expect(document.activeElement).toBe(outside);

    outside.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));

    expect(document.activeElement).toBe(first);

    outside.remove();
  });

  it('bails out of trapping focus while a nested PrimeVue dialog is open on top', () => {
    // Opening Move/Delete/Rename from inside the lightbox stacks a PrimeVue modal
    // Dialog (which has its own `v-focustrap`) above it. Without this bailout,
    // `onTrapFocus` would still be bound to `window` and would hijack Tab back into
    // the lightbox instead of letting the nested dialog's own trap handle it. A plain
    // element with `role="dialog"` is enough to trigger the bailout - no PrimeVue
    // instance is needed, since the check only cares about ARIA role, not internals.
    wrapper.unmount();
    wrapper = mountPhotoDetail({ attachTo: document.body });

    const nestedDialog = document.createElement('div');
    nestedDialog.setAttribute('role', 'dialog');
    document.body.appendChild(nestedDialog);

    const buttons = wrapper.findAll('button');
    const last = buttons[buttons.length - 1]?.element as HTMLElement;
    last.focus();
    expect(document.activeElement).toBe(last);

    last.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));

    // Without the bailout this would wrap to `first`; with a nested dialog present,
    // `onTrapFocus` must do nothing and leave focus exactly where the browser (or the
    // nested dialog's own trap) puts it.
    expect(document.activeElement).toBe(last);

    nestedDialog.remove();
  });

  it('bails out of trapping focus while a nested PrimeVue popup menu is open on top', () => {
    // The admin photo-actions menu (`EditPhoto.vue`'s PrimeVue `Menu popup`) renders
    // `role="menu"`, appended to `body` - never `role="dialog"`. Before this widened
    // the selector, `hasNestedDialog()` missed it entirely: `onTrapFocus` kept
    // trapping Tab back into the lightbox, making the menu's own items (Copy Link,
    // Delete, Move, Rename, Make Cover) keyboard-unreachable.
    wrapper.unmount();
    wrapper = mountPhotoDetail({ attachTo: document.body });

    const nestedMenu = document.createElement('div');
    nestedMenu.setAttribute('role', 'menu');
    document.body.appendChild(nestedMenu);

    const buttons = wrapper.findAll('button');
    const last = buttons[buttons.length - 1]?.element as HTMLElement;
    last.focus();
    expect(document.activeElement).toBe(last);

    last.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));

    // Without the bailout this would wrap to `first`; with the menu present,
    // `onTrapFocus` must do nothing and leave focus exactly where it is.
    expect(document.activeElement).toBe(last);

    nestedMenu.remove();
  });

  it('still navigates on arrow keys with the lightbox open and no other overlay present', async () => {
    // Guard test for `hasNestedDialog()`'s baseline. Must mount attached
    // (`attachTo: document.body`): a detached wrapper is never in `document`, so
    // `document.querySelectorAll('[role="dialog"], ...')` would match nothing at
    // all - not even the lightbox's own `[role="dialog"]` - and the `!==
    // dialogRef.value` self-exclusion this function relies on would never
    // actually be exercised, letting the test pass for the wrong reason. Attached,
    // the lightbox's own dialog *is* in the document, so this also pins the
    // self-exclusion: if it ever regressed, `hasNestedDialog()` would treat the
    // lightbox as nested-above-itself and this test would fail.
    //
    // What this does NOT cover: an always-mounted overlay inside `PhotoList.vue`
    // or `App.vue` (e.g. `primevue/autocomplete` with `multiple` set, or a
    // standalone inline `Listbox`) - see the comment above `hasNestedDialog` in
    // `PhotoDetail.vue` for that known gap.
    wrapper.unmount();
    wrapper = mountPhotoDetail({ attachTo: document.body });

    const vm = wrapper.vm as unknown as { selectedImageIndex: number };
    const indexBefore = vm.selectedImageIndex;

    globalThis.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight' }));
    await wrapper.vm.$nextTick();
    expect(vm.selectedImageIndex).toBe(indexBefore + 1);

    globalThis.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft' }));
    await wrapper.vm.$nextTick();
    expect(vm.selectedImageIndex).toBe(indexBefore);
  });

  it('leaves arrow keys and the i key inert while a nested dialog is open on top', async () => {
    // Mirrors the nested-dialog bailout `onTrapFocus` already has, but for
    // `onHandleKeydown`: with a Move/Rename dialog stacked above the lightbox, arrow
    // keys and `i` must not keep driving the photo underneath it. Both handlers now
    // share the same `hasNestedDialog()` check, so they cannot drift apart again.
    const vm = wrapper.vm as unknown as { selectedImageIndex: number };
    const indexBefore = vm.selectedImageIndex;

    const nestedDialog = document.createElement('div');
    nestedDialog.setAttribute('role', 'dialog');
    document.body.appendChild(nestedDialog);

    globalThis.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight' }));
    await wrapper.vm.$nextTick();
    expect(vm.selectedImageIndex).toBe(indexBefore);

    globalThis.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft' }));
    await wrapper.vm.$nextTick();
    expect(vm.selectedImageIndex).toBe(indexBefore);

    globalThis.dispatchEvent(new KeyboardEvent('keydown', { key: 'i' }));
    await wrapper.vm.$nextTick();
    expect(wrapper.find('[data-test-id="photo-info-panel"]').exists()).toBe(false);

    nestedDialog.remove();
  });

  it('leaves arrow keys and the i key inert while a nested PrimeVue popup menu is open on top', async () => {
    // Regression test for the reported bug: with the photo-actions `Menu` (role
    // "menu", not "dialog") open, ArrowRight/ArrowLeft must not keep navigating the
    // photo underneath it - otherwise `EditPhotoButton`'s `:photo-key` changes to a
    // different photo while the menu stays open, so a subsequent Delete/Move/Make
    // Cover click would act on the wrong photo. Escape must also be swallowed by the
    // menu instead of closing the whole lightbox.
    const vm = wrapper.vm as unknown as { selectedImageIndex: number };
    const indexBefore = vm.selectedImageIndex;

    const nestedMenu = document.createElement('div');
    nestedMenu.setAttribute('role', 'menu');
    document.body.appendChild(nestedMenu);

    globalThis.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight' }));
    await wrapper.vm.$nextTick();
    expect(vm.selectedImageIndex).toBe(indexBefore);

    globalThis.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft' }));
    await wrapper.vm.$nextTick();
    expect(vm.selectedImageIndex).toBe(indexBefore);

    globalThis.dispatchEvent(new KeyboardEvent('keydown', { key: 'i' }));
    await wrapper.vm.$nextTick();
    expect(wrapper.find('[data-test-id="photo-info-panel"]').exists()).toBe(false);

    globalThis.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    await wrapper.vm.$nextTick();
    expect(wrapper.emitted('closePhotoDetail')).toBeFalsy();

    nestedMenu.remove();
  });

  it('closes via Escape even while the info panel is open', async () => {
    await wrapper.find('[data-test-id="photo-info-button"]').trigger('click');
    expect(wrapper.find('[data-test-id="photo-info-panel"]').exists()).toBe(true);

    globalThis.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    await wrapper.vm.$nextTick();

    expect(wrapper.emitted('closePhotoDetail')).toBeTruthy();
  });

  it('remembers the info panel preference across a remount via localStorage', async () => {
    await wrapper.find('[data-test-id="photo-info-button"]').trigger('click');
    expect(localStorage.getItem(PHOTO_INFO_PANEL_OPEN)).toBe('true');

    const remounted = mountPhotoDetail();
    expect(remounted.find('[data-test-id="photo-info-panel"]').exists()).toBe(true);
    remounted.unmount();
  });

  it('keeps toggling in memory when localStorage.setItem throws', async () => {
    // Spied on the instance rather than `Storage.prototype`: this repo's
    // `vitest.setup.ts` replaces `window.localStorage` with a plain
    // `LocalStorageMock` class that does not extend `Storage`, so a
    // `Storage.prototype` spy would never intercept the real call.
    const setItemSpy = vi.spyOn(window.localStorage, 'setItem').mockImplementation(() => {
      throw new DOMException('QuotaExceededError');
    });

    await wrapper.find('[data-test-id="photo-info-button"]').trigger('click');

    expect(wrapper.find('[data-test-id="photo-info-panel"]').exists()).toBe(true);
    expect(setItemSpy).toHaveBeenCalled();

    setItemSpy.mockRestore();
  });

  it('still mounts the lightbox when localStorage.getItem throws (e.g. Safari private mode)', () => {
    // Unlike `setItem` above, this read runs synchronously during `setup()` - an
    // uncaught throw here used to fail the whole component's mount, not just this
    // one preference.
    const getItemSpy = vi.spyOn(window.localStorage, 'getItem').mockImplementation(() => {
      throw new DOMException('SecurityError');
    });

    const safariPrivateMode = mountPhotoDetail();

    expect(safariPrivateMode.exists()).toBe(true);
    expect(safariPrivateMode.find('[role="dialog"]').exists()).toBe(true);
    // Defaults closed when the preference cannot be read.
    expect(safariPrivateMode.find('[data-test-id="photo-info-panel"]').exists()).toBe(false);

    safariPrivateMode.unmount();
    getItemSpy.mockRestore();
  });

  it('does not toggle the panel when "i" is typed inside an input', async () => {
    // Dispatched on a real, connected <input> with `bubbles: true` so it
    // reaches the window-level listener with `event.target` set to the
    // input - dispatching directly on `globalThis` (as the plain `i`-key test
    // above does) would leave `event.target` as `window`, which has no
    // `tagName` and would never exercise the guard this test checks.
    const input = document.createElement('input');
    document.body.appendChild(input);

    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'i', bubbles: true }));
    await wrapper.vm.$nextTick();

    expect(wrapper.find('[data-test-id="photo-info-panel"]').exists()).toBe(false);

    input.remove();
  });

  it('hides prev/next buttons for an album with exactly one photo', () => {
    wrapper.unmount();
    mockPhotoStore.photosInAlbum.value = [
      { key: 'album/photo1.jpg', url: 'https://example.com/photo1.jpg' },
    ];
    wrapper = mountPhotoDetail();

    expect(wrapper.find('[data-test-id="previous-photo-button"]').exists()).toBe(false);
    expect(wrapper.find('[data-test-id="next-photo-button"]').exists()).toBe(false);
  });

  it('shows an error toast and does not crash when the photo id is not found', () => {
    wrapper.unmount();
    mockPhotoStore.photosInAlbum.value = [
      { key: 'album/other.jpg', url: 'https://example.com/other.jpg' },
    ];
    wrapper = mountPhotoDetail();

    expect(mockToastAdd).toHaveBeenCalledWith(
      expect.objectContaining({ severity: 'error', detail: 'Photo does not exist' }),
    );
  });

  it('shows the panorama badge only when the photo is detected as a 360', async () => {
    expect(wrapper.find('[data-test-id="panorama-badge"]').exists()).toBe(false);

    const vm = wrapper.vm as unknown as { exifTags: Record<string, unknown> };
    vm.exifTags = { ProjectionType: { description: 'equirectangular' } };
    await wrapper.vm.$nextTick();

    expect(wrapper.find('[data-test-id="panorama-badge"]').exists()).toBe(true);
  });

  // Sonar flagged `role="img"` on a bare wrapper <div>. The accessible name now
  // lives on the icon's own rendered <svg> instead - verified against the actual
  // mounted DOM rather than assumed, since @tabler/icons-vue forwards non-prop
  // attributes onto its <svg> via a plain `...attrs` spread.
  it('puts the panorama badge accessible name on the icon svg itself, not the wrapper', async () => {
    const vm = wrapper.vm as unknown as { exifTags: Record<string, unknown> };
    vm.exifTags = { ProjectionType: { description: 'equirectangular' } };
    await wrapper.vm.$nextTick();

    const badge = wrapper.find('[data-test-id="panorama-badge"]');
    expect(badge.exists()).toBe(true);
    expect(badge.attributes('role')).toBeUndefined();
    expect(badge.attributes('aria-label')).toBeUndefined();

    const icon = badge.find('svg');
    expect(icon.exists()).toBe(true);
    expect(icon.attributes('role')).toBe('img');
    expect(icon.attributes('aria-label')).toBe('360 panorama photo');
    // `aria-hidden` must NOT also land here: paired with `aria-label` it would
    // remove the element from the accessibility tree entirely, so the badge
    // would announce nothing at all - worse than the finding it "fixes".
    expect(icon.attributes('aria-hidden')).toBeUndefined();
  });

  it('does not crash and still logs when EXIF parsing rejects', async () => {
    const ExifReader = (await import('exifreader')).default;
    vi.mocked(ExifReader.load).mockRejectedValueOnce(new Error('bad exif'));
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    wrapper.unmount();
    wrapper = mountPhotoDetail();
    await flushPromises();

    expect(wrapper.exists()).toBe(true);
    expect(consoleError).toHaveBeenCalled();

    consoleError.mockRestore();
  });

  it('discards a stale EXIF response instead of letting it overwrite the on-screen photo\'s tags', async () => {
    // Rapid navigation (arrow keys held down, or the filmstrip) can fire the EXIF
    // watcher again before an earlier photo's `ExifReader.load` has settled. If that
    // earlier request happens to resolve *after* the later one already updated
    // `exifTags`, whichever one settles last must not win - only the photo actually
    // on screen may ever be reflected. `isPanoramaPhoto` and the info panel both
    // derive from `exifTags`, so a stale write here would show the wrong date,
    // camera, and possibly wrongly swap in `PanoramaViewer`.
    const ExifReader = (await import('exifreader')).default;
    const pending: { resolve: (tags: Record<string, unknown>) => void }[] = [];
    // `ExifReader.load` is overloaded (sync/async depending on input type and
    // options), so a single arrow function can't structurally satisfy all of its
    // call signatures at once - cast the mock wholesale rather than fighting the
    // overload set, same as the component itself casts the resolved value to
    // `ExifData` at the call site.
    vi.mocked(ExifReader.load).mockImplementation(
      (() =>
        new Promise((resolve) => {
          pending.push({ resolve });
        })) as unknown as typeof ExifReader.load,
    );

    const vm = wrapper.vm as unknown as {
      selectedImageIndex: number;
      exifTags: Record<string, unknown>;
    };

    // Navigate photo1 (index 0, already mounted) -> photo2 (index 1) -> back to
    // photo1 (index 0), each a real change so the watcher fires every time.
    vm.selectedImageIndex = 1;
    await wrapper.vm.$nextTick();
    vm.selectedImageIndex = 0;
    await wrapper.vm.$nextTick();

    expect(pending).toHaveLength(2);

    // The current photo's (photo1, the second navigation) load resolves first.
    pending[1]?.resolve({ Model: { description: 'photo-1-camera' } });
    await flushPromises();
    expect(vm.exifTags).toEqual({ Model: { description: 'photo-1-camera' } });

    // The now-superseded photo's (photo2, the first navigation) load resolves late.
    // It must be discarded, not clobber photo1's already-displayed tags.
    pending[0]?.resolve({ Model: { description: 'photo-2-camera' } });
    await flushPromises();
    expect(vm.exifTags).toEqual({ Model: { description: 'photo-1-camera' } });
  });

  it('resets loadImage even when selectedImage becomes undefined before the EXIF load settles (regression: spinner stuck forever)', async () => {
    // Regression test for a bug introduced alongside the staleness guard above:
    // `photosInAlbum` shrinking under a live index (or the `?photo=` not-found
    // path) makes `selectedImage` become `undefined`. The watcher's cleanup marks
    // the in-flight run stale, but its *body* is skipped entirely for the new,
    // `undefined` value - so nothing else resets `loadImage`. If the `finally`
    // block only reset `loadImage` for a non-stale run, it would stay `true`
    // forever once the original run settles, wedging `ProgressSpinner` on screen
    // and never mounting the `<img>`/`PanoramaViewer` behind it.
    const ExifReader = (await import('exifreader')).default;
    const pending: { resolve: (tags: Record<string, unknown>) => void }[] = [];
    vi.mocked(ExifReader.load).mockImplementation(
      (() =>
        new Promise((resolve) => {
          pending.push({ resolve });
        })) as unknown as typeof ExifReader.load,
    );

    wrapper.unmount();
    wrapper = mountPhotoDetail();

    const vm = wrapper.vm as unknown as { loadImage: boolean };
    expect(vm.loadImage).toBe(true);
    expect(pending).toHaveLength(1);

    // Shrink the array out from under the live index, mirroring
    // `findPhotoByIndex`'s bare `photosInAlbum.value[index]` access in
    // `stores/photo.ts` - `selectedImage` becomes `undefined` before the
    // pending load below ever settles.
    mockPhotoStore.photosInAlbum.value = [];
    await wrapper.vm.$nextTick();

    pending[0]?.resolve({});
    await flushPromises();

    expect(vm.loadImage).toBe(false);
  });

  it('renders the caption below the image rather than inside the top bar', async () => {
    await wrapper.vm.$nextTick();

    const caption = wrapper.find('[data-test-id="photo-file-name"]');
    expect(caption.exists()).toBe(true);
    expect(caption.text()).toBe('photo1.jpg');

    // Guards against a regression back to the old top-left layout: the caption
    // must live in the stage column, not the header bar.
    expect(wrapper.find('header').find('[data-test-id="photo-file-name"]').exists()).toBe(false);
  });

  it('keeps the photo counter in the top bar', async () => {
    await wrapper.vm.$nextTick();

    const counter = wrapper.find('header').find('[data-test-id="photo-index"]');
    expect(counter.exists()).toBe(true);
    expect(counter.text()).toBe('(1/2)');
  });

  it('labels the admin photo-actions button so it does not announce as just "button"', () => {
    // `EditPhotoButton` (the icon-only dots menu trigger) only renders for admins, so
    // the default `isAdmin: false` fixture never mounts it - flip the mocked user-config
    // store here rather than adding a whole separate test harness for `EditPhoto.vue` in
    // isolation, which would need its own mocks for `AlbumService`/`useMutation`/the
    // dialog store for no extra value over exercising it exactly where it renders.
    mockUserConfigStore.isAdmin.value = true;
    wrapper.unmount();
    wrapper = mountPhotoDetail();

    const editButton = wrapper.find('[data-test-id="edit-photo-button"]');
    expect(editButton.exists()).toBe(true);
    expect(editButton.attributes('aria-label')).toBeTruthy();
  });

  it('hides the filmstrip for an album with exactly one photo, matching the prev/next chevrons', () => {
    wrapper.unmount();
    mockPhotoStore.photosInAlbum.value = [
      { key: 'album/photo1.jpg', url: 'https://example.com/photo1.jpg' },
    ];
    wrapper = mountPhotoDetail();

    expect(wrapper.find('[data-test-id="photo-filmstrip"]').exists()).toBe(false);
  });

  it('routes to the selected photo through ?photo= when a filmstrip thumbnail is clicked', async () => {
    await wrapper.vm.$nextTick();

    const thumbnails = wrapper.findAll('[data-test-id="filmstrip-thumbnail"]');
    expect(thumbnails).toHaveLength(2);

    mockRouterReplace.mockClear();
    await thumbnails[1]?.trigger('click');

    // The same `?photo=` mechanism nextPhoto uses - no second navigation path.
    expect(mockRouterReplace).toHaveBeenCalledWith(
      expect.objectContaining({ query: expect.objectContaining({ photo: 'photo2.jpg' }) }),
    );

    const vm = wrapper.vm as unknown as { selectedImageIndex: number };
    expect(vm.selectedImageIndex).toBe(1);
  });

  it('hides the caption and filmstrip below lg while the info panel is open, since the sheet fully covers them', async () => {
    // Below `lg` the info panel is a bottom sheet over the lower half of the
    // screen, landing exactly on the caption and filmstrip - leaving them
    // mounted underneath would waste layout and put unreachable controls in
    // the accessibility tree.
    setViewportWidth(500);
    wrapper.unmount();
    wrapper = mountPhotoDetail();
    await wrapper.vm.$nextTick();

    await wrapper.find('[data-test-id="photo-info-button"]').trigger('click');
    await wrapper.vm.$nextTick();

    expect(wrapper.find('[data-test-id="photo-info-panel"]').exists()).toBe(true);
    expect(wrapper.find('[data-test-id="photo-file-name"]').exists()).toBe(false);
    expect(wrapper.find('[data-test-id="photo-filmstrip"]').exists()).toBe(false);
  });

  it('keeps the caption and filmstrip visible at lg+ with the info panel open, since the drawer is a side panel there', async () => {
    setViewportWidth(1280);
    wrapper.unmount();
    wrapper = mountPhotoDetail();
    await wrapper.vm.$nextTick();

    await wrapper.find('[data-test-id="photo-info-button"]').trigger('click');
    await wrapper.vm.$nextTick();

    expect(wrapper.find('[data-test-id="photo-info-panel"]').exists()).toBe(true);
    expect(wrapper.find('[data-test-id="photo-file-name"]').exists()).toBe(true);
    expect(wrapper.find('[data-test-id="photo-filmstrip"]').exists()).toBe(true);
  });
});
