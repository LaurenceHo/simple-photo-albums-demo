import { z } from 'zod';

const LOCATION_API_TIMEOUT_MS = 10_000;
const PLACES_SEARCH_TEXT_URL = 'https://places.googleapis.com/v1/places:searchText';

/**
 * Fields requested from Places, sent as the `X-Goog-FieldMask` header.
 *
 * Declared here, beside `PlacesSearchResponseSchema`, because the mask and the schema
 * have to agree: a field named here but absent from the schema is fetched, billed and
 * then thrown away by Zod, while a field the schema requires but the mask omits arrives
 * as `undefined` and fails parsing at runtime. This used to be a parameter supplied by
 * the controller, which let the two drift apart with nothing to catch it.
 *
 * **Billing.** All four fields sit in the Text Search **Pro** SKU, so `addressComponents`
 * - our only source of the country code - costs nothing beyond what `displayName`,
 * `formattedAddress` and `location` already trigger. Google bills each request at the
 * highest SKU any requested field belongs to, so adding an Enterprise-tier field
 * (`rating`, `websiteUri`, opening hours, ...) would re-price every search, not just the
 * ones that use it.
 */
const PLACES_FIELD_MASK = [
  'places.displayName',
  'places.formattedAddress',
  'places.location',
  'places.addressComponents',
].join(',');

/**
 * One entry of `addressComponents`; `country` is the only type read (see the controller).
 *
 * `types` is **optional even though Google documents it as present**. Live probing of
 * `cafe in Auckland` returned components with no `types` key at all, and a required field
 * here made Zod reject the whole payload - one such component 500s the entire search
 * rather than costing one suggestion. A component with no `types` simply cannot be the
 * country component, so treating it as "no types" is the correct reading, not a fudge.
 */
const PlacesAddressComponentSchema = z.object({
  types: z.array(z.string()).optional(),
  shortText: z.string().optional(),
  longText: z.string().optional(),
});

const PlacesSearchResultSchema = z.object({
  // Optional for the same reason as `types` above: Google omits valueless fields rather
  // than sending them empty, and a required field turns one odd result into a failed
  // search. The controller falls back to `displayName.text`, which `PlaceSchema.min(1)`
  // needs. This is deliberately more lenient than the response shape Google documents.
  formattedAddress: z.string().optional(),
  displayName: z.object({
    text: z.string(),
    languageCode: z.string().optional(),
  }),
  location: z.object({
    latitude: z.number(),
    longitude: z.number(),
  }),
  addressComponents: z.array(PlacesAddressComponentSchema).optional(),
});

/**
 * Zod schema for the Google Places API (New) `places:searchText` response.
 *
 * Only the fields mapped onto `Place` are declared - Zod strips unknown keys, so anything
 * Google adds later is discarded at the boundary. `places.id`/`places.name` are neither
 * requested nor parsed, so nothing persisted to D1 identifies a Google record.
 */
const PlacesSearchResponseSchema = z.object({
  places: z.array(PlacesSearchResultSchema).optional(),
});

export type PlacesSearchResponse = z.infer<typeof PlacesSearchResponseSchema>;
export type PlacesSearchResult = z.infer<typeof PlacesSearchResultSchema>;
export type PlacesAddressComponent = z.infer<typeof PlacesAddressComponentSchema>;

/**
 * Search places by keyword using the Google Places API (New).
 *
 * Chosen over Mapbox Search Box for POI coverage: Mapbox has no record of many local
 * landmarks outside its core markets, and falls back to loose character matching rather
 * than returning nothing. See the "Superseded" note at the top of
 * `docs/specs/2026-08-08-mapbox-search-migration-design.md`.
 *
 * @param apiKey Google Places API key. Server-only - this must never reach the browser
 *   bundle, which is why the binding carries no `VITE_` prefix.
 * @param textQuery Search query text.
 * @returns Parsed `places:searchText` response.
 */
export const getLocation = async (
  apiKey: string,
  textQuery: string,
): Promise<PlacesSearchResponse> => {
  if (!apiKey) {
    throw new Error('GOOGLE_PLACES_API_KEY is not configured');
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), LOCATION_API_TIMEOUT_MS);

  try {
    const response = await fetch(PLACES_SEARCH_TEXT_URL, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        // The key travels in this header, and the request URL carries no query string at
        // all. Keep it that way: `wrangler.ci.toml` sets `head_sampling_rate = 1` with
        // `persist = true`, so anything that ends up in a URL is retained in account-scoped
        // observability data. Google also accepts `?key=<token>`, and switching to it would
        // silently put the credential into every trace span and every logged fetch error.
        'X-Goog-Api-Key': apiKey,
        'X-Goog-FieldMask': PLACES_FIELD_MASK,
      },
      // `languageCode` sets the language of the *response*, not the matching: a CJK query
      // still matches CJK place names. It governs whether a Taiwanese peak comes back as
      // its local name or a romanised/English one where Google holds both.
      //
      // `maxResultCount` restores the cap the Mapbox implementation carried as `limit=10`.
      // Without it Google defaults to 20 (also its maximum), which doubles both the payload
      // and the length of an admin dropdown that nobody scrolls. Verified live: an
      // unconstrained `cafe in Auckland` came back with well over ten results.
      body: JSON.stringify({ textQuery, languageCode: 'en', maxResultCount: 10 }),
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`Google Places API returned ${response.status}`);
    }

    const data: unknown = await response.json();
    return PlacesSearchResponseSchema.parse(data);
  } finally {
    clearTimeout(timeoutId);
  }
};
