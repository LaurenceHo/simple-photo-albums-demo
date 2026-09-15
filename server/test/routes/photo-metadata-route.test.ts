import { beforeEach, describe, expect, it, vi } from 'vitest';
import app from '../../src/index';
import { signJwt } from '../../src/utils/jwt';
import { AUCKLAND, buildGeotaggedJpeg, buildJpegWithoutGps } from '../fixtures/geotagged-jpeg';

const JWT_SECRET = 'test-secret';
const ALBUM = 'demo-album';
const BASE = `/api/photos/metadata/${ALBUM}`;

const env = {
  DB: {},
  JWT_SECRET,
  R2_BUCKET_NAME: 'test-bucket',
  // The controller passes this through to the service, which is mocked below, so the
  // binding only has to be present rather than functional.
  BUCKET: {},
};

/** Mutable fixtures the mocked R2 service reads, reset in `beforeEach`. */
const state = vi.hoisted(() => ({
  /** Keyed by full R2 key; `null` stands for an object that is not there. */
  objects: new Map<
    string,
    { bytes: ArrayBuffer; contentType: string | undefined; customMetadata: Record<string, string> }
  >(),
  /** Keys whose ranged read should throw, to exercise the per-photo failure path. */
  readThrows: new Set<string>(),
  /** Keys whose metadata write should report failure. */
  writeFails: new Set<string>(),
  /** Every `replaceCustomMetadata` call, as `[bucket, key, metadata, contentType]`. */
  writes: [] as unknown[][],
}));

vi.mock('../../src/services/r2-service', () => ({
  default: class {
    async readRange(_bucket: unknown, key: string) {
      if (state.readThrows.has(key)) {
        throw new Error('R2 read failed');
      }
      return state.objects.get(key) ?? null;
    }
    async replaceCustomMetadata(...args: unknown[]) {
      state.writes.push(args);
      return !state.writeFails.has(args[1] as string);
    }
  },
}));

vi.mock('../../src/utils/helpers', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../src/utils/helpers')>();
  return { ...original, buildR2Config: () => ({}) };
});

const adminCookie = async () =>
  `jwt=${await signJwt({ uid: '1', role: 'admin', email: 'admin@example.com' }, JWT_SECRET)}`;

const viewerCookie = async () =>
  `jwt=${await signJwt({ uid: '2', role: 'viewer', email: 'viewer@example.com' }, JWT_SECRET)}`;

const scan = async (body: unknown, cookie?: string, base = BASE) =>
  app.request(
    base,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
      body: JSON.stringify(body),
    },
    env,
  );

/** Register an object the mocked service will return for `<ALBUM>/<name>`. */
const givenPhoto = (
  name: string,
  bytes: Uint8Array,
  contentType: string | undefined = 'image/jpeg',
  customMetadata: Record<string, string> = {},
) => {
  state.objects.set(`${ALBUM}/${name}`, {
    // `slice()` so the ArrayBuffer is exactly these bytes — a subarray would share its
    // parent's whole buffer.
    bytes: bytes.slice().buffer as ArrayBuffer,
    contentType,
    customMetadata,
  });
};

/** The metadata argument of the write recorded for `<ALBUM>/<name>`. */
const writtenMetadataFor = (name: string): Record<string, string> | undefined =>
  state.writes.find((call) => call[1] === `${ALBUM}/${name}`)?.[2] as
    | Record<string, string>
    | undefined;

