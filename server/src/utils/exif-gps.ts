import ExifReader, { type ExpandedTags } from 'exifreader';
import { toCoordinates, type Coordinates } from './coordinates';

/**
 * EXIF extraction for the photo-locations scan.
 *
 * The Worker, not the browser, does this: the backfill would otherwise download every
 * full photo to the client (a 300-photo album at up to 10 MB each is ~3 GB) and would
 * need R2 bucket CORS to do it.
 */

/**
 * How much of each photo is read before parsing.
 *
 * EXIF lives in an APP1 segment immediately after the SOI marker, so the first 128 KB is
 * generously more than a camera needs — the segment itself is capped at 64 KB by the JPEG
 * format. A camera that writes an unusually large thumbnail into APP1 could in principle
 * exceed this; such a photo simply reports no GPS rather than failing, and the fix would
 * be to raise this constant.
 */
export const EXIF_READ_BYTES = 131072;

/** What the scan found in one photo. */
export interface ExtractedPhotoMetadata {
  /** Signed decimal degrees. Absent unless both coordinates were usable. */
  coordinates?: Coordinates;
  /** `DateTimeOriginal`, as an ISO-8601 local date-time with no timezone. */
  takenAt?: string;
}

/**
 * Convert EXIF's `DateTimeOriginal` to an ISO-8601 local date-time.
 *
 * EXIF writes `YYYY:MM:DD HH:MM:SS` and carries **no timezone**, so this deliberately
 * does not append a `Z` or an offset: doing so would assert a timezone the file never
 * stated and shift the displayed time for anyone who took the photo outside UTC. The
 * result is a valid ISO-8601 local date-time, which is exactly what is known.
 *
 * @param description The tag value as `exifreader` reports it.
 * @returns The ISO local date-time, or `undefined` when the value is not the EXIF shape.
 */
const toIsoLocalDateTime = (description: string | undefined): string | undefined => {
  if (!description) {
    return undefined;
  }
  const match = /^(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(description.trim());
  if (!match) {
    return undefined;
  }
  const [, year, month, day, hour, minute, second] = match;
  return `${year}-${month}-${day}T${hour}:${minute}:${second}`;
};

/**
 * Read GPS coordinates and capture time out of a photo's leading bytes.
 *
 * `exifreader`'s expanded `gps` block already applies the `GPSLatitudeRef === 'S'` and
 * `GPSLongitudeRef === 'W'` sign conventions, so this does **not** repeat the manual sign
 * handling in `PhotoInfoPanel.vue` — verified against southern/eastern and
 * northern/western fixtures in `exif-gps.test.ts`. Leaving the arithmetic to the library
 * removes the copy of it that could drift.
 *
 * Both coordinates or neither: half a coordinate cannot place a pin, and returning one
 * invites a caller to default the other to 0, which is a real place in the Gulf of
 * Guinea.
 *
 * @param bytes The photo's first bytes — see `EXIF_READ_BYTES`.
 * @returns Whatever could be read; an empty object when there is no usable GPS.
 * @throws Never for a malformed or EXIF-less image; only a caller error can throw here.
 */
export const extractPhotoMetadata = (bytes: ArrayBuffer): ExtractedPhotoMetadata => {
  let tags: ExpandedTags;
  try {
    // `expanded: true` with `async` left off resolves to the synchronous overload, so
    // this is `ExpandedTags` rather than a promise.
    tags = ExifReader.load(bytes, { expanded: true });
  } catch {
    // A truncated read, a non-JPEG, or a file with no EXIF at all. None of these are
    // worth failing the batch over - the photo simply has no location.
    return {};
  }

  const coordinates = toCoordinates(tags.gps?.Latitude, tags.gps?.Longitude);
  const takenAt = toIsoLocalDateTime(tags.exif?.DateTimeOriginal?.description);

  return {
    ...(coordinates ? { coordinates } : {}),
    ...(takenAt ? { takenAt } : {}),
  };
};
