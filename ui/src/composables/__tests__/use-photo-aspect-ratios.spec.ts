import usePhotoAspectRatios, {
  DEFAULT_ASPECT_RATIO,
  MAX_ASPECT_RATIO,
  MIN_ASPECT_RATIO,
  MIN_SAMPLES_FOR_ALBUM_DEFAULT,
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

  it('clamps a persisted ratio that is outside the allowed bounds', () => {
    // Persisted data is plain localStorage JSON, so it can be tampered with
    // directly, or simply predate MIN_ASPECT_RATIO/MAX_ASPECT_RATIO existing.
    // Hydration must enforce the same clamp `setRatio` enforces on a fresh
    // measurement, not just check `Number.isFinite`.
    localStorage.setItem(
      PHOTO_ASPECT_RATIOS,
      JSON.stringify({ 'album/tampered-high.jpg': 50, 'album/tampered-low.jpg': 0.001 }),
    );
    __resetAspectRatioCache();

    const { getRatio } = usePhotoAspectRatios();
    expect(getRatio('album/tampered-high.jpg')).toBe(MAX_ASPECT_RATIO);
    expect(getRatio('album/tampered-low.jpg')).toBe(MIN_ASPECT_RATIO);
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
    // Spied on the instance rather than `Storage.prototype`: this repo's
    // `vitest.setup.ts` replaces `window.localStorage` with a plain `LocalStorageMock`
    // class that does not extend `Storage`, so a `Storage.prototype` spy would never
    // intercept the real call and this test would pass for the wrong reason.
    const setItem = vi.spyOn(window.localStorage, 'setItem').mockImplementation(() => {
      throw new DOMException('QuotaExceededError');
    });

    const { getRatio, setRatio } = usePhotoAspectRatios();
    setRatio('album/d.jpg', 2000, 1000);
    vi.advanceTimersByTime(500);

    expect(setItem).toHaveBeenCalled();
    expect(getRatio('album/d.jpg')).toBe(2);
  });

  it('ignores a negative dimension from a malformed measurement', () => {
    const { getRatio, setRatio } = usePhotoAspectRatios();
    setRatio('album/neg.jpg', -100, 50);
    expect(getRatio('album/neg.jpg')).toBe(DEFAULT_ASPECT_RATIO);
  });

  it('treats a key with no "/" separator as its own single-photo album', () => {
    const { getRatio, setRatio } = usePhotoAspectRatios();
    setRatio('bare.jpg', 4000, 2000);
    expect(getRatio('bare.jpg')).toBe(2);
    // A bare key must not leak into some shared "no album" bucket that other
    // unrelated bare keys would then read a stale default from.
    expect(getRatio('other.jpg')).toBe(DEFAULT_ASPECT_RATIO);
  });

  it('ignores NaN dimensions so they cannot poison an album median', () => {
    const { getRatio, setRatio } = usePhotoAspectRatios();
    setRatio('album/nan.jpg', Number.NaN, Number.NaN);
    expect(getRatio('album/nan.jpg')).toBe(DEFAULT_ASPECT_RATIO);
  });

  it('ignores Infinity dimensions', () => {
    const { getRatio, setRatio } = usePhotoAspectRatios();
    setRatio('album/inf.jpg', Number.POSITIVE_INFINITY, 100);
    expect(getRatio('album/inf.jpg')).toBe(DEFAULT_ASPECT_RATIO);
  });

  it('evicts the oldest entries once MAX_ENTRIES is exceeded', () => {
    const { getRatio, setRatio } = usePhotoAspectRatios();

    // Insert first, in its own single-photo album so it never accrues enough samples
    // to freeze an album default. An unmeasured photo in that album therefore falls
    // back to DEFAULT_ASPECT_RATIO (1.5) -- clearly distinguishable from the measured
    // ratio of 2 used everywhere else in this test, so the assertion below can only
    // pass if eviction actually happened.
    setRatio('capalbum/oldest.jpg', 2000, 1000); // ratio 2, sole sample in "capalbum"

    // Push past MAX_ENTRIES (5000) with a different album's keys, so this proves
    // capacity-driven eviction rather than album-default freezing.
    for (let i = 0; i < 5000; i++) {
      setRatio(`filler/${i}.jpg`, 2000, 1000);
    }

    // The oldest inserted key must have been evicted: it falls back to the seed
    // default rather than returning its old measured ratio of 2.
    expect(getRatio('capalbum/oldest.jpg')).toBe(DEFAULT_ASPECT_RATIO);
    // A recently inserted key is still measured.
    expect(getRatio('filler/4999.jpg')).toBe(2);
  });

  it('pins the exact constant values that Task 3 depends on', () => {
    expect(DEFAULT_ASPECT_RATIO).toBe(1.5);
    expect(MIN_ASPECT_RATIO).toBe(0.4);
    expect(MAX_ASPECT_RATIO).toBe(3);
    expect(MIN_SAMPLES_FOR_ALBUM_DEFAULT).toBe(5);
  });
});
