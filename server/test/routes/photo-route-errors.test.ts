import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import app from '../../src/index';

let mockAlbumResult: Record<string, unknown> | null = {
  id: 'test',
  albumName: 'Test',
  isUnlisted: false,
  tags: [],
};
let mockR2Behavior: 'success' | 'error' = 'success';

vi.mock('../../src/services/album-service', () => ({
  default: class {
    async getById() {
      return mockAlbumResult;
    }
    async update() {
      return 'updated';
    }
  },
}));

vi.mock('../../src/services/r2-service', () => ({
  default: class {
    async findAll() {
      if (mockR2Behavior === 'error') throw new Error('R2 list error');
      return [];
    }
    async copy() {
      if (mockR2Behavior === 'error') return false;
      return true;
    }
    async getPresignedUploadUrl() {
      if (mockR2Behavior === 'error') throw new Error('Presign error');
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
    // Global middleware in src/index.ts; a pass-through keeps route tests focused.
    verifyOrigin: createMiddleware(async (c, next) => await next()),
    clearJwtCookie: () => {},
    verifyUserPermission: createMiddleware(async (c, next) => await next()),
    optionalVerifyJwtClaim: createMiddleware(async (c, next) => await next()),
    cleanJwtCookie: (c: any, message: string, code = 401) => c.json({ message }, code),
  };
});

const env = {
  DB: {},
  JWT_SECRET: 'test-secret',
  R2_BUCKET_NAME: 'test-bucket',
};

describe('Photo route - error paths', () => {
  beforeEach(() => {
    mockAlbumResult = { id: 'test', albumName: 'Test', isUnlisted: false, tags: [], albumCover: '' };
    mockR2Behavior = 'success';
    mockDeleteObjects.mockReset().mockResolvedValue(true);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /* ------------------------------------------------------------------ */
  /* findAll errors                                                      */
  /* ------------------------------------------------------------------ */
  describe('GET /api/photos/:year/:albumId', () => {
    it('should return 404 when album does not exist', async () => {
      mockAlbumResult = null;

      const res = await app.request('/api/photos/2024/nonexistent', {}, env);

      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body.message).toBe('Album does not exist');
    });

    it('should return 500 when R2 service throws', async () => {
      mockR2Behavior = 'error';

      const res = await app.request('/api/photos/2024/test', {}, env);

      expect(res.status).toBe(500);
      const body = await res.json();
      expect(body.message).toBe('Failed to get photos');
    });
  });

  /* ------------------------------------------------------------------ */
  /* create (presigned URL) errors                                       */
  /* ------------------------------------------------------------------ */
  describe('POST /api/photos/upload/:albumId', () => {
    // 400, not 500: the query is now schema-validated by zValidator, which rejects a
    // malformed request before the handler runs.
    it('should return 400 when filename is missing', async () => {
      const res = await app.request(
        '/api/photos/upload/test?mimeType=image/jpeg',
        { method: 'POST' },
        env,
      );

      expect(res.status).toBe(400);
    });

    it('should return 400 when mimeType is missing', async () => {
      const res = await app.request(
        '/api/photos/upload/test?filename=photo.jpg',
        { method: 'POST' },
        env,
      );

      expect(res.status).toBe(400);
    });

    it('should return 400 when mimeType is not an allowed image type', async () => {
      // text/html would otherwise be written as the presigned PUT's ContentType, which
      // is stored XSS on a public CDN origin.
      const res = await app.request(
        '/api/photos/upload/test?filename=evil.html&mimeType=text/html',
        { method: 'POST' },
        env,
      );

      expect(res.status).toBe(400);
    });

    it('should return 400 when filename attempts path traversal', async () => {
      const res = await app.request(
        `/api/photos/upload/test?filename=${encodeURIComponent('../../evil.jpg')}&mimeType=image/jpeg`,
        { method: 'POST' },
        env,
      );

      expect(res.status).toBe(400);
    });

    it('should return 500 when presigned URL generation fails', async () => {
      mockR2Behavior = 'error';

      const res = await app.request(
        '/api/photos/upload/test?filename=photo.jpg&mimeType=image/jpeg',
        { method: 'POST' },
        env,
      );

      expect(res.status).toBe(500);
      const body = await res.json();
      expect(body.message).toBe('Failed to generate upload URL');
    });
  });

  /* ------------------------------------------------------------------ */
  /* move (update) errors                                                */
  /* ------------------------------------------------------------------ */
  describe('PUT /api/photos (move)', () => {
    const moveBody = {
      albumId: 'src-album',
      destinationAlbumId: 'dest-album',
      photoKeys: ['photo1.jpg', 'photo2.jpg'],
    };

    // A move without a destination used to pass validation, copy every photo to the
    // literal prefix `undefined/`, and then delete the originals - silently relocating
    // them to a garbage prefix. MovePhotosRequestSchema makes the field required.
    it('should return 400 when destinationAlbumId is missing', async () => {
      const { destinationAlbumId: _omitted, ...bodyWithoutDestination } = moveBody;

      const res = await app.request(
        '/api/photos',
        {
          method: 'PUT',
          body: JSON.stringify(bodyWithoutDestination),
          headers: { 'Content-Type': 'application/json' },
        },
        env,
      );

      expect(res.status).toBe(400);
      expect(mockDeleteObjects).not.toHaveBeenCalled();
    });

    it('should return 400 when destinationAlbumId attempts path traversal', async () => {
      const res = await app.request(
        '/api/photos',
        {
          method: 'PUT',
          body: JSON.stringify({ ...moveBody, destinationAlbumId: '../elsewhere' }),
          headers: { 'Content-Type': 'application/json' },
        },
        env,
      );

      expect(res.status).toBe(400);
      expect(mockDeleteObjects).not.toHaveBeenCalled();
    });

    // Delete has no destination, so it must keep accepting a body without one.
    it('should still allow DELETE without a destinationAlbumId', async () => {
      const { destinationAlbumId: _omitted, ...bodyWithoutDestination } = moveBody;

      const res = await app.request(
        '/api/photos',
        {
          method: 'DELETE',
          body: JSON.stringify(bodyWithoutDestination),
          headers: { 'Content-Type': 'application/json' },
        },
        env,
      );

      expect(res.status).not.toBe(400);
    });

    it('should return 500 when all copies fail', async () => {
      mockR2Behavior = 'error';

      const res = await app.request(
        '/api/photos',
        {
          method: 'PUT',
          body: JSON.stringify(moveBody),
          headers: { 'Content-Type': 'application/json' },
        },
        env,
      );

      expect(res.status).toBe(500);
      const body = await res.json();
      expect(body.message).toBe('Failed to move any photos');
    });

    it('should return 500 when delete after copy fails', async () => {
      mockDeleteObjects.mockResolvedValue(false);

      const res = await app.request(
        '/api/photos',
        {
          method: 'PUT',
          body: JSON.stringify(moveBody),
          headers: { 'Content-Type': 'application/json' },
        },
        env,
      );

      expect(res.status).toBe(500);
      const body = await res.json();
      expect(body.message).toBe('Photos were copied but failed to remove originals');
    });
  });

  /* ------------------------------------------------------------------ */
  /* rename errors                                                       */
  /* ------------------------------------------------------------------ */
  describe('PUT /api/photos/rename', () => {
    const renameBody = {
      albumId: 'album-1',
      currentPhotoKey: 'old.jpg',
      newPhotoKey: 'new.jpg',
    };

    it('should return 500 when copy fails during rename', async () => {
      mockR2Behavior = 'error';

      const res = await app.request(
        '/api/photos/rename',
        {
          method: 'PUT',
          body: JSON.stringify(renameBody),
          headers: { 'Content-Type': 'application/json' },
        },
        env,
      );

      expect(res.status).toBe(500);
      const body = await res.json();
      expect(body.message).toBe('Failed to rename photo');
    });

    it('should return 500 when delete after rename copy fails', async () => {
      mockDeleteObjects.mockResolvedValue(false);

      const res = await app.request(
        '/api/photos/rename',
        {
          method: 'PUT',
          body: JSON.stringify(renameBody),
          headers: { 'Content-Type': 'application/json' },
        },
        env,
      );

      expect(res.status).toBe(500);
      const body = await res.json();
      expect(body.message).toBe('Photo was renamed but failed to remove original');
    });
  });

  /* ------------------------------------------------------------------ */
  /* delete errors                                                       */
  /* ------------------------------------------------------------------ */
  describe('DELETE /api/photos', () => {
    const deleteBody = { albumId: 'album-1', photoKeys: ['photo1.jpg'] };

    it('should return 500 when deleteObjects returns false', async () => {
      mockDeleteObjects.mockResolvedValue(false);

      const res = await app.request(
        '/api/photos',
        {
          method: 'DELETE',
          body: JSON.stringify(deleteBody),
          headers: { 'Content-Type': 'application/json' },
        },
        env,
      );

      expect(res.status).toBe(500);
      const body = await res.json();
      expect(body.message).toBe('Failed to delete photos');
    });

    it('should return 500 when deleteObjects throws', async () => {
      mockDeleteObjects.mockRejectedValue(new Error('R2 failure'));

      const res = await app.request(
        '/api/photos',
        {
          method: 'DELETE',
          body: JSON.stringify(deleteBody),
          headers: { 'Content-Type': 'application/json' },
        },
        env,
      );

      expect(res.status).toBe(500);
      const body = await res.json();
      expect(body.message).toBe('Failed to delete photos');
    });
  });
});