describe('POST /api/photos/metadata/:albumId', () => {
  beforeEach(() => {
    state.objects.clear();
    state.readThrows.clear();
    state.writeFails.clear();
    state.writes = [];
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  describe('access control', () => {
    it('401s without a token', async () => {
      const res = await scan({ photoKeys: ['a.jpg'] });

      expect(res.status).toBe(401);
    });

    it('403s for a signed-in non-admin', async () => {
      const res = await scan({ photoKeys: ['a.jpg'] }, await viewerCookie());

      expect(res.status).toBe(403);
      expect(state.writes).toHaveLength(0);
    });
  });

  describe('request validation', () => {
    it('rejects a batch larger than 50', async () => {
      const photoKeys = Array.from({ length: 51 }, (_, i) => `photo-${i}.jpg`);

      const res = await scan({ photoKeys }, await adminCookie());

      expect(res.status).toBe(400);
    });

    it('accepts a batch of exactly 50', async () => {
      const photoKeys = Array.from({ length: 50 }, (_, i) => `photo-${i}.jpg`);

      const res = await scan({ photoKeys }, await adminCookie());

      expect(res.status).toBe(200);
    });

    it('rejects an empty batch', async () => {
      const res = await scan({ photoKeys: [] }, await adminCookie());

      expect(res.status).toBe(400);
    });

    // `safeR2Segment` is what stops a key addressing objects outside the album prefix.
    it.each(['../other-album/secret.jpg', 'nested/photo.jpg', '..'])(
      'rejects the traversal key %s',
      async (photoKey) => {
        const res = await scan({ photoKeys: [photoKey] }, await adminCookie());

        expect(res.status).toBe(400);
        expect(state.writes).toHaveLength(0);
      },
    );

    // Hono decodes the path param before the handler sees it, so an encoded separator is
    // the form that actually reaches the guard — a literal `..` segment is normalised out
    // by the router and 404s before any of this runs.
    it('rejects an album id whose encoded form decodes to a path separator', async () => {
      const res = await scan(
        { photoKeys: ['a.jpg'] },
        await adminCookie(),
        '/api/photos/metadata/album%2F..%2Fother',
      );

      expect(res.status).toBe(400);
      expect(state.writes).toHaveLength(0);
    });

    it('does not scan anything for a literal parent-directory album id', async () => {
      const res = await scan({ photoKeys: ['a.jpg'] }, await adminCookie(), '/api/photos/metadata/..');

      expect(res.status).not.toBe(200);
      expect(state.writes).toHaveLength(0);
    });
  });

  describe('extraction', () => {
    it('stores the coordinates it finds and reports them back', async () => {
      givenPhoto('pinned.jpg', buildGeotaggedJpeg(AUCKLAND));

      const res = await scan({ photoKeys: ['pinned.jpg'] }, await adminCookie());
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body.data.results).toEqual([
        {
          photoKey: 'pinned.jpg',
          status: 'located',
          latitude: expect.closeTo(-36.8484, 4),
          longitude: expect.closeTo(174.7633, 4),
          takenAt: '2025-01-01T10:00:00',
        },
      ]);

      const metadata = writtenMetadataFor('pinned.jpg');
      expect(Number(metadata?.['latitude'])).toBeCloseTo(-36.8484, 4);
      expect(Number(metadata?.['longitude'])).toBeCloseTo(174.7633, 4);
      expect(metadata?.['hasgps']).toBe('true');
    });

    // Without this marker a photo that genuinely has no GPS is indistinguishable from one
    // never scanned, and every re-run reads it again forever.
    it('marks a photo with no GPS as scanned rather than leaving it unmarked', async () => {
      givenPhoto('plain.jpg', buildJpegWithoutGps());

      const res = await scan({ photoKeys: ['plain.jpg'] }, await adminCookie());
      const body = await res.json();

      expect(body.data.results).toEqual([{ photoKey: 'plain.jpg', status: 'noGps' }]);
      expect(writtenMetadataFor('plain.jpg')).toEqual({ hasgps: 'false' });
    });

    // `MetadataDirective: 'REPLACE'` drops the content type with the metadata. A photo
    // returning as application/octet-stream downloads instead of rendering.
    it('passes the existing content type through to the copy', async () => {
      givenPhoto('pinned.webp', buildGeotaggedJpeg(AUCKLAND), 'image/webp');

      await scan({ photoKeys: ['pinned.webp'] }, await adminCookie());

      const call = state.writes.find((c) => c[1] === `${ALBUM}/pinned.webp`);
      expect(call?.[3]).toBe('image/webp');
    });

    // REPLACE discards every key, so anything already on the object has to be re-sent.
    it('preserves unrelated custom metadata already on the object', async () => {
      givenPhoto('pinned.jpg', buildGeotaggedJpeg(AUCKLAND), 'image/jpeg', {
        caption: 'sunset over the harbour',
        latitude: '0',
      });

      await scan({ photoKeys: ['pinned.jpg'] }, await adminCookie());

      const metadata = writtenMetadataFor('pinned.jpg');
      expect(metadata?.['caption']).toBe('sunset over the harbour');
      // The stale coordinate is replaced by the freshly parsed one, not kept.
      expect(Number(metadata?.['latitude'])).toBeCloseTo(-36.8484, 4);
    });

    it('reports a missing object without failing the request', async () => {
      const res = await scan({ photoKeys: ['gone.jpg'] }, await adminCookie());
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body.data.results).toEqual([{ photoKey: 'gone.jpg', status: 'notFound' }]);
      expect(state.writes).toHaveLength(0);
    });

    it('reports a failed metadata write for that photo only', async () => {
      givenPhoto('unwritable.jpg', buildGeotaggedJpeg(AUCKLAND));
      state.writeFails.add(`${ALBUM}/unwritable.jpg`);

      const res = await scan({ photoKeys: ['unwritable.jpg'] }, await adminCookie());
      const body = await res.json();

      expect(body.data.results[0]).toMatchObject({
        photoKey: 'unwritable.jpg',
        status: 'failed',
      });
    });

    // The batch is the unit of work for the UI's progress bar; one corrupt file must not
    // cost an admin the other forty-nine.
    it('continues the batch when one photo cannot be read', async () => {
      givenPhoto('good.jpg', buildGeotaggedJpeg(AUCKLAND));
      givenPhoto('plain.jpg', buildJpegWithoutGps());
      state.readThrows.add(`${ALBUM}/broken.jpg`);

      const res = await scan(
        { photoKeys: ['good.jpg', 'broken.jpg', 'plain.jpg'] },
        await adminCookie(),
      );
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body.data.results.map((r: { status: string }) => r.status)).toEqual([
        'located',
        'failed',
        'noGps',
      ]);
    });

    it('returns results in the order the keys were sent', async () => {
      givenPhoto('a.jpg', buildJpegWithoutGps());
      givenPhoto('b.jpg', buildGeotaggedJpeg(AUCKLAND));
      givenPhoto('c.jpg', buildJpegWithoutGps());

      const res = await scan({ photoKeys: ['c.jpg', 'a.jpg', 'b.jpg'] }, await adminCookie());
      const body = await res.json();

      expect(body.data.results.map((r: { photoKey: string }) => r.photoKey)).toEqual([
        'c.jpg',
        'a.jpg',
        'b.jpg',
      ]);
    });
  });
});
