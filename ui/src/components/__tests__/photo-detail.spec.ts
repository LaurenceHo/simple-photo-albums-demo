import { EditPhotoButton } from '@/components/button';
import PanoramaViewer from '@/components/PanoramaViewer.vue';
import PhotoDetail from '@/components/PhotoDetail.vue';
import PhotoInfoPanel from '@/components/PhotoInfoPanel.vue';
import router from '@/router';
import { PHOTO_INFO_PANEL_OPEN } from '@/utils/local-storage-key';
import { createTestingPinia } from '@pinia/testing';
import { QueryClient, VueQueryPlugin, type VueQueryPluginOptions } from '@tanstack/vue-query';
import { flushPromises, mount } from '@vue/test-utils';
import ExifReader from 'exifreader';
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

  // There is deliberately no viewport-width helper here any more. `PhotoDetail`
  // no longer reads `window.innerWidth` - the drawer/sheet split is pure CSS
  // (`lg:` variants) - and jsdom applies no CSS and evaluates no media queries,
  // so setting a width could not change a single rendered byte. Breakpoint
  // behaviour is covered by asserting the layout classes and was verified in a
  // real browser; anything that sets `innerWidth` here would only look like
  // coverage.

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
    // Several tests below swap in their own `load` behaviour (equirectangular
    // tags, or a never-settling promise for the staleness guards) and none of
    // them put it back. Reset here so a test's result cannot depend on which
    // ones happened to run before it.
    vi.mocked(ExifReader.load).mockReset();
    vi.mocked(ExifReader.load).mockResolvedValue(
      {} as unknown as Awaited<ReturnType<typeof ExifReader.load>>,
    );
    wrapper = mountPhotoDetail();
  });

  afterEach(() => {
    wrapper.unmount();
    mockPhotoStore.photosInAlbum.value = DEFAULT_PHOTOS;
    mockUserConfigStore.isAdmin.value = false;
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

    // Test filename with '360'. Dimensions are required now: the filename alone
    // no longer promotes a photo to the sphere viewer unless the image is
    // actually shaped like one.
    const sphere = { 'Image Width': { value: 6000 }, 'Image Height': { value: 3000 } };
    vm.exifTags = { ...sphere };
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
     * Sets `photoFileName` with no EXIF beyond a 2:1 dimension pair, so the
     * filename is the only thing that can decide the result - none of the EXIF
     * checks that run ahead of it, and none of the aspect-ratio gate that runs
     * after it.
     *
     * The dimensions are not incidental: since the gate landed, a name-only
     * match is denied unless the image is shaped like a full sphere, so omitting
     * them would make every case here fail for the wrong reason.
     */
    const setFileNameOnly = (fileName: string) => {
      const vm = wrapper.vm as unknown as {
        exifTags: Record<string, unknown>;
        photoFileName: string;
        isPanoramaPhoto: boolean;
      };
      vm.exifTags = { 'Image Width': { value: 6000 }, 'Image Height': { value: 3000 } };
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

    describe('full-sphere aspect ratio gate on the filename path', () => {
      const setNameAndSize = (fileName: string, width: number, height: number) => {
        const vm = wrapper.vm as unknown as {
          exifTags: Record<string, unknown>;
          photoFileName: string;
          isPanoramaPhoto: boolean;
        };
        vm.exifTags = { 'Image Width': { value: width }, 'Image Height': { value: height } };
        vm.photoFileName = fileName;
        return vm;
      };

      it('rejects a panorama-named photo that is not shaped like a full sphere', () => {
        // The real case: an 8192x3105 (2.638:1) aerial panorama. Genuinely 360
        // around - its left and right edges join, measured against a
        // quarter-turn control - but cropped top and bottom to roughly 136
        // degrees of vertical coverage. Pannellum assumes a full 180 and
        // stretches it, so it rendered as a broken 360 rather than the wide flat
        // photo it is better shown as.
        expect(setNameAndSize('test-panorama-photo-1.jpg', 8192, 3105).isPanoramaPhoto).toBe(false);
      });

      it.each([
        ['12000x6000', 12000, 6000],
        ['6000x3000', 6000, 3000],
        ['8192x4096', 8192, 4096],
      ])('accepts a panorama-named photo at %s, an exact 2:1 sphere', (_label, width, height) => {
        expect(setNameAndSize('test-panorama-photo-2.jpg', width, height).isPanoramaPhoto).toBe(
          true,
        );
      });

      it('tolerates an off-by-a-pixel export but not a real crop', () => {
        expect(setNameAndSize('pano.jpg', 6001, 3000).isPanoramaPhoto).toBe(true);
        expect(setNameAndSize('pano.jpg', 6000, 2800).isPanoramaPhoto).toBe(false);
      });

      it('gates only the filename path, never EXIF or a known 360 camera', () => {
        // `ProjectionType` and camera make/model describe how the photo was
        // made, and pannellum reads GPano's crop tags itself - so a partial
        // sphere that still carries its metadata is projected correctly and must
        // not be rejected for its shape.
        const vm = setNameAndSize('anything.jpg', 8192, 3105);
        vm.exifTags = {
          'Image Width': { value: 8192 },
          'Image Height': { value: 3105 },
          ProjectionType: { description: 'equirectangular' },
        };
        expect(vm.isPanoramaPhoto).toBe(true);

        vm.exifTags = {
          'Image Width': { value: 8192 },
          'Image Height': { value: 3105 },
          Make: { description: 'RICOH' },
          Model: { description: 'RICOH THETA Z1' },
        };
        expect(vm.isPanoramaPhoto).toBe(true);
      });

      it('denies the filename signal when dimensions cannot be read at all', () => {
        // The two failure modes are not symmetric. A real sphere shown flat is
        // still perfectly viewable, just not pannable; a non-sphere handed to
        // pannellum is visibly wrong. Uncertainty lands on the cheaper mistake.
        //
        // In practice this means the EXIF fetch failed outright - ExifReader
        // takes these from the JPEG header, so they survive EXIF being stripped,
        // which is exactly the case for the photos that prompted the gate.
        const vm = wrapper.vm as unknown as {
          exifTags: Record<string, unknown>;
          photoFileName: string;
          isPanoramaPhoto: boolean;
        };
        vm.exifTags = {};
        vm.photoFileName = 'panorama.jpg';
        expect(vm.isPanoramaPhoto).toBe(false);
      });
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
    // `z-1100`, not `z-[1100]` - Tailwind v4 takes a bare number for z-index, so
    // the arbitrary-value form is redundant and the linter canonicalises it. The
    // rendered z-index is identical; only the class name changed.
    const dialog = wrapper.find('[role="dialog"]');
    expect(dialog.classes()).toContain('z-1100');
  });

  it('keeps the 360 badge clear of pannellum, which owns the top-left corner', async () => {
    // Pannellum stacks its zoom controls and fullscreen toggle down the top-left
    // of its own container, so a badge at `left-2` sat directly on the zoom `+`
    // and both were unusable. Measured in Edge at 390x844: zoom occupies
    // (4,60)-(32,114) and fullscreen (4,118)-(32,146); the badge now sits at
    // (354,64), clear of those and of the next-photo chevron at (338,372).
    const vm = wrapper.vm as unknown as { exifTags: Record<string, unknown> };
    vm.exifTags = { ProjectionType: { description: 'equirectangular' } };
    await wrapper.vm.$nextTick();

    const badge = wrapper.find('[data-test-id="panorama-badge"]');
    expect(badge.exists()).toBe(true);
    expect(badge.classes()).toContain('right-2');
    expect(badge.classes()).not.toContain('left-2');
  });

  it('paints the backdrop fully opaque, so the page behind does not read through it', () => {
    // Was `bg-black/95`. Five percent sounds like nothing, but the album page
    // behind is high-contrast (white background, dark text, bright thumbnails)
    // and its title, breadcrumbs and photo grid stayed plainly legible through
    // the backdrop - verified in Edge at both 390x844 and 1440x900. This is a
    // modal lightbox; nothing behind it should be readable.
    const dialog = wrapper.find('[role="dialog"]');
    expect(dialog.classes()).toContain('bg-black');
    expect(dialog.classes()).not.toContain('bg-black/95');
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
    // Drives the panorama branch through `ExifReader` rather than by assigning
    // `exifTags` directly. What renders now comes from the committed frame, whose
    // `isPanorama` is decided from the tags the watcher actually resolved - so
    // poking the ref afterwards changes the badge but not the frame already on
    // screen, which is precisely the mid-transition mismatch the frame prevents.
    const ExifReader = (await import('exifreader')).default;
    vi.mocked(ExifReader.load).mockResolvedValue({
      ProjectionType: { description: 'equirectangular' },
    } as unknown as Awaited<ReturnType<typeof ExifReader.load>>);

    wrapper.unmount();
    wrapper = mountPhotoDetail();
    await flushPromises();

    const exifCalls = vi.mocked(ExifReader.load).mock.calls;
    const lastExifCall = exifCalls[exifCalls.length - 1]?.[0];
    expect(lastExifCall).toBeTruthy();

    const panoramaViewer = wrapper.findComponent(PanoramaViewer);
    expect(panoramaViewer.exists()).toBe(true);
    expect(panoramaViewer.props('imageUrl')).toBe(lastExifCall);
  });

  describe('slide transition', () => {
    type SlideVm = {
      slideDirection: 'next' | 'prev' | 'none';
      slideClasses: { enterFrom: string; leaveTo: string; enterActive: string };
      displayedFrame: {
        key: string;
        url: string;
        isPanorama: boolean;
        alt: string;
        photo?: { key: string };
      } | null;
      selectedImageIndex: number;
    };
    const slideVm = () => wrapper.vm as unknown as SlideVm;

    it('starts with no direction, so a deep link cross-fades instead of sliding in from nowhere', async () => {
      await flushPromises();

      expect(slideVm().slideDirection).toBe('none');
      expect(slideVm().slideClasses.enterFrom).toBe('opacity-0');
    });

    it('sends the next photo in from the right and the old one out to the left', async () => {
      await flushPromises();
      await wrapper.find('[data-test-id="next-photo-button"]').trigger('click');
      await flushPromises();

      // lightGallery's convention: content travels leftwards to advance.
      expect(slideVm().slideDirection).toBe('next');
      expect(slideVm().slideClasses.enterFrom).toBe('translate-x-full opacity-0');
      expect(slideVm().slideClasses.leaveTo).toBe('-translate-x-full opacity-0');
    });

    it('mirrors the travel for the previous photo', async () => {
      await flushPromises();
      await wrapper.find('[data-test-id="previous-photo-button"]').trigger('click');
      await flushPromises();

      expect(slideVm().slideDirection).toBe('prev');
      expect(slideVm().slideClasses.enterFrom).toBe('-translate-x-full opacity-0');
      expect(slideVm().slideClasses.leaveTo).toBe('translate-x-full opacity-0');
    });

    // The `?photo=`-driven direction reset in the `photoId` watcher has no test
    // here on purpose. `useRoute` is mocked as a static object, so `photoId`
    // never changes and that watcher only ever runs its `immediate` pass - any
    // test claiming to exercise an edited URL or history navigation would be
    // asserting against a path that cannot fire, which is worse than no test.
    // Covering it properly means a reactive route mock, and that is a change to
    // this file's whole mocking strategy rather than one spec.

    it('keeps travelling forwards when "next" wraps from the last photo to the first', async () => {
      // The regression this guards: wrapping moves the index from 1 to 0, which
      // reads as backwards. Direction has to come from the user's intent, not the
      // index delta, or the last->first step slides the wrong way.
      await flushPromises();
      await wrapper.find('[data-test-id="next-photo-button"]').trigger('click');
      await flushPromises();
      expect(slideVm().selectedImageIndex).toBe(1);

      await wrapper.find('[data-test-id="next-photo-button"]').trigger('click');
      await flushPromises();

      expect(slideVm().selectedImageIndex).toBe(0);
      expect(slideVm().slideDirection).toBe('next');
    });

    it('infers direction from the jump when the filmstrip picks an arbitrary photo', async () => {
      await flushPromises();

      // Re-queried after each click: the filmstrip re-renders on navigation
      // (roving tabindex moves), so handles captured beforehand go stale.
      const thumbnailAt = (index: number) =>
        wrapper.findAll('[data-test-id="filmstrip-thumbnail"]')[index];

      await thumbnailAt(1)?.trigger('click');
      await flushPromises();
      expect(slideVm().selectedImageIndex).toBe(1);
      expect(slideVm().slideDirection).toBe('next');

      await thumbnailAt(0)?.trigger('click');
      await flushPromises();
      expect(slideVm().selectedImageIndex).toBe(0);
      expect(slideVm().slideDirection).toBe('prev');
    });

    it('commits the frame only once, keyed on the photo the transition swaps', async () => {
      await flushPromises();
      expect(slideVm().displayedFrame?.key).toBe('album/photo1.jpg');

      await wrapper.find('[data-test-id="next-photo-button"]').trigger('click');
      await flushPromises();

      expect(slideVm().displayedFrame?.key).toBe('album/photo2.jpg');
      // Same builder as the EXIF read, so the preload shares their cache entry
      // rather than adding a third download of the same photo.
      expect(slideVm().displayedFrame?.url).toContain('tr=md-true');
    });

    it('holds the previous photo on screen until the next one is committed', async () => {
      // The reason the frame exists: navigation used to blank the stage to a
      // spinner the moment `?photo=` changed, which would cut any slide short.
      const ExifReader = (await import('exifreader')).default;
      let release: ((tags: Record<string, unknown>) => void) | undefined;
      vi.mocked(ExifReader.load).mockImplementation(
        (() => new Promise((resolve) => (release = resolve))) as never,
      );

      await flushPromises();
      const before = slideVm().displayedFrame?.key;

      await wrapper.find('[data-test-id="next-photo-button"]').trigger('click');
      await flushPromises();

      // EXIF still in flight: the old frame is untouched, not cleared.
      expect(slideVm().displayedFrame?.key).toBe(before);
      expect(wrapper.find('[data-test-id="photo-frame"]').exists()).toBe(true);

      release?.({});
      await flushPromises();
      expect(slideVm().displayedFrame?.key).not.toBe(before);
    });

    it('honours prefers-reduced-motion by dropping the animation, not the swap', async () => {
      await flushPromises();
      expect(slideVm().slideClasses.enterActive).toContain('motion-reduce:transition-none');
    });

    it('keeps every info-panel input on the committed photo, never mixing two', async () => {
      // The panel used to take `:photo` live off `selectedImage` while its EXIF
      // came from the commit, so for the whole fetch-and-decode window it showed
      // the *next* photo's file name and size above the *current* photo's date,
      // camera and GPS pin. Incomplete metadata is fine; metadata that
      // confidently attributes one photo's location to another is not.
      // Admin, so `EditPhotoButton` is mounted and its binding can be asserted
      // too. Remounted before the hanging mock is installed, so the first frame
      // still commits normally.
      mockUserConfigStore.isAdmin.value = true;
      wrapper.unmount();
      wrapper = mountPhotoDetail();
      await flushPromises();

      const ExifReader = (await import('exifreader')).default;
      let release: ((tags: Record<string, unknown>) => void) | undefined;
      vi.mocked(ExifReader.load).mockImplementation(
        (() => new Promise((resolve) => (release = resolve))) as never,
      );

      await wrapper.find('[data-test-id="photo-info-button"]').trigger('click');
      await flushPromises();

      await wrapper.find('[data-test-id="next-photo-button"]').trigger('click');
      await flushPromises();

      // Asserted on what the panel is actually handed, not on the frame's own
      // fields - binding the template back to `selectedImage` has to fail here,
      // and a frame-level assertion would sail straight past that.
      const panel = wrapper.findComponent(PhotoInfoPanel);
      expect(panel.exists()).toBe(true);

      // `selectedImageIndex` has already advanced - intended, the counter and
      // filmstrip lead the photo - but everything describing the photo must
      // still agree on the one that is actually on screen.
      expect(slideVm().selectedImageIndex).toBe(1);
      expect(slideVm().displayedFrame?.key).toBe('album/photo1.jpg');
      expect((panel.props('photo') as { key: string } | undefined)?.key).toBe('album/photo1.jpg');

      // The admin actions carry the more damaging version of the same bug -
      // Delete/Move/Rename acting on a photo other than the one on screen - so
      // assert the binding, not just that the button exists.
      const editButton = wrapper.findComponent(EditPhotoButton);
      expect(editButton.exists()).toBe(true);
      expect(editButton.props('photoKey')).toBe('album/photo1.jpg');

      release?.({});
      await flushPromises();

      const settled = wrapper.findComponent(PhotoInfoPanel);
      expect((settled.props('photo') as { key: string } | undefined)?.key).toBe('album/photo2.jpg');
    });

    it('lets only the newest load control the spinner', async () => {
      // A superseded run reaching its end used to clear `loadImage`
      // unconditionally, switching the spinner off while the run that replaced
      // it was still fetching - a black stage with no feedback for as long as
      // that took. `stale` cannot express this; it says "I am obsolete", not
      // "am I still the newest?".
      const ExifReader = (await import('exifreader')).default;
      const pending: ((tags: Record<string, unknown>) => void)[] = [];
      vi.mocked(ExifReader.load).mockImplementation(
        (() => new Promise((resolve) => pending.push(resolve))) as never,
      );

      wrapper.unmount();
      wrapper = mountPhotoDetail();
      await flushPromises();

      const vm = wrapper.vm as unknown as { loadImage: boolean };
      // First photo, nothing on screen yet, so the spinner is immediate.
      expect(vm.loadImage).toBe(true);

      await wrapper.find('[data-test-id="next-photo-button"]').trigger('click');
      await flushPromises();

      // Settle the first, now-superseded run. It must not clear the spinner.
      pending[0]?.({});
      await flushPromises();
      expect(vm.loadImage).toBe(true);

      pending[1]?.({});
      await flushPromises();
      expect(vm.loadImage).toBe(false);
    });

    it('measures the decoded image when the header carries no dimensions', async () => {
      // The gate would otherwise be format-dependent in a way dev never shows.
      // ExifReader only emits `Image Width`/`Image Height` for JPEG, PNG, GIF and
      // JXL - `image-header-webp.js` returns no `fileDataOffset`, so a WebP
      // yields nothing on every successful read. WebP is an accepted upload
      // type, and production serves through ImageKit, which negotiates format:
      // the same URL that returns JPEG from raw R2 locally can return WebP in
      // production. Header-only, every filename-detected 360 would have gone
      // flat in production while every local check passed.
      const ExifReader = (await import('exifreader')).default;
      vi.mocked(ExifReader.load).mockResolvedValue(
        {} as unknown as Awaited<ReturnType<typeof ExifReader.load>>,
      );

      // jsdom never loads images, so stand in for the decode with a 2:1 result.
      const decode = vi.fn().mockResolvedValue(undefined);
      const ImageStub = function (this: Record<string, unknown>) {
        this.decode = decode;
        this.naturalWidth = 6000;
        this.naturalHeight = 3000;
         
      } as unknown as new () => HTMLImageElement;
      vi.stubGlobal('Image', ImageStub);

      mockPhotoStore.photosInAlbum.value = [
        { key: 'album/photo1.jpg', url: 'https://example.com/photo1.jpg' },
        { key: 'album/garden-pano.webp', url: 'https://example.com/garden-pano.webp' },
      ];
      wrapper.unmount();
      wrapper = mountPhotoDetail();
      await flushPromises();
      await wrapper.find('[data-test-id="next-photo-button"]').trigger('click');
      await flushPromises();

      expect(decode).toHaveBeenCalled();
      expect(slideVm().displayedFrame?.key).toBe('album/garden-pano.webp');
      expect(slideVm().displayedFrame?.isPanorama).toBe(true);

      vi.unstubAllGlobals();
    });

    it('renders a non-spherical panorama-named photo as a flat image, not in pannellum', async () => {
      // Asserted at the frame, not at `isPanoramaPhoto`. That computed only
      // drives the badge; what actually reaches pannellum is
      // `displayedFrame.isPanorama`, so wiring the gate into the frame wrongly
      // would leave the badge-level tests green.
      const ExifReader = (await import('exifreader')).default;
      vi.mocked(ExifReader.load).mockResolvedValue({
        'Image Width': { value: 8192 },
        'Image Height': { value: 3105 },
      } as unknown as Awaited<ReturnType<typeof ExifReader.load>>);

      mockPhotoStore.photosInAlbum.value = [
        { key: 'album/photo1.jpg', url: 'https://example.com/photo1.jpg' },
        { key: 'album/test-panorama-photo-1.jpg', url: 'https://example.com/pano.jpg' },
      ];
      wrapper.unmount();
      wrapper = mountPhotoDetail();
      await flushPromises();
      await wrapper.find('[data-test-id="next-photo-button"]').trigger('click');
      await flushPromises();

      expect(slideVm().displayedFrame?.key).toBe('album/test-panorama-photo-1.jpg');
      expect(slideVm().displayedFrame?.isPanorama).toBe(false);
      expect(wrapper.findComponent(PanoramaViewer).exists()).toBe(false);
      expect(wrapper.find('[data-test-id="photo-frame"] img').exists()).toBe(true);
    });
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
    // `flushPromises`, not `$nextTick`: the caption is committed alongside the
    // photo frame at the end of the EXIF+decode chain, so that it changes at the
    // same moment the photo does rather than ahead of it.
    await flushPromises();

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

  it('labels the admin photo-actions button so it does not announce as just "button"', async () => {
    // `EditPhotoButton` (the icon-only dots menu trigger) only renders for admins, so
    // the default `isAdmin: false` fixture never mounts it - flip the mocked user-config
    // store here rather than adding a whole separate test harness for `EditPhoto.vue` in
    // isolation, which would need its own mocks for `AlbumService`/`useMutation`/the
    // dialog store for no extra value over exercising it exactly where it renders.
    mockUserConfigStore.isAdmin.value = true;
    wrapper.unmount();
    wrapper = mountPhotoDetail();
    // The button is keyed off the committed frame now, so it only exists once
    // the first photo has been committed.
    await flushPromises();

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

  it('keeps the filmstrip mounted while the info panel is open', async () => {
    // Regression: the sheet used to be `absolute`, so it covered the lower half
    // of the stage instead of shrinking it - which hid the bottom of the photo
    // and forced the caption and filmstrip to be unmounted to avoid rendering
    // them underneath. The sheet is now an in-flow flex sibling below `lg`
    // (`lg:absolute` keeps the side-drawer behaviour above it), so nothing is
    // occluded and the filmstrip stays reachable.
    //
    // Not parameterised over viewport width: the component no longer reads
    // `window.innerWidth` at all, and jsdom applies no CSS and evaluates no
    // media queries, so mounting at 500 vs 1280 renders byte-identical output.
    // A width loop here would look like breakpoint coverage while proving
    // nothing. The layout classes are asserted directly below instead, and the
    // real breakpoint behaviour was verified in Edge at 390x844 and 1440x900.
    await wrapper.find('[data-test-id="photo-info-button"]').trigger('click');
    await wrapper.vm.$nextTick();

    expect(wrapper.find('[data-test-id="photo-info-panel"]').exists()).toBe(true);
    expect(wrapper.find('[data-test-id="photo-filmstrip"]').exists()).toBe(true);
  });

  it('stacks the stage and info sheet below lg, and goes back to a row at lg+', async () => {
    // `flex-col` is the single class the whole fix rests on. Drop it and the
    // container reverts to a row, the in-flow sheet becomes a side-by-side
    // sibling, the stage stops shrinking vertically, and the original bug is
    // back - with every other test in this file still green.
    const row = wrapper.find('[data-test-id="photo-stage-row"]');
    expect(row.classes()).toContain('flex-col');
    expect(row.classes()).toContain('lg:flex-row');
    // Without this the stage cannot give up height for the sheet at all.
    expect(row.classes()).toContain('min-h-0');
  });

  it('puts the sheet beside the photo in landscape below lg, not underneath it', async () => {
    // A phone on its side is 844x390 - still below `lg`, so it took the stacked
    // layout and splitting the height left the photo ~87px tall once the
    // filmstrip had its 80. Wide-and-short needs the other axis.
    //
    // Every landscape rule is scoped `max-lg:` on purpose: a desktop monitor is
    // landscape too, and an unscoped `landscape:w-2/5` would fight `lg:w-90`
    // on the sheet with the winner decided by Tailwind's variant sort order.
    await wrapper.find('[data-test-id="photo-info-button"]').trigger('click');
    await wrapper.vm.$nextTick();

    const row = wrapper.find('[data-test-id="photo-stage-row"]');
    expect(row.classes()).toContain('max-lg:landscape:flex-row');

    const sheet = wrapper.find('[data-test-id="photo-info-panel"]');
    expect(sheet.classes()).toContain('max-lg:landscape:h-full');
    expect(sheet.classes()).toContain('max-lg:landscape:w-2/5');

    for (const className of [...row.classes(), ...sheet.classes()]) {
      if (className.startsWith('landscape:')) {
        throw new Error(`Unscoped landscape variant "${className}" would also apply at lg+`);
      }
    }
  });

  it('stacks the info sheet below lg but keeps it an absolute side drawer at lg+', async () => {
    // The whole fix in one assertion: the sheet must be in flow (no `absolute`)
    // so the stage column shrinks to the remaining half and `max-h-full` fits
    // the *whole* photo, while `lg:absolute` preserves the desktop drawer.
    await wrapper.find('[data-test-id="photo-info-button"]').trigger('click');
    await wrapper.vm.$nextTick();

    const sheet = wrapper.find('[data-test-id="photo-info-panel"]');
    expect(sheet.classes()).not.toContain('absolute');
    expect(sheet.classes()).toContain('lg:absolute');
    expect(sheet.classes()).toContain('h-1/2');
    // `shrink-0` is as load-bearing as `h-1/2`: without it the sheet defaults to
    // `flex-shrink: 1` and gives up height alongside the stage, so the split
    // lands somewhere other than the intended half.
    expect(sheet.classes()).toContain('shrink-0');
  });

  it('hides only the caption below lg while the info panel is open, to buy the photo back height', async () => {
    // The file name is already in the sheet's own `photo-info-file` block, so
    // hiding it here loses nothing. A CSS breakpoint, not a JS one - the element
    // stays mounted, which is why this checks classes and not `exists()`.
    await flushPromises();
    const closed = wrapper.find('[data-test-id="photo-file-name"]');
    expect(closed.classes()).not.toContain('hidden');

    await wrapper.find('[data-test-id="photo-info-button"]').trigger('click');
    await wrapper.vm.$nextTick();

    const caption = wrapper.find('[data-test-id="photo-file-name"]');
    expect(caption.classes()).toContain('hidden');
    expect(caption.classes()).toContain('lg:block');
  });

  it('shows the info toggle as pressed with a filled icon and the primary colour', async () => {
    // `aria-pressed` alone is invisible; the icon swap and the dropped
    // `p-button-secondary` are what make the state readable on screen.
    const button = wrapper.find('[data-test-id="photo-info-button"]');
    expect(button.attributes('aria-pressed')).toBe('false');
    expect(button.classes()).toContain('p-button-secondary');

    await button.trigger('click');
    await wrapper.vm.$nextTick();

    const pressed = wrapper.find('[data-test-id="photo-info-button"]');
    expect(pressed.attributes('aria-pressed')).toBe('true');
    expect(pressed.classes()).not.toContain('p-button-secondary');
  });
});
