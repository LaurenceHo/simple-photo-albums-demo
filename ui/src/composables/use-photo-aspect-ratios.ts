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
        // Clamped the same way `setRatio` clamps a freshly-measured value: persisted
        // data can be tampered with directly (it is plain localStorage JSON) or stale
        // from before MIN_ASPECT_RATIO/MAX_ASPECT_RATIO existed, and neither should be
        // able to bypass the limits every other path enforces.
        const clamped = Math.min(MAX_ASPECT_RATIO, Math.max(MIN_ASPECT_RATIO, value));
        ratios.set(key, clamped);
        // Rebuild album defaults from persisted data, so a revisited album has its
        // placeholder ready before a single image loads.
        noteSample(key, clamped);
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
   * @param width `naturalWidth`; ignored when not a positive, finite number.
   * @param height `naturalHeight`; ignored when not a positive, finite number.
   */
  const setRatio = (key: string, width: number, height: number): void => {
    if (!key || !Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
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
