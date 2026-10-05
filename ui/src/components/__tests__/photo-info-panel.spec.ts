import PhotoInfoPanel from '@/components/PhotoInfoPanel.vue';
import PhotoLocationMap from '@/components/PhotoLocationMap.vue';
import { mount } from '@vue/test-utils';
import PrimeVue from 'primevue/config';
import { describe, expect, it, vi } from 'vitest';

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
    const map = wrapper.findComponent(PhotoLocationMap);
    expect(map.props('latitude')).toBe(-33.85);
    expect(map.props('longitude')).toBe(-70.66);
  });

  it('omits the date section when neither EXIF nor the file name carries one', () => {
    expect(mountPanel().find('[data-test-id="photo-info-date"]').exists()).toBe(false);
  });

  // --- Additional edge cases beyond the brief's 7 tests ---

  it('does not render "0 MP" when EXIF is present but dimensions are zero', () => {
    const text = mountPanel({
      naturalWidth: 0,
      naturalHeight: 0,
      exifTags: { Make: { description: 'samsung' } },
    }).text();
    expect(text).not.toContain('0 MP');
    expect(text).not.toContain(' MP');
  });

  it('renders without crashing when the photo prop is undefined, and omits the file size', () => {
    const wrapper = mountPanel({ photo: undefined });
    expect(wrapper.exists()).toBe(true);
    expect(wrapper.text()).not.toContain('MB');
    expect(wrapper.text()).not.toContain('KB');
  });

  it('formats a file size under 1024 bytes as KB, not MB', () => {
    const text = mountPanel({ photo: { ...PHOTO, size: 500 } }).text();
    expect(text).toContain('0.49 KB');
    expect(text).not.toContain('MB');
  });

  it('shows the map for a GPS latitude of exactly 0, which is falsy but valid', () => {
    const wrapper = mountPanel({
      exifTags: {
        GPSLatitudeRef: { value: ['N'], description: 'North latitude' },
        GPSLongitudeRef: { value: ['E'], description: 'East longitude' },
        GPSLatitude: { description: '0' },
        GPSLongitude: { description: '103.82' },
      },
    });
    expect(wrapper.find('[data-test-id="photo-info-map"]').exists()).toBe(true);
    const map = wrapper.findComponent(PhotoLocationMap);
    expect(map.props('latitude')).toBe(0);
  });

  // What a phone without a satellite fix writes. Drawing it would show open ocean.
  it('omits the map for a zeroed GPS block at exactly (0, 0)', () => {
    const wrapper = mountPanel({
      exifTags: {
        GPSLatitudeRef: { value: ['N'], description: 'North latitude' },
        GPSLongitudeRef: { value: ['E'], description: 'East longitude' },
        GPSLatitude: { description: '0' },
        GPSLongitude: { description: '0' },
      },
    });
    expect(wrapper.find('[data-test-id="photo-info-map"]').exists()).toBe(false);
  });

  // --- Fix round 1: dimensions must gate the EXIF aperture/exposure line ---

  it('hides the aperture/exposure line when dimensions are unknown, while still showing the file name', () => {
    const wrapper = mountPanel({
      naturalWidth: 0,
      naturalHeight: 0,
      exifTags: {
        ApertureValue: { description: '2.8' },
        ExposureTime: { description: '1/125' },
      },
    });
    const text = wrapper.text();
    // The file section itself still renders (filename survives with no known dimensions) ...
    expect(wrapper.find('[data-test-id="photo-info-file"]').exists()).toBe(true);
    expect(text).toContain('photo1.jpg');
    // ... but the aperture/exposure EXIF line, previously implicitly gated by the
    // dimensions wrapper, must not render without dimensions.
    expect(text).not.toContain('f/2.8');
    expect(text).not.toContain('1/125');
  });

  // --- Fix round 1: positive-path coverage for the date section ---

  it('shows the date section when EXIF carries a DateTime, including the offset suffix', () => {
    const wrapper = mountPanel({
      exifTags: {
        DateTime: { description: '2023:11:10 12:00:00' },
        OffsetTime: { value: ['+10:00'] },
      },
    });
    const date = wrapper.find('[data-test-id="photo-info-date"]');
    expect(date.exists()).toBe(true);
    expect(date.text()).toContain('2023');
    expect(date.text()).toContain('+10:00');
  });

  it('shows the date section parsed from the file name when EXIF has no date', () => {
    const wrapper = mountPanel({
      photo: { ...PHOTO, key: 'album/2026-01-02_08.44.59.jpg' },
      exifTags: {},
    });
    const date = wrapper.find('[data-test-id="photo-info-date"]');
    expect(date.exists()).toBe(true);
    // TZ is pinned to Pacific/Auckland in ui/vitest.setup.ts, and toLocaleString's
    // exact rendering varies by locale/TZ, so match components rather than a full
    // localised string.
    expect(date.text()).toContain('2026');
    expect(date.text()).toMatch(/0?8/);
    expect(date.text()).toMatch(/44/);
    expect(date.text()).toMatch(/59/);
  });

  it('omits the date section when the EXIF DateTime does not match the expected format', () => {
    const wrapper = mountPanel({
      exifTags: { DateTime: { description: 'not-a-date' } },
    });
    expect(wrapper.find('[data-test-id="photo-info-date"]').exists()).toBe(false);
  });

  it('omits the date section when the EXIF DateTime matches the format but parses to an invalid date', () => {
    const wrapper = mountPanel({
      // Matches the `^\d{4}:\d{2}:\d{2} \d{2}:\d{2}:\d{2}$` shape but month 13 is
      // out of range, so `new Date(...)` yields NaN.
      exifTags: { DateTime: { description: '2024:13:01 10:00:00' } },
    });
    expect(wrapper.find('[data-test-id="photo-info-date"]').exists()).toBe(false);
  });

  // --- Fix round 2, Finding 1: isPhotoLandscape / Orientation branch coverage ---
  //
  // Characterisation tests for logic that already existed in PhotoDetail.vue and
  // moved here verbatim — they document current behaviour, not a spec being
  // implemented fresh. `photo-detail.spec.ts` used to cover this directly
  // (`computes isPhotoLandscape correctly`) but that test was deleted when Task 7
  // removed the sidebar from PhotoDetail.vue, and the coverage never followed the
  // logic to this component.

  it('does not transpose dimensions for a landscape photo with no Orientation tag', () => {
    const text = mountPanel({
      naturalWidth: 4000,
      naturalHeight: 3000,
      exifTags: {},
    }).text();
    expect(text).toContain('4000 x 3000');
  });

  it('does not transpose dimensions for Orientation 1 or 3 (landscape-normal)', () => {
    for (const orientationValue of [1, 3]) {
      const text = mountPanel({
        naturalWidth: 4000,
        naturalHeight: 3000,
        exifTags: { Orientation: { value: orientationValue } },
      }).text();
      expect(text).toContain('4000 x 3000');
    }
  });

  it('does not transpose dimensions when Orientation is exactly 0, even for portrait natural dimensions', () => {
    const text = mountPanel({
      naturalWidth: 3000,
      naturalHeight: 4000,
      exifTags: { Orientation: { value: 0 } },
    }).text();
    // The explicit `Orientation?.value === 0` branch renders width-then-height
    // regardless of isPhotoLandscape, which would be false here (3000 !> 4000).
    expect(text).toContain('3000 x 4000');
    expect(text).not.toContain('4000 x 3000');
  });

  it('transposes dimensions for Orientation 6 (rotated 90 degrees) with portrait natural dimensions', () => {
    const text = mountPanel({
      naturalWidth: 3000,
      naturalHeight: 4000,
      exifTags: { Orientation: { value: 6 } },
    }).text();
    expect(text).toContain('4000 x 3000');
    expect(text).not.toContain('3000 x 4000');
  });

  it('falls back to EXIF Image Width/Height when natural dimensions are unknown', () => {
    const text = mountPanel({
      naturalWidth: 0,
      naturalHeight: 0,
      exifTags: {
        'Image Width': { value: 4000 },
        'Image Height': { value: 3000 },
      },
    }).text();
    expect(text).toContain('4000 x 3000');
  });

  // Sonar/CodeRabbit fix: megapixels used to be computed from the raw naturalWidth/
  // naturalHeight props directly, so a photo whose dimensions are known only from
  // the EXIF fallback rendered its "W x H" line with no megapixels line at all.
  it('shows megapixels derived from the EXIF fallback dimensions, not just naturalWidth/Height', () => {
    const text = mountPanel({
      naturalWidth: 0,
      naturalHeight: 0,
      exifTags: {
        'Image Width': { value: 4000 },
        'Image Height': { value: 2250 },
      },
    }).text();
    expect(text).toContain('4000 x 2250');
    expect(text).toContain('9 MP');
  });

  // Guards the `!Number.isFinite` check added alongside the fix above: a malformed
  // EXIF fallback (a multi-value tag, which coerces to NaN via `Number(...)`) must
  // never render "NaN MP".
  it('never renders "NaN MP" when the EXIF fallback dimension is malformed', () => {
    const text = mountPanel({
      naturalWidth: 0,
      naturalHeight: 0,
      exifTags: {
        // A multi-value tag: `Number([4000, 3000])` is NaN, unlike the well-formed
        // single-value tags used elsewhere in this file.
        'Image Width': { value: [4000, 3000] },
        'Image Height': { value: 2250 },
      },
    }).text();
    expect(text).not.toContain('NaN');
    expect(text).not.toContain('MP');
  });

  it('isPanorama forces the non-transposed landscape branch even when Orientation would say otherwise', () => {
    const baseProps = {
      naturalWidth: 4000,
      naturalHeight: 3000,
      exifTags: { Orientation: { value: 6 } },
    };
    // Without isPanorama, Orientation 6 is not landscape-normal, so — even though
    // width > height — isPhotoLandscape is false and the dimensions transpose.
    const withoutPanorama = mountPanel({ ...baseProps, isPanorama: false }).text();
    expect(withoutPanorama).toContain('3000 x 4000');
    expect(withoutPanorama).not.toContain('4000 x 3000');

    // isPanorama alone flips isPhotoLandscape to true, so the same Orientation
    // and dimensions now render non-transposed.
    const withPanorama = mountPanel({ ...baseProps, isPanorama: true }).text();
    expect(withPanorama).toContain('4000 x 3000');
    expect(withPanorama).not.toContain('3000 x 4000');
  });

  // --- Fix round 2, Finding 2: sub-megapixel images must never show "0 MP" ---

  it('shows one decimal place for sub-megapixel images instead of a meaningless "0 MP"', () => {
    const text = mountPanel({ naturalWidth: 720, naturalHeight: 479 }).text();
    expect(text).toContain('0.3 MP');
    expect(text).not.toContain('0 MP');
  });

  it('rounds to a whole number of megapixels at or above 1 MP', () => {
    expect(mountPanel({ naturalWidth: 4000, naturalHeight: 2250 }).text()).toContain('9 MP');
    expect(mountPanel({ naturalWidth: 1440, naturalHeight: 1440 }).text()).toContain('2 MP');
  });

  it('shows no megapixel text at all for zero dimensions', () => {
    const text = mountPanel({ naturalWidth: 0, naturalHeight: 0 }).text();
    expect(text).not.toContain('MP');
  });

  // --- Camera-settings line: separator placement and absent-value handling ---
  //
  // This line used to be five sibling <span>s, each gating its own leading " | "
  // on a cumulative OR of every preceding tag. These pin the observable contract
  // that replaced it, so the joining rule cannot regress into stray, doubled or
  // leading separators as settings are added or removed.

  /** Whitespace-normalised text of the aperture/exposure line. */
  const settingsText = (overrides = {}): string =>
    mountPanel(overrides)
      .find('[data-test-id="photo-info-settings"]')
      .text()
      .replace(/\s+/g, ' ')
      .trim();

  const settingsLine = (overrides = {}) =>
    mountPanel(overrides).find('[data-test-id="photo-info-settings"]');

  it('renders a lone setting with no leading or trailing separator', () => {
    expect(settingsText({ exifTags: { ISOSpeedRatings: { description: '100' } } })).toBe('ISO100');
  });

  it('renders a lone exposure bias with no leading separator, though it is last in the order', () => {
    // The old template gated this span's separator on four preceding tags, so it
    // was the most likely to emit a stray leading " | " when it stood alone.
    expect(settingsText({ exifTags: { ExposureBiasValue: { description: '0.33' } } })).toBe(
      'EV0.33',
    );
  });

  it('joins every setting in a fixed order with a single separator between each', () => {
    expect(
      settingsText({
        exifTags: {
          ApertureValue: { description: '2.8' },
          ExposureTime: { description: '1/125' },
          FocalLength: { description: '24 mm' },
          ISOSpeedRatings: { description: '100' },
          ExposureBiasValue: { description: '-0.33' },
        },
      }),
    ).toBe('f/2.8 | 1/125 | 24 mm | ISO100 | EV-0.33');
  });

  it('omits only the absent settings, closing the gap rather than leaving a doubled separator', () => {
    expect(
      settingsText({
        exifTags: {
          ExposureTime: { description: '1/125' },
          ISOSpeedRatings: { description: '100' },
        },
      }),
    ).toBe('1/125 | ISO100');
  });

  it('falls back to MaxApertureValue when ApertureValue is absent', () => {
    expect(settingsText({ exifTags: { MaxApertureValue: { description: '1.8' } } })).toBe('f/1.8');
  });

  it('prefers ApertureValue over MaxApertureValue when both are present', () => {
    expect(
      settingsText({
        exifTags: {
          ApertureValue: { description: '2.8' },
          MaxApertureValue: { description: '1.8' },
        },
      }),
    ).toBe('f/2.8');
  });

  it('hides an exposure bias of exactly zero, which is the default and carries no information', () => {
    expect(
      settingsText({
        exifTags: {
          ISOSpeedRatings: { description: '100' },
          ExposureBiasValue: { description: '0' },
        },
      }),
    ).toBe('ISO100');
  });

  it('hides an exposure bias too small to survive rounding, instead of showing "EV0.00"', () => {
    expect(
      settingsText({
        exifTags: {
          ISOSpeedRatings: { description: '100' },
          ExposureBiasValue: { description: '0.004' },
        },
      }),
    ).toBe('ISO100');
  });

  it('shows an exposure bias that rounds to a non-zero two-decimal value', () => {
    expect(settingsText({ exifTags: { ExposureBiasValue: { description: '0.005' } } })).toBe(
      'EV0.01',
    );
  });

  it('hides an aperture that parses to zero rather than rendering "f/0.0"', () => {
    expect(
      settingsText({
        exifTags: {
          ApertureValue: { description: '0' },
          ISOSpeedRatings: { description: '100' },
        },
      }),
    ).toBe('ISO100');
  });

  // Guards a latent bug in the pre-refactor code: absence was detected by
  // comparing the formatted string against the '0.0'/'0.00' sentinels, so a
  // non-numeric description parsed to NaN, formatted to the *string* 'NaN',
  // compared unequal to the sentinel, and rendered "f/NaN" to the user.
  it('never renders "f/NaN" for a non-numeric ApertureValue', () => {
    const text = settingsText({
      exifTags: {
        ApertureValue: { description: 'unknown' },
        ISOSpeedRatings: { description: '100' },
      },
    });
    expect(text).not.toContain('NaN');
    expect(text).toBe('ISO100');
  });

  it('never renders "EVNaN" for a non-numeric ExposureBiasValue', () => {
    const text = settingsText({
      exifTags: {
        ExposureBiasValue: { description: 'unknown' },
        ISOSpeedRatings: { description: '100' },
      },
    });
    expect(text).not.toContain('NaN');
    expect(text).toBe('ISO100');
  });

  it('omits the settings line entirely when every present tag resolves to nothing renderable', () => {
    // ApertureValue is present, so the old wrapper's `v-if` opened — but its only
    // child span was hidden by the '0.0' check, leaving an empty <small> in the DOM.
    expect(settingsLine({ exifTags: { ApertureValue: { description: '0' } } }).exists()).toBe(
      false,
    );
  });

  it('omits the settings line when dimensions are unknown, even with settings present', () => {
    expect(
      settingsLine({
        naturalWidth: 0,
        naturalHeight: 0,
        exifTags: { ISOSpeedRatings: { description: '100' } },
      }).exists(),
    ).toBe(false);
  });

  // --- Megapixels/file-size line uses the same joining rule ---

  it('joins megapixels and file size with one separator', () => {
    const text = mountPanel()
      .find('[data-test-id="photo-info-summary"]')
      .text()
      .replace(/\s+/g, ' ')
      .trim();
    expect(text).toBe('12 MP | 1.70 MB');
  });

  // Browser-verified regression: <small> is inline and Vue condenses away the
  // whitespace node between the two siblings, so without an explicit `block` the
  // panel rendered "9 MP | 3.35 MBf/1.8 | 1/20 | ..." as one run-on line.
  it('stacks the summary and settings lines rather than running them together', () => {
    const wrapper = mountPanel({ exifTags: { ISOSpeedRatings: { description: '100' } } });
    expect(wrapper.find('[data-test-id="photo-info-summary"]').classes()).toContain('block');
    expect(wrapper.find('[data-test-id="photo-info-settings"]').classes()).toContain('block');
  });

  it('drops the separator when only the file size is known', () => {
    const text = mountPanel({ naturalWidth: 0, naturalHeight: 0 })
      .find('[data-test-id="photo-info-summary"]')
      .text()
      .replace(/\s+/g, ' ')
      .trim();
    expect(text).toBe('1.70 MB');
  });
});
