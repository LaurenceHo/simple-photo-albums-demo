import { beforeEach, describe, expect, it, vi } from 'vitest';
import app from '../../src/index';
import { MAX_GPX_LENGTH } from '../../src/types/gps-track';
import { signJwt } from '../../src/utils/jwt';

const JWT_SECRET = 'test-secret';
const ALBUM = 'demo-album';
const BASE = `/api/albums/${ALBUM}/gps-tracks`;

const env = {
  DB: {},
  JWT_SECRET,
  R2_BUCKET_NAME: 'test-bucket',
};

/** Mutable fixtures the mocked services read, reset in beforeEach. */
const state = vi.hoisted(() => ({
  album: null as Record<string, unknown> | null,
  tracks: [] as Record<string, unknown>[],
  track: null as Record<string, unknown> | null,
  exists: false,
  count: 0,
  putThrows: null as Error | null,
  deleteResult: true,
  putCalls: [] as unknown[][],
  deleteCalls: [] as unknown[][],
}));

vi.mock('../../src/services/album-service', () => ({
  default: class {
    async getById() {
      return state.album;
    }
  },
}));

vi.mock('../../src/services/gps-track-service', async (importOriginal) => {
  // The real InvalidTrackKeyError and MAX_TRACKS_PER_ALBUM, so the controller's
  // `instanceof` check and its cap comparison are the production ones.
  const original =
    await importOriginal<typeof import('../../src/services/gps-track-service')>();

  return {
    ...original,
    default: class {
      async listTracks() {
        return state.tracks;
      }
      async getTrack() {
        return state.track;
      }
      async hasTrack() {
        return state.exists;
      }
      async countTracks() {
        return state.count;
      }
      async putTrack(...args: unknown[]) {
        state.putCalls.push(args);
        if (state.putThrows) throw state.putThrows;
        return { type: 'Feature', properties: { distanceKm: 1 }, geometry: {} };
      }
      async deleteTrack(...args: unknown[]) {
        state.deleteCalls.push(args);
        return state.deleteResult;
      }
    },
  };
});

vi.mock('../../src/utils/helpers', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../src/utils/helpers')>();
  return { ...original, buildR2Config: () => ({}) };
});

const adminCookie = async () =>
  `jwt=${await signJwt({ uid: '1', role: 'admin', email: 'admin@example.com' }, JWT_SECRET)}`;

const viewerCookie = async () =>
  `jwt=${await signJwt({ uid: '2', role: 'viewer', email: 'viewer@example.com' }, JWT_SECRET)}`;

const postTrack = async (body: unknown, cookie?: string) =>
  app.request(
    BASE,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
      body: JSON.stringify(body),
    },
    env,
  );

