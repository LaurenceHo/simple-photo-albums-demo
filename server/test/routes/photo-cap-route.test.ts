import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MAX_PHOTOS_PER_ALBUM } from '../../src/constants';
import app from '../../src/index';
import { signJwt } from '../../src/utils/jwt';

/**
 * The album photo cap, as the server enforces it.
 *
 * This check is a backstop, not the primary guard — the endpoint mints one presigned URL
 * per file and the uploader fires them in parallel, so it can only catch "far over", never
 * "exactly at". The behaviour worth pinning is therefore narrow: it refuses at the cap,
 * and it refuses *only* uploads. Delete and move must keep working on an album that is
 * already over, or an admin cannot dig themselves out.
 */

const JWT_SECRET = 'test-secret';
const ALBUM = 'demo-album';

const env = {
  DB: {},
  JWT_SECRET,
  R2_BUCKET_NAME: 'test-bucket',
  BUCKET: {},
};

const state = vi.hoisted(() => ({
  /** What `countObjects` reports for the album. */
  photoCount: 0,
  presignCalls: 0,
  deleteCalls: [] as unknown[][],
  copyCalls: [] as unknown[][],
}));

vi.mock('../../src/services/r2-service', () => ({
  default: class {
    async countObjects() {
      return state.photoCount;
    }
    async getPresignedUploadUrl() {
      state.presignCalls++;
      return 'https://upload-url';
    }
    async copy(...args: unknown[]) {
      state.copyCalls.push(args);
      return true;
    }
    async findAll() {
      return [];
    }
  },
}));

vi.mock('../../src/utils/helpers', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../src/utils/helpers')>();
  return {
    ...original,
    buildR2Config: () => ({}),
    deleteObjects: (...args: unknown[]) => {
      state.deleteCalls.push(args);
      return Promise.resolve(true);
    },
  };
});

const adminCookie = async () =>
  `jwt=${await signJwt({ uid: '1', role: 'admin', email: 'admin@example.com' }, JWT_SECRET)}`;

const requestUpload = async (cookie: string) =>
  app.request(
    `/api/photos/upload/${ALBUM}?filename=new.jpg&mimeType=image/jpeg`,
    { method: 'POST', headers: { Cookie: cookie } },
    env,
  );

describe('album photo cap', () => {
  beforeEach(() => {
    state.photoCount = 0;
    state.presignCalls = 0;
    state.deleteCalls = [];
    state.copyCalls = [];
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  it('mints an upload URL for an album below the cap', async () => {
    state.photoCount = MAX_PHOTOS_PER_ALBUM - 1;

    const res = await requestUpload(await adminCookie());

    expect(res.status).toBe(200);
    expect(state.presignCalls).toBe(1);
  });

  it('refuses to mint an upload URL for an album at the cap', async () => {
    state.photoCount = MAX_PHOTOS_PER_ALBUM;

    const res = await requestUpload(await adminCookie());
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body.message).toContain(String(MAX_PHOTOS_PER_ALBUM));
    // The credential must not be minted at all, not merely go unused.
    expect(state.presignCalls).toBe(0);
  });

  it('refuses an album already over the cap', async () => {
    state.photoCount = MAX_PHOTOS_PER_ALBUM + 25;

    const res = await requestUpload(await adminCookie());

    expect(res.status).toBe(409);
    expect(state.presignCalls).toBe(0);
  });

  // The cap gates adding only. An album over the limit that could not be pruned would be
  // permanently stuck, which is worse than being over the limit.
  describe('an album over the cap is not locked', () => {
    beforeEach(() => {
      state.photoCount = MAX_PHOTOS_PER_ALBUM + 50;
    });

    it('still allows photos to be deleted', async () => {
      const res = await app.request(
        '/api/photos',
        {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json', Cookie: await adminCookie() },
          body: JSON.stringify({ albumId: ALBUM, photoKeys: ['old.jpg'] }),
        },
        env,
      );

      expect(res.status).toBe(200);
      expect(state.deleteCalls).toHaveLength(1);
    });

    it('still allows photos to be moved out', async () => {
      const res = await app.request(
        '/api/photos',
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json', Cookie: await adminCookie() },
          body: JSON.stringify({
            albumId: ALBUM,
            destinationAlbumId: 'somewhere-else',
            photoKeys: ['old.jpg'],
          }),
        },
        env,
      );

      expect(res.status).toBe(200);
      expect(state.copyCalls).toHaveLength(1);
    });
  });
});
