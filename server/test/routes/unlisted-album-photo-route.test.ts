import { afterEach, describe, expect, it, vi } from 'vitest';
import app from '../../src/index';
import { mockAlbumList, mockPhotoList, mockSignedCookies } from '../mock-data';

vi.mock('../../src/services/album-service', async () => {
  const { mockAlbumList } = await import('../mock-data');
  return {
    default: class {
      constructor(db: any) {}
      async getById(id: string) {
        return mockAlbumList[2]; // unlisted album
      }
      async update() {
        return 'updated';
      }
    },
  };
});

vi.mock('../../src/services/r2-service', async () => {
  const { mockPhotoList } = await import('../mock-data');
  return {
    default: class {
      findAll() {
        return Promise.resolve(mockPhotoList);
      }
    },
  };
});

// Mock auth middleware to simulate real behavior for testing 401
vi.mock('../../src/routes/auth-middleware', async () => {
  const { createMiddleware } = await import('hono/factory');
  return {
    verifyJwtClaim: createMiddleware(async (c, next) => {
      const token = c.req.header('Cookie');
      if (token && token.includes('jwt=')) {
        c.set('user', { role: 'admin', email: 'test@test.com' });
        await next();
      } else {
        return c.json({ message: 'Authentication failed. Please login.' }, 401);
      }
    }),
    // Global middleware in src/index.ts; a pass-through keeps route tests focused.
    verifyOrigin: createMiddleware(async (c, next) => await next()),
    clearJwtCookie: () => {},
    verifyUserPermission: createMiddleware(async (c, next) => await next()),
    optionalVerifyJwtClaim: createMiddleware(async (c, next) => {
      const token = c.req.header('Cookie');
      if (token && token.includes('jwt=')) {
        c.set('user', { role: 'admin', email: 'test@test.com' });
      }
      await next();
    }),
    cleanJwtCookie: (c: any, message: string, code = 401) => {
      return c.json({ message }, code);
    },
  };
});

// Mock env
const env = {
  DB: {},
  JWT_SECRET: 'test-secret',
};

describe('unlisted album route', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should return correct photos', async () => {
    process.env.JWT_SECRET = 'test-secret';
    const token = await mockSignedCookies();
    const response = await app.request(
      '/api/photos/2024/test',
      {
        headers: {
          Cookie: `jwt=${token}`,
        },
      },
      env,
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.code).toBe(200);
    expect(body.data.album).toEqual(mockAlbumList[2]);
    expect(body.data.photos).toHaveLength(mockPhotoList.length);
  });

  // `isUnlisted` hides an album from the site; it is not a confidentiality control, and
  // the photo bytes are intentionally public on the CDN. So the URLs handed back here
  // are the ordinary CDN URLs - what this route gates is the *listing*, above.
  it('should return ordinary CDN photo URLs', async () => {
    process.env.JWT_SECRET = 'test-secret';
    const token = await mockSignedCookies();
    const response = await app.request(
      '/api/photos/2024/test',
      { headers: { Cookie: `jwt=${token}` } },
      env,
    );

    const body = await response.json();
    expect(body.data.photos).toEqual(mockPhotoList);
  });

  it('should return 401', async () => {
    const response = await app.request('/api/photos/2024/test', {}, env);
    expect(response.status).toBe(401);
  });
});
