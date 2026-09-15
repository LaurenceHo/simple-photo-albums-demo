import { describe, expect, it } from 'vitest';
import { extractPhotoMetadata } from '../../src/utils/exif-gps';
import { AUCKLAND, buildGeotaggedJpeg, buildJpegWithoutGps } from '../fixtures/geotagged-jpeg';

/**
 * `extractPhotoMetadata` takes the raw bytes, as the ranged R2 read supplies them.
 *
 * `slice()` rather than `.buffer`: a `subarray` shares its parent's whole `ArrayBuffer`,
 * so passing `.buffer` would hand the parser the complete file and quietly undo any
 * truncation a test is trying to set up.
 */
const parse = (bytes: Uint8Array) => extractPhotoMetadata(bytes.slice().buffer as ArrayBuffer);

describe('extractPhotoMetadata', () => {
  // The whole point of the GPS refs. A hemisphere sign that silently inverts puts a pin
  // in the wrong ocean, and no test that only ever uses one hemisphere would notice.
  describe('hemisphere signs', () => {
    it('should negate a southern latitude and keep an eastern longitude', () => {
      const result = parse(buildGeotaggedJpeg(AUCKLAND));

      expect(result.coordinates?.latitude).toBeCloseTo(-36.8484, 6);
      expect(result.coordinates?.longitude).toBeCloseTo(174.7633, 6);
    });

    it('should keep a northern latitude and negate a western longitude', () => {
      const result = parse(
        buildGeotaggedJpeg({
          latitude: [40, 45, 0],
          latitudeRef: 'N',
          longitude: [73, 59, 0],
          longitudeRef: 'W',
        }),
      );

      expect(result.coordinates?.latitude).toBeCloseTo(40.75, 6);
      expect(result.coordinates?.longitude).toBeCloseTo(-73.9833, 4);
    });

    it('should keep both positive in the northern and eastern hemispheres', () => {
      const result = parse(
        buildGeotaggedJpeg({
          latitude: [51, 30, 0],
          latitudeRef: 'N',
          longitude: [0, 7, 0],
          longitudeRef: 'E',
        }),
      );

      expect(result.coordinates?.latitude).toBeCloseTo(51.5, 6);
      expect(result.coordinates?.longitude).toBeCloseTo(0.11667, 4);
    });

    it('should negate both in the southern and western hemispheres', () => {
      const result = parse(
        buildGeotaggedJpeg({
          latitude: [33, 27, 0],
          latitudeRef: 'S',
          longitude: [70, 39, 0],
          longitudeRef: 'W',
        }),
      );

      expect(result.coordinates?.latitude).toBeCloseTo(-33.45, 6);
      expect(result.coordinates?.longitude).toBeCloseTo(-70.65, 6);
    });
  });

  describe('capture time', () => {
    it('should convert DateTimeOriginal to an ISO local date-time', () => {
      const result = parse(buildGeotaggedJpeg(AUCKLAND));

      expect(result.takenAt).toBe('2025-01-01T10:00:00');
    });

    // EXIF carries no timezone, so appending one would assert something the file never
    // said and shift the time for every photo taken outside UTC.
    it('should not append a timezone it does not know', () => {
      const result = parse(buildGeotaggedJpeg(AUCKLAND));

      expect(result.takenAt).not.toMatch(/Z$/);
      expect(result.takenAt).not.toMatch(/[+-]\d{2}:\d{2}$/);
    });

    it('should omit takenAt when the tag is absent', () => {
      const result = parse(
        buildGeotaggedJpeg({
          latitude: [10, 0, 0],
          latitudeRef: 'N',
          longitude: [10, 0, 0],
          longitudeRef: 'E',
        }),
      );

      expect(result.takenAt).toBeUndefined();
      expect(result.coordinates?.latitude).toBeCloseTo(10, 6);
    });
  });

  describe('photos with nothing to find', () => {
    it('should return an empty result for a JPEG with no EXIF', () => {
      expect(parse(buildJpegWithoutGps())).toEqual({});
    });

    // A batch of 50 must not be lost to one unreadable file, so parse failures are a
    // normal return rather than a throw.
    it('should return an empty result rather than throwing on non-image bytes', () => {
      const notAnImage = new TextEncoder().encode('this is not a photo at all');

      expect(() => parse(notAnImage)).not.toThrow();
      expect(parse(notAnImage)).toEqual({});
    });

    it('should return an empty result rather than throwing on truncated bytes', () => {
      const truncated = buildGeotaggedJpeg(AUCKLAND).subarray(0, 12);

      expect(() => parse(truncated)).not.toThrow();
      expect(parse(truncated)).toEqual({});
    });

    it('should return an empty result for an empty buffer', () => {
      expect(parse(new Uint8Array(0))).toEqual({});
    });
  });
});
