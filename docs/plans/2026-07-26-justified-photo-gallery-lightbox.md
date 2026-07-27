# Justified Photo Gallery + Lightbox Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Display album photos in justified rows at their original aspect ratio, open them in a full-screen lightbox, and reveal EXIF details plus a location map behind an info button.

**Architecture:** Pure `ui/` change. Aspect ratios are measured in the browser from `img.naturalWidth / naturalHeight`, cached in `localStorage`, and fed to a CSS flexbox justified layout as a single `--ratio` custom property per cell — CSS derives all sizes, so no resize listener exists. `PhotoDetail.vue` becomes a `<Teleport>`-ed overlay rendered above the still-mounted grid, with its EXIF sidebar extracted into a presentational `PhotoInfoPanel.vue` that the info button toggles.

**Tech Stack:** Vue 3.5 (`script setup`), TypeScript (strict), PrimeVue 4, Tailwind CSS v4, Pinia, Vitest + `@vue/test-utils`, Bun.

**Spec:** [`docs/specs/2026-07-26-justified-photo-gallery-lightbox-design.md`](../specs/2026-07-26-justified-photo-gallery-lightbox-design.md)

## Global Constraints

- **No `server/` changes.** Not the API, not D1, not R2, not any type in `server/src/types/`. The photo API contract stays `{ url, key, size, lastModified }`.
- **Commit once per task — authorised.** The user explicitly authorised per-task commits for this plan, superseding the default `CLAUDE.md` prohibition. Each task ends with `git add` of **only that task's files** followed by `git commit`.
- **Never add AI attribution to a commit message.** No `Co-Authored-By`, no "Generated with" trailer. `CLAUDE.md`: "NEVER put your name in the commit message as co-author."
- **Stage only your own task's files.** `server/package.json`, `bun.lock` and `CLAUDE.md` carry unrelated changes the user made. Never `git add -A` or `git add .` — name every path explicitly.
- **Tests must cover failure and edge cases, not only happy paths.** For every unit under test, cover: invalid or zero input, absent data, storage/IO failure, boundary values, and each guarded or clamped branch. A suite proving only the success path is incomplete and will be rejected at review.
- **No `any` types.** Strict TypeScript throughout. Define interfaces for all data.
- **Vue components:** `script setup` + PrimeVue components + Tailwind utility classes.
- **Accessibility is a requirement, not a nicety:** every `<img>` needs a meaningful `alt`; every icon-only button needs `aria-label`; the lightbox needs `role="dialog"` + `aria-modal="true"` + focus trap + focus restore.
- **Browser support:** Chrome, Safari, Firefox. No feature outside that intersection.
- **Verification after every task, from the repo root:** `bun run type-check`, `bun run test:all`, `bun run lint`. Run `bun run build` before the final task's hand-off. `bun run test:unit` does **not** exist at the root — it is a `ui/` script only.
- **Single-workspace test runs:** `bun run --cwd ui test:unit`.
- **Aspect ratios clamp to `[0.4, 3.0]`.** Seed default is `1.5` (3:2), replaced by the album's median once 5 photos in it are measured. Clamping means an extreme panorama is cropped in the grid and shown whole in the lightbox — this is intended.
- **Row heights:** 105px (`<640`), 150px (`≥640`), 190px (`≥1024`), 220px (`≥1280`). These give 2 photos per row on a phone, matching today's density, and 4 larger ones on a desktop instead of today's 6.
- **ImageKit URL roles:** thumbnail `?tr=h-320` (+ `h-640` at 2×); the lightbox `<img>`, the EXIF read and `PanoramaViewer` all share one `sharedPhotoUrl()` → `?tr=md-true`, with no dimension transform. **Superseded twice:** an intermediate version of this bullet said `lightboxUrl()` → `?tr=h-1600,md-true`; the `h-1600` downscale was reverted because it made the info panel's dimensions and megapixels describe the downscaled copy rather than the original (design doc §4.7). Before that, this bullet read "lightbox uses the plain URL because stored photos are already ~1080 px, so a downscale would be a no-op; EXIF read `?tr=md-true` as insurance" — both premises were wrong (a real sample measured 4000×2250 at 3.5 MB, and `ExifReader` does not get a `206` here, so its own separate `?tr=md-true`-only URL cost a full download), and using two different URLs for the `<img>` and the EXIF read meant the same photo downloaded twice per view. See the design doc's §4.4/§4.5 for the measurements and the fix.
- **No swipe gesture in the lightbox.** Deferred by decision.

---

## File Structure

**Create**

| File | Responsibility |
| --- | --- |
| `ui/src/schema/exif.ts` | The shared `ExifData` type. **Must be a plain `.ts` module** — `<script setup>` cannot carry named exports, so this type cannot live in `PhotoInfoPanel.vue`. |
| `ui/src/utils/photo-url.ts` | Build the three ImageKit URL variants from a base photo URL. Pure functions, no Vue. |
| `ui/src/utils/__tests__/photo-url.spec.ts` | Tests for the above. |
| `ui/src/composables/use-photo-aspect-ratios.ts` | Aspect-ratio cache: read, write, clamp, persist to `localStorage`. |
| `ui/src/composables/__tests__/use-photo-aspect-ratios.spec.ts` | Tests for the above. |
| `ui/src/assets/justified-grid.css` | The `.justified-grid` / `.photo-cell` rules and the `--photo-row-height` breakpoints. Global because the custom property must cascade across a component boundary. |
| `ui/src/components/PhotoInfoPanel.vue` | Presentational EXIF/details/map sidebar. Props in, nothing emitted. |
| `ui/src/components/__tests__/photo-info-panel.spec.ts` | Tests for the above. |
| `ui/src/components/__tests__/photo.spec.ts` | Tests for `Photo.vue`'s justified grid cell. |
| `ui/src/components/__tests__/photo-location-map.spec.ts` | Tests that two maps can coexist. |

**Modify**

| File | Change |
| --- | --- |
| `ui/src/utils/local-storage-key.ts` | Add two keys. |
| `ui/src/composables/index.ts` | Export the new composable. |
| `ui/src/main.ts` | Import `justified-grid.css`. |
| `ui/src/components/Photo.vue` | Grid branch → justified cell. Delete the `onMounted`/`clientWidth` hack. |
| `ui/src/views/PhotoList.vue` | Flex container + last-row spacers; `PhotoDetail` becomes an overlay sibling. |
| `ui/src/components/SkeletonPhotoList.vue` | Grid skeleton → justified rows. |
| `ui/src/components/PhotoLocationMap.vue` | `useId()` + template ref instead of a hardcoded DOM id. |
| `ui/src/components/PhotoDetail.vue` | Becomes the lightbox; sidebar extracted; `imageStyles` deleted. |
| `ui/src/components/__tests__/photo-detail.spec.ts` | Overlay + info-toggle tests; three `imageStyles` tests removed. |

**Do not touch:** `SquareImage.vue`, `PanoramaViewer.vue`, any store, any service, any schema, `ui/src/mocks/setup-query-mock.ts` (no new query keys).

---

> **Task 0 is at the end of this document** and is optional — a two-minute manual
> EXIF check. Nothing depends on its outcome, so you may start at Task 1.

---

## Task 1: ImageKit URL builders

The three URL roles are needed by Tasks 3 and 8. Isolating them keeps the ImageKit
query-string knowledge in one tested place instead of interpolated into templates.

**Files:**
- Create: `ui/src/utils/photo-url.ts`
- Create: `ui/src/utils/__tests__/photo-url.spec.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  ```ts
  export const thumbnailUrl: (url: string) => string;        // ?tr=h-320
  export const thumbnailSrcSet: (url: string) => string;     // "…h-320 1x, …h-640 2x"
  export const exifUrl: (url: string) => string;             // ?tr=md-true
  ```
  **Superseded — do not implement `exifUrl` as written.** It shipped, then merged
  into `sharedPhotoUrl()` (same `?tr=md-true`, one builder for the lightbox
  `<img>`, the EXIF read and `PanoramaViewer`). Two builders meant two cache keys
  and a full second download per view. The rest of this task stands; see the
  "ImageKit URL roles" bullet above and design doc §4.4/§4.7.

- [ ] **Step 1: Write the failing test**

`ui/src/utils/__tests__/photo-url.spec.ts`:

```ts
import { exifUrl, thumbnailSrcSet, thumbnailUrl } from '@/utils/photo-url';
import { describe, expect, it } from 'vitest';

const BASE = 'https://ik.imagekit.io/abc/album-1/photo.jpg';

