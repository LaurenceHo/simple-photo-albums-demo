import { TrackFeature } from '../types/gps-track';
import { parseGpxToFeature } from '../utils/gpx';
import R2Service, { R2Config } from './r2-service';

/**
 * Top-level prefix for track objects.
 *
 * Deliberately a sibling of the photo prefixes rather than living under `<albumId>/`.
 * `PhotoController.findAll` lists photos with `Prefix: '<albumId>/'` and `syncAlbumCover`
 * then adopts `photos[0].key` - and R2 lists lexicographically. A track stored alongside
 * the photos would be returned *as a photo* and could silently become the album cover.
 */
export const TRACK_PREFIX = 'gps-tracks';

/** Guard rail on tracks per album. A multi-week trip at one file per day is about this. */
export const MAX_TRACKS_PER_ALBUM = 20;

const GEOJSON_SUFFIX = '.geojson';
const GPX_SUFFIX = '.gpx';

/**
 * Line colours, assigned by position in the album's sorted track ids.
 *
 * Okabe-Ito based, which is the usual choice for categorical colour that survives the
 * common forms of colour-vision deficiency. Black and yellow are left out: both read
 * badly as a thin line over Mapbox's standard basemap in one theme or the other.
 *
 * Beyond `TRACK_COLOURS.length` tracks the palette wraps and two lines share a colour.
 * That is accepted - twenty visually distinct line colours on a map do not exist, and the
 * legend still names every track.
 */
export const TRACK_COLOURS = [
  '#0072B2',
  '#D55E00',
  '#009E73',
  '#CC79A7',
  '#E69F00',
  '#56B4E9',
  '#8C564B',
  '#7F3C8D',
] as const;

const FALLBACK_COLOUR = '#0072B2';

/** One track as the manifest reports it - everything but the geometry. */
export interface TrackManifestEntry {
  trackId: string;
  colour: string;
  size: number;
  lastModified: string;
}

/**
 * An `albumId` or `trackId` that must not be turned into an R2 key.
 *
 * Thrown rather than returned because there is no sensible partial result: every caller
 * either has a usable segment or has a request that should not have reached R2 at all.
 */
export class InvalidTrackKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidTrackKeyError';
  }
}

/**
 * Reject a path segment that could escape the album's own prefix.
 *
 * This forbids the traversal constructs rather than allowlisting characters, matching
 * `safeR2Segment` in `api-response.ts`: track ids come from user filenames, which may
 * legitimately contain spaces or non-ASCII characters.
 */
const assertSafeSegment = (label: string, value: string): string => {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    /[/\\]/.test(value) ||
    value === '.' ||
    value === '..'
  ) {
    throw new InvalidTrackKeyError(
      `${label} must not be empty, contain a path separator, or refer to a parent directory`,
    );
  }
  return value;
};

/**
 * `gps-tracks/<albumId>/` - the listing prefix for one album.
 *
 * Exported so no caller has to build this by hand. `AlbumController.delete` empties this
 * prefix, and concatenating it there was a data-loss bug: an empty `albumId` produced the
 * bare `gps-tracks/`, which `emptyR2Folder` treats as an already-terminated prefix and so
 * matches *every album's* tracks. Going through the guard makes that request a 400.
 */
export const albumTrackPrefix = (albumId: string): string =>
  `${TRACK_PREFIX}/${assertSafeSegment('albumId', albumId)}/`;

const colourFor = (index: number): string =>
  TRACK_COLOURS[index % TRACK_COLOURS.length] ?? FALLBACK_COLOUR;

/** True for the "object is not there" shapes the S3 client uses across commands. */
const isNotFound = (error: unknown): boolean => {
  const candidate = error as { name?: string; $metadata?: { httpStatusCode?: number } };
  return (
    candidate?.name === 'NotFound' ||
    candidate?.name === 'NoSuchKey' ||
    candidate?.$metadata?.httpStatusCode === 404
  );
};

/**
 * Reads and writes an album's GPS tracks in R2.
 *
 * Each track is two objects - the original `.gpx` kept for reprocessing, and the derived
 * `.geojson` that is actually served. Every key is built by `objectKey`, so no caller
 * assembles one by hand.
 */
export default class GpsTrackService {
  private readonly r2Service: R2Service;
  private readonly bucketName: string;

  constructor(config: R2Config, bucketName: string) {
    this.r2Service = new R2Service(config);
    this.bucketName = bucketName;
  }

  private albumPrefix(albumId: string): string {
    return albumTrackPrefix(albumId);
  }

  private objectKey(albumId: string, trackId: string, suffix: string): string {
    return `${this.albumPrefix(albumId)}${assertSafeSegment('trackId', trackId)}${suffix}`;
  }

