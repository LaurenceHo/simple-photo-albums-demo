export const STATUS_ERROR = 'Error';
export const STATUS_SUCCESS = 'Success';
export const STATUS_UNAUTHORIZED = 'Unauthorized';
export const STATUS_BAD_REQUEST = 'Bad Request';

/**
 * Most photos one album may hold.
 *
 * A guard rail rather than a fix for anything: the largest album holds roughly 300
 * photos, so this is ~3x headroom and is not expected to fire. What it buys is a bounded
 * worst case for the response payload, the DOM and the pin count on the map.
 *
 * It does **not** remove the need to paginate the R2 listing — with custom metadata
 * requested the page size is variable and can be below 1000 — and it does not make a
 * large photo list render quickly.
 *
 * Enforcement is deliberately approximate. The upload endpoint mints one presigned URL
 * per file and the uploader fires them in parallel, so fifty requests against a 990-photo
 * album all see 990 and all pass. The UI, which knows the batch size up front, is the
 * primary check; this server check is a backstop for "far over", not "exactly at".
 * Coordinating them to make it exact is not warranted for a single-admin app.
 */
export const MAX_PHOTOS_PER_ALBUM = 1000;

/**
 * R2 custom-metadata keys for a photo's location data.
 *
 * **All lowercase, and they must stay that way.** These travel as `x-amz-meta-<key>` HTTP
 * headers, and R2 lowercases the key: writing `takenAt` and `hasGps` through the S3 API
 * and reading them back reports `takenat` and `hasgps`. Verified directly against a real
 * bucket — a `CopyObject` with `Metadata: { latitude, takenAt, hasGps }` came back from
 * `HeadObject` as `{ hasgps, latitude, takenat }`.
 *
 * A camelCase spelling therefore round-trips to nothing. `latitude` and `longitude` were
 * unaffected because they are already lowercase, so the map kept working while `hasGps`
 * silently read back as `undefined` — which would make every photo look unscanned forever
 * and turn each re-scan into a full re-read of the album.
 *
 * Shared by the writer (`PhotoController.scanPhoto`) and the reader (`R2Service.toPhoto`)
 * so the two cannot drift. The `Photo` field names the API returns stay camelCase; only
 * the storage keys are lowercase.
 */
export const PHOTO_METADATA_KEYS = {
  latitude: 'latitude',
  longitude: 'longitude',
  takenAt: 'takenat',
  hasGps: 'hasgps',
} as const;
