import { Context } from 'hono';
import { isEmpty } from 'radash';
import { HonoEnv, ValidatedJsonContext, ValidatedQueryContext } from '../env';
import AlbumService from '../services/album-service';
import R2Service from '../services/r2-service';
import { PhotoResponse, PhotosRequest, RenamePhotoRequest } from '../types';
import {
  MovePhotosRequest,
  PhotoMetadataRequest,
  PhotoMetadataResult,
  UploadPhotoQuery,
} from '../types/api-response';
import { Album } from '../types/album';
import { MAX_PHOTOS_PER_ALBUM, PHOTO_METADATA_KEYS } from '../constants';
import { EXIF_READ_BYTES, extractPhotoMetadata } from '../utils/exif-gps';
import { buildR2Config, deleteObjects, forLog } from '../utils/helpers';
import { BaseController } from './base-controller';

export default class PhotoController extends BaseController {
  /**
   * Get all photos from an album
   */
  findAll = async (c: Context<HonoEnv>) => {
    const albumId = c.req.param('albumId');
    if (!albumId) {
      return this.clientError(c, 'Album ID is required');
    }
    const albumService = new AlbumService(c.env.DB);
    const r2Config = buildR2Config(c.env);
    const r2Service = new R2Service(r2Config);

    try {
      const album = await albumService.getById(albumId);

      if (!album) {
        return this.notFoundError(c, 'Album does not exist');
      }

      // Check authorization for unlisted albums
      const accessError = await this.checkAlbumAccess(c, album);
      if (accessError) {
        return accessError;
      }

      // No decodeURIComponent: Hono has already decoded the path param, so decoding
      // again would turn a literal `%2F` in an album id into a `/` and let the R2 Prefix
      // escape the album's own folder. The album must exist under the once-decoded id
      // anyway, since that is what `getById` above matched.
      const folderNameKey = albumId + '/';
      const photos = await r2Service.findAll(c.env.BUCKET, folderNameKey);

      // `syncAlbumCover` writes to D1 during what is otherwise a read-only photo-list
      // GET, so its own failure must not cost the caller the list they asked for.
      // Sharing the outer `catch` meant a failed cover update returned a 500 with no
      // photos, for a request whose photos had already been fetched successfully.
      try {
        await this.syncAlbumCover(albumService, album, photos);
      } catch (err: any) {
        console.error('Failed to sync album cover: %s', err);
      }

      return this.ok<PhotoResponse>(c, 'ok', { album, photos });
    } catch (err: any) {
      console.error('Failed to get photos: %s', err);
      return this.fail(c, 'Failed to get photos');
    }
  };

  /**
   * Update album cover if needed
   * @param albumService Album service
   * @param album Album object
   * @param photos Photo list
   */
  private async syncAlbumCover(
    albumService: AlbumService,
    album: Album,
    photos: any[],
  ): Promise<void> {
    const hasPhotos = !isEmpty(photos);
    const hasCover = !isEmpty(album.albumCover);

    // Nothing to do unless the two disagree: photos but no cover means adopt one, cover
    // but no photos means clear it.
    if (hasPhotos === hasCover) {
      return;
    }

    // Only the fields that actually change. Spreading the whole `album` row here meant:
    //
    // - `tags` was always present, so `AlbumService.update` ran `DELETE FROM
    //   album_tags_map` and re-inserted every tag. The delete and the re-insert are
    //   separate statements, not one transaction, so a failure in between dropped the
    //   album's tags - on an ordinary photo-list GET.
    // - `updatedAt` was carried over from the row while `updatedBy` was set to 'System',
    //   leaving the two fields disagreeing about when the row last changed.
    // - every column was rewritten, including `id` (the primary key, with its own value)
    //   and `place` (re-serialised through a JSON parse/stringify round trip).
    await albumService.update(album.id, {
      albumCover: hasPhotos ? (photos[0]?.key || '') : '',
      updatedBy: 'System',
      updatedAt: new Date().toISOString(),
    });
  }

