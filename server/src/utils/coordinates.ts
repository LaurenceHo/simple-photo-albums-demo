/**
 * One definition of what counts as a usable map coordinate.
 *
 * Three places need this rule and had grown their own copy: the photo listing parses
 * coordinates out of R2 custom metadata, the EXIF scan reads them out of a photo, and the
 * scan's controller decides whether a photo counts as located. Keeping the rule in one
 * place is what stops those three drifting into disagreeing about, say, whether a latitude
 * of exactly 90 is allowed.
 */

/** Latitude runs to the poles. */
export const LATITUDE_LIMIT = 90;

/** Longitude runs to the antimeridian. */
export const LONGITUDE_LIMIT = 180;

export interface Coordinates {
  latitude: number;
  longitude: number;
}

/**
 * Whether a value can be used as a coordinate.
 *
 * Takes `unknown` because the callers' inputs are equally untrusted from different
 * directions: R2 custom metadata is a string map anything with bucket access can write,
 * and `exifreader` reports whatever the file claims.
 *
 * @param value Candidate coordinate.
 * @param limit `LATITUDE_LIMIT` or `LONGITUDE_LIMIT`.
 * @returns `true` when the value is a finite number within the limit.
 */
export const isUsableCoordinate = (value: unknown, limit: number): value is number =>
  typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= limit;

/**
 * A usable coordinate pair, or `undefined`.
 *
 * Both or neither, deliberately: a photo carrying one half of a pair cannot be placed on a
 * map, and returning half a coordinate invites a caller to default the other half to 0 —
 * which is a real location in the Gulf of Guinea rather than an obviously wrong one.
 *
 * The exact pair (0, 0) is rejected for the same reason. Phones without a satellite fix
 * still write a GPS block, with every coordinate field zeroed, and taken at face value that
 * pins the photo in open ocean. Nobody takes photos at that spot, so it is treated as "no
 * fix". Either half on its own being 0 is still fine: the equator and the prime meridian
 * are real places.
 *
 * @param latitude Candidate latitude.
 * @param longitude Candidate longitude.
 * @returns The pair, or `undefined` when either is unusable or both are exactly zero.
 */
export const toCoordinates = (latitude: unknown, longitude: unknown): Coordinates | undefined =>
  isUsableCoordinate(latitude, LATITUDE_LIMIT) &&
  isUsableCoordinate(longitude, LONGITUDE_LIMIT) &&
  !(latitude === 0 && longitude === 0)
    ? { latitude, longitude }
    : undefined;
