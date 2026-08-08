import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getLocation } from '../../src/services/location-service';

const TEST_API_KEY = 'pk.test-token';

/** A minimal well-formed Search Box `/forward` payload. */
const mockSearchBoxResponse = {
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
};

/** Returns the URL string `fetch` was called with on its first invocation. */
const firstFetchUrl = (): string => String(vi.mocked(fetch).mock.calls[0]?.[0]);

describe('getLocation', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should call the Search Box forward endpoint with the expected query params', async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(mockSearchBoxResponse),
    } as Response);

    await getLocation(TEST_API_KEY, 'Auckland');

    const url = new URL(firstFetchUrl());
    expect(url.origin + url.pathname).toBe('https://api.mapbox.com/search/searchbox/v1/forward');
    expect(url.searchParams.get('q')).toBe('Auckland');
    expect(url.searchParams.get('access_token')).toBe(TEST_API_KEY);
    expect(url.searchParams.get('language')).toBe('en');
    expect(url.searchParams.get('limit')).toBe('10');
    // The caller is a typeahead sending partial strings, and Mapbox does not document
    // this parameter's default - so it is set explicitly and asserted here.
    expect(url.searchParams.get('auto_complete')).toBe('true');
  });

  it('should return the parsed response', async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(mockSearchBoxResponse),
    } as Response);

    const result = await getLocation(TEST_API_KEY, 'Auckland');

    expect(result).toEqual(mockSearchBoxResponse);
  });

  it('should throw when MAPBOXAPI_KEY is not configured, without calling fetch', async () => {
    await expect(getLocation('', 'Auckland')).rejects.toThrow('MAPBOXAPI_KEY is not configured');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('should throw for various non-ok status codes', async () => {
    for (const status of [400, 401, 404, 429, 500, 503]) {
      vi.mocked(fetch).mockResolvedValue({ ok: false, status } as Response);

      await expect(getLocation(TEST_API_KEY, 'test')).rejects.toThrow(
        `Mapbox Search API returned ${status}`,
      );
    }
  });

  it('should pass an AbortSignal to fetch', async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(mockSearchBoxResponse),
    } as Response);

    await getLocation(TEST_API_KEY, 'Auckland');

    const options = vi.mocked(fetch).mock.calls[0]?.[1] as RequestInit;
    expect(options.signal).toBeInstanceOf(AbortSignal);
  });

  it('should url-encode a query containing spaces and ampersands', async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(mockSearchBoxResponse),
    } as Response);

    await getLocation(TEST_API_KEY, 'Marks & Spencer, High St');

    const raw = firstFetchUrl();
    expect(raw).not.toContain('Marks & Spencer');
    expect(new URL(raw).searchParams.get('q')).toBe('Marks & Spencer, High St');
  });

  it('should throw a Zod error for an unexpected response shape', async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ features: [{ properties: { unexpected: true } }] }),
    } as Response);

    await expect(getLocation(TEST_API_KEY, 'Auckland')).rejects.toThrow();
  });

  it('should accept an empty features array', async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ features: [] }),
    } as Response);

    const result = await getLocation(TEST_API_KEY, 'Auckland');

    expect(result.features).toEqual([]);
  });

  it('should accept a response with no features field', async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({}),
    } as Response);

    const result = await getLocation(TEST_API_KEY, 'Auckland');

    expect(result.features).toBeUndefined();
  });

  it('should accept a feature carrying neither full_address nor place_formatted', async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          features: [
            {
              properties: {
                name: 'Unnamed Peak',
                coordinates: { longitude: 170.1, latitude: -43.6 },
              },
            },
          ],
        }),
    } as Response);

    const result = await getLocation(TEST_API_KEY, 'Unnamed Peak');

    expect(result.features?.[0]?.properties.full_address).toBeUndefined();
    expect(result.features?.[0]?.properties.context).toBeUndefined();
  });

  it('should omit the proximity param when the argument is undefined', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(mockSearchBoxResponse),
    } as Response);

    await getLocation(TEST_API_KEY, 'Auckland');

    const url = new URL(firstFetchUrl());
    expect(url.searchParams.has('proximity')).toBe(false);
    // Absence is a normal, supported configuration - it must not be logged as invalid.
    expect(console.error).not.toHaveBeenCalled();
  });

  it('should omit the proximity param when the argument is an empty string', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(mockSearchBoxResponse),
    } as Response);

    await getLocation(TEST_API_KEY, 'Auckland', '');

    const url = new URL(firstFetchUrl());
    expect(url.searchParams.has('proximity')).toBe(false);
    expect(console.error).not.toHaveBeenCalled();
  });

  it('should set proximity to a valid "lon,lat" value', async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(mockSearchBoxResponse),
    } as Response);

    await getLocation(TEST_API_KEY, 'Auckland', '174.7633,-36.8485');

    const url = new URL(firstFetchUrl());
    expect(url.searchParams.get('proximity')).toBe('174.7633,-36.8485');
  });

  it('should forward a very small coordinate verbatim rather than as exponential notation', async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(mockSearchBoxResponse),
    } as Response);

    await getLocation(TEST_API_KEY, 'Auckland', '0.0000001,0.0000001');

    const url = new URL(firstFetchUrl());
    // Number('0.0000001') stringifies as '1e-7' - the output must be built from the
    // regex's own captured digit strings, not from round-tripping through Number(),
    // or this would reach Mapbox as '1e-7,1e-7' instead.
    expect(url.searchParams.get('proximity')).toBe('0.0000001,0.0000001');
  });

  it('should accept the literal "ip" for proximity', async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(mockSearchBoxResponse),
    } as Response);

    await getLocation(TEST_API_KEY, 'Auckland', 'ip');

    const url = new URL(firstFetchUrl());
    expect(url.searchParams.get('proximity')).toBe('ip');
  });

  it('should trim whitespace from the proximity value before validating and using it', async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(mockSearchBoxResponse),
    } as Response);

    await getLocation(TEST_API_KEY, 'Auckland', '\n174.7633,-36.8485 ');

    const url = new URL(firstFetchUrl());
    expect(url.searchParams.get('proximity')).toBe('174.7633,-36.8485');
  });

  it('should accept proximity at the longitude/latitude upper boundary', async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(mockSearchBoxResponse),
    } as Response);

    await getLocation(TEST_API_KEY, 'Auckland', '180,90');

    const url = new URL(firstFetchUrl());
    expect(url.searchParams.get('proximity')).toBe('180,90');
  });

  it('should accept proximity at the longitude/latitude lower boundary', async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(mockSearchBoxResponse),
    } as Response);

    await getLocation(TEST_API_KEY, 'Auckland', '-180,-90');

    const url = new URL(firstFetchUrl());
    expect(url.searchParams.get('proximity')).toBe('-180,-90');
  });

  it('should reject a longitude just past the upper boundary', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(mockSearchBoxResponse),
    } as Response);

    await getLocation(TEST_API_KEY, 'Auckland', '180.1,0');

    const url = new URL(firstFetchUrl());
    expect(url.searchParams.has('proximity')).toBe(false);
  });

  it('should reject a latitude just past the lower boundary', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(mockSearchBoxResponse),
    } as Response);

    await getLocation(TEST_API_KEY, 'Auckland', '0,-90.1');

    const url = new URL(firstFetchUrl());
    expect(url.searchParams.has('proximity')).toBe(false);
  });

  it('should accept a "lon,lat" value with a space after the comma', async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(mockSearchBoxResponse),
    } as Response);

    await getLocation(TEST_API_KEY, 'Auckland', '174.7633, -36.8485');

    const url = new URL(firstFetchUrl());
    expect(url.searchParams.get('proximity')).toBe('174.7633,-36.8485');
  });

  it('should accept a "lon,lat" value with whitespace around both the pair and the comma', async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(mockSearchBoxResponse),
    } as Response);

    await getLocation(TEST_API_KEY, 'Auckland', ' 174.7633 , -36.8485 ');

    const url = new URL(firstFetchUrl());
    expect(url.searchParams.get('proximity')).toBe('174.7633,-36.8485');
  });

  it('should omit a malformed proximity value and still perform the search', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(mockSearchBoxResponse),
    } as Response);

    await getLocation(TEST_API_KEY, 'Auckland', 'not-a-coord');

    const url = new URL(firstFetchUrl());
    expect(url.searchParams.has('proximity')).toBe(false);
    expect(fetch).toHaveBeenCalled();
    // The invalid value must never reach the log line - only the variable name and reason do.
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('SEARCH_PROXIMITY'));
    expect(console.error).not.toHaveBeenCalledWith(expect.stringContaining('not-a-coord'));
  });

  it('should omit an out-of-range proximity value and still perform the search', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(mockSearchBoxResponse),
    } as Response);

    await getLocation(TEST_API_KEY, 'Auckland', '999,999');

    const url = new URL(firstFetchUrl());
    expect(url.searchParams.has('proximity')).toBe(false);
    expect(fetch).toHaveBeenCalled();
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('SEARCH_PROXIMITY'));
    expect(console.error).not.toHaveBeenCalledWith(expect.stringContaining('999,999'));
  });
});
