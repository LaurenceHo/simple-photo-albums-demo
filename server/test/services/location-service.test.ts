import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getLocation } from '../../src/services/location-service';

const TEST_API_KEY = 'test-google-places-key';
const SEARCH_TEXT_URL = 'https://places.googleapis.com/v1/places:searchText';

/** A minimal well-formed `places:searchText` payload. */
const mockPlacesResponse = {
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
};

const okResponse = () =>
  ({ ok: true, json: () => Promise.resolve(mockPlacesResponse) }) as Response;

/** The `RequestInit` that `fetch` was called with on its first invocation. */
const firstFetchOptions = (): RequestInit =>
  vi.mocked(fetch).mock.calls[0]?.[1] as RequestInit;

const firstFetchHeaders = (): Record<string, string> =>
  firstFetchOptions().headers as Record<string, string>;

const firstFetchBody = (): {
  textQuery?: string;
  languageCode?: string;
  maxResultCount?: number;
} => JSON.parse(String(firstFetchOptions().body));

describe('getLocation', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should POST to the Places searchText endpoint', async () => {
    vi.mocked(fetch).mockResolvedValue(okResponse());

    await getLocation(TEST_API_KEY, 'Auckland');

    expect(vi.mocked(fetch).mock.calls[0]?.[0]).toBe(SEARCH_TEXT_URL);
    expect(firstFetchOptions().method).toBe('POST');
  });

  it('should send the API key in the X-Goog-Api-Key header', async () => {
    vi.mocked(fetch).mockResolvedValue(okResponse());

    await getLocation(TEST_API_KEY, 'Auckland');

    expect(firstFetchHeaders()['X-Goog-Api-Key']).toBe(TEST_API_KEY);
  });

  // The Worker runs with `head_sampling_rate = 1` and `persist = true`, so a credential in
  // a request URL is retained in account-scoped observability data. Google also accepts
  // `?key=<token>`; this pins the header form so a future "simplification" to the query
  // parameter fails here rather than silently leaking the key into every trace span.
  it('should never put the API key in the request URL', async () => {
    vi.mocked(fetch).mockResolvedValue(okResponse());

    await getLocation(TEST_API_KEY, 'Auckland');

    const calledUrl = String(vi.mocked(fetch).mock.calls[0]?.[0]);
    expect(calledUrl).not.toContain(TEST_API_KEY);
    expect(calledUrl).not.toContain('key=');
    expect(new URL(calledUrl).search).toBe('');
  });

  // The field mask drives billing: all four fields are Text Search Pro SKU, and adding an
  // Enterprise-tier field would re-price every search. It must also stay in step with the
  // Zod schema - a masked field the schema omits is billed and discarded, and a schema
  // field the mask omits arrives undefined and fails parsing.
  it('should request exactly the four Pro-tier fields in the field mask', async () => {
    vi.mocked(fetch).mockResolvedValue(okResponse());

    await getLocation(TEST_API_KEY, 'Auckland');

    const mask = firstFetchHeaders()['X-Goog-FieldMask'].split(',');
    expect(mask).toEqual([
      'places.displayName',
      'places.formattedAddress',
      'places.location',
      'places.addressComponents',
    ]);
  });

  // `maxResultCount` is asserted because Google's default is 20 (also its maximum). The
  // Mapbox implementation carried the same cap as `limit=10`; dropping it silently doubles
  // both the payload and the length of the admin dropdown.
  it('should send the query, language and result cap in the request body', async () => {
    vi.mocked(fetch).mockResolvedValue(okResponse());

    await getLocation(TEST_API_KEY, 'Auckland');

    expect(firstFetchBody()).toEqual({
      textQuery: 'Auckland',
      languageCode: 'en',
      maxResultCount: 10,
    });
  });

  // The query travels in a JSON body, not a query string, so characters that would need
  // URL-encoding must survive verbatim - including CJK, which is the coverage case this
  // vendor was restored for.
  it('should carry punctuation and CJK queries through the body unaltered', async () => {
    vi.mocked(fetch).mockResolvedValue(okResponse());

    await getLocation(TEST_API_KEY, '新竹飛鳳山 & Marks & Spencer, High St');

    expect(firstFetchBody().textQuery).toBe('新竹飛鳳山 & Marks & Spencer, High St');
  });

  it('should return the parsed response', async () => {
    vi.mocked(fetch).mockResolvedValue(okResponse());

    const result = await getLocation(TEST_API_KEY, 'Auckland');

    expect(result).toEqual(mockPlacesResponse);
  });

  it('should throw when GOOGLE_PLACES_API_KEY is not configured, without calling fetch', async () => {
    await expect(getLocation('', 'Auckland')).rejects.toThrow(
      'GOOGLE_PLACES_API_KEY is not configured',
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  it('should throw for various non-ok status codes', async () => {
    for (const status of [400, 401, 403, 404, 429, 500, 503]) {
      vi.mocked(fetch).mockResolvedValue({ ok: false, status } as Response);

      await expect(getLocation(TEST_API_KEY, 'test')).rejects.toThrow(
        `Google Places API returned ${status}`,
      );
    }
  });

  it('should pass an AbortSignal to fetch', async () => {
    vi.mocked(fetch).mockResolvedValue(okResponse());

    await getLocation(TEST_API_KEY, 'Auckland');

    expect(firstFetchOptions().signal).toBeInstanceOf(AbortSignal);
  });

  it('should throw a Zod error for an unexpected response shape', async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ places: [{ unexpected: true }] }),
    } as Response);

    await expect(getLocation(TEST_API_KEY, 'Auckland')).rejects.toThrow();
  });

  it('should accept an empty places array', async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ places: [] }),
    } as Response);

    const result = await getLocation(TEST_API_KEY, 'Auckland');

    expect(result.places).toEqual([]);
  });

  it('should accept a response with no places field', async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({}),
    } as Response);

    const result = await getLocation(TEST_API_KEY, 'Auckland');

    expect(result.places).toBeUndefined();
  });

  // `addressComponents` is optional in the mask's response: a result without it must parse
  // and simply yield no country, rather than failing the whole search.
  it('should accept a place carrying no addressComponents', async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          places: [
            {
              displayName: { text: 'Unnamed Peak' },
              formattedAddress: 'Otago, New Zealand',
              location: { latitude: -43.6, longitude: 170.1 },
            },
          ],
        }),
    } as Response);

    const result = await getLocation(TEST_API_KEY, 'Unnamed Peak');

    expect(result.places?.[0]?.addressComponents).toBeUndefined();
  });

  // Regression, found by probing the live API rather than by reasoning about the docs:
  // `cafe in Auckland` returned address components with no `types` key at all. Google
  // documents `types` as present, so this schema is deliberately more lenient than the
  // documented shape. With `types` required, one such component made Zod reject the whole
  // payload and the entire search 500'd - costing every suggestion, not just one.
  it('should accept an address component with no types key', async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          places: [
            {
              displayName: { text: 'Some Cafe' },
              formattedAddress: 'Auckland, New Zealand',
              location: { latitude: -36.85, longitude: 174.76 },
              addressComponents: [
                { shortText: 'NZ', longText: 'New Zealand' },
                { types: ['country'], shortText: 'NZ' },
              ],
            },
          ],
        }),
    } as Response);

    const result = await getLocation(TEST_API_KEY, 'cafe in Auckland');

    expect(result.places?.[0]?.addressComponents?.[0]?.types).toBeUndefined();
  });

  // Same principle as `types` above: Google omits valueless fields rather than sending
  // them empty, and a required `formattedAddress` would fail the whole search over one
  // result. The controller falls back to `displayName.text`.
  it('should accept a place with no formattedAddress key', async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          places: [
            {
              displayName: { text: 'Unnamed Peak' },
              location: { latitude: -43.6, longitude: 170.1 },
            },
          ],
        }),
    } as Response);

    const result = await getLocation(TEST_API_KEY, 'Unnamed Peak');

    expect(result.places?.[0]?.formattedAddress).toBeUndefined();
  });
});
