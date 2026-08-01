import { Context } from 'hono';
import { HonoEnv, ValidatedJsonContext } from '../env';
import AlbumService from '../services/album-service';
import { Album } from '../types/album';
import {
  CreateAlbumRequest,
  DeleteAlbumRequest,
  UpdateAlbumRequest,
} from '../types/request-schemas';
import { UserPermission } from '../types/user-permission';
import { buildR2Config, emptyR2Folder, uploadObject, verifyIfIsAdmin } from '../utils/helpers';
import { BaseController } from './base-controller';

export default class AlbumController extends BaseController {
  findAll = async (c: Context<HonoEnv>) => {
    const year = c.req.param('year');
    const albumService = new AlbumService(c.env.DB);

    try {
      const isAdmin = await verifyIfIsAdmin(c);

      const query: any = { year };
      if (!isAdmin) {
        query.isUnlisted = 0;
      }

      const albumList = await albumService.getAll(query);

      return this.ok<Album[]>(c, 'ok', albumList);
    } catch (err: any) {
      console.error(`Failed to query photo album: ${err.stack}`);
      return this.fail(c, 'Failed to query photo album');
    }
  };

  create = async (c: ValidatedJsonContext<CreateAlbumRequest>) => {
    const user = c.get('user') as UserPermission;
    const now = new Date().toISOString();
    // c.req.valid, not c.req.json: the validated output has unknown keys stripped.
    const album: Album = {
      ...c.req.valid('json'),
      createdBy: user?.email ?? 'unknown',
      updatedBy: user?.email ?? 'unknown',
      createdAt: now,
      updatedAt: now,
    };
    const albumService = new AlbumService(c.env.DB);

    try {
      // Check if album already exists
      const existing = await albumService.getById(album.id);
      if (existing) {
        return this.conflictError(c, 'Album already exists');
      }

      await albumService.create(album);
      // Create folder in R2
      const r2Config = buildR2Config(c.env);
      await uploadObject(r2Config, c.env.R2_BUCKET_NAME, album.id + '/', null);
      return this.ok(c, 'Album created');
    } catch (err: any) {
      console.error(`Failed to insert photo album: ${err}`);
      return this.fail(c, 'Failed to create photo album');
    }
  };

  update = async (c: ValidatedJsonContext<UpdateAlbumRequest>) => {
    try {
      const user = c.get('user') as UserPermission;
      // `id` is the WHERE key, not a SET field - same pattern as
      // travel-record-controller.ts. Leaving it in produced `SET id = ? ... WHERE id = ?`,
      // rewriting the primary key with its own value on every update.
      const { id, ...rest } = c.req.valid('json');
      // Partial, not Album: the schema omits createdAt/createdBy, and leaving them
      // absent means `D1Service.update` skips them, preserving the stored values.
      const album: Partial<Album> = {
        ...rest,
        updatedBy: user?.email ?? 'unknown',
        updatedAt: new Date().toISOString(),
      };

      const albumService = new AlbumService(c.env.DB);

      await albumService.update(id, album);

      return this.ok(c, 'Album updated');
    } catch (err: any) {
      console.error(`Failed to update photo album: ${err}`);
      return this.fail(c, 'Failed to update photo album');
    }
  };

  delete = async (c: ValidatedJsonContext<DeleteAlbumRequest>) => {
    try {
      const requestBody = c.req.valid('json');
      console.log('##### Delete album: %s', requestBody.id);
      const albumService = new AlbumService(c.env.DB);

      // Empty R2 folder
      const r2Config = buildR2Config(c.env);
      const result = await emptyR2Folder(r2Config, c.env.R2_BUCKET_NAME, requestBody.id);

      if (result) {
        // Delete album from database
        await albumService.delete(requestBody.id);
        return this.ok(c, 'Album deleted');
      } else {
        return this.fail(c, 'Failed to delete photo album');
      }
    } catch (err: any) {
      console.error(`Failed to delete photo album: ${err}`);
      return this.fail(c, 'Failed to delete photo album');
    }
  };

  findOne = async (c: Context<HonoEnv>) => {
    const albumId = c.req.param('id');
    if (!albumId) {
      return this.clientError(c, 'Album ID is required');
    }
    const albumService = new AlbumService(c.env.DB);

    try {
      const album = await albumService.getById(albumId);
      if (!album) {
        return this.clientError(c, 'Album not found');
      }
      return this.ok<Album>(c, 'ok', album);
    } catch (err: any) {
      console.error(`Failed to query photo album: ${err}`);
      return this.fail(c, 'Failed to query photo album');
    }
  };
}
