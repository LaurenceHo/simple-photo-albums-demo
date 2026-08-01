import { describe, expect, it, vi } from 'vitest';
import app from '../../src/index';
import { mockAlbumList, mockSignedCookies } from '../mock-data';

const helperMock = vi.hoisted(() => ({
  verifyIfIsAdmin: vi.fn(() => true),
}));

/** Records the `includeUnlisted` argument the controller passes to the service. */
const featuredAlbumsSpy = vi.hoisted(() => vi.fn());

vi.mock('../../src/services/aggregation-service', async () => {
  const { mockAlbumList } = await import('../mock-data');

  return {
    default: class {
      constructor(db: any) {}
      async getAlbumsWithLocation(isAdmin: boolean) {
        return mockAlbumList;
      }
      async getCountAlbumsByYear(includeUnlisted: boolean) {
        if (includeUnlisted) {
          return [
            { year: '2018', count: 1 },
            { year: '2019', count: 11 },
            { year: '2020', count: 10 },
            { year: '2021', count: 20 },
          ];
        } else {
          return [
            { year: '2020', count: 10 },
            { year: '2021', count: 20 },
          ];
        }
      }
      async getFeaturedAlbums(includeUnlisted: boolean) {
        featuredAlbumsSpy(includeUnlisted);
        return [];
      }
    },
  };
});

vi.mock('../../src/controllers/helpers', () => ({
  verifyIfIsAdmin: () => helperMock.verifyIfIsAdmin,
}));

// Mock env with DB and JWT_SECRET
const env = {
  DB: {},
  JWT_SECRET: 'test-secret',
};

// Set process.env.JWT_SECRET for mockSignedCookies
process.env.JWT_SECRET = 'test-secret';

describe("aggregate route when it's admin", () => {
  it('should return album list', async () => {
    const token = await mockSignedCookies();
    const response = await app.request(
      '/api/aggregate/albums-with-location',
      {
        headers: {
          Cookie: `jwt=${token}`,
        },
      },
      env,
    );
    const body = await response.json();
    expect(body).toEqual({
      code: 200,
      status: 'Success',
      message: 'ok',
      data: mockAlbumList,
    });
    expect(response.status).toBe(200);
  });

  it('should return count albums include unlisted album', async () => {
    const token = await mockSignedCookies();
    const response = await app.request(
      '/api/aggregate/count-albums-by-year',
      {
        headers: {
          Cookie: `jwt=${token}`,
        },
      },
      env,
    );
    const body = await response.json();
    expect(body).toEqual({
      code: 200,
      status: 'Success',
      message: 'ok',
      data: [
        { year: '2018', count: 1 },
        { year: '2019', count: 11 },
        { year: '2020', count: 10 },
        { year: '2021', count: 20 },
      ],
    });
    expect(response.status).toBe(200);
  });

  it('should return 400 bad request', async () => {
    const response = await app.request('/api/aggregate/invalidType', {}, env);
    expect(response.status).toBe(400);
  });

  // Guards the controller wiring, which is where the leak actually was: the service
  // gained an includeUnlisted parameter but the controller never passed one, so every
  // caller - signed in or not - received unlisted featured albums.
  it('should ask for unlisted featured albums when the caller is an admin', async () => {
    featuredAlbumsSpy.mockClear();
    const token = await mockSignedCookies();

    await app.request(
      '/api/aggregate/featured-albums',
      { headers: { Cookie: `jwt=${token}` } },
      env,
    );

    expect(featuredAlbumsSpy).toHaveBeenCalledWith(true);
  });

  it('should exclude unlisted featured albums for an anonymous caller', async () => {
    featuredAlbumsSpy.mockClear();

    await app.request('/api/aggregate/featured-albums', {}, env);

    expect(featuredAlbumsSpy).toHaveBeenCalledWith(false);
  });
});