describe('GPS track routes', () => {
  beforeEach(() => {
    state.album = { id: ALBUM, year: '2026', albumName: 'Demo', isUnlisted: false };
    state.tracks = [];
    state.track = null;
    state.exists = false;
    state.count = 0;
    state.putThrows = null;
    state.deleteResult = true;
    state.putCalls = [];
    state.deleteCalls = [];
  });

  describe('GET the manifest', () => {
    it('returns an empty array for an album with no tracks, not a 404', async () => {
      const res = await app.request(BASE, {}, env);

      expect(res.status).toBe(200);
      expect((await res.json()).data).toEqual([]);
    });

    it('returns the album tracks', async () => {
      state.tracks = [{ trackId: 'day-1', colour: '#0072B2', size: 10, lastModified: 'x' }];

      const res = await app.request(BASE, {}, env);

      expect((await res.json()).data).toHaveLength(1);
    });

    it('404s for an album that does not exist', async () => {
      state.album = null;

      const res = await app.request(BASE, {}, env);

      expect(res.status).toBe(404);
    });
  });

  describe('GET one track', () => {
    it('returns the stored feature', async () => {
      state.track = { type: 'Feature', properties: {}, geometry: { type: 'LineString' } };

      const res = await app.request(`${BASE}/day-1`, {}, env);

      expect(res.status).toBe(200);
      expect((await res.json()).data.type).toBe('Feature');
    });

    it('404s when the album has no such track', async () => {
      state.track = null;

      const res = await app.request(`${BASE}/missing`, {}, env);

      expect(res.status).toBe(404);
    });
  });

  describe('unlisted albums', () => {
    beforeEach(() => {
      state.album = { id: ALBUM, year: '2026', albumName: 'Demo', isUnlisted: true };
      state.tracks = [{ trackId: 'day-1', colour: '#0072B2', size: 10, lastModified: 'x' }];
    });

    it.each([
      ['the manifest', BASE],
      ['one track', `${BASE}/day-1`],
    ])('401s on %s without a JWT', async (_label, path) => {
      const res = await app.request(path, {}, env);

      expect(res.status).toBe(401);
    });

    it('403s for a signed-in non-admin', async () => {
      const res = await app.request(BASE, { headers: { Cookie: await viewerCookie() } }, env);

      expect(res.status).toBe(403);
    });

    it('allows an admin', async () => {
      const res = await app.request(BASE, { headers: { Cookie: await adminCookie() } }, env);

      expect(res.status).toBe(200);
    });
  });

  describe('POST a track', () => {
    it('stores the track and reports it as an upload', async () => {
      const res = await postTrack({ trackId: 'day-1', gpx: '<gpx/>' }, await adminCookie());
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body.message).toBe('Track uploaded');
      expect(state.putCalls[0]).toEqual([ALBUM, 'day-1', '<gpx/>']);
    });

    it('reports an existing trackId as a replacement', async () => {
      state.exists = true;

      const res = await postTrack({ trackId: 'day-1', gpx: '<gpx/>' }, await adminCookie());

      expect((await res.json()).message).toBe('Track replaced');
    });

    it('401s without a JWT', async () => {
      const res = await postTrack({ trackId: 'day-1', gpx: '<gpx/>' });

      expect(res.status).toBe(401);
    });

    /**
     * The schema's `MAX_GPX_LENGTH` only runs once Hono has buffered and JSON-parsed the
     * whole body, so a 100 MB upload was fully materialised in the Worker before anything
     * rejected it. `bodyLimit` sits ahead of `zValidator` to stop that.
     */
    it('413s on an oversize body without parsing or storing it', async () => {
      const res = await postTrack({
        trackId: 'day-1',
        gpx: 'x'.repeat(2 * MAX_GPX_LENGTH + 1024),
      }, await adminCookie());

      expect(res.status).toBe(413);
      expect(state.putCalls).toHaveLength(0);
    });

    it('lets a body under the transport limit through to the schema', async () => {
      // Over what the schema allows but under the transport cap, so this must come back as
      // Zod's 400 rather than the middleware's 413 - proving the two limits are ordered,
      // and that the middleware is not simply rejecting everything.
      const res = await postTrack({
        trackId: 'day-1',
        gpx: 'x'.repeat(MAX_GPX_LENGTH + 1024),
      }, await adminCookie());

      expect(res.status).toBe(400);
      expect(state.putCalls).toHaveLength(0);
    });

    it('403s for a signed-in non-admin', async () => {
      const res = await postTrack({ trackId: 'day-1', gpx: '<gpx/>' }, await viewerCookie());

      expect(res.status).toBe(403);
      expect(state.putCalls).toHaveLength(0);
    });

    it.each([
      ['a missing trackId', { gpx: '<gpx/>' }],
      ['an empty gpx', { trackId: 'day-1', gpx: '' }],
      ['a traversing trackId', { trackId: '../escape', gpx: '<gpx/>' }],
    ])('400s on %s', async (_label, body) => {
      const res = await postTrack(body, await adminCookie());

      expect(res.status).toBe(400);
      expect(state.putCalls).toHaveLength(0);
    });

    it('400s with the parser message when the GPX is unusable', async () => {
      const { GpxParseError } = await import('../../src/utils/gpx');
      state.putThrows = new GpxParseError('The GPX file contains no track points');

      const res = await postTrack({ trackId: 'day-1', gpx: '<gpx/>' }, await adminCookie());

      expect(res.status).toBe(400);
      expect((await res.json()).message).toMatch(/no track points/);
    });

    describe('the 20-track cap', () => {
      it('409s when creating a new track at the cap', async () => {
        const { MAX_TRACKS_PER_ALBUM } = await import('../../src/services/gps-track-service');
        state.exists = false;
        state.count = MAX_TRACKS_PER_ALBUM;

        const res = await postTrack({ trackId: 'day-21', gpx: '<gpx/>' }, await adminCookie());

        expect(res.status).toBe(409);
        expect(state.putCalls).toHaveLength(0);
      });

      it('still allows replacing an existing track at the cap', async () => {
        const { MAX_TRACKS_PER_ALBUM } = await import('../../src/services/gps-track-service');
        state.exists = true;
        state.count = MAX_TRACKS_PER_ALBUM;

        const res = await postTrack({ trackId: 'day-1', gpx: '<gpx/>' }, await adminCookie());

        expect(res.status).toBe(200);
        expect(state.putCalls).toHaveLength(1);
      });
    });
  });

  describe('DELETE a track', () => {
    const del = async (trackId: string, cookie?: string) =>
      app.request(
        `${BASE}/${trackId}`,
        { method: 'DELETE', headers: cookie ? { Cookie: cookie } : {} },
        env,
      );

    it('deletes an existing track', async () => {
      state.exists = true;

      const res = await del('day-1', await adminCookie());

      expect(res.status).toBe(200);
      expect(state.deleteCalls[0]).toEqual([ALBUM, 'day-1']);
    });

    it('404s for a track that is not there, rather than reporting a no-op success', async () => {
      state.exists = false;

      const res = await del('missing', await adminCookie());

      expect(res.status).toBe(404);
      expect(state.deleteCalls).toHaveLength(0);
    });

    it('401s without a JWT', async () => {
      expect((await del('day-1')).status).toBe(401);
    });

    it('403s for a signed-in non-admin', async () => {
      state.exists = true;

      const res = await del('day-1', await viewerCookie());

      expect(res.status).toBe(403);
      expect(state.deleteCalls).toHaveLength(0);
    });

    it('500s when the delete itself fails', async () => {
      state.exists = true;
      state.deleteResult = false;

      const res = await del('day-1', await adminCookie());

      expect(res.status).toBe(500);
    });

    it('leaves the album other tracks alone', async () => {
      state.exists = true;

      await del('day-1', await adminCookie());

      expect(state.deleteCalls).toEqual([[ALBUM, 'day-1']]);
    });
  });
});
