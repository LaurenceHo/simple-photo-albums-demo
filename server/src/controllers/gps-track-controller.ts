import { Context } from 'hono';
import { HonoEnv, ValidatedJsonContext } from '../env';
import AlbumService from '../services/album-service';
import GpsTrackService, {
  InvalidTrackKeyError,
  MAX_TRACKS_PER_ALBUM,
} from '../services/gps-track-service';
import { Album } from '../types/album';
import { CreateGpsTrackRequest } from '../types/gps-track';
import { GpxParseError } from '../utils/gpx';
import { buildR2Config, forLog } from '../utils/helpers';
import { BaseController } from './base-controller';

/**
 * GPS tracks belonging to an album.
 *
 * Reads are public but pass through `checkAlbumAccess`, so an unlisted album's tracks are
 * gated by exactly the same rule as its photos. Writes are admin-only at the route.
 */
export default class GpsTrackController extends BaseController {
  private trackService(c: Context<HonoEnv>): GpsTrackService {
    return new GpsTrackService(buildR2Config(c.env), c.env.R2_BUCKET_NAME);
  }

  /**
   * Load the album and apply the unlisted-album rule.
   *
   * Returns either the album or the Response to send instead, so every handler starts the
   * same way and none can accidentally skip the access check.
   */
  private async resolveAlbum(
    c: Context<HonoEnv>,
  ): Promise<{ album: Album } | { response: Response }> {
    const albumId = c.req.param('albumId');
    if (!albumId) {
      return { response: this.clientError(c, 'Album ID is required') };
    }

    const album = await new AlbumService(c.env.DB).getById(albumId);
    if (!album) {
      return { response: this.notFoundError(c, 'Album does not exist') };
    }

    const accessError = await this.checkAlbumAccess(c, album);
    if (accessError) {
      return { response: accessError };
    }

    return { album };
  }

  /**
   * Turn a thrown error into the response for it.
   *
   * `InvalidTrackKeyError` and `GpxParseError` both mean the request was wrong, not that
   * the server broke. That distinction matters most on `findOne`: it is the one public
   * route taking a caller-supplied key segment, so a crafted `:trackId` reaches the
   * traversal guard without a JWT and must come back as a 400 rather than a 500.
   *
   * Anything else is ours - logged with the cause, reported without it.
   */
  private handleError(c: Context, err: unknown, failMessage: string) {
    if (err instanceof InvalidTrackKeyError || err instanceof GpxParseError) {
      return this.clientError(c, err.message);
    }
    console.error(`${failMessage}: %s`, err);
    return this.fail(c, failMessage);
  }

  /** `GET /api/albums/:albumId/gps-tracks` - the manifest, without geometry. */
  findAll = async (c: Context<HonoEnv>) => {
    try {
      const resolved = await this.resolveAlbum(c);
      if ('response' in resolved) return resolved.response;

      const tracks = await this.trackService(c).listTracks(resolved.album.id);

      // An album with no tracks is a normal state, not a 404: the UI renders an empty
      // legend from this and offers to add the first track.
      return this.ok(c, 'ok', tracks);
    } catch (err: unknown) {
      return this.handleError(c, err, 'Failed to list GPS tracks');
    }
  };

  /** `GET /api/albums/:albumId/gps-tracks/:trackId` - one track's geometry. */
  findOne = async (c: Context<HonoEnv>) => {
    const trackId = c.req.param('trackId');
    if (!trackId) {
      return this.clientError(c, 'Track ID is required');
    }

    try {
      const resolved = await this.resolveAlbum(c);
      if ('response' in resolved) return resolved.response;

      const track = await this.trackService(c).getTrack(resolved.album.id, trackId);
      if (!track) {
        return this.notFoundError(c, 'Track does not exist');
      }

      return this.ok(c, 'ok', track);
    } catch (err: unknown) {
      return this.handleError(c, err, 'Failed to get GPS track');
    }
  };

  /** `POST /api/albums/:albumId/gps-tracks` - upload or replace one track. */
  create = async (c: ValidatedJsonContext<CreateGpsTrackRequest>) => {
    const { trackId, gpx } = c.req.valid('json');

    try {
      const resolved = await this.resolveAlbum(c);
      if ('response' in resolved) return resolved.response;

      const albumId = resolved.album.id;
      const trackService = this.trackService(c);

      // The cap applies to creates, not replaces. `trackId` comes from the uploaded
      // filename, so re-uploading the same file overwrites in place and leaves the count
      // unchanged - a bare count check would stop an album at the cap from ever
      // correcting a track it already has.
      const exists = await trackService.hasTrack(albumId, trackId);
      if (!exists && (await trackService.countTracks(albumId)) >= MAX_TRACKS_PER_ALBUM) {
        return this.conflictError(
          c,
          `This album already has the maximum of ${MAX_TRACKS_PER_ALBUM} GPS tracks. Delete one before adding another.`,
        );
      }

      const feature = await trackService.putTrack(albumId, trackId, gpx);
      console.log('##### Stored GPS track: %s/%s', forLog(albumId), forLog(trackId));

      return this.ok(c, exists ? 'Track replaced' : 'Track uploaded', feature);
    } catch (err: unknown) {
      return this.handleError(c, err, 'Failed to store GPS track');
    }
  };

  /** `DELETE /api/albums/:albumId/gps-tracks/:trackId`. */
  delete = async (c: Context<HonoEnv>) => {
    const trackId = c.req.param('trackId');
    if (!trackId) {
      return this.clientError(c, 'Track ID is required');
    }

    try {
      const resolved = await this.resolveAlbum(c);
      if ('response' in resolved) return resolved.response;

      const albumId = resolved.album.id;
      const trackService = this.trackService(c);

      // Checked before deleting so a missing track answers 404 rather than reporting a
      // success that removed nothing. The service itself tolerates a missing key, which
      // is what keeps a double-click from erroring after the first delete wins.
      if (!(await trackService.hasTrack(albumId, trackId))) {
        return this.notFoundError(c, 'Track does not exist');
      }

      const deleted = await trackService.deleteTrack(albumId, trackId);
      if (!deleted) {
        return this.fail(c, 'Failed to delete GPS track');
      }

      console.log('##### Deleted GPS track: %s/%s', forLog(albumId), forLog(trackId));
      return this.ok(c, 'Track deleted');
    } catch (err: unknown) {
      return this.handleError(c, err, 'Failed to delete GPS track');
    }
  };

  update = async (_c: Context) => {
    // Replacing a track is a POST with an existing trackId; there is nothing else about a
    // track that can be edited in place.
    throw new Error('Method not implemented.');
  };
}
