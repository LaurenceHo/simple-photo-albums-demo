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

  // Regression guard for the unauthenticated-billing hole: this endpoint proxies Mapbox
  // Search on the server's own API key, so an anonymous caller could previously run up
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

  // Mapbox's own docs claim `q` is capped at 256 characters; live probing of the real
  // endpoint found the true limit is 200 - the API's own error names it: "Query exceeded
  // character limit of 200". 201 is therefore the correct rejected boundary, not 257.
  it('should return 400 when textQuery exceeds 200 characters', async () => {
    const overLimitQuery = 'a'.repeat(201);

    const response = await app.request(`/api/location/search?textQuery=${overLimitQuery}`, {}, env);

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.success).toBe(false);
    expect(mockGetLocation).not.toHaveBeenCalled();
  });

  // Pins the accepted side of the boundary: without this, a much stricter max (e.g. 50)
  // would still pass the suite as long as the 201-character case above kept failing.
  it('should accept a textQuery exactly 200 characters long', async () => {
    const atLimitQuery = 'a'.repeat(200);
    mockGetLocation.mockResolvedValue({});

    const response = await app.request(`/api/location/search?textQuery=${atLimitQuery}`, {}, env);

    expect(response.status).toBe(200);
    expect(mockGetLocation).toHaveBeenCalledWith(undefined, atLimitQuery, undefined);
  });

  it('should map a Mapbox feature onto the Place DTO', async () => {
    mockGetLocation.mockResolvedValue({
      features: [
        {
          properties: {
            name: 'Auckland',
            full_address: 'Auckland, New Zealand',
            place_formatted: 'New Zealand',
            coordinates: { longitude: 174.7644881, latitude: -36.8508827 },
            context: { country: { name: 'New Zealand', country_code: 'NZ' } },
          },
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
          location: { latitude: -36.8508827, longitude: 174.7644881 },
          country: 'NZ',
        },
      ],
    });
  });

  // Sydney is used deliberately: latitude -33.85 and longitude 151.21 are wildly
  // different numbers in different hemispheres, so a lat/lng transposition cannot pass
  // this test. `properties.coordinates` is a named object, but the sibling
  // `geometry.coordinates` is a [longitude, latitude] array - reading that one and
  // assuming [lat, lng] is the classic silent bug in this migration.
  //
  // This fixture is also the POI-mapping case: the Opera House is exactly the result
  // Geocoding v6 could not return, which is why Search Box was chosen. The Zod schema
  // deliberately omits `feature_type` - nothing branches on it, so parsing it would be
  // dead weight.
  //
  // `full_address` below ('Bennelong Point, Sydney NSW 2000, Australia') is synthetic,
  // chosen only for coordinates that make a lat/lng transposition impossible to miss - it
  // is not a claim about what Mapbox actually returns for this query. Live Mapbox returns
  // the much terser 'Sydney 2000, Australia' (design spec §5.7). Do not "fix" this fixture
  // to match that - reconcile the other way if the two are ever compared.
  it('should not transpose latitude and longitude', async () => {
    mockGetLocation.mockResolvedValue({
      features: [
        {
          properties: {
            name: 'Sydney Opera House',
            full_address: 'Bennelong Point, Sydney NSW 2000, Australia',
            coordinates: { longitude: 151.2153, latitude: -33.8568 },
            context: { country: { country_code: 'AU' } },
          },
        },
      ],
    });

    const response = await app.request('/api/location/search?textQuery=opera', {}, env);
    const body = await response.json();

    expect(body.data[0].location.latitude).toBe(-33.8568);
    expect(body.data[0].location.longitude).toBe(151.2153);
  });

  it('should fall back to place_formatted then name for formattedAddress', async () => {
    mockGetLocation.mockResolvedValue({
      features: [
        {
          properties: {
            name: 'Somewhere',
            place_formatted: 'Otago, New Zealand',
            coordinates: { longitude: 170.1, latitude: -43.6 },
          },
        },
        {
          properties: {
            name: 'Unnamed Peak',
            coordinates: { longitude: 170.2, latitude: -43.7 },
          },
        },
      ],
    });

    const response = await app.request('/api/location/search?textQuery=peak', {}, env);
    const body = await response.json();

    expect(body.data[0].formattedAddress).toBe('Otago, New Zealand');
    // `PlaceSchema.formattedAddress` is `.min(1)`, so the chain must never yield ''.
    expect(body.data[1].formattedAddress).toBe('Unnamed Peak');
  });

  // Mapbox can send `full_address` as an empty string rather than omitting it, and `??`
  // only falls through on null/undefined - `||` is required so this counts as absent too.
  it('should treat an empty full_address as absent and fall back to place_formatted', async () => {
    mockGetLocation.mockResolvedValue({
      features: [
        {
          properties: {
            name: 'Somewhere',
            full_address: '',
            place_formatted: 'Otago, New Zealand',
            coordinates: { longitude: 170.1, latitude: -43.6 },
          },
        },
      ],
    });

    const response = await app.request('/api/location/search?textQuery=somewhere', {}, env);
    const body = await response.json();

    expect(body.data[0].formattedAddress).toBe('Otago, New Zealand');
  });

  // A nameless suggestion is useless in a dropdown, and `PlaceSchema.displayName` is
  // `.min(1)` - an empty `name` must be filtered out before mapping, not passed through
  // to fail Zod validation later (an opaque 400 on album save, not a dropdown error).
  it('should exclude a feature whose name is empty', async () => {
    mockGetLocation.mockResolvedValue({
      features: [
        {
          properties: {
            name: '',
            full_address: 'Somewhere, New Zealand',
            coordinates: { longitude: 170.1, latitude: -43.6 },
          },
        },
        {
          properties: {
            name: 'Valid Place',
            coordinates: { longitude: 170.2, latitude: -43.7 },
          },
        },
      ],
    });

    const response = await app.request('/api/location/search?textQuery=somewhere', {}, env);
    const body = await response.json();

    expect(body.data).toHaveLength(1);
    expect(body.data[0].displayName).toBe('Valid Place');
  });

  it('should omit country when context is absent, without throwing', async () => {
    mockGetLocation.mockResolvedValue({
      features: [
        {
          properties: {
            name: 'Unnamed Peak',
            coordinates: { longitude: 170.2, latitude: -43.7 },
          },
        },
      ],
    });

    const response = await app.request('/api/location/search?textQuery=peak', {}, env);

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.data[0].country).toBeUndefined();
  });

  // `extractCountry` in ui/src/stores/travel-records.ts puts this value into a Set to
  // count distinct countries visited, and existing D1 rows hold Google's uppercase
  // `shortText` ('NZ'). A lowercase code from Mapbox would double-count silently.
  it('should upper-case the country code', async () => {
    mockGetLocation.mockResolvedValue({
      features: [
        {
          properties: {
            name: 'Auckland',
            full_address: 'Auckland, New Zealand',
            coordinates: { longitude: 174.7644881, latitude: -36.8508827 },
            context: { country: { country_code: 'nz' } },
          },
        },
      ],
    });

    const response = await app.request('/api/location/search?textQuery=auckland', {}, env);
    const body = await response.json();

    expect(body.data[0].country).toBe('NZ');
  });

  it('should return an empty list when Mapbox returns no features', async () => {
    mockGetLocation.mockResolvedValue({});

    const response = await app.request('/api/location/search?textQuery=nowhere', {}, env);

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.data).toEqual([]);
  });

  it('should forward SEARCH_PROXIMITY from the environment to getLocation', async () => {
    mockGetLocation.mockResolvedValue({});

    const envWithProximity = { ...env, SEARCH_PROXIMITY: '174.7633,-36.8485' };
    await app.request('/api/location/search?textQuery=auckland', {}, envWithProximity);

    // Asserts the third argument directly rather than the full call, so this doesn't
    // couple to the first argument's value - the shared `env` fixture has no
    // MAPBOXAPI_KEY, but that's incidental to what this test verifies.
    expect(mockGetLocation).toHaveBeenCalledTimes(1);
    expect(mockGetLocation.mock.calls[0]?.[2]).toBe('174.7633,-36.8485');
  });

  it('should return 500 when location service throws', async () => {
    mockGetLocation.mockRejectedValue(new Error('Mapbox Search API returned 403'));

    const response = await app.request('/api/location/search?textQuery=somewhere', {}, env);

    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body.code).toBe(500);
    expect(body.message).toBe('Failed to fetch location data');
  });

  it('should return 500 when API key is missing', async () => {
    mockGetLocation.mockRejectedValue(new Error('MAPBOXAPI_KEY is not configured'));

    const response = await app.request('/api/location/search?textQuery=somewhere', {}, env);

    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body.code).toBe(500);
    expect(body.message).toBe('Failed to fetch location data');
  });

  // The service never constructs a message containing the request URL, but a runtime
  // `fetch` error is not under our control and could embed one - and the Mapbox access
  // token is a query parameter, so an unredacted log would leak it into Worker logs
  // (retained at 100% per wrangler.ci.toml). Spied locally, not suite-wide, and restored
  // at the end so it doesn't silence console.error for later tests in this file.
  it('should redact the access token from a logged error message without breaking the response', async () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      mockGetLocation.mockRejectedValue(
        new Error(
          'fetch failed for https://api.mapbox.com/search/searchbox/v1/forward?q=x&access_token=secret-value&limit=10',
        ),
      );

      const response = await app.request('/api/location/search?textQuery=somewhere', {}, env);

      expect(response.status).toBe(500);
      const body = await response.json();
      expect(body.code).toBe(500);
      expect(body.message).toBe('Failed to fetch location data');

      const loggedMessage = String(consoleErrorSpy.mock.calls[0]?.[0]);
      expect(loggedMessage).not.toContain('secret-value');
      expect(loggedMessage).toContain('access_token=REDACTED');
      // Only the token value must be stripped - a regex that greedily consumes the rest
      // of the string would also pass the two assertions above.
      expect(loggedMessage).toContain('&limit=10');
    } finally {
      consoleErrorSpy.mockRestore();
    }
  });
});
