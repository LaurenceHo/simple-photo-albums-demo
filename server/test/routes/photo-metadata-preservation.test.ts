import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import app from '../../src/index';

/**
 * Coordinates travel with the photo object in R2 custom metadata rather than in D1, so
 * the thing worth testing is that the operations which move objects around leave that
 * metadata alone. These tests cover the two ways that could silently regress:
 *
 * - `CopyObject` being given `MetadataDirective: 'REPLACE'`, which drops user metadata
 *   and would strip a photo's pin on move or rename.
 * - `syncAlbumCover` failing and taking the whole photo list down with it, which now
 *   also loses every pin on the page.
 */

/** Captures the params each `copy` call receives, so the directive can be asserted. */
const mockCopy = vi.fn().mockResolvedValue(true);

/** Album row the mocked service returns; reassigned per test. */
let mockAlbumResult: Record<string, unknown> | null = null;

/** When true, the mocked `AlbumService.update` throws — the cover-sync failure path. */
let albumUpdateThrows = false;

const photoWithCoordinates = {
  url: 'https://cdn.example.com/test/pinned.jpg',
  key: 'test/pinned.jpg',
  size: 1024,
  lastModified: '2025-01-01T00:00:00.000Z',
  latitude: -36.8484,
  longitude: 174.7633,
  takenAt: '2025-01-01T10:00:00.000Z',
};

vi.mock('../../src/services/album-service', () => ({
  default: class {
    async getById() {
      return mockAlbumResult;
    }
    async update() {
      if (albumUpdateThrows) {
        throw new Error('D1 write failed');
      }
      return 'updated';
    }
  },
}));

vi.mock('../../src/services/r2-service', () => ({
  default: class {
    async findAll() {
      return [photoWithCoordinates];
    }
    async copy(params: unknown) {
      return mockCopy(params);
    }
    async getPresignedUploadUrl() {
      return 'https://upload-url';
    }
  },
}));

vi.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: () => Promise.resolve('https://upload-url'),
}));

const mockDeleteObjects = vi.fn().mockResolvedValue(true);

vi.mock('../../src/utils/helpers', () => ({
  buildR2Config: () => ({}),
  deleteObjects: (...args: unknown[]) => mockDeleteObjects(...args),
  uploadObject: () => Promise.resolve(true),
  verifyIfIsAdmin: () => true,
}));

vi.mock('../../src/routes/auth-middleware', async () => {
  const { createMiddleware } = await import('hono/factory');
  return {
    verifyJwtClaim: createMiddleware(async (c, next) => {
      c.set('user', { role: 'admin', email: 'test@test.com' });
      await next();
    }),
    verifyOrigin: createMiddleware(async (c, next) => await next()),
    clearJwtCookie: () => {},
    verifyUserPermission: createMiddleware(async (c, next) => await next()),
    optionalVerifyJwtClaim: createMiddleware(async (c, next) => await next()),
  };
});

const env = {
  DB: {},
  JWT_SECRET: 'test-secret',
  R2_BUCKET_NAME: 'test-bucket',
  BUCKET: {},
};

describe('Photo route - custom metadata is preserved', () => {
  beforeEach(() => {
    mockAlbumResult = {
      id: 'test',
      albumName: 'Test',
      isUnlisted: false,
      tags: [],
      albumCover: 'test/pinned.jpg',
    };
    albumUpdateThrows = false;
    mockCopy.mockReset().mockResolvedValue(true);
    mockDeleteObjects.mockReset().mockResolvedValue(true);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('GET /api/photos/:year/:albumId', () => {
    it('should return coordinates that came from custom metadata', async () => {
      const res = await app.request('/api/photos/2024/test', {}, env);

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data.photos[0]).toMatchObject({
        latitude: -36.8484,
        longitude: 174.7633,
        takenAt: '2025-01-01T10:00:00.000Z',
      });
    });

    // `syncAlbumCover` writes to D1 on a read-only GET. It used to share the handler's
    // outer try/catch, so a D1 failure there returned 500 and no photos for a request
    // whose photos had already been listed successfully.
    it('should still return the full photo list when the album cover sync fails', async () => {
      // Cover set but no photos disagreement is what triggers the write: an album with
      // no cover and photos present makes `syncAlbumCover` attempt an update.
      mockAlbumResult = {
        id: 'test',
        albumName: 'Test',
        isUnlisted: false,
        tags: [],
        albumCover: '',
      };
      albumUpdateThrows = true;

      const res = await app.request('/api/photos/2024/test', {}, env);

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.code).toBe(200);
      expect(body.data.photos).toHaveLength(1);
      expect(body.data.photos[0]).toMatchObject({ latitude: -36.8484, longitude: 174.7633 });
    });
  });

  // R2 `CopyObject` carries user metadata by default; only `MetadataDirective: 'REPLACE'`
  // discards it. These assert the absence of that directive, which is what keeps move and
  // rename free of any metadata-specific code.
  describe('operations that copy objects', () => {
    it('should move a photo without replacing its metadata', async () => {
      const res = await app.request(
        '/api/photos',
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            albumId: 'test',
            destinationAlbumId: 'destination',
            photoKeys: ['pinned.jpg'],
          }),
        },
        env,
      );

      expect(res.status).toBe(200);
      expect(mockCopy).toHaveBeenCalledTimes(1);
      const params = mockCopy.mock.calls[0]?.[0];
      expect(params).not.toHaveProperty('MetadataDirective');
      expect(params).toMatchObject({ Key: 'destination/pinned.jpg' });
    });

    it('should rename a photo without replacing its metadata', async () => {
      const res = await app.request(
        '/api/photos/rename',
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            albumId: 'test',
            currentPhotoKey: 'pinned.jpg',
            newPhotoKey: 'renamed.jpg',
          }),
        },
        env,
      );

      expect(res.status).toBe(200);
      expect(mockCopy).toHaveBeenCalledTimes(1);
      const params = mockCopy.mock.calls[0]?.[0];
      expect(params).not.toHaveProperty('MetadataDirective');
      expect(params).toMatchObject({ Key: 'test/renamed.jpg' });
    });

    // Delete removes the object and its metadata together, so there is nothing for it to
    // preserve — this pins that it needs no metadata-aware code path.
    it('should delete a photo without any copy step', async () => {
      const res = await app.request(
        '/api/photos',
        {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ albumId: 'test', photoKeys: ['pinned.jpg'] }),
        },
        env,
      );

      expect(res.status).toBe(200);
      expect(mockCopy).not.toHaveBeenCalled();
      expect(mockDeleteObjects).toHaveBeenCalledWith({}, 'test-bucket', ['test/pinned.jpg']);
    });
  });
});
