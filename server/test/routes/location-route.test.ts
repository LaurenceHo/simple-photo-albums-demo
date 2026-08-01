import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import app from '../../src/index';

const mockGetLocation = vi.fn();

vi.mock('../../src/services/location-service', () => ({
  getLocation: (...args: any[]) => mockGetLocation(...args),
}));

/**
 * Toggles whether the mocked `verifyJwtClaim` admits the request, so the same suite can
 * cover both the authorised behaviour and the rejection of anonymous callers.
 */
let mockIsAuthenticated = true;

vi.mock('../../src/routes/auth-middleware', async () => {
  const { createMiddleware } = await import('hono/factory');
  return {
    verifyOrigin: createMiddleware(async (c, next) => await next()),
    clearJwtCookie: () => {},
    verifyJwtClaim: createMiddleware(async (c, next) => {
      if (!mockIsAuthenticated) {
        return c.json({ message: 'Authentication failed. Please login.' }, 401);
      }
      c.set('user', { role: 'admin', email: 'admin@test.com' });
      await next();
    }),
    verifyUserPermission: createMiddleware(async (c, next) => await next()),
    optionalVerifyJwtClaim: createMiddleware(async (c, next) => await next()),
  };
});

const env = {
  DB: {},
};

describe('location route', () => {
  beforeEach(() => {
    mockIsAuthenticated = true;
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  // Regression guard for the unauthenticated-billing hole: this endpoint proxies Google
  // Places on the server's own API key, so an anonymous caller could previously run up
  // an unbounded bill.
  it('should return 401 when the caller is not authenticated', async () => {
    mockIsAuthenticated = false;

    const response = await app.request('/api/location/search?textQuery=somewhere', {}, env);

    expect(response.status).toBe(401);
    expect(mockGetLocation).not.toHaveBeenCalled();
  });

  it('should return 400 when textQuery is missing', async () => {
    const response = await app.request('/api/location/search', {}, env);
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.success).toBe(false);
  });

  it('should return 400 when textQuery is whitespace only', async () => {
    const response = await app.request('/api/location/search?textQuery=%20%20', {}, env);
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.code).toBe(400);
    expect(body.message).toBe('textQuery parameter is required');
  });

  it('should return correct location', async () => {
    mockGetLocation.mockResolvedValue({
      places: [
        {
          formattedAddress: 'Auckland, New Zealand',
          location: { latitude: -36.85088270000001, longitude: 174.7644881 },
          displayName: { text: 'Auckland', languageCode: 'en' },
        },
      ],
    });

    const response = await app.request('/api/location/search?textQuery=somewhere', {}, env);

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({
      code: 200,
      status: 'Success',
      message: 'ok',
      data: [
        {
          displayName: 'Auckland',
          formattedAddress: 'Auckland, New Zealand',
          location: { latitude: -36.85088270000001, longitude: 174.7644881 },
        },
      ],
    });
  });

  it('should return 500 when location service throws', async () => {
    mockGetLocation.mockRejectedValue(new Error('Google Places API returned 403'));

    const response = await app.request('/api/location/search?textQuery=somewhere', {}, env);

    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body.code).toBe(500);
    expect(body.message).toBe('Failed to fetch location data');
  });

  it('should return 500 when API key is missing', async () => {
    mockGetLocation.mockRejectedValue(new Error('GOOGLE_PLACES_API_KEY is not configured'));

    const response = await app.request('/api/location/search?textQuery=somewhere', {}, env);

    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body.code).toBe(500);
    expect(body.message).toBe('Failed to fetch location data');
  });
});
