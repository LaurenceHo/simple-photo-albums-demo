import { Context } from 'hono';
import { HonoEnv, ValidatedJsonContext } from '../env';
import AlbumTagService from '../services/album-tag-service';
import { AlbumTag } from '../types/album';
import { CreateTagRequest } from '../types/request-schemas';
import { UserPermission } from '../types/user-permission';
import { BaseController } from './base-controller';

export default class AlbumTagController extends BaseController {
  findAll = async (c: Context<HonoEnv>) => {
    const albumTagService = new AlbumTagService(c.env.DB);
    try {
      const albumTags = await albumTagService.getAll();

      return this.ok<AlbumTag[]>(c, 'ok', albumTags);
    } catch (err: any) {
      console.error(`Failed to query album tags: ${err}`);
      return this.fail(c, 'Failed to query album tags');
    }
  };

  create = async (c: ValidatedJsonContext<CreateTagRequest>) => {
    const tags = c.req.valid('json');
    const user = c.get('user') as UserPermission;
    // Both audit fields are set here rather than taken from the request: CreateTagSchema
    // accepts only `tag`, so a client cannot forge who created a tag or when.
    const createdAt = new Date().toISOString();
    const tagsToCreate: AlbumTag[] = tags.map((tag) => {
      return {
        ...tag,
        createdAt,
        createdBy: user?.email ?? 'unknown',
      };
    });
    const albumTagService = new AlbumTagService(c.env.DB);

    try {
      await albumTagService.create(tagsToCreate);

      return this.ok(c, 'Album tag created');
    } catch (err) {
      console.error(`Failed to create album tag: ${err}`);
      return this.fail(c, 'Failed to create album tag');
    }
  };

  delete = async (c: Context<HonoEnv>) => {
    const tag = c.req.param('tagId');
    if (!tag) {
      return this.clientError(c, 'Tag ID is required');
    }
    const albumTagService = new AlbumTagService(c.env.DB);
    try {
      console.log('##### Delete tag: %s', tag);
      await albumTagService.delete(tag);

      return this.ok(c, 'Album tag deleted');
    } catch (err) {
      console.error(`Failed to delete album tag: ${err}`);
      return this.fail(c, 'Failed to delete album tag');
    }
  };

  findOne = async (_c: Context) => {
    throw new Error('Method not implemented.');
  };

  update = async (_c: Context) => {
    throw new Error('Method not implemented.');
  };
}
