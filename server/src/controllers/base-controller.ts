import { Context } from 'hono';
import { getCookie } from 'hono/cookie';
import { get } from 'radash';
import { HonoEnv } from '../env';
import { cleanJwtCookie } from '../routes/auth-middleware';
import { Album } from '../types/album';
import { ApiResponse } from '../types/api-response';
import { BaseController as IBaseController } from '../types/models';
import { UserPermission } from '../types/user-permission';
import { verifyJwt } from '../utils/jwt';

const AUDIT_FIELDS = new Set(['createdAt', 'createdBy', 'updatedAt', 'updatedBy']);

/**
 * Recursively strips audit fields (createdAt, createdBy, updatedAt, updatedBy)
 * from plain objects and arrays before sending to the client.
 */
function stripAuditFields<T>(data: T): T {
  if (data === null || data === undefined || typeof data !== 'object') {
    return data;
  }

  if (Array.isArray(data)) {
    return data.map((item) => stripAuditFields(item)) as T;
  }

  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    if (AUDIT_FIELDS.has(key)) {
      continue;
    }
    result[key] = typeof value === 'object' && value !== null ? stripAuditFields(value) : value;
  }
  return result as T;
}

export abstract class BaseController implements IBaseController {
  abstract findAll(c: Context): Promise<Response>;

  abstract findOne(c: Context): Promise<Response>;

  abstract create(c: Context): Promise<Response>;

  abstract update(c: Context): Promise<Response>;

  abstract delete(c: Context): Promise<Response>;

  public ok<T>(c: Context, message = 'ok', data?: T) {
    const response: ApiResponse<T> = {
      code: 200,
      status: 'Success',
      message,
    };
    if (data !== undefined) {
      response.data = stripAuditFields(data);
    }
    return c.json(response, 200);
  }

  public clientError(c: Context, message = 'Bad Request') {
    const response: ApiResponse<null> = {
      code: 400,
      status: 'Bad Request',
      message,
    };
    return c.json(response, 400);
  }

  public notFoundError(c: Context, message = 'Not Found') {
    const response: ApiResponse<null> = {
      code: 404,
      status: 'Not Found',
      message,
    };
    return c.json(response, 404);
  }

  public unauthorized(c: Context, message = 'Unauthorized') {
    const response: ApiResponse<null> = {
      code: 401,
      status: 'Unauthorized',
      message,
    };
    return c.json(response, 401);
  }

  public insufficientPermission(c: Context, message = 'Forbidden') {
    const response: ApiResponse<null> = {
      code: 403,
      status: 'Forbidden',
      message,
    };
    return c.json(response, 403);
  }

  public conflictError(c: Context, message = 'Document already exists') {
    const response: ApiResponse<null> = {
      code: 409,
      status: 'Document already exists',
      message,
    };
    return c.json(response, 409);
  }

  public fail(c: Context, message: string) {
    const response: ApiResponse<null> = {
      code: 500,
      status: 'Internal Server Error',
      message,
    };
    return c.json(response, 500);
  }

  /**
   * Gate access to anything belonging to an unlisted album.
   *
   * Lives here rather than on one controller because it is the rule for an album's whole
   * contents, not just its photos: the GPS track endpoints have to apply exactly the same
   * check, and a second copy would be one edit away from the two disagreeing about who
   * can see what.
   *
   * Note this is authorisation, not confidentiality. `isUnlisted` hides an album from the
   * site's listings; whether the stored objects are reachable directly is a property of
   * the bucket, not of this check. See migration 0003.
   *
   * @param c Hono context, for the JWT cookie and the environment.
   * @param album The album whose contents are being requested.
   * @returns A Response to return immediately when access is denied, otherwise undefined.
   */
  protected async checkAlbumAccess(
    c: Context<HonoEnv>,
    album: Album,
  ): Promise<Response | undefined> {
    if (!album.isUnlisted) {
      return undefined;
    }

    const token = getCookie(c, 'jwt');
    if (!token) {
      return cleanJwtCookie(c, 'Authentication failed.');
    }

    try {
      const decodedPayload = await verifyJwt<UserPermission>(token, c.env.JWT_SECRET);
      if (get(decodedPayload, 'role') !== 'admin') {
        return cleanJwtCookie(c, 'Unauthorized action.', 403);
      }
      return undefined;
    } catch (error) {
      console.error('JWT verification failed in checkAlbumAccess:', error);
      return cleanJwtCookie(c, 'Authentication failed.');
    }
  }
}