  create = async (c: ValidatedQueryContext<UploadPhotoQuery>) => {
    const albumId = c.req.param('albumId');
    const { filename, mimeType } = c.req.valid('query');

    if (!albumId || /[/\\]/.test(albumId) || albumId === '.' || albumId === '..') {
      return this.clientError(c, 'Invalid album ID');
    }

    const r2Config = buildR2Config(c.env);
    const r2Service = new R2Service(r2Config);
    const filePath = `${albumId}/${filename}`;

    try {
      // A backstop for "far over", not "exactly at". This endpoint is per-file and the
      // uploader fires its requests in parallel, so fifty requests against a 990-photo
      // album all see 990 and all pass. The UI, which knows the batch size before it
      // starts, is the check that actually holds the line; making this one exact would
      // need coordination not worth building for a single-admin app.
      //
      // It gates *adding* only. Deleting and moving photos out of an album that is
      // already over the cap must keep working, which is why no other handler consults it.
      const photoCount = await r2Service.countObjects(
        c.env.BUCKET,
        `${albumId}/`,
        MAX_PHOTOS_PER_ALBUM,
      );
      if (photoCount >= MAX_PHOTOS_PER_ALBUM) {
        return this.conflictError(
          c,
          `This album already holds the maximum of ${MAX_PHOTOS_PER_ALBUM} photos`,
        );
      }

      const uploadUrl = await r2Service.getPresignedUploadUrl(
        c.env.R2_BUCKET_NAME,
        filePath,
        mimeType,
      );

      console.log(`##### Generated presigned URL for file: ${filePath}`);
      return this.ok(c, 'ok', { uploadUrl });
    } catch (err: any) {
      console.error('Failed to generate presigned URL: %s', err);
      return this.fail(c, 'Failed to generate upload URL');
    }
  };

  /**
   * Scan photos for EXIF GPS and store what is found as R2 custom metadata.
   *
   * One endpoint serves both callers: the uploader, straight after an upload, and the
   * admin backfill over photos already in the bucket.
   *
   * Each photo is independent. One that cannot be read or parsed is reported in its own
   * result entry and the rest of the batch continues — a single corrupt file must not
   * cost an admin the other forty-nine.
   */
  extractMetadata = async (c: ValidatedJsonContext<PhotoMetadataRequest>) => {
    const albumId = c.req.param('albumId');
    if (!albumId || /[/\\]/.test(albumId) || albumId === '.' || albumId === '..') {
      return this.clientError(c, 'Invalid album ID');
    }

    const { photoKeys } = c.req.valid('json');
    const r2Service = new R2Service(buildR2Config(c.env));
    const bucketName = c.env.R2_BUCKET_NAME;

    const results = await Promise.all(
      photoKeys.map((photoKey) =>
        this.scanPhoto(r2Service, c.env.BUCKET, bucketName, albumId, photoKey),
      ),
    );

    return this.ok(c, 'ok', { results });
  };

  /**
   * Read one photo's EXIF and write the result back to its R2 custom metadata.
   *
   * @param r2Service Service used for the ranged read and the in-place copy.
   * @param bucket The `BUCKET` binding.
   * @param bucketName Name of the R2 bucket, for the copy source.
   * @param albumId Album the photo belongs to.
   * @param photoKey The photo's filename within the album.
   * @returns A result entry for this photo; never throws.
   */
  private async scanPhoto(
    r2Service: R2Service,
    bucket: R2Bucket,
    bucketName: string,
    albumId: string,
    photoKey: string,
  ): Promise<PhotoMetadataResult> {
    const key = `${albumId}/${photoKey}`;

    try {
      const object = await r2Service.readRange(bucket, key, EXIF_READ_BYTES);
      if (!object) {
        return { photoKey, status: 'notFound' };
      }

      const { coordinates, takenAt } = extractPhotoMetadata(object.bytes);

      // REPLACE discards every existing key, so the new metadata has to be the complete
      // set. The three fields this owns are rebuilt from what was just parsed; anything
      // else on the object is carried through untouched.
      //
      // Keys come from `PHOTO_METADATA_KEYS` because R2 lowercases them in transit — see
      // the note there. Spelling one of them camelCase here would store a key the reader
      // never finds.
      const metadata: Record<string, string> = { ...object.customMetadata };
      delete metadata[PHOTO_METADATA_KEYS.latitude];
      delete metadata[PHOTO_METADATA_KEYS.longitude];
      delete metadata[PHOTO_METADATA_KEYS.takenAt];

      if (coordinates) {
        metadata[PHOTO_METADATA_KEYS.latitude] = String(coordinates.latitude);
        metadata[PHOTO_METADATA_KEYS.longitude] = String(coordinates.longitude);
      }
      if (takenAt) {
        metadata[PHOTO_METADATA_KEYS.takenAt] = takenAt;
      }

      // Recorded either way, so a photo with no GPS is marked as *scanned* rather than
      // looking identical to one that has never been read. Without it every re-scan
      // would read every un-located photo again, forever.
      metadata[PHOTO_METADATA_KEYS.hasGps] = coordinates ? 'true' : 'false';

      const written = await r2Service.replaceCustomMetadata(
        bucketName,
        key,
        metadata,
        object.contentType,
      );
      if (!written) {
        return { photoKey, status: 'failed', message: 'Could not write metadata' };
      }

      return coordinates
        ? { photoKey, status: 'located', ...coordinates, ...(takenAt ? { takenAt } : {}) }
        : { photoKey, status: 'noGps' };
    } catch (err: any) {
      console.error('Failed to extract metadata for %s: %s', forLog(key), err);
      return { photoKey, status: 'failed', message: 'Could not read photo' };
    }
  }

