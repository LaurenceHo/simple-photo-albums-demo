import { describe, expect, it } from 'vitest';
import { isUsableCoordinate, LATITUDE_LIMIT, LONGITUDE_LIMIT, toCoordinates } from '../../src/utils/coordinates';

/**
 * The rule three callers share: the photo listing parsing R2 custom metadata, the EXIF
 * scan, and the scan controller deciding whether a photo counts as located. Tested here
 * once rather than three times over.
 */
describe('coordinates', () => {
  describe('isUsableCoordinate', () => {
    it.each([0, 45.5, -45.5, LATITUDE_LIMIT, -LATITUDE_LIMIT])(
      'should accept the in-range latitude %s',
      (value) => {
        expect(isUsableCoordinate(value, LATITUDE_LIMIT)).toBe(true);
      },
    );

    // The poles and the antimeridian are real places, so the bound is inclusive.
    it('should accept a longitude exactly on the antimeridian', () => {
      expect(isUsableCoordinate(LONGITUDE_LIMIT, LONGITUDE_LIMIT)).toBe(true);
      expect(isUsableCoordinate(-LONGITUDE_LIMIT, LONGITUDE_LIMIT)).toBe(true);
    });

    it.each([
      ['just beyond the pole', 90.0001],
      ['far beyond the pole', 1000],
      ['negative beyond the pole', -91],
    ])('should reject a latitude %s', (_label, value) => {
      expect(isUsableCoordinate(value, LATITUDE_LIMIT)).toBe(false);
    });

    // These are what actually arrive from a writable string map or a malformed file, and
    // each would become a NaN pin if it slipped through.
    it.each([
      ['NaN', Number.NaN],
      ['Infinity', Number.POSITIVE_INFINITY],
      ['a numeric string', '45'],
      ['an empty string', ''],
      ['null', null],
      ['undefined', undefined],
      ['an object', {}],
    ])('should reject %s', (_label, value) => {
      expect(isUsableCoordinate(value, LATITUDE_LIMIT)).toBe(false);
    });
  });

  describe('toCoordinates', () => {
    it('should return the pair when both are usable', () => {
      expect(toCoordinates(-36.8484, 174.7633)).toEqual({
        latitude: -36.8484,
        longitude: 174.7633,
      });
    });

    // Half a coordinate cannot place a pin, and returning one invites a caller to default
    // the other to 0 - a real location in the Gulf of Guinea.
    it.each([
      ['the latitude is missing', undefined, 174.7633],
      ['the longitude is missing', -36.8484, undefined],
      ['the latitude is out of range', 91, 174.7633],
      ['the longitude is out of range', -36.8484, 181],
      ['both are missing', undefined, undefined],
    ])('should return undefined when %s', (_label, latitude, longitude) => {
      expect(toCoordinates(latitude, longitude)).toBeUndefined();
    });

    // A latitude of 100 is out of range while a longitude of 100 is fine, so the two
    // arguments must not share one limit.
    it('should apply the correct limit to each argument', () => {
      expect(toCoordinates(100, 100)).toBeUndefined();
      expect(toCoordinates(45, 100)).toEqual({ latitude: 45, longitude: 100 });
    });

    it('should accept a genuine zero rather than treating it as absent', () => {
      expect(toCoordinates(0, 0)).toEqual({ latitude: 0, longitude: 0 });
    });
  });
});
