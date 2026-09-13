import { Context } from 'hono';
import { isEmpty } from 'radash';
import { HonoEnv, ValidatedJsonContext, ValidatedQueryContext } from '../env';
import AlbumService from '../services/album-service';
import R2Service from '../services/r2-service';
import { PhotoResponse, PhotosRequest, RenamePhotoRequest } from '../types';
import { MovePhotosRequest, UploadPhotoQuery } from '../types/api-response';
import { Album } from '../types/album';
import { buildR2Config, deleteObjects } from '../utils/helpers';
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
    const bucketName = c.env.R2_BUCKET_NAME;

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
      const photos = await r2Service.findAll({
        Prefix: folderNameKey,
        Bucket: bucketName,
        MaxKeys: 1000,
        StartAfter: folderNameKey,
      });

      // Synchronize album cover
      await this.syncAlbumCover(albumService, album, photos);

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