describe('photo-url', () => {
  it('requests a height-only thumbnail so ImageKit preserves the aspect ratio', () => {
    expect(thumbnailUrl(BASE)).toBe(`${BASE}?tr=h-320`);
  });

  it('offers a 2x thumbnail via srcset', () => {
    expect(thumbnailSrcSet(BASE)).toBe(`${BASE}?tr=h-320 1x, ${BASE}?tr=h-640 2x`);
  });

  it('preserves metadata for the EXIF read, or GPS and camera data are stripped', () => {
    expect(exifUrl(BASE)).toBe(`${BASE}?tr=md-true`);
  });

  it('appends with & when the url already has a query string', () => {
    const signed = `${BASE}?token=xyz`;
    expect(thumbnailUrl(signed)).toBe(`${signed}&tr=h-320`);
  });

  it('returns an empty string unchanged rather than producing a bare query string', () => {
    expect(thumbnailUrl('')).toBe('');
    expect(exifUrl('')).toBe('');
  });

  it('returns an empty srcset rather than a malformed " 1x,  2x" candidate list', () => {
    // The guard inside withTransformation is not enough here: composing two empty
    // results into a template literal would still emit descriptors.
    expect(thumbnailSrcSet('')).toBe('');
  });

  it('builds a srcset correctly when the url already has a query string', () => {
    const signed = `${BASE}?token=xyz`;
    expect(thumbnailSrcSet(signed)).toBe(`${signed}&tr=h-320 1x, ${signed}&tr=h-640 2x`);
  });
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `bun run --cwd ui test:unit -- photo-url`
Expected: FAIL — `Failed to resolve import "@/utils/photo-url"`.

- [ ] **Step 3: Write the implementation**

`ui/src/utils/photo-url.ts`:

```ts
/**
 * ImageKit URL builders.
 *
 * ImageKit resizes only when a `tr` transformation is present, and it preserves
 * the source aspect ratio only when a single dimension is given — `h-320` yields
 * a 320px-tall image at its natural width, whereas `w-320,h-320` centre-crops to
 * a square. It also strips all metadata by default, including EXIF GPS, unless
 * `md-true` is set.
 *
 * In development `VITE_IMAGEKIT_CDN_URL` points at a raw R2 bucket, which ignores
 * these parameters and serves the original. That is expected.
 */

/** Thumbnail height in CSS pixels; covers the largest row height at 1x. */
const THUMBNAIL_HEIGHT = 320;

/** Thumbnail height for 2x displays. */
const THUMBNAIL_HEIGHT_2X = 640;

/**
 * Append an ImageKit transformation to a photo URL.
 *
 * @param url Base CDN URL. An empty value is returned unchanged.
 * @param transformation `tr` value, for example `h-320`.
 * @returns The URL with the transformation appended.
 */
const withTransformation = (url: string, transformation: string): string => {
  if (!url) {
    return url;
  }
  const separator = url.includes('?') ? '&' : '?';
  return `${url}${separator}tr=${transformation}`;
};

/** Grid thumbnail: height-constrained so the aspect ratio survives. */
export const thumbnailUrl = (url: string): string =>
  withTransformation(url, `h-${THUMBNAIL_HEIGHT}`);

/**
 * `srcset` using `x` descriptors, which depend only on device pixel ratio.
 *
 * The empty-URL guard has to be repeated here: `withTransformation` returns ''
 * unchanged, but composing two of those into a template literal would yield
 * " 1x,  2x" — a malformed candidate list — rather than ''.
 */
export const thumbnailSrcSet = (url: string): string => {
  if (!url) {
    return url;
  }
  return (
    `${withTransformation(url, `h-${THUMBNAIL_HEIGHT}`)} 1x, ` +
    `${withTransformation(url, `h-${THUMBNAIL_HEIGHT_2X}`)} 2x`
  );
};

/*
 * There is deliberately no lightbox URL builder. Stored photos are already about
 * 1080px wide — camera originals are not kept, because they are too large — so a
 * downscaling transform would be a no-op, and ImageKit does not upscale. The
 * lightbox uses the plain URL, exactly as it does today.
 */

/**
 * EXIF read. On the ImageKit demo account, metadata is stripped from every URL
 * including the untransformed one, and only `md-true` preserves it. This
 * deployment's EXIF demonstrably works without it, so this is insurance against
 * that difference, not a fix.
 */
export const exifUrl = (url: string): string => withTransformation(url, 'md-true');
```

- [ ] **Step 4: Run the test and confirm it passes**

Run: `bun run --cwd ui test:unit -- photo-url`
Expected: PASS, 5 tests.

- [ ] **Step 5: Verify and stage**

```bash
bun run type-check && bun run lint
git add ui/src/utils/photo-url.ts ui/src/utils/__tests__/photo-url.spec.ts
```

Then commit (stage only the paths listed above — never `git add -A`):

```bash
git commit -m "feat(ui): add ImageKit URL builders for thumbnail and EXIF variants"
```

---

## Task 2: Aspect-ratio cache composable

**Files:**
- Create: `ui/src/composables/use-photo-aspect-ratios.ts`
- Create: `ui/src/composables/__tests__/use-photo-aspect-ratios.spec.ts`
- Modify: `ui/src/utils/local-storage-key.ts`
- Modify: `ui/src/composables/index.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  ```ts
  export const DEFAULT_ASPECT_RATIO = 1.5;
  export const MIN_ASPECT_RATIO = 0.4;
  export const MAX_ASPECT_RATIO = 3;
  export const MIN_SAMPLES_FOR_ALBUM_DEFAULT = 5;

  export default function usePhotoAspectRatios(): {
    getRatio: (key: string) => number;
    setRatio: (key: string, width: number, height: number) => void;
  };

  /** Test-only: drops in-memory state so specs start clean. */
  export const __resetAspectRatioCache: () => void;
  ```

- [ ] **Step 1: Add the storage keys**

Append to `ui/src/utils/local-storage-key.ts`:

```ts
export const PHOTO_ASPECT_RATIOS = 'PHOTO_ASPECT_RATIOS';
export const PHOTO_INFO_PANEL_OPEN = 'PHOTO_INFO_PANEL_OPEN';
```

- [ ] **Step 2: Write the failing test**

`ui/src/composables/__tests__/use-photo-aspect-ratios.spec.ts`:

```ts
import usePhotoAspectRatios, {
  DEFAULT_ASPECT_RATIO,
  MAX_ASPECT_RATIO,
  MIN_ASPECT_RATIO,
  __resetAspectRatioCache,
} from '@/composables/use-photo-aspect-ratios';
import { PHOTO_ASPECT_RATIOS } from '@/utils/local-storage-key';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('usePhotoAspectRatios', () => {
  beforeEach(() => {
    localStorage.clear();
    __resetAspectRatioCache();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('returns the 3:2 default for an unmeasured photo', () => {
    const { getRatio } = usePhotoAspectRatios();
    expect(getRatio('album/unknown.jpg')).toBe(DEFAULT_ASPECT_RATIO);
  });

  it('returns a measured ratio', () => {
    const { getRatio, setRatio } = usePhotoAspectRatios();
    setRatio('album/wide.jpg', 4000, 2000);
    expect(getRatio('album/wide.jpg')).toBe(2);
  });

  it('clamps an extreme panorama so it cannot occupy a whole row', () => {
    const { getRatio, setRatio } = usePhotoAspectRatios();
    setRatio('album/pano.jpg', 12000, 1000);
    expect(getRatio('album/pano.jpg')).toBe(MAX_ASPECT_RATIO);
  });

  it('clamps an extremely tall photo', () => {
    const { getRatio, setRatio } = usePhotoAspectRatios();
    setRatio('album/tall.jpg', 500, 5000);
    expect(getRatio('album/tall.jpg')).toBe(MIN_ASPECT_RATIO);
  });

  it('ignores zero dimensions from a failed image load', () => {
    const { getRatio, setRatio } = usePhotoAspectRatios();
    setRatio('album/broken.jpg', 0, 0);
    expect(getRatio('album/broken.jpg')).toBe(DEFAULT_ASPECT_RATIO);
  });

  it('persists to localStorage after the debounce window', () => {
    const { setRatio } = usePhotoAspectRatios();
    setRatio('album/a.jpg', 3000, 2000);
    expect(localStorage.getItem(PHOTO_ASPECT_RATIOS)).toBeNull();

    vi.advanceTimersByTime(500);

    expect(JSON.parse(localStorage.getItem(PHOTO_ASPECT_RATIOS) as string)).toEqual({
      'album/a.jpg': 1.5,
    });
  });

  it('rehydrates a persisted ratio into a fresh cache', () => {
    localStorage.setItem(PHOTO_ASPECT_RATIOS, JSON.stringify({ 'album/b.jpg': 2.5 }));
    __resetAspectRatioCache();

    const { getRatio } = usePhotoAspectRatios();
    expect(getRatio('album/b.jpg')).toBe(2.5);
  });

  it('falls back to defaults when stored JSON is corrupt', () => {
    localStorage.setItem(PHOTO_ASPECT_RATIOS, '{not json');
    __resetAspectRatioCache();

    const { getRatio } = usePhotoAspectRatios();
    expect(getRatio('album/c.jpg')).toBe(DEFAULT_ASPECT_RATIO);
  });

  it('uses the album median as the default once enough photos are measured', () => {
    const { getRatio, setRatio } = usePhotoAspectRatios();

    // A portrait-heavy album: five measurements, median 0.75.
    setRatio('portraits/1.jpg', 3, 4); // 0.75
    setRatio('portraits/2.jpg', 3, 4); // 0.75
    setRatio('portraits/3.jpg', 3, 4); // 0.75
    setRatio('portraits/4.jpg', 2, 3); // 0.667
    setRatio('portraits/5.jpg', 4, 3); // 1.333

    expect(getRatio('portraits/unmeasured.jpg')).toBe(0.75);
  });

  it('keeps the seed default until the album has enough samples', () => {
    const { getRatio, setRatio } = usePhotoAspectRatios();
    setRatio('sparse/1.jpg', 3, 4);
    setRatio('sparse/2.jpg', 3, 4);

    expect(getRatio('sparse/unmeasured.jpg')).toBe(DEFAULT_ASPECT_RATIO);
  });

  it('does not let one album affect another album default', () => {
    const { getRatio, setRatio } = usePhotoAspectRatios();
    for (let i = 1; i <= 5; i++) {
      setRatio(`portraits/${i}.jpg`, 3, 4);
    }

    expect(getRatio('landscapes/unmeasured.jpg')).toBe(DEFAULT_ASPECT_RATIO);
  });

  it('uses the median, so one panorama cannot drag the default', () => {
    const { getRatio, setRatio } = usePhotoAspectRatios();
    setRatio('mixed/1.jpg', 3, 2); // 1.5
    setRatio('mixed/2.jpg', 3, 2); // 1.5
    setRatio('mixed/3.jpg', 3, 2); // 1.5
    setRatio('mixed/4.jpg', 3, 2); // 1.5
    setRatio('mixed/5.jpg', 6000, 1000); // clamped to 3

    expect(getRatio('mixed/unmeasured.jpg')).toBe(1.5);
  });

  it('freezes the album default rather than letting it drift', () => {
    const { getRatio, setRatio } = usePhotoAspectRatios();
    for (let i = 1; i <= 5; i++) {
      setRatio(`frozen/${i}.jpg`, 3, 2); // median settles at 1.5
    }
    expect(getRatio('frozen/unmeasured.jpg')).toBe(1.5);

    // Twenty portraits afterwards must not move the placeholder; a drifting default
    // would itself re-pack the layout, which is what this exists to prevent.
    for (let i = 6; i <= 25; i++) {
      setRatio(`frozen/${i}.jpg`, 2, 3);
    }
    expect(getRatio('frozen/unmeasured.jpg')).toBe(1.5);
  });

  it('rebuilds album defaults from persisted ratios before any image loads', () => {
    localStorage.setItem(
      PHOTO_ASPECT_RATIOS,
      JSON.stringify({
        'revisited/1.jpg': 0.75,
        'revisited/2.jpg': 0.75,
        'revisited/3.jpg': 0.75,
        'revisited/4.jpg': 0.75,
        'revisited/5.jpg': 0.75,
      }),
    );
    __resetAspectRatioCache();

    const { getRatio } = usePhotoAspectRatios();
    expect(getRatio('revisited/unmeasured.jpg')).toBe(0.75);
  });

  it('keeps working in memory when localStorage writes throw', () => {
    // Spy on `window.localStorage`, NOT `Storage.prototype`: ui/vitest.setup.ts
    // replaces window.localStorage with a hand-rolled LocalStorageMock that does not
    // extend Storage, so a Storage.prototype spy never intercepts the real call.
    const setItem = vi.spyOn(window.localStorage, 'setItem').mockImplementation(() => {
      throw new DOMException('QuotaExceededError');
    });

    const { getRatio, setRatio } = usePhotoAspectRatios();
    setRatio('album/d.jpg', 2000, 1000);
    vi.advanceTimersByTime(500);

    expect(setItem).toHaveBeenCalled();
    expect(getRatio('album/d.jpg')).toBe(2);
  });
});
```

- [ ] **Step 3: Run the test and confirm it fails**

Run: `bun run --cwd ui test:unit -- use-photo-aspect-ratios`
Expected: FAIL — cannot resolve `@/composables/use-photo-aspect-ratios`.

- [ ] **Step 4: Write the implementation**

`ui/src/composables/use-photo-aspect-ratios.ts`:

```ts
import { PHOTO_ASPECT_RATIOS } from '@/utils/local-storage-key';
import { reactive } from 'vue';

/** 3:2, the most common photo ratio. The seed default, before an album has samples. */
export const DEFAULT_ASPECT_RATIO = 1.5;

/**
 * Measurements an album needs before its own median replaces the seed default.
 * Low, because the whole point is to settle the layout early.
 */
export const MIN_SAMPLES_FOR_ALBUM_DEFAULT = 5;

/** Floor, so an extremely tall photo cannot force a very short row. */
export const MIN_ASPECT_RATIO = 0.4;

/** Ceiling, so a panorama cannot occupy an entire row on its own. */
export const MAX_ASPECT_RATIO = 3;

/** Entry cap; ~200KB of the 5MB localStorage quota. */
const MAX_ENTRIES = 5000;

/** Coalesces the burst of writes produced by a screenful of images loading. */
const PERSIST_DEBOUNCE_MS = 500;

/**
 * Module-level so every component shares one cache for the SPA session.
 * Reactive so a cell re-renders when its ratio is measured.
 */
let ratios = reactive(new Map<string, number>());

/**
 * Per-album placeholder ratio, set exactly once when an album reaches
 * MIN_SAMPLES_FOR_ALBUM_DEFAULT measurements, then never changed.
 *
 * Frozen deliberately. A default that kept drifting as more photos loaded would
 * itself shift the layout, which is the very thing this is meant to reduce. Reactive
 * so cells still using the placeholder re-render the moment it is first established.
 */
let albumDefaults = reactive(new Map<string, number>());

/** Measured ratios per album, so the median is computed without scanning `ratios`. */
let albumSamples = new Map<string, number[]>();

let hydrated = false;
let persistTimer: ReturnType<typeof setTimeout> | undefined;

/** `<albumId>/<photoId>` → `<albumId>`. */
const albumIdOf = (key: string): string => key.split('/')[0] ?? '';

const median = (values: number[]): number => {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? ((sorted[middle - 1] as number) + (sorted[middle] as number)) / 2
    : (sorted[middle] as number);
};

/**
 * Record a sample and, on crossing the threshold for the first time, freeze that
 * album's placeholder ratio.
 *
 * Median rather than mean, so one clamped panorama cannot skew it. This is a far
 * better placeholder than a fixed 1.5 for albums that are not mostly 3:2: an
 * all-portrait album otherwise starts every cell at 1.5 and settles at ~0.667,
 * shrinking each to ~44% of its placeholder width and re-packing the whole page.
 */
const noteSample = (key: string, ratio: number): void => {
  const albumId = albumIdOf(key);
  if (!albumId || albumDefaults.has(albumId)) {
    return;
  }
  const samples = albumSamples.get(albumId) ?? [];
  samples.push(ratio);
  albumSamples.set(albumId, samples);

  if (samples.length >= MIN_SAMPLES_FOR_ALBUM_DEFAULT) {
    albumDefaults.set(albumId, median(samples));
    albumSamples.delete(albumId); // no longer needed once frozen
  }
};

/** Read persisted ratios. Never throws: a corrupt or unavailable store yields nothing. */
const hydrate = (): void => {
  if (hydrated) {
    return;
  }
  hydrated = true;
  try {
    const raw = localStorage.getItem(PHOTO_ASPECT_RATIOS);
    if (!raw) {
      return;
    }
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) {
      return;
    }
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value === 'number' && Number.isFinite(value)) {
        ratios.set(key, value);
        // Rebuild album defaults from persisted data, so a revisited album has its
        // placeholder ready before a single image loads.
        noteSample(key, value);
      }
    }
  } catch {
    // Corrupt JSON or a disabled store: run from memory only.
  }
};

/** Write the cache out. Never throws: Safari private mode rejects writes. */
const persist = (): void => {
  try {
    localStorage.setItem(PHOTO_ASPECT_RATIOS, JSON.stringify(Object.fromEntries(ratios)));
  } catch {
    // Quota exceeded or storage disabled: the in-memory cache still works.
  }
};

const schedulePersist = (): void => {
  clearTimeout(persistTimer);
  persistTimer = setTimeout(persist, PERSIST_DEBOUNCE_MS);
};

/** Drop the oldest insertions once the cap is exceeded. */
const prune = (): void => {
  while (ratios.size > MAX_ENTRIES) {
    const oldest = ratios.keys().next();
    if (oldest.done) {
      return;
    }
    ratios.delete(oldest.value);
  }
};

/**
 * Shared cache of measured photo aspect ratios.
 *
 * The photo API returns no image dimensions, so ratios can only come from the
 * browser once an image has loaded. Persisting them means the justified layout
 * is stable on every visit after the first.
 */
export default function usePhotoAspectRatios() {
  hydrate();

  /**
   * @param key Photo key, `${albumId}/${photoId}`.
   * @returns The measured ratio; else the album's frozen median default once it has
   *          enough samples; else the 3:2 seed default. All O(1).
   */
  const getRatio = (key: string): number => {
    const measured = ratios.get(key);
    if (measured !== undefined) {
      return measured;
    }
    return albumDefaults.get(albumIdOf(key)) ?? DEFAULT_ASPECT_RATIO;
  };

  /**
   * Record a ratio measured from a loaded image.
   *
   * @param key Photo key.
   * @param width `naturalWidth`; ignored when not positive.
   * @param height `naturalHeight`; ignored when not positive.
   */
  const setRatio = (key: string, width: number, height: number): void => {
    // `Number.isFinite` is load-bearing, not belt-and-braces: `NaN <= 0` is false, so a
    // NaN dimension would pass a bare `<= 0` guard, be stored, and then permanently
    // poison the album median — which freezes and can never self-correct.
    if (
      !key ||
      !Number.isFinite(width) ||
      !Number.isFinite(height) ||
      width <= 0 ||
      height <= 0
    ) {
      return;
    }
    const ratio = Math.min(MAX_ASPECT_RATIO, Math.max(MIN_ASPECT_RATIO, width / height));
    if (ratios.get(key) === ratio) {
      return;
    }
    ratios.set(key, ratio);
    noteSample(key, ratio);
    prune();
    schedulePersist();
  };

  return { getRatio, setRatio };
}

/** Test-only hook: clears in-memory state so specs do not leak into each other. */
export const __resetAspectRatioCache = (): void => {
  clearTimeout(persistTimer);
  persistTimer = undefined;
  ratios = reactive(new Map<string, number>());
  albumDefaults = reactive(new Map<string, number>());
  albumSamples = new Map<string, number[]>();
  hydrated = false;
};
```

- [ ] **Step 5: Export from the barrel**

Add to `ui/src/composables/index.ts`. That file uses the `@/` alias, not a relative
path — match it:

```ts
export { default as usePhotoAspectRatios } from '@/composables/use-photo-aspect-ratios';
```

- [ ] **Step 6: Run the test and confirm it passes**

Run: `bun run --cwd ui test:unit -- use-photo-aspect-ratios`
Expected: PASS, 15 tests.

- [ ] **Step 7: Verify and stage**

```bash
bun run type-check && bun run lint
git add ui/src/composables ui/src/utils/local-storage-key.ts
```

Then commit (stage only the paths listed above — never `git add -A`):

```bash
git commit -m "feat(ui): add persisted photo aspect-ratio cache"
```

---

## Task 3: Justified grid CSS and the `Photo.vue` cell

**Files:**
- Create: `ui/src/assets/justified-grid.css`
- Create: `ui/src/components/__tests__/photo.spec.ts`
- Modify: `ui/src/main.ts`
- Modify: `ui/src/components/Photo.vue` (grid branch only; lines 2-35, and delete `onMounted` at 136-141)

**Interfaces:**
- Consumes: `thumbnailUrl`, `thumbnailSrcSet` (Task 1); `usePhotoAspectRatios` (Task 2).
- Produces: the `.justified-grid` container class consumed by Task 4; `Photo.vue` gains an
  `eager: boolean` prop (default `false`) that Task 4 sets for the first 12 cells.

- [ ] **Step 1: Write the stylesheet**

`ui/src/assets/justified-grid.css`:

```css
/*
 * Justified photo rows.
 *
 * Each cell contributes `flex-grow: --ratio` and
 * `flex-basis: --ratio * --photo-row-height`. Flexbox distributes a row's free
 * space in proportion to flex-grow, so for every cell in a row:
 *
 *   width  = ratio * (H + free / sum-of-ratios)
 *   height = width / ratio = H + free / sum-of-ratios   <- equal for the whole row
 *
 * Sizes are therefore derived entirely in CSS. JavaScript supplies only --ratio,
 * which means resize, zoom and orientation changes need no listener.
 *
 * Global rather than scoped because --photo-row-height is set on the container in
 * PhotoList.vue and read by cells rendered inside Photo.vue.
 */

.justified-grid {
  display: flex;
  flex-wrap: wrap;
  gap: 0.25rem;
  /*
   * Row height is the single tuning knob; photos-per-row falls out of it and the
   * container width. For 3:2 photos this yields 2 per row on a ~360px phone
   * (matching the previous grid-cols-2 density) and 4 larger photos on a 1500px
   * desktop, where the square grid previously showed 6. Lower the 1280px value to
   * ~150px to restore the denser desktop look.
   */
  --photo-row-height: 105px;
}

@media (min-width: 640px) {
  .justified-grid {
    --photo-row-height: 150px;
  }
}

@media (min-width: 1024px) {
  .justified-grid {
    --photo-row-height: 190px;
  }
}

@media (min-width: 1280px) {
  .justified-grid {
    --photo-row-height: 220px;
  }
}

.photo-cell {
  flex-grow: var(--ratio, 1.5);
  /*
   * Both custom properties need fallbacks. Without one on --photo-row-height, a
   * cell rendered outside .justified-grid resolves flex-basis to 0, and
   * `min-width: 0` plus `aspect-ratio` then collapses it to zero height in Safari.
   */
  flex-basis: calc(var(--ratio, 1.5) * var(--photo-row-height, 150px));
  aspect-ratio: var(--ratio, 1.5);
  min-width: 0;
}

/*
 * Trailing spacers stop flexbox stretching the final row to full width, which
 * would make its photos taller than every other row. `flex-basis: 0` means they
 * can never force an extra row; a high flex-grow means they absorb almost all of
 * the last row's free space.
 */
.photo-cell-spacer {
  flex-grow: 10;
  flex-basis: 0;
  height: 0;
}
```

- [ ] **Step 2: Import the stylesheet**

In `ui/src/main.ts`, add alongside the existing `./assets/primevue-override.css` import:

```ts
import './assets/justified-grid.css';
```

- [ ] **Step 3: Write the failing test**

`ui/src/components/__tests__/photo.spec.ts`:

```ts
import Photo from '@/components/Photo.vue';
import { __resetAspectRatioCache } from '@/composables/use-photo-aspect-ratios';
import { createTestingPinia } from '@pinia/testing';
import { mount } from '@vue/test-utils';
import PrimeVue from 'primevue/config';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('vue-router', async () => {
  const actual = (await vi.importActual('vue-router')) as Record<string, unknown>;
  return {
    ...actual,
    useRoute: vi.fn(() => ({ params: { albumId: 'album', year: '2026' }, query: {} })),
    useRouter: vi.fn(() => ({ replace: vi.fn(), push: vi.fn() })),
  };
});

vi.mock('primevue/usetoast', () => ({ useToast: vi.fn(() => ({ add: vi.fn() })) }));

const PHOTO = {
  key: 'album/photo1.jpg',
  url: 'https://cdn.test/album/photo1.jpg',
  size: 1_234_567,
  lastModified: '2026-01-01T00:00:00.000Z',
};

const mountPhoto = (eager = false) =>
  mount(Photo, {
    props: { photoStyle: 'grid', photo: PHOTO, eager },
    global: {
      plugins: [PrimeVue, createTestingPinia({ createSpy: vi.fn })],
    },
  });

describe('Photo.vue justified grid cell', () => {
  beforeEach(() => {
    localStorage.clear();
    __resetAspectRatioCache();
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
});
```

- [ ] **Step 4: Run the test and confirm it fails**

Run: `bun run --cwd ui test:unit -- photo.spec`
Expected: FAIL — `--ratio` is absent and `src` still contains `w-`.

- [ ] **Step 5: Rewrite the grid branch**

Replace `Photo.vue`'s grid branch (currently lines 2-35) with:

```html
<div
  v-if="photoStyle === 'grid'"
  :style="{ '--ratio': aspectRatio }"
  :class="['photo-item photo-cell relative cursor-pointer', { 'photo-selected rounded-md': isPhotoSelected }]"
  data-test-id="photo-item"
>
  <img
    :id="`photo-image-${photo['key']}`"
    :alt="photoAltText"
    :src="thumbnailUrl(photo['url'])"
    :srcset="thumbnailSrcSet(photo['url'])"
    :loading="eager ? 'eager' : 'lazy'"
    :fetchpriority="eager ? 'high' : 'auto'"
    class="bg-surface-200 dark:bg-surface-800 h-full w-full rounded-md object-cover"
    decoding="async"
    @click="goToPhotoDetail"
    @load="onThumbnailLoad"
  />
  <div
    v-if="isAdmin"
    class="photo-top-button-container absolute top-0 right-0 left-0 flex justify-between"
  >
    <Button
      v-tooltip="'Select Photo'"
      :severity="`${isPhotoSelected ? 'primary' : 'secondary'}`"
      aria-label="Select photo"
      data-test-id="select-photo-button"
      rounded
      text
      @click="selectPhoto(photo['key'])"
    >
      <template #icon>
        <IconCircleCheckFilled :size="24" />
      </template>
    </Button>
    <EditPhotoButton :photo-key="photo['key']" extra-class="text-white" />
  </div>
  <IconInfoCircle
    v-if="isAlbumCover(photo['key'])"
    v-tooltip="'Album cover'"
    :size="24"
    class="text-primary-600 absolute bottom-1 left-1"
  />
</div>
```

The `bg-surface-200 dark:bg-surface-800` fill on the `<img>` is what a broken
thumbnail leaves behind: the cell keeps its reserved space instead of collapsing
and re-packing the row.

- [ ] **Step 6: Update the script block**

Add the `eager` prop to `defineProps`:

```ts
eager: {
  type: Boolean,
  default: false,
},
```

Add these imports and members:

```ts
import { usePhotoAspectRatios } from '@/composables';
import { thumbnailSrcSet, thumbnailUrl } from '@/utils/photo-url';

const { getRatio, setRatio } = usePhotoAspectRatios();

const aspectRatio = computed(() => getRatio(photo.value['key'] as string));

/** File name without its extension — far more useful to a screen reader than the key. */
const photoAltText = computed(() => photoId.value.replace(/\.[^.]+$/, ''));

const onThumbnailLoad = (event: Event) => {
  const img = event.target as HTMLImageElement;
  setRatio(photo.value['key'] as string, img.naturalWidth, img.naturalHeight);
};
```

**Delete** the `onMounted` block at lines 136-141 and the `imageWidth` ref at line 88,
then drop `onMounted` from the `vue` import. The thumbnail size no longer depends on
the rendered element width.

Leave the `detail` branch, `selectPhoto`, `goToPhotoDetail` and the `<style>` block
untouched. `SquareImage` is still imported and used by the `detail` branch.

- [ ] **Step 7: Run the test and confirm it passes**

Run: `bun run --cwd ui test:unit -- photo.spec`
Expected: PASS, 5 tests.

- [ ] **Step 8: Verify and stage**

```bash
bun run type-check && bun run test:all && bun run lint
git add ui/src/assets/justified-grid.css ui/src/main.ts ui/src/components/Photo.vue ui/src/components/__tests__/photo.spec.ts
```

Then commit (stage only the paths listed above — never `git add -A`):

```bash
git commit -m "feat(ui): render grid photos at their original aspect ratio"
```

---

## Task 4: Justified container and skeleton

**Files:**
- Modify: `ui/src/views/PhotoList.vue` (the grid container, currently lines 161-176)
- Modify: `ui/src/components/SkeletonPhotoList.vue` (the grid skeleton, lines 12-16)

**Interfaces:**
- Consumes: `.justified-grid`, `.photo-cell-spacer`, and `Photo.vue`'s `eager` prop (Task 3).
- Produces: nothing consumed by later tasks.

- [ ] **Step 1: Replace the grid container**

In `PhotoList.vue`, replace the `<div v-if="photosInAlbum.length > 0" :class="[...]">` block
and its `<Photo>` child with:

```html
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
```

- [ ] **Step 2: Add the constant**

In the `PhotoList.vue` script block, near the other top-level constants:

```ts
/** Cells loaded eagerly so the first screenful does not wait on the lazy-load observer. */
const EAGER_PHOTO_COUNT = 12;
```

- [ ] **Step 3: Collapse the skeleton's dead branch**

`SkeletonPhotoList.vue` splits on `v-if="!photoId"` — a grid skeleton versus a
detail-page skeleton. That split only made sense while the detail view *replaced*
the grid. From Task 7 onward the grid stays mounted and the lightbox shows its own
`ProgressSpinner`, so the `v-else` branch becomes unreachable.

Delete the `v-else` branch (lines 18-30), the surrounding `<template v-if>` wrapper,
and the now-unused `photoId` computed together with the `useRoute` import. The
component renders one thing: the grid skeleton.

- [ ] **Step 4: Update the skeleton**

In `SkeletonPhotoList.vue`, replace the grid skeleton (lines 12-16) with rows of
mixed widths so the loading state resembles justified rows rather than squares:

```html
<div class="mt-4 flex flex-wrap gap-1">
  <Skeleton
    v-for="(width, n) in SKELETON_WIDTHS"
    :key="n"
    :height="isXSmallDevice ? '8.75rem' : '13.75rem'"
    :width="width"
  />
</div>
```

And in its script block:

```ts
/** Mixed widths so the placeholder reads as justified rows, not a square grid. */
const SKELETON_WIDTHS = ['18%', '26%', '14%', '22%', '16%', '24%', '20%', '18%'];
```

- [ ] **Step 5: Verify the album list view still passes**

`album-list.spec.ts` mounts views that render `Photo`. Run the full UI suite:

Run: `bun run --cwd ui test:unit`
Expected: PASS. If `album-list.spec.ts` asserts on `grid-cols-*` classes for the
photo grid, update those assertions to `justified-grid`. Do **not** change the
assertions for the album grid — only the photo grid moves.

- [ ] **Step 6: Verify the layout in a real browser**

jsdom has no layout engine — `getBoundingClientRect()` returns zeros and flexbox
never computes — so the unit tests above prove only that `--ratio` reaches the
element. Row packing must be measured in a real browser.

Start the dev server on a port that will not collide with `bun run dev`:

```bash
cd ui && bunx vite --mode MSW --port 5174 --host 127.0.0.1
```

Then, against `http://127.0.0.1:5174/album/na/demo-album-4`, assert each of the
following by measuring `getBoundingClientRect()` on `[data-test-id="photo-item"]`
and grouping cells by rounded `top`:

| # | Assertion | Why it can fail |
| --- | --- | --- |
| 1 | Cells are **no longer square** — width ≠ height for a landscape photo | The measured baseline was 221 × 221; if it stays square, `?tr=` still has both `w` and `h`, or `aspect-ratio` is not applying |
| 2 | Within each row, every cell has the **same height** (±1px) | `--photo-row-height` failed to cascade from the container into `Photo.vue`'s root, so `flex-basis` collapsed |
| 3 | The last row is **not TALLER** than the preceding row | The trailing spacers are missing, wrongly ordered, or their `flex-basis` is non-zero. Note the assertion is one-sided on purpose: the failure mode being prevented is a *stretched* final row. A final row that comes out **shorter** than its neighbours is the spacers working correctly — a lone photo settles near the target row height while full rows stretch above it. An earlier draft of this plan wrongly demanded "within 15%", which a correct implementation fails. |
| 4 | Rows are flush: `left` of the first cell ≈ container padding, and `right` of the last cell ≈ container width | A stray `justify-content` or margin |
| 5 | At a **360 × 780** viewport, the first row holds **exactly 2** landscape cells | `--photo-row-height` at the `<640px` breakpoint is wrong. The measured pre-change baseline is 2 per row, so this preserves today's density |
| 6 | `img` `src` ends with `?tr=h-320` and `srcset` contains `?tr=h-640 2x` | Task 1 or Task 3 wiring |

Capture a screenshot at 1440 × 900 and at 360 × 780 for the record.

**Baseline for comparison, measured before any change:** 8 cells, 2 rows, first row
6 cells at 221 × 221, first `src` = `…?tr=w-221,h-221`.

- [ ] **Step 7: Verify and stage**

```bash
bun run type-check && bun run test:all && bun run lint
git add ui/src/views/PhotoList.vue ui/src/components/SkeletonPhotoList.vue
```

Then commit (stage only the paths listed above — never `git add -A`):

```bash
git commit -m "feat(ui): pack album photos into justified rows"
```

---

## Task 5: Allow two maps to coexist

Required before Task 7: today the grid unmounts when the detail view opens, so only
one map exists at a time. Once the grid stays mounted beneath the lightbox, the
toolbar's album Popover map and the lightbox's photo map can be alive together, and
`getElementById('photo-location-map')` would bind Mapbox to whichever node the
document happens to return first.

**Files:**
- Modify: `ui/src/components/PhotoLocationMap.vue`
- Create: `ui/src/components/__tests__/photo-location-map.spec.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `PhotoLocationMap` keeps its existing props (`latitude`, `longitude`, `width`, `height`). No API change.
- **Three consumers, not two:** `PhotoDetail.vue`, `PhotoList.vue`, and `CreateAlbum.vue`.
  All three must keep working untouched.
- **Expect fallout in two other spec files.** `photo-detail.spec.ts` and `create-album.spec.ts`
  mount without `attachTo`, and the OLD `getElementById` implementation silently found
  nothing for a detached wrapper, so Mapbox was never constructed — accidental test
  isolation. A template ref binds unconditionally, so both specs need a `mapbox-gl` mock
  added. That is a genuine consequence of the fix, not scope creep.

- [ ] **Step 1: Write the failing test**

`ui/src/components/__tests__/photo-location-map.spec.ts`:

```ts
import PhotoLocationMap from '@/components/PhotoLocationMap.vue';
import { mount } from '@vue/test-utils';
import { defineComponent } from 'vue';
import { describe, expect, it, vi } from 'vitest';

const mapInstances: { container: unknown }[] = [];
// Declared here, not inside a test, so the "calls map.resize() when Mapbox
// reports idle" test below can reference it.
const resizeSpy = vi.fn();

vi.mock('mapbox-gl', () => ({
  default: {
    accessToken: '',
    Map: vi.fn(function (options: { container: unknown }) {
      mapInstances.push(options);
      return {
        // Actually invoke the 'idle' callback, so the component's
        // `map.on('idle', () => map?.resize())` handler runs for real. An inert
        // `on: vi.fn()` (as an earlier draft of this recipe had) would leave the
        // resize assertion below unable to prove anything - it would pass even
        // if the component never wired up `map.on('idle', …)` at all.
        on: vi.fn((event: string, cb: () => void) => {
          if (event === 'idle') cb();
        }),
        remove: vi.fn(),
        resize: resizeSpy,
      };
    }),
    // `function`, not an arrow: the component calls `new mapboxgl.Marker()`, and arrow
    // functions have no [[Construct]] slot, so an arrow mock throws.
    Marker: vi.fn(function () {
      return { setLngLat: vi.fn().mockReturnThis(), addTo: vi.fn() };
    }),
  },
}));

describe('PhotoLocationMap.vue', () => {
  it('binds Mapbox to its own element, so two maps can coexist', () => {
    mapInstances.length = 0;

    const first = mount(PhotoLocationMap, {
      props: { latitude: -33.85, longitude: 151.21 },
      attachTo: document.body,
    });
    const second = mount(PhotoLocationMap, {
      props: { latitude: 51.5, longitude: -0.12 },
      attachTo: document.body,
    });

    expect(mapInstances).toHaveLength(2);
    expect(mapInstances[0]?.container).toBe(first.element);
    expect(mapInstances[1]?.container).toBe(second.element);
    expect(mapInstances[0]?.container).not.toBe(mapInstances[1]?.container);

    first.unmount();
    second.unmount();
  });

  /*
   * Two maps must be mounted in ONE app, not two separate mount() calls.
   *
   * `useId()` is app-scoped, and Vue Test Utils creates a fresh app per mount(), so two
   * independent mounts both receive `v-0` — a cross-mount uniqueness assertion is invalid
   * and will fail against a correct implementation. It also does not model the real
   * scenario, which is the toolbar Popover map and the lightbox map coexisting inside the
   * single application instance.
   *
   * Do NOT "fix" a failing cross-mount test by wrapping it in `it.fails`: that inverts the
   * signal, so restoring the old hardcoded id would make the test report as passing.
   */
  it('gives sibling instances distinct ids and distinct containers in one app', () => {
    mapInstances.length = 0;

    const TwoMaps = defineComponent({
      components: { PhotoLocationMap },
      template: `
        <div>
          <PhotoLocationMap :latitude="1" :longitude="2" />
          <PhotoLocationMap :latitude="3" :longitude="4" />
        </div>
      `,
    });

    const wrapper = mount(TwoMaps, { attachTo: document.body });
    const [first, second] = wrapper.findAllComponents(PhotoLocationMap);

    expect(first?.attributes('id')).toBeTruthy();
    expect(first?.attributes('id')).not.toBe(second?.attributes('id'));

    // The point of the whole task: each map is bound to its OWN element.
    expect(mapInstances).toHaveLength(2);
    expect(mapInstances[0]?.container).toBe(first?.element);
    expect(mapInstances[1]?.container).toBe(second?.element);
    expect(mapInstances[0]?.container).not.toBe(mapInstances[1]?.container);

    wrapper.unmount();
  });

  it('calls map.resize() when Mapbox reports idle', () => {
    // The map is often inside a Popover with no size until it opens.
    mapInstances.length = 0;
    resizeSpy.mockClear();
    const wrapper = mount(PhotoLocationMap, { props: { latitude: 1, longitude: 2 } });
    expect(resizeSpy).toHaveBeenCalled();
    wrapper.unmount();
  });
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `bun run --cwd ui test:unit -- photo-location-map`
Expected: FAIL — `container` is the string `'photo-location-map'`, not an element,
and both instances share one id.

- [ ] **Step 3: Rewrite the component**

`ui/src/components/PhotoLocationMap.vue`:

```html
<template>
  <div :id="mapId" ref="mapContainer" :style="`width: ${width}; height: ${height};`" class="rounded-md"></div>
</template>

<script lang="ts" setup>
import mapboxgl from 'mapbox-gl';
import { onMounted, onUnmounted, ref, toRefs, useId } from 'vue';

const props = defineProps({
  latitude: {
    type: Number,
    default: () => 0,
  },
  longitude: {
    type: Number,
    default: () => 0,
  },
  width: {
    type: String,
    default: () => '100%',
  },
  height: {
    type: String,
    default: () => '300px',
  },
});

const { latitude, longitude, width, height } = toRefs(props);

/**
 * A unique id per instance. The album Popover map and the lightbox photo map can
 * be mounted at the same time, so a shared literal id would make Mapbox bind to
 * the wrong element.
 */
const mapId = useId();
const mapContainer = ref<HTMLDivElement | null>(null);

let map: mapboxgl.Map | undefined;

onMounted(() => {
  mapboxgl.accessToken = import.meta.env.VITE_MAPBOX_API_KEY as string;

  if (!mapContainer.value) {
    return;
  }

  map = new mapboxgl.Map({
    container: mapContainer.value,
    style: 'mapbox://styles/mapbox/standard',
    center: [longitude.value, latitude.value],
    zoom: 11,
  });

  new mapboxgl.Marker().setLngLat([longitude.value, latitude.value]).addTo(map);

  map.on('idle', () => {
    map?.resize();
  });
});

onUnmounted(() => {
  map?.remove();
  map = undefined;
});
</script>
```

- [ ] **Step 4: Run the test and confirm it passes**

Run: `bun run --cwd ui test:unit -- photo-location-map`
Expected: PASS, 3 tests.

- [ ] **Step 5: Verify and stage**

```bash
bun run type-check && bun run test:all && bun run lint
git add ui/src/components/PhotoLocationMap.vue ui/src/components/__tests__/photo-location-map.spec.ts
```

Then commit (stage only the paths listed above — never `git add -A`):

```bash
git commit -m "fix(ui): scope PhotoLocationMap to its own element so two maps can coexist"
```

---

## Task 6: Extract `PhotoInfoPanel.vue`

Pure extraction plus two added fields. No behaviour of the existing sections changes,
which keeps Task 7's overlay work separable from this markup move.

**Files:**
- Create: `ui/src/components/PhotoInfoPanel.vue`
- Create: `ui/src/components/__tests__/photo-info-panel.spec.ts`

**Interfaces:**
- Consumes: `PhotoLocationMap` (Task 5).
- Produces:
  ```ts
  // PhotoInfoPanel props
  {
    photo: Photo | undefined;          // for file name and size
    exifTags: Partial<ExifData>;       // ExifTags & FileTags & { ProjectionType?: ValueTag }
    naturalWidth: number;
    naturalHeight: number;
    isPanorama: boolean;
  }
  ```
  The `ExifData` type currently declared inside `PhotoDetail.vue` moves to a new
  plain module, `ui/src/schema/exif.ts`, imported by both components:
  ```ts
  import type { ExifTags, FileTags, ValueTag } from 'exifreader';

  /**
   * EXIF payload as returned by ExifReader, plus the equirectangular marker used
   * to detect 360 photos. Lives in a plain module because `<script setup>` cannot
   * declare named exports.
   */
  export type ExifData = ExifTags & FileTags & { ProjectionType?: ValueTag };
  ```
  Also re-export it from `ui/src/schema/index.ts`, which uses an
  `import type` / `export type { … }` pair rather than `export … from`:
  ```ts
  import type { ExifData } from './exif';   // add to the existing import block
  // then add ExifData to the alphabetised export type { … } list
  ```

- [ ] **Step 1: Write the failing test**

`ui/src/components/__tests__/photo-info-panel.spec.ts`:

```ts
import PhotoInfoPanel from '@/components/PhotoInfoPanel.vue';
import { mount } from '@vue/test-utils';
import PrimeVue from 'primevue/config';
import { describe, expect, it, vi } from 'vitest';

vi.mock('mapbox-gl', () => ({
  default: {
    accessToken: '',
    Map: vi.fn(() => ({ on: vi.fn(), remove: vi.fn(), resize: vi.fn() })),
    // `function`, not an arrow: the component calls `new mapboxgl.Marker()`, and arrow
    // functions have no [[Construct]] slot, so an arrow mock throws.
    Marker: vi.fn(function () {
      return { setLngLat: vi.fn().mockReturnThis(), addTo: vi.fn() };
    }),
  },
}));

const PHOTO = { key: 'album/photo1.jpg', url: 'https://cdn.test/a/photo1.jpg', size: 1_782_579 };

const mountPanel = (overrides = {}) =>
  mount(PhotoInfoPanel, {
    props: {
      photo: PHOTO,
      exifTags: {},
      naturalWidth: 4000,
      naturalHeight: 3000,
      isPanorama: false,
      ...overrides,
    },
    global: { plugins: [PrimeVue] },
  });

describe('PhotoInfoPanel.vue', () => {
  it('shows dimensions, megapixels and file size', () => {
    const text = mountPanel().text();
    expect(text).toContain('4000 x 3000');
    expect(text).toContain('12 MP');
    expect(text).toContain('1.70 MB');
  });

  it('omits the camera section when EXIF has no model', () => {
    expect(mountPanel().find('[data-test-id="photo-info-camera"]').exists()).toBe(false);
  });

  it('shows the camera section when EXIF has a model', () => {
    const wrapper = mountPanel({
      exifTags: {
        Make: { description: 'samsung' },
        Model: { value: ['Galaxy A34 5G'], description: 'Galaxy A34 5G' },
      },
    });
    const camera = wrapper.find('[data-test-id="photo-info-camera"]');
    expect(camera.exists()).toBe(true);
    expect(camera.text()).toContain('samsung');
    expect(camera.text()).toContain('Galaxy A34 5G');
  });

  it('omits the map when EXIF has no GPS', () => {
    expect(mountPanel().find('[data-test-id="photo-info-map"]').exists()).toBe(false);
  });

  it('shows the map when EXIF has GPS', () => {
    const wrapper = mountPanel({
      exifTags: {
        GPSLatitudeRef: { value: ['S'], description: 'South latitude' },
        GPSLongitudeRef: { value: ['E'], description: 'East longitude' },
        GPSLatitude: { description: '33.85' },
        GPSLongitude: { description: '151.21' },
      },
    });
    expect(wrapper.find('[data-test-id="photo-info-map"]').exists()).toBe(true);
  });

  it('negates southern latitudes and western longitudes', () => {
    const wrapper = mountPanel({
      exifTags: {
        GPSLatitudeRef: { value: ['S'], description: 'South latitude' },
        GPSLongitudeRef: { value: ['W'], description: 'West longitude' },
        GPSLatitude: { description: '33.85' },
        GPSLongitude: { description: '70.66' },
      },
    });
    const map = wrapper.findComponent({ name: 'PhotoLocationMap' });
    expect(map.props('latitude')).toBe(-33.85);
    expect(map.props('longitude')).toBe(-70.66);
  });

  it('omits the date section when neither EXIF nor the file name carries one', () => {
    expect(mountPanel().find('[data-test-id="photo-info-date"]').exists()).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `bun run --cwd ui test:unit -- photo-info-panel`
Expected: FAIL — cannot resolve `@/components/PhotoInfoPanel.vue`.

- [ ] **Step 3: Create the component**

Create `PhotoInfoPanel.vue` by moving, verbatim, from `PhotoDetail.vue`:

- the template from line 75 (`<div class="col-span-4 mt-3 lg:col-span-1 lg:mt-0">`) through line 162, dropping the outer grid-column wrapper and the `EditPhotoButton` (which belongs to the lightbox toolbar in Task 7);
- the `ExifData` type (lines 196-199) → into the new `ui/src/schema/exif.ts` shown in the Interfaces block above, **not** into this `.vue` file;
- these computeds unchanged: `localDateTime`, `latitude`, `longitude`, `exposureBias`, `aperture`, `imageOriginalWidth`, `imageOriginalHeight`, `isPhotoLandscape`.

`photoFileName` becomes derived from the `photo` prop rather than a local ref:

```ts
const photoFileName = computed(() => props.photo?.key.split('/')[1] ?? '');
```

`isPanoramaPhoto` stays in `PhotoDetail.vue` — the lightbox needs it to choose
between `<img>` and `PanoramaViewer` — and arrives here as the `isPanorama` prop,
replacing `isPanoramaPhoto.value` inside `isPhotoLandscape`.

Add these three, which the existing sidebar did not show:

```ts
/** Megapixels, matching how Google Photos labels a file. */
const megaPixels = computed(() => {
  const pixels = props.naturalWidth * props.naturalHeight;
  return pixels > 0 ? `${Math.round(pixels / 1_000_000)} MP` : '';
});

/** Human-readable file size. Mirrors the formatting already used by Photo.vue. */
const fileSize = computed(() => {
  const bytes = props.photo?.size;
  if (!bytes) {
    return '';
  }
  const kb = bytes / 1024;
  return kb < 1024 ? `${kb.toFixed(2)} KB` : `${(kb / 1024).toFixed(2)} MB`;
});
```

Add `data-test-id` attributes the tests rely on: `photo-info-file` (name, dimensions,
MP, size), `photo-info-date`, `photo-info-camera`, `photo-info-map`. Give the map
wrapper `data-test-id="photo-info-map"`.

- [ ] **Step 4: Run the test and confirm it passes**

Run: `bun run --cwd ui test:unit -- photo-info-panel`
Expected: PASS, 7 tests.

- [ ] **Step 5: Verify and stage**

`PhotoDetail.vue` is not yet wired to the new panel, so it still renders its own
sidebar and `photo-detail.spec.ts` must still pass unchanged.

```bash
bun run type-check && bun run test:all && bun run lint
git add ui/src/components/PhotoInfoPanel.vue ui/src/components/__tests__/photo-info-panel.spec.ts
```

Then commit (stage only the paths listed above — never `git add -A`):

```bash
git commit -m "feat(ui): extract PhotoInfoPanel with megapixel and file-size details"
```

---

## Task 7: Turn `PhotoDetail.vue` into a lightbox overlay

**Files:**
- Modify: `ui/src/components/PhotoDetail.vue`
- Modify: `ui/src/views/PhotoList.vue` (lines 6 and 180-202)
- Modify: `ui/src/components/__tests__/photo-detail.spec.ts`

**Interfaces:**
- Consumes: `exifUrl` (Task 1); `PhotoInfoPanel` (Task 6) and `ExifData` from `@/schema`.
- Produces: `PhotoDetail` keeps its existing `refreshPhotoList` and `closePhotoDetail` emits, so `PhotoList.vue`'s handlers are unchanged.

- [ ] **Step 1: Stop unmounting the grid**

In `PhotoList.vue`, change the grid's condition on line 6 from
`v-if="!photoId && !showPhotoUploader"` to `v-if="!showPhotoUploader"`, then replace
the `v-else` block (lines 180-202) with:

```html
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
```

The `?photo=` query parameter is untouched, so deep links, `closePhotoDetail` and
browser-back keep working exactly as before.

- [ ] **Step 2: Write the failing tests**

Add to `photo-detail.spec.ts`. Teleported content leaves the wrapper, so stub
`Teleport` in the existing `mount` options to keep every current assertion working —
add to the `global` object in `beforeEach`:

```ts
stubs: { teleport: true },
```

Then add:

```ts
it('renders as a modal dialog over the grid', () => {
  const dialog = wrapper.find('[role="dialog"]');
  expect(dialog.exists()).toBe(true);
  expect(dialog.attributes('aria-modal')).toBe('true');
});

it('shows the stored photo untransformed, since it is already display-sized', () => {
  const src = wrapper.find('img').attributes('src');
  expect(src).toBe('https://example.com/photo1.jpg');
  expect(src).not.toContain('tr=');
});

it('reads EXIF with md-true, or ImageKit strips GPS and camera tags', async () => {
  const ExifReader = (await import('exifreader')).default;
  expect(ExifReader.load).toHaveBeenCalledWith(
    expect.stringContaining('?tr=md-true'),
  );
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
  await wrapper.find('[data-test-id="photo-info-button"]').trigger('click');
  expect(wrapper.find('[data-test-id="photo-info-panel"]').text()).toContain('1000 x 1000');
});
```

**Delete** the three tests that assert on the now-deleted `imageStyles` computed —
at [`:289`](../../ui/src/components/__tests__/photo-detail.spec.ts#L289),
[`:319`](../../ui/src/components/__tests__/photo-detail.spec.ts#L319) and
[`:342`](../../ui/src/components/__tests__/photo-detail.spec.ts#L342). The
`1000 x 1000` text assertion from `:323` is preserved by the last new test above.
Keep every other existing test: keyboard navigation, the photo-not-found toast,
and EXIF-absent handling.

- [ ] **Step 3: Run the tests and confirm they fail**

Run: `bun run --cwd ui test:unit -- photo-detail`
Expected: FAIL — no `role="dialog"`, no info button, `src` has no `tr=`.

- [ ] **Step 4: Rewrite the template**

```html
<template>
  <Teleport to="body">
    <div
      :aria-label="`Photo ${photoFileName}`"
      aria-modal="true"
      class="fixed inset-0 z-[1100] flex flex-col bg-black/95"
      role="dialog"
      tabindex="-1"
      ref="dialogRef"
    >
      <header class="flex shrink-0 items-center justify-between gap-2 p-2 text-white">
        <div class="min-w-0">
          <div class="truncate" data-test-id="photo-file-name">{{ photoFileName }}</div>
          <div class="text-surface-400 text-sm" data-test-id="photo-index">
            ({{ selectedImageIndex + 1 }}/{{ photosInAlbum.length }})
          </div>
        </div>
        <div class="flex shrink-0 items-center gap-1">
          <Button
            v-tooltip.bottom="'Info'"
            :aria-pressed="isInfoOpen"
            aria-label="Toggle photo information"
            data-test-id="photo-info-button"
            rounded
            severity="secondary"
            text
            @click="toggleInfo"
          >
            <template #icon>
              <IconInfoCircle :size="24" />
            </template>
          </Button>
          <EditPhotoButton v-if="isAdmin && selectedImage" :photo-key="selectedImage.key" />
          <Button
            aria-label="Close photo"
            data-test-id="close-button"
            rounded
            severity="secondary"
            text
            @click="emits('closePhotoDetail')"
          >
            <template #icon>
              <IconX :size="24" />
            </template>
          </Button>
        </div>
      </header>

      <div class="relative flex min-h-0 grow">
        <div
          :class="['relative flex min-w-0 grow items-center justify-center', { 'lg:mr-[360px]': isInfoOpen }]"
        >
          <ProgressSpinner v-if="loadImage" />
          <template v-else>
            <img
              v-if="!isPanoramaPhoto"
              :alt="photoAltText"
              :src="selectedImage?.url ?? ''"
              class="max-h-full max-w-full object-contain"
              @error="onImageError"
              @load="onImageLoad"
            />
            <PanoramaViewer v-else :imageUrl="selectedImage?.url ?? ''" />
          </template>

          <Button
            v-if="photosInAlbum.length > 1"
            aria-label="Previous photo"
            class="absolute! top-1/2! left-2! h-11! min-w-11!"
            data-test-id="previous-photo-button"
            rounded
            @click="nextPhoto(-1)"
          >
            <template #icon>
              <IconChevronLeft :size="24" />
            </template>
          </Button>
          <Button
            v-if="photosInAlbum.length > 1"
            aria-label="Next photo"
            class="absolute! top-1/2! right-2! h-11! min-w-11!"
            data-test-id="next-photo-button"
            rounded
            @click="nextPhoto(1)"
          >
            <template #icon>
              <IconChevronRight :size="24" />
            </template>
          </Button>
        </div>

        <transition
          enter-active-class="transition ease-out duration-200 motion-reduce:transition-none"
          enter-from-class="opacity-0 translate-y-full lg:translate-y-0 lg:translate-x-full"
          leave-active-class="transition ease-in duration-200 motion-reduce:transition-none"
          leave-to-class="opacity-0 translate-y-full lg:translate-y-0 lg:translate-x-full"
        >
          <aside
            v-if="isInfoOpen"
            aria-label="Photo information"
            class="dark:bg-surface-900 bg-surface-0 absolute right-0 bottom-0 left-0 z-10 h-1/2 overflow-y-auto rounded-t-lg p-4 lg:top-0 lg:left-auto lg:h-full lg:w-[360px] lg:rounded-none"
            data-test-id="photo-info-panel"
          >
            <PhotoInfoPanel
              :exif-tags="exifTags"
              :is-panorama="isPanoramaPhoto"
              :natural-height="naturalHeight"
              :natural-width="naturalWidth"
              :photo="selectedImage"
            />
          </aside>
        </transition>
      </div>
    </div>
  </Teleport>
</template>
```

- [ ] **Step 5: Rewrite the script block**

Keep unchanged: `selectedImageIndex`, `selectedImage`, `photoFileName`, `exifTags`,
`loadImage`, `naturalWidth`/`naturalHeight`, `nextPhoto`, `isPanoramaPhoto`,
`onImageLoad`, `onImageError`, and both `watch` blocks on `photoId` and `selectedImage`.

**Delete:** the `imageStyles` computed (lines 342-396), `photoImageDetailRef`,
`imageContainerWidth`, `imageContainerHeight`, `updateContainerDimensions`, the
`resize` listener, and the `watch` on `loadImage`. `object-contain` with
`max-h-full max-w-full` replaces all of it. Also delete the computeds that moved to
`PhotoInfoPanel` in Task 6: `localDateTime`, `latitude`, `longitude`, `exposureBias`,
`aperture`, `imageOriginalWidth`, `imageOriginalHeight`, `isPhotoLandscape`.

**Change** the EXIF read to preserve metadata:

```ts
exifTags.value = (await ExifReader.load(exifUrl(newValue.url))) as ExifData;
```

**Add:**

```ts
import PhotoInfoPanel from '@/components/PhotoInfoPanel.vue';
import type { ExifData } from '@/schema';
import { exifUrl } from '@/utils/photo-url';
import { PHOTO_INFO_PANEL_OPEN } from '@/utils/local-storage-key';
import { IconInfoCircle } from '@tabler/icons-vue';

const dialogRef = ref<HTMLDivElement | null>(null);
const isInfoOpen = ref(localStorage.getItem(PHOTO_INFO_PANEL_OPEN) === 'true');

/** File name without its extension, for screen readers. */
const photoAltText = computed(() => photoFileName.value.replace(/\.[^.]+$/, '') || 'Photo');

const toggleInfo = () => {
  isInfoOpen.value = !isInfoOpen.value;
  try {
    localStorage.setItem(PHOTO_INFO_PANEL_OPEN, String(isInfoOpen.value));
  } catch {
    // Storage disabled: the preference simply does not survive the session.
  }
};
```

Extend `onHandleKeydown` with an `i` case that calls `toggleInfo()`, keeping the
existing `INPUT`/`TEXTAREA`/`contentEditable` guard at the top so typing `i` in a
field does not toggle the panel.

Replace the mount and unmount hooks:

```ts
/** Element focused before the lightbox opened, so focus can be handed back. */
let previouslyFocused: HTMLElement | null = null;

/** Keep Tab inside the dialog while it is modal. */
const onTrapFocus = (event: KeyboardEvent) => {
  if (event.key !== 'Tab' || !dialogRef.value) {
    return;
  }
  const focusable = dialogRef.value.querySelectorAll<HTMLElement>(
    'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
  );
  if (focusable.length === 0) {
    return;
  }
  const first = focusable[0] as HTMLElement;
  const last = focusable[focusable.length - 1] as HTMLElement;
  const active = document.activeElement;

  // Focus outside the dialog (including the container itself on open) must be
  // pulled back in, or Tab silently escapes to the grid behind an aria-modal
  // overlay. Without this branch, focus starting on the dialog container itself
  // (as it does on open, via `dialogRef.value?.focus()`) matched neither `first`
  // nor `last` below, so the very first Tab/Shift+Tab press escaped the trap.
  if (!dialogRef.value.contains(active) || active === dialogRef.value) {
    event.preventDefault();
    (event.shiftKey ? last : first).focus();
    return;
  }
  if (event.shiftKey && active === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && active === last) {
    event.preventDefault();
    first.focus();
  }
};

onMounted(() => {
  previouslyFocused = document.activeElement as HTMLElement | null;
  document.body.classList.add('overflow-hidden');
  globalThis.addEventListener('keydown', onHandleKeydown);
  globalThis.addEventListener('keydown', onTrapFocus);
  dialogRef.value?.focus();
});

onUnmounted(() => {
  document.body.classList.remove('overflow-hidden');
  globalThis.removeEventListener('keydown', onHandleKeydown);
  globalThis.removeEventListener('keydown', onTrapFocus);
  previouslyFocused?.focus();
});
```

- [ ] **Step 6: Run the tests and confirm they pass**

Run: `bun run --cwd ui test:unit -- photo-detail`
Expected: PASS — the seven new tests plus every retained existing test.

- [ ] **Step 7: Run the whole suite**

Run: `bun run --cwd ui test:unit`
Expected: PASS. (`SkeletonPhotoList`'s `?photo=` branch was already removed in Task 4
Step 3, precisely because this change makes it unreachable.)

- [ ] **Step 8: Verify the lightbox in a real browser**

Against `http://127.0.0.1:5174/album/na/demo-album-4`, driving a real browser:

| # | Action | Assertion |
| --- | --- | --- |
| 1 | Click the first photo | URL gains `?photo=`; a `[role="dialog"]` exists; the grid's `[data-test-id="photo-item"]` cells are **still in the DOM** behind it |
| 2 | Inspect `document.body` | Carries `overflow-hidden`; `document.body.scrollHeight` does not change while open |
| 3 | Press `ArrowRight`, then `ArrowLeft` | `?photo=` changes and returns; the index caption tracks it |
| 4 | Click the info button | `[data-test-id="photo-info-panel"]` appears; at 1440px the stage's right edge moves left by ~360px rather than being overlapped |
| 5 | Press `i` twice | Panel closes then reopens |
| 6 | At 360 × 780, open the panel | It renders as a bottom sheet — its `top` is below the viewport midpoint, not pinned to the right edge |
| 7 | Reload with the panel open | It is still open, proving the `localStorage` preference persists |
| 8 | Press `Escape` | Dialog is gone; `?photo=` is cleared; `overflow-hidden` removed from `body` |
| 9 | Browser back after reopening | **Leaves the album** — this is pre-existing behaviour, not a bug introduced here. `Photo.vue:133` opens a photo with `router.replace`, so no history entry is created and back pops to whatever preceded the album. An earlier draft of this plan wrongly asserted that back closes the lightbox. Changing `replace` to `push` would make back close the lightbox (as Google Photos does), but that is a deliberate UX change and is out of scope. |
| 10 | Reopen, then close, then click the toolbar map button | The album Popover map still initialises — this is what the `useId()` fix in Task 5 protects |
| 11 | Check the console | No errors or Vue warnings logged during any of the above |

Capture a screenshot with the panel open at 1440 × 900 and at 360 × 780.

**Note on the demo data:** MSW demo photos have no GPS EXIF, so assertion 4 confirms
the panel opens, not that the map renders.

**Verifying the map needs the real API.** MSW cannot supply EXIF. Run both servers:

```bash
bun run --cwd server start:wrangler   # Worker on 8787; needs DEVELOPMENT=true in server/.dev.vars
bun run dev                            # UI on 9000 — CORS only allows 9000
```

Then open this photo, which the user confirmed carries GPS EXIF, and check that the
info panel renders date, camera, aperture/shutter/focal/ISO **and** the Mapbox pin:

```text
http://localhost:9000/album/na/demo-album-4?photo=auckland_18.28.53.jpg
```

This is also the check that settles Task 0: if the map renders here, EXIF survives
whatever CDN this deployment uses.

- [ ] **Step 9: Full verification and stage**

```bash
bun run type-check && bun run test:all && bun run lint && bun run build
git add ui/src/components/PhotoDetail.vue ui/src/views/PhotoList.vue ui/src/components/__tests__/photo-detail.spec.ts
```

Then commit (stage only the paths listed above — never `git add -A`):

```bash
git commit -m "feat(ui): open photos in a full-screen lightbox with a toggleable info panel"
```

---

## Task 0: EXIF sanity check — optional, ~2 minutes

**Already answered: EXIF works.** The project owner confirmed with a screenshot of a
live photo detail page showing date, `1080 x 720`, `f/2.8 | 1/100 | 8.96 mm | ISO125`,
`SONY ZV-1M2`, and a rendered Mapbox pin. So the blocking concern this task originally
guarded against is resolved, and Tasks 1-7 can proceed regardless of the outcome here.

What remains is a small ambiguity: that screenshot could have come from local
development, where `VITE_IMAGEKIT_CDN_URL` points at raw R2 and `tr` parameters are
ignored entirely. On the ImageKit **demo** account, metadata is stripped from every
URL including the untransformed one. Task 1 therefore adds `md-true` to the EXIF read
as cheap insurance. This check just confirms whether that insurance is doing anything.

**Files:** none. Skip if you already know the screenshot came from production.

- [ ] **Step 1: Pick a photo known to carry GPS EXIF**

Choose one taken on a phone with location services enabled, and note its key.

- [ ] **Step 2: Compare the two URLs**

Using the production CDN base from `ui/.env` line 9 (`https://ik.imagekit.io/oeqc5vsr3tf`):

```bash
curl -s -o with-md.jpg    "https://ik.imagekit.io/oeqc5vsr3tf/<key>?tr=md-true"
curl -s -o without-md.jpg "https://ik.imagekit.io/oeqc5vsr3tf/<key>"
ls -l with-md.jpg without-md.jpg
```

Then check each file for an `Exif` APP1 segment — for example open both in an EXIF
viewer, or reuse the byte-scanning approach from the spec's §4.3 verification.

- [ ] **Step 3: Record the outcome**

- Both carry EXIF → the account preserves metadata; `md-true` is redundant but
  harmless, and stays as insurance.
- Only `?tr=md-true` carries EXIF → the confirming screenshot was local, and Task 1's
  `md-true` is what keeps the info panel and map working in production. Worth noting
  in the PR description.

Either way, continue to Task 1.

---

## Task ordering

Task 0 (optional) → 1 → 2 → 3 → 4 → 5 → 6 → 7. Tasks 1 and 2 are independent of each
other and could run in parallel; everything from Task 3 onward is sequential.

---

## Self-Review

**Spec coverage**

| Spec section | Task |
| --- | --- |
| §4.2 single-dimension transform | 1, 3 |
| §4.3 `md-true` for EXIF | 0, 1, 7 |
| §5 flexbox justified rows | 3 |
| §6 layout mechanics, row heights, srcset, eager loading | 3, 4 |
| §7.1 aspect-ratio composable | 2 |
| §7.2 `PhotoInfoPanel` | 6 |
| §7.3 lightbox | 7 |
| §7.4 `PhotoList` overlay wiring | 7 |
| §7.5 `Photo.vue` grid cell | 3 |
| §7.6 `PhotoLocationMap` `useId` | 5 |
| §7.7 skeleton | 4 |
| §9 error handling | 2 (storage, zero dims, clamping), 3 (failed thumbnail), 7 (EXIF absent) |
| §10 testing | every task |

**Placeholder scan:** none. Every code step carries the actual code; every test step
carries the actual assertions; the only judgement call is Task 0 Step 3, which lists
all three outcomes and the action for each.

**Known jsdom quirks the executor should not chase:** `previouslyFocused?.focus()` in
Task 7 is a no-op under jsdom, where `document.activeElement` is `<body>`; do not add
a focus assertion for it. Teleport is stubbed in `photo-detail.spec.ts` so content
stays inside the wrapper and the existing selectors keep working.

**Type consistency:** `getRatio` / `setRatio` (Task 2) are used with those exact names
in Task 3. `thumbnailUrl` / `thumbnailSrcSet` / `exifUrl` (Task 1) match their uses in
Tasks 3 and 7; there is deliberately no lightbox URL builder. **Superseded:** `exifUrl`
became `sharedPhotoUrl`, which *is* the lightbox URL builder — see Task 1 and the
"ImageKit URL roles" bullet. `ExifData` lives in
`ui/src/schema/exif.ts`, re-exported from the `ui/src/schema` barrel, and is imported
under that name in both Task 6 and Task 7. `PhotoInfoPanel`'s five props match the five
bound attributes in Task 7's template. `EAGER_PHOTO_COUNT` (Task 4) pairs with the
`eager` prop declared in Task 3.

**Ordering:** Task 5 precedes Task 7 because the duplicate-id bug only becomes
reachable once the grid stays mounted. Task 6 precedes Task 7 because the lightbox
imports the panel. Tasks 1 and 2 precede Task 3 because the cell consumes both.

---

## Task 8: Thumbnail filmstrip and bottom-centre caption

Added after the user reviewed the working lightbox against
https://www.lightgalleryjs.com/#lg=nature&slide=0 and identified two gaps: there is no
thumbnail strip, and the filename sits top-left instead of bottom-centre.

**Files:**
- Create: `ui/src/components/PhotoFilmstrip.vue`
- Create: `ui/src/components/__tests__/photo-filmstrip.spec.ts`
- Modify: `ui/src/components/PhotoDetail.vue`
- Modify: `ui/src/components/__tests__/photo-detail.spec.ts`

**Interfaces:**
- Consumes: `thumbnailUrl` from `@/utils/photo-url` (Task 1); `Photo` from `@/schema`.
- Produces:
  ```ts
  // PhotoFilmstrip props
  { photos: Photo[]; activeIndex: number }
  // emits
  (e: 'select', index: number): void
  ```

### Layout, matching the reference

| Region | Content |
| --- | --- |
| Top-left | `(4/11)` counter — **stays where it is** |
| Top-right | info · edit · close |
| Centre | image stage |
| **Bottom-centre** | **filename caption — moved here from top-left** |
| **Below caption** | **thumbnail filmstrip** |

The caption and filmstrip live **inside the stage column**, so they inherit the
`lg:mr-[360px]` shift and stay visually tied to the image when the info drawer opens.

### Two decisions that are not cosmetic

**1. Roving tabindex is mandatory, not a nicety.** The filmstrip renders one button per
photo, and albums reach 200–500. Inside a focus-trapped `role="dialog"`, that would put 500
stops in the Tab cycle and make keyboard escape effectively impossible. So: the active
thumbnail carries `tabindex="0"`, every other carries `tabindex="-1"`. Tab enters the strip
once; `←`/`→` already move between photos at the window level, which moves the active
thumbnail with them. Mark the active one `aria-current="true"`.

**2. Thumbnails must lazy-load.** `?tr=h-160` (80px displayed at 2×) with `loading="lazy"`
and `decoding="async"`. Without this, opening the lightbox on a 500-photo album fires 500
image requests at once.

### Behaviour

- Clicking a thumbnail emits `select(index)`; `PhotoDetail` routes to that photo using the
  **existing** `?photo=` mechanism — do not introduce a second navigation path.
- On `activeIndex` change, scroll the active thumbnail into view with
  `scrollIntoView({ inline: 'center', block: 'nearest' })`. Use `behavior: 'smooth'` only
  when `matchMedia('(prefers-reduced-motion: reduce)')` does **not** match.
- The strip is hidden entirely when the album holds one photo, matching the prev/next
  chevrons.
- Height: 80px at `sm+`, 56px below that. Horizontal scroll, no wrap.
- The active thumbnail gets a visible ring meeting contrast requirements — do not rely on
  opacity alone, which fails for low-vision users.

### Tests — cover failure and edge cases, not only the happy path

`photo-filmstrip.spec.ts`:
- renders one button per photo, in order
- only the active button has `tabindex="0"`; all others `-1`
- the active button has `aria-current="true"` and no other does
- clicking a thumbnail emits `select` with **that** index
- thumbnails request `?tr=h-160` and carry `loading="lazy"`
- an empty `photos` array renders nothing and does not throw
- `activeIndex` out of range (`-1`, or `>= photos.length`) renders without throwing and
  marks nothing active
- `scrollIntoView` is called on `activeIndex` change, and uses `behavior: 'auto'` when
  `prefers-reduced-motion` matches (stub `matchMedia`; note `ui/vitest.setup.ts` already
  defines a `matchMedia` mock returning `matches: false` — override it per-test)

`photo-detail.spec.ts` additions:
- the caption renders the filename and is NOT inside the top bar
- the counter `(n/m)` is still in the top bar
- the filmstrip is absent for a single-photo album
- selecting a filmstrip thumbnail updates `?photo=`

### Verification

Unit tests cannot prove the strip scrolls or that the active ring is visible. I verify in a
real browser: filmstrip present, active thumbnail centred after `→`, caption bottom-centre
below the image, counter still top-left, and the strip shifting left when the info drawer
opens.

### Task 8 — corrections after user review of the running implementation

The user compared the working filmstrip against
https://www.lightgalleryjs.com/#lg=nature&slide=1 and reported two defects.

#### Correction 1: every thumbnail must be an IDENTICAL fixed box

The first implementation used `h-full w-auto` plus a height-only `?tr=h-160` transform, so
each thumbnail kept its own aspect ratio and widths varied wildly across the strip. That is
the right behaviour for the main justified grid and the **wrong** behaviour here — the
filmstrip is a uniform index, not a justified layout.

- Button and image both take a **fixed width and height** (see Correction 4 for the authoritative numbers): `h-16 w-24` below `sm`,
  `h-24 w-36` at `sm+` (144x96, 3:2). Never `w-auto`.
- The `<img>` gets `h-full w-full object-cover` so the image centre-crops to fill the box.
- The CDN transform must specify **both** dimensions so the crop happens server-side and
  every response is the same size: `?tr=w-288,h-192` (2x of 144x96, one cached variant).
  Recall §4.2: a single dimension preserves the ratio, both dimensions centre-crop — that
  is precisely the behaviour wanted here.
- `shrink-0` stays, so flex never squeezes a thumbnail narrower than its neighbours.

#### Correction 2: the strip must be drag-scrollable

Native `overflow-x-auto` gives touch and trackpad scrolling but leaves mouse users with no
way to move the strip beyond a scrollbar. lightGallery lets you grab and drag it.

- Implement with **pointer events** (`pointerdown` / `pointermove` / `pointerup` /
  `pointercancel`), not mouse events, so pen and touch are covered by the same path.
- On `pointerdown`, record `startX` and `startScrollLeft` and call `setPointerCapture` so a
  drag continuing outside the element still tracks.
- On `pointermove`, set `scrollLeft = startScrollLeft - (event.clientX - startX)`.
- **Suppress the click that follows a drag.** Track total movement; if it exceeds a small
  threshold (~5px), swallow the subsequent `click` so dragging across the strip does not
  navigate to whichever thumbnail the pointer happens to land on. This is the detail that
  makes drag-scroll feel broken when omitted.
- Cursor: `cursor-grab`, switching to `cursor-grabbing` while dragging.
- Do **not** call `preventDefault` on `pointerdown` — that would break native touch
  scrolling, which already works. Let touch fall through to the browser.
- Release pointer capture on `pointerup` and `pointercancel`; a missed `pointercancel`
  leaves the strip stuck in dragging state.

#### Tests for the corrections

- every thumbnail button carries the same width and height classes; none uses `w-auto`
- the thumbnail URL requests **both** `w-` and `h-` so the CDN crops uniformly
- `pointerdown` then `pointermove` changes `scrollLeft` by the negated pointer delta
- a drag beyond the threshold does **not** emit `select`
- a plain click with no movement **does** emit `select`
- `pointercancel` clears the dragging state

#### Correction 3: active-state marker

The reference marks the active thumbnail with a **coloured ring around an otherwise
identically-sized box** — it is never larger, smaller, or a different shape than its
neighbours. Use a ring in a theme accent colour with sufficient contrast against the black
strip. Reserve the ring's space on every thumbnail (a transparent ring on inactive items)
so activating one does not shift the strip's layout by the ring's width.

#### Correction 4: small devices

From the user's mobile reference shot: the strip stays present and the thumbnails stay
uniform on a phone — they are scaled down, not dropped or reflowed.

- **Keep one aspect ratio across breakpoints** so the server-side crop is identical and only
  one CDN variant is cached: 3:2 at both sizes. `h-16 w-24` (96x64) below `sm`,
  `h-24 w-36` (144x96) at `sm+`. Transform `?tr=w-288,h-192` (2x of 144x96) serves both.
- Thumbnails are touch targets. At 96x64 they clear the 44px minimum comfortably; do not
  shrink them further to fit more on screen.
- **Native touch scrolling must keep working.** The pointer-event drag handler exists for
  mouse users; on touch the browser's own scrolling is better. Do not `preventDefault` on
  `pointerdown`, and do not set `touch-action: none`.

##### The drawer/filmstrip collision — a decision the reference does not have to make

Below `lg` the info panel is a **bottom sheet occupying the lower half of the screen**, which
lands exactly on top of the caption and filmstrip. lightGallery has no info drawer, so its
layout offers no guidance here.

**Decision:** below `lg`, hide the caption and filmstrip while the info sheet is open. They
are fully occluded anyway, so leaving them mounted underneath wastes layout and puts
unreachable controls in the accessibility tree. At `lg+` the drawer is a side panel, so both
stay visible and simply shift with the stage.

Test: with the info panel open at a small viewport, the filmstrip and caption are absent
from the DOM; at a large viewport with the panel open, both are still present.
