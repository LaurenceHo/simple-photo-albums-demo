import { S3Client } from '@aws-sdk/client-s3';
import { mockClient } from 'aws-sdk-client-mock';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import app from '../../src/index';

/**
 * Traversal guard on the track routes, exercised through the **real** `GpsTrackService`.
 *
 * Separate from `gps-track-route.test.ts` because that file mocks the service to control
 * its results, which would also mock away the very guard being checked here. `vi.mock` is
 * file-scoped, so proving this end to end needs its own file.
 *
 * `GET /gps-tracks/:trackId` is the only public endpoint in the app that takes a
 * caller-supplied R2 key segment, so a hole here is reachable without a session.
 */
const r2Mock = mockClient(S3Client);

const ALBUM = 'demo-album';

const env = {
  DB: {},
  JWT_SECRET: 'test-secret',
  R2_BUCKET_NAME: 'test-bucket',
};

vi.mock('../../src/services/album-service', () => ({
  default: class {
    async getById() {
      return { id: ALBUM, year: '2026', albumName: 'Demo', isUnlisted: false };
    }
  },
}));

vi.mock('../../src/utils/helpers', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../src/utils/helpers')>();
  return { ...original, buildR2Config: () => ({}) };
});

describe('GPS track routes - traversal guard', () => {
  beforeEach(() => {
    r2Mock.reset();
  });

  /**
   * Two different mechanisms reject traversal, and they answer with different statuses.
   * Asserting a uniform 400 would be wrong, and would break the moment either layer
   * changed - so each is pinned to the layer that actually handles it.
   */

  it('rejects an encoded path separator in :trackId at the service guard', async () => {
    // `%2F` survives URL normalisation, so this is the case that genuinely reaches the
    // handler with a dangerous segment - and the only one the key guard has to catch.
    const res = await app.request(`/api/albums/${ALBUM}/gps-tracks/a%2Fb`, {}, env);

    expect(res.status).toBe(400);
    expect(r2Mock.calls()).toHaveLength(0);
  });

  it.each([
    ['a parent reference', '%2E%2E'],
    ['a bare dot', '%2E'],
  ])('rejects %s in :trackId before routing', async (_label, encoded) => {
    // `.` and `..` are resolved as path segments during URL normalisation, before Hono
    // routes: `/gps-tracks/..` collapses to `/api/albums/demo-album/`, which matches no
    // route. So these never reach a handler at all - a 404 from the router, not a 400
    // from the guard. Safer than the guard, just answered somewhere else.
    const res = await app.request(`/api/albums/${ALBUM}/gps-tracks/${encoded}`, {}, env);

    expect(res.status).toBe(404);
    expect(r2Mock.calls()).toHaveLength(0);
  });

  it('rejects a traversing albumId before routing', async () => {
    // Collapses to `/api/gps-tracks`, which is not a route.
    const res = await app.request('/api/albums/%2E%2E/gps-tracks', {}, env);

    expect(res.status).toBe(404);
    expect(r2Mock.calls()).toHaveLength(0);
  });

  it('lets a legitimate trackId through to R2', async () => {
    r2Mock.onAnyCommand().rejects({ name: 'NoSuchKey' } as never);

    const res = await app.request(`/api/albums/${ALBUM}/gps-tracks/2026-04-12-day-1`, {}, env);

    // 404, not 400: the id was accepted and the object simply is not there.
    expect(res.status).toBe(404);
    expect(r2Mock.calls().length).toBeGreaterThan(0);
  });
});
