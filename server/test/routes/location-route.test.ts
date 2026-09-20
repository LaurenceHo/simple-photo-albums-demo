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

  // 200 is a defensive bound on an admin typeahead, not a Google limit - see the comment
  // on `LocationSearchSchema`. Without it an over-long query reaches a billed endpoint and
  // surfaces as a generic 500 rather than a 400 at the validation layer.
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
    expect(mockGetLocation).toHaveBeenCalledWith(undefined, atLimitQuery);
  });

  // Pins which binding the controller reads. Every other test here uses the shared `env`
  // fixture, which carries no key - so they assert `undefined` as argument 0 and would pass
  // against a typo'd or stale binding name just as happily. Setting the binding is the only
  // way to catch `c.env.MAPBOXAPI_KEY` surviving a bad merge, which type-checks fine on an
  // optional-shaped read and then 500s on every search in production.
  it('should pass GOOGLE_PLACES_API_KEY from the environment to getLocation', async () => {
    mockGetLocation.mockResolvedValue({});

    const envWithKey = { ...env, GOOGLE_PLACES_API_KEY: 'test-key' };
    await app.request('/api/location/search?textQuery=auckland', {}, envWithKey);

    expect(mockGetLocation).toHaveBeenCalledTimes(1);
    expect(mockGetLocation.mock.calls[0]?.[0]).toBe('test-key');
  });

  it('should map a Places result onto the Place DTO', async () => {
    mockGetLocation.mockResolvedValue({
      places: [
        {
          displayName: { text: 'Auckland', languageCode: 'en' },
          formattedAddress: 'Auckland, New Zealand',
          location: { latitude: -36.8508827, longitude: 174.7644881 },
          addressComponents: [
            { types: ['country', 'political'], shortText: 'NZ', longText: 'New Zealand' },
          ],
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

  // The reason this vendor was restored: Mapbox Search Box had no record of this peak and
  // returned a Korean address for the same query. The mapping must carry a CJK name and a
  // non-Latin address through unaltered.
  it('should map a CJK place name and address without mangling them', async () => {
    mockGetLocation.mockResolvedValue({
      places: [
        {
          displayName: { text: '飛鳳山', languageCode: 'zh-TW' },
          formattedAddress: '307台灣新竹縣芎林鄉飛鳳山',
          location: { latitude: 24.7656671, longitude: 121.112232 },
          addressComponents: [{ types: ['country', 'political'], shortText: 'TW' }],
        },
      ],
    });

    const response = await app.request('/api/location/search?textQuery=x', {}, env);
    const body = await response.json();

    expect(body.data[0].displayName).toBe('飛鳳山');
    expect(body.data[0].formattedAddress).toBe('307台灣新竹縣芎林鄉飛鳳山');
    expect(body.data[0].country).toBe('TW');
  });

  // Sydney is used deliberately: latitude -33.85 and longitude 151.21 are wildly different
  // numbers in different hemispheres, so a lat/lng transposition cannot pass this test.
  // Google returns `location` as a named `{ latitude, longitude }` object, so it is passed
  // through whole - this guards that it stays that way.
  it('should not transpose latitude and longitude', async () => {
    mockGetLocation.mockResolvedValue({
      places: [
        {
          displayName: { text: 'Sydney Opera House' },
          formattedAddress: 'Bennelong Point, Sydney NSW 2000, Australia',
          location: { latitude: -33.8568, longitude: 151.2153 },
          addressComponents: [{ types: ['country'], shortText: 'AU' }],
        },
      ],
    });

    const response = await app.request('/api/location/search?textQuery=opera', {}, env);
    const body = await response.json();

    expect(body.data[0].location.latitude).toBe(-33.8568);
    expect(body.data[0].location.longitude).toBe(151.2153);
  });

  // `PlaceSchema.formattedAddress` is `.min(1)`, so the fallback must never yield ''.
  // Google can send this as an empty string rather than omitting it, and `??` would let
  // that through - the mapper uses `||` for exactly this case.
  it('should fall back to displayName when formattedAddress is empty', async () => {
    mockGetLocation.mockResolvedValue({
      places: [
        {
          displayName: { text: 'Unnamed Peak' },
          formattedAddress: '',
          location: { latitude: -43.7, longitude: 170.2 },
        },
      ],
    });

    const response = await app.request('/api/location/search?textQuery=peak', {}, env);
    const body = await response.json();

    expect(body.data[0].formattedAddress).toBe('Unnamed Peak');
  });

  // A nameless suggestion is useless in a dropdown, and `PlaceSchema.displayName` is
  // `.min(1)` - an empty name must be filtered out before mapping, not passed through to
  // fail Zod validation later (an opaque 400 on album save, not a dropdown error).
  it('should exclude a place whose displayName is blank', async () => {
    mockGetLocation.mockResolvedValue({
      places: [
        {
          displayName: { text: '   ' },
          formattedAddress: 'Somewhere, New Zealand',
          location: { latitude: -43.6, longitude: 170.1 },
        },
        {
          displayName: { text: 'Valid Place' },
          formattedAddress: 'Otago, New Zealand',
          location: { latitude: -43.7, longitude: 170.2 },
        },
      ],
    });

    const response = await app.request('/api/location/search?textQuery=somewhere', {}, env);
    const body = await response.json();

    expect(body.data).toHaveLength(1);
    expect(body.data[0].displayName).toBe('Valid Place');
  });

  it('should omit country when addressComponents is absent, without throwing', async () => {
    mockGetLocation.mockResolvedValue({
      places: [
        {
          displayName: { text: 'Unnamed Peak' },
          formattedAddress: 'Otago, New Zealand',
          location: { latitude: -43.7, longitude: 170.2 },
        },
      ],
    });

    const response = await app.request('/api/location/search?textQuery=peak', {}, env);

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.data[0].country).toBeUndefined();
  });

  // Companion to the service-level regression: live Google returns address components with
  // no `types` key, so the mapper reads it with `?.`. An unguarded `.includes` would throw
  // a TypeError here and turn a perfectly parseable response into a 500 at the mapping
  // step - past Zod, so the service test alone would not catch it.
  it('should not throw when an address component has no types key', async () => {
    mockGetLocation.mockResolvedValue({
      places: [
        {
          displayName: { text: 'Some Cafe' },
          formattedAddress: 'Auckland, New Zealand',
          location: { latitude: -36.85, longitude: 174.76 },
          addressComponents: [{ shortText: 'NZ' }, { types: ['country'], shortText: 'NZ' }],
        },
      ],
    });

    const response = await app.request('/api/location/search?textQuery=cafe', {}, env);

    expect(response.status).toBe(200);
    const body = await response.json();
    // The typeless component is skipped, and the real country component is still found.
    expect(body.data[0].country).toBe('NZ');
  });

  it('should fall back to displayName when formattedAddress is absent entirely', async () => {
    mockGetLocation.mockResolvedValue({
      places: [
        {
          displayName: { text: 'Unnamed Peak' },
          location: { latitude: -43.7, longitude: 170.2 },
        },
      ],
    });

    const response = await app.request('/api/location/search?textQuery=peak', {}, env);

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.data[0].formattedAddress).toBe('Unnamed Peak');
  });

  it('should omit country when no component is of type country', async () => {
    mockGetLocation.mockResolvedValue({
      places: [
        {
          displayName: { text: 'Somewhere' },
          formattedAddress: 'Otago, New Zealand',
          location: { latitude: -43.7, longitude: 170.2 },
          addressComponents: [{ types: ['locality', 'political'], shortText: 'Otago' }],
        },
      ],
    });

    const response = await app.request('/api/location/search?textQuery=somewhere', {}, env);
    const body = await response.json();

    expect(body.data[0].country).toBeUndefined();
  });

  // `extractCountry` in ui/src/stores/travel-records.ts puts this value into a Set to count
  // distinct countries visited, so a casing flip would double-count silently.
  it('should upper-case the country code', async () => {
    mockGetLocation.mockResolvedValue({
      places: [
        {
          displayName: { text: 'Auckland' },
          formattedAddress: 'Auckland, New Zealand',
          location: { latitude: -36.8508827, longitude: 174.7644881 },
          addressComponents: [{ types: ['country'], shortText: 'nz' }],
        },
      ],
    });

    const response = await app.request('/api/location/search?textQuery=auckland', {}, env);
    const body = await response.json();

    expect(body.data[0].country).toBe('NZ');
  });

  it('should return an empty list when Google returns no places', async () => {
    mockGetLocation.mockResolvedValue({});

    const response = await app.request('/api/location/search?textQuery=nowhere', {}, env);

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.data).toEqual([]);
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