  /**
   * Parse a GPX and store both objects.
   *
   * The `.gpx` is written first on purpose. A track is only visible once its `.geojson`
   * exists, because that is what `listTracks` reads - so if the second write fails, the
   * album is left with an invisible orphan rather than a listed track whose geometry
   * cannot be fetched.
   *
   * @throws {GpxParseError} If the GPX cannot be turned into a track.
   * @throws {InvalidTrackKeyError} If either id could escape the album prefix.
   */
  async putTrack(albumId: string, trackId: string, gpx: string): Promise<TrackFeature> {
    const feature = parseGpxToFeature(gpx);

    const storedGpx = await this.r2Service.create({
      Bucket: this.bucketName,
      Key: this.objectKey(albumId, trackId, GPX_SUFFIX),
      Body: gpx,
      ContentType: 'application/gpx+xml',
    });
    if (!storedGpx) {
      throw new Error('Failed to store the GPX file');
    }

    const storedGeoJson = await this.r2Service.create({
      Bucket: this.bucketName,
      Key: this.objectKey(albumId, trackId, GEOJSON_SUFFIX),
      Body: JSON.stringify(feature),
      ContentType: 'application/geo+json',
    });
    if (!storedGeoJson) {
      throw new Error('Failed to store the parsed track');
    }

    return feature;
  }

  /**
   * Every track in an album, sorted by id, with its colour.
   *
   * Ids are derived from `.geojson` keys **only**. The prefix holds two objects per track,
   * and a `.gpx` key reaching `R2Service.read()` would throw inside its `JSON.parse()` -
   * so a loose filter here would surface as an unexplained failure much later.
   *
   * No pagination: an album holds at most `MAX_TRACKS_PER_ALBUM` tracks, so forty objects
   * against a thousand-key page.
   */
  async listTracks(albumId: string): Promise<TrackManifestEntry[]> {
    const prefix = this.albumPrefix(albumId);

    const response = await this.r2Service.listObjects({
      Bucket: this.bucketName,
      Prefix: prefix,
      MaxKeys: 1000,
    });

    const entries = (response.Contents ?? [])
      .flatMap((object) => {
        const key = object.Key;
        if (!key?.endsWith(GEOJSON_SUFFIX)) return [];

        const trackId = key.slice(prefix.length, -GEOJSON_SUFFIX.length);
        // A hand-placed object could sit deeper than one level under the prefix; it is
        // not a track this service wrote, so it is not a track it reports.
        if (trackId.length === 0 || trackId.includes('/')) return [];

        return [
          {
            trackId,
            size: object.Size ?? 0,
            lastModified: (object.LastModified ?? new Date()).toISOString(),
          },
        ];
      })
      .sort((first, second) => first.trackId.localeCompare(second.trackId));

    return entries.map((entry, index) => ({ ...entry, colour: colourFor(index) }));
  }

  /** How many tracks the album holds, for the create-vs-replace cap check. */
  async countTracks(albumId: string): Promise<number> {
    const tracks = await this.listTracks(albumId);
    return tracks.length;
  }

  /**
   * One track's geometry, or null when there is no such track.
   *
   * The key is rebuilt from `trackId` rather than carried over from a listing, so this
   * path has the same traversal guard as every other.
   */
  async getTrack(albumId: string, trackId: string): Promise<TrackFeature | null> {
    const key = this.objectKey(albumId, trackId, GEOJSON_SUFFIX);

    try {
      return (await this.r2Service.read({ Bucket: this.bucketName, Key: key })) as TrackFeature;
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }

  /** Whether the album already has this track - drives create-vs-replace, not existence checks for reads. */
  async hasTrack(albumId: string, trackId: string): Promise<boolean> {
    return this.r2Service.checkIfFileExists({
      Bucket: this.bucketName,
      Key: this.objectKey(albumId, trackId, GEOJSON_SUFFIX),
    });
  }

  /**
   * Remove both of a track's objects.
   *
   * Both, not just the `.geojson`: dropping only the served object hides the track from
   * every listing while its source silently occupies storage forever.
   *
   * Deleting a track that is not there is not an error. `DeleteObjects` reports success
   * for keys that do not exist, which is the behaviour wanted here - the UI can race a
   * double-click, and "it is already gone" is the outcome the caller asked for.
   */
  async deleteTrack(albumId: string, trackId: string): Promise<boolean> {
    return this.r2Service.delete({
      Bucket: this.bucketName,
      Delete: {
        Objects: [
          { Key: this.objectKey(albumId, trackId, GEOJSON_SUFFIX) },
          { Key: this.objectKey(albumId, trackId, GPX_SUFFIX) },
        ],
      },
    });
  }
}
