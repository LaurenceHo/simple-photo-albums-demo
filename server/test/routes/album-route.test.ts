import { afterEach, describe, expect, it, vi } from 'vitest';
import app from '../../src/index';
import { Album } from '../../src/types/album';

vi.mock('../../src/services/album-service', async () => {
  const mockAlbumList = [
    {
      albumCover: 'demo-album2/batch_bird-8360220.jpg',
      isUnlisted: false,
      place: {
        displayName: 'Honolulu',
        formattedAddress: 'Honolulu, HI, USA',
        location: { latitude: 21.3098845, longitude: -157.85814009999999 },
      },
      albumName: 'demo-album 2',
      description: 'This is demo album 2',
      id: 'demo-album2',
      tags: ['tag1', 'tag3'],
    },
  ];
  return {
    default: class {
      constructor(db: any) {}
      async getAll(query: any) {
        if (query.year === '2024') {
          return mockAlbumList;
        }
        return [];
      }
      async getById(id: string) {
        if (id === 'test-album') {
          return mockAlbumList[0];
        }
        return null;
      }
      async create() {
        return 'created';
      }
      async update() {
        return 'updated';
      }
      async delete() {
        return 'deleted';
      }
    },
  };
});

vi.mock('../../src/routes/auth-middleware', async () => {
  const { createMiddleware } = await import('hono/factory');
  return {
    verifyJwtClaim: createMiddleware(async (c, next) => {
      c.set('user', { role: 'admin', email: 'test@test.com' });
      await next();
    }),
    // Global middleware in src/index.ts; a pass-through keeps route tests focused.
    verifyOrigin: createMiddleware(async (c, next) => await next()),
    clearJwtCookie: () => {},
    verifyUserPermission: createMiddleware(async (c, next) => await next()),
    optionalVerifyJwtClaim: createMiddleware(async (c, next) => await next()),
  };
});

/** Prefixes passed to `emptyR2Folder`, so the delete path can be asserted. */
const emptiedPrefixes = vi.hoisted(() => [] as string[]);

// Spreads the real module rather than replacing it: only the R2-touching helpers need
// stubbing, and a bare object silently turns every other helper into `undefined`, which
// surfaces as an unexplained 500 the first time the controller reaches for a new one.
vi.mock('../../src/utils/helpers', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../src/utils/helpers')>();

  return {
    ...original,
    buildR2Config: () => ({}),
    emptyR2Folder: (_config: unknown, _bucket: string, prefix: string) => {
      emptiedPrefixes.push(prefix);
      return Promise.resolve(true);
    },
    uploadObject: () => Promise.resolve(true),
    verifyIfIsAdmin: () => true,
  };
});

// Mock env
const env = {
  DB: {},
  JWT_SECRET: 'test-secret',
};

describe('album route', () => {
  afterEach(() => {
    vi.resetAllMocks();
  });

  it('should return correct albums', async () => {
    const response = await app.request('/api/albums/2024', {}, env);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({
      code: 200,
      status: 'Success',
      message: 'ok',
      data: [
        {
          albumCover: 'demo-album2/batch_bird-8360220.jpg',
          isUnlisted: false,
          place: {
            displayName: 'Honolulu',
            formattedAddress: 'Honolulu, HI, USA',
            location: { latitude: 21.3098845, longitude: -157.85814009999999 },
          },
          albumName: 'demo-album 2',
          description: 'This is demo album 2',
          id: 'demo-album2',
          tags: ['tag1', 'tag3'],
        },
      ],
    });
  });

  describe('create album', () => {
    it('should return 200', async () => {
      const response = await app.request(
        '/api/albums',
        {
          method: 'POST',
          body: JSON.stringify({
            year: '2024',
            id: 'new-album',
            albumCover: '',
            albumName: 'Test album',
            description: '',
            isUnlisted: true,
          } as Album),
          headers: { 'Content-Type': 'application/json' },
        },
        env,
      );
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body).toEqual({
        code: 200,
        status: 'Success',
        message: 'Album created',
      });
    });

    it('should return 400 bad request when body is empty', async () => {
      const response = await app.request('/api/albums', { method: 'POST' }, env);
      expect(response.status).toBe(400);
    });
  });

  describe('update album', () => {
    it('should return 200', async () => {
      const response = await app.request(
        '/api/albums',
        {
          method: 'PUT',
          body: JSON.stringify({
            year: '2024',
            id: 'test-album',
            albumCover: '',
            albumName: 'Test album',
            description: '',
            isUnlisted: true,
          } as Album),
          headers: { 'Content-Type': 'application/json' },
        },
        env,
      );
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body).toEqual({
        code: 200,
        status: 'Success',
        message: 'Album updated',
      });
    });
  });

  describe('delete album', () => {
    const deleteAlbum = () =>
      app.request(
        '/api/albums',
        {
          method: 'DELETE',
          body: JSON.stringify({
            year: '2024',
            id: 'test-album',
          }),
          headers: { 'Content-Type': 'application/json' },
        },
        env,
      );

    it('should return 200', async () => {
      const response = await deleteAlbum();
      expect(response.status).toBe(200);
    });

    it('empties the photo prefix and the sibling GPS track prefix', async () => {
      emptiedPrefixes.length = 0;

      await deleteAlbum();

      // Tracks live under `gps-tracks/<albumId>/`, outside the album's photo folder, so
      // one call cannot reach both. Missing the second leaves orphaned track objects that
      // nothing ever cleans up.
      expect(emptiedPrefixes).toEqual(['test-album', 'gps-tracks/test-album/']);
    });

    /**
     * Regression tests for a destructive bug.
     *
     * `DeleteAlbumSchema.id` was a bare `z.string()`, so `''` was a valid body. The photo
     * prefix then became `'/'`, which matches nothing and so *reported success*, and the
     * track prefix became the bare `'gps-tracks/'` - which `emptyR2Folder` treats as an
     * already-terminated prefix, so it listed and deleted every album's tracks. The
     * response was 200 "Album deleted", naming an album that was never touched.
     */
    describe('an id that is not a usable R2 segment', () => {
      const deleteWithId = (id: string) =>
        app.request(
          '/api/albums',
          {
            method: 'DELETE',
            body: JSON.stringify({ year: '2024', id }),
            headers: { 'Content-Type': 'application/json' },
          },
          env,
        );

      it.each([
        ['empty', ''],
        ['a path separator', 'a/b'],
        ['a parent directory', '..'],
      ])('rejects %s before touching R2', async (_label, id) => {
        emptiedPrefixes.length = 0;

        const response = await deleteWithId(id);

        expect(response.status).toBe(400);
        // The assertion that matters: nothing was deleted. A 400 that still emptied a
        // prefix would be the same bug wearing a different status code.
        expect(emptiedPrefixes).toEqual([]);
      });
    });
  });
});