  /**
   * Move photos to another album
   */
  update = async (c: ValidatedJsonContext<MovePhotosRequest>) => {
    // destinationAlbumId is required by MovePhotosRequestSchema, so it cannot be
    // undefined here - which would otherwise copy to an `undefined/` prefix and then
    // delete the originals.
    const { destinationAlbumId, albumId, photoKeys } = c.req.valid('json');
    const r2Config = buildR2Config(c.env);
    const r2Service = new R2Service(r2Config);
    const bucketName = c.env.R2_BUCKET_NAME;

    const copyPromises = photoKeys.map(async (photoKey) => {
      const sourcePhotoKey = `${albumId}/${photoKey}`;
      try {
        const result = await r2Service.copy({
          Bucket: bucketName,
          CopySource: `/${bucketName}/${sourcePhotoKey}`,
          Key: `${destinationAlbumId}/${photoKey}`,
        });
        return result ? sourcePhotoKey : null;
      } catch (e) {
        console.error(`Failed to copy photo ${sourcePhotoKey}:`, e);
        return null;
      }
    });

    try {
      const results = await Promise.all(copyPromises);
      const successfulSourceKeys = results.filter((key): key is string => key !== null);

      if (successfulSourceKeys.length > 0) {
        const deleted = await deleteObjects(r2Config, bucketName, successfulSourceKeys);
        if (!deleted) {
          console.error(
            'Failed to delete source photos after copy: %s',
            successfulSourceKeys.join(', '),
          );
          return this.fail(c, 'Photos were copied but failed to remove originals');
        }
        console.log(`##### Photos moved: ${successfulSourceKeys.join(', ')}`);
      }

      if (successfulSourceKeys.length === 0 && photoKeys.length > 0) {
        return this.fail(c, 'Failed to move any photos');
      }

      return this.ok(c, 'Photo moved');
    } catch (err: any) {
      console.error(`Failed to move photos: ${err}`);
      return this.fail(c, 'Failed to move photos');
    }
  };

  rename = async (c: ValidatedJsonContext<RenamePhotoRequest>) => {
    const { albumId, newPhotoKey, currentPhotoKey } = c.req.valid('json');
    const r2Config = buildR2Config(c.env);
    const r2Service = new R2Service(r2Config);
    const bucketName = c.env.R2_BUCKET_NAME;

    // Currently, the only way to rename an object using the SDK is to copy the object with a different name and
    // then delete the original object.
    try {
      const result = await r2Service.copy({
        Bucket: bucketName,
        CopySource: `/${bucketName}/${albumId}/${currentPhotoKey}`,
        Key: `${albumId}/${newPhotoKey}`,
      });
      if (result) {
        const deleted = await deleteObjects(r2Config, bucketName, [
          `${albumId}/${currentPhotoKey}`,
        ]);
        if (!deleted) {
          console.error(
            'Failed to delete original photo after rename: %s',
            `${albumId}/${currentPhotoKey}`,
          );
          return this.fail(c, 'Photo was renamed but failed to remove original');
        }
        return this.ok(c, 'Photo renamed');
      }
      return this.fail(c, 'Failed to rename photo');
    } catch (err: any) {
      console.error('Failed to rename photo: %s', err);
      return this.fail(c, 'Failed to rename photo');
    }
  };

  delete = async (c: ValidatedJsonContext<PhotosRequest>) => {
    const { albumId, photoKeys } = c.req.valid('json');

    const photoKeysArray = photoKeys.map((photoKey) => `${albumId}/${photoKey}`);
    try {
      const r2Config = buildR2Config(c.env);
      const bucketName = c.env.R2_BUCKET_NAME;
      const result = await deleteObjects(r2Config, bucketName, photoKeysArray);
      if (result) {
        return this.ok(c, 'Photo deleted');
      }
      return this.fail(c, 'Failed to delete photos');
    } catch (err: any) {
      console.error('Failed to delete photos: %s', err);
      return this.fail(c, 'Failed to delete photos');
    }
  };

  findOne = async (_c: Context) => {
    throw new Error('Method not implemented.');
  };
}
