import { z } from 'zod';

const LOCATION_API_TIMEOUT_MS = 10_000;
const SEARCH_BOX_FORWARD_URL = 'https://api.mapbox.com/search/searchbox/v1/forward';

/** Endpoint maximum. */
const RESULT_LIMIT = '10';

const SearchBoxContextSchema = z.object({
  country: z
    .object({
      name: z.string().optional(),
      country_code: z.string().optional(),
    })
    .optional(),
});

const SearchBoxPropertiesSchema = z.object({
  name: z.string(),
  full_address: z.string().optional(),
  place_formatted: z.string().optional(),
  coordinates: z.object({
    longitude: z.number(),
    latitude: z.number(),
  }),
  context: SearchBoxContextSchema.optional(),
});

const SearchBoxFeatureSchema = z.object({
  properties: SearchBoxPropertiesSchema,
});

/**
 * Zod schema for the Mapbox Search Box `/forward` GeoJSON response.
 *
 * Only the fields mapped onto `Place` are declared - Zod strips unknown keys, so the
 * rest of the Search Box payload (`maki`, `poi_category`, `metadata`, `mapbox_id`, ...)
 * is discarded at the boundary rather than carried around. Dropping `mapbox_id` is
 * deliberate: nothing persisted to D1 then identifies a Mapbox record.
 */
const SearchBoxResponseSchema = z.object({
  features: z.array(SearchBoxFeatureSchema).optional(),
});

export type SearchBoxResponse = z.infer<typeof SearchBoxResponseSchema>;
export type SearchBoxFeature = z.infer<typeof SearchBoxFeatureSchema>;

/**
 * Validates and canonicalises a `SEARCH_PROXIMITY` value before it is used: either the
 * literal `ip`, or `"<lon>,<lat>"` - two comma-separated decimals (whitespace around the
 * comma is tolerated), longitude in [-180, 180] and latitude in [-90, 90]. This is
 * Mapbox's own format; a regex plus range checks covers it without pulling in a
 * coordinate-parsing dependency.
 *
 * Returns the canonical `"<lon>,<lat>"` string (rebuilt from the regex's own captured
 * digit strings, so whatever whitespace the operator typed never reaches Mapbox) or the
 * literal `ip`, or `null` when the value is malformed or out of range.
 */
const normalizeProximity = (value: string): string | null => {
  if (value === 'ip') {
    return 'ip';
  }

  const match = /^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/.exec(value);
  if (!match) {
    return null;
  }

  const [, longitudeText, latitudeText] = match;
  // Number() here is for the range check only - the output is built from the regex's own
  // captured digit strings (below), not from these parsed numbers. Number()'s string
  // coercion switches to exponential notation below 1e-6 (so `0.0000001` would become
  // `"1e-7"`), which Mapbox may not accept the same way; joining the raw capture groups
  // preserves the operator's exact digits and sidesteps that entirely.
  const longitude = Number(longitudeText);
  const latitude = Number(latitudeText);
  const inRange = longitude >= -180 && longitude <= 180 && latitude >= -90 && latitude <= 90;
  return inRange ? `${longitudeText},${latitudeText}` : null;
};

/**
 * Search places by keyword using the Mapbox Search Box API.
 *
 * The single-call `/forward` endpoint is used rather than `/suggest` + `/retrieve`:
 * it returns coordinates directly, needs no `session_token`, and so requires no state
 * in the UI. It also returns `feature_type: "poi"`, which Geocoding v6 cannot - album
 * locations and travel departures are landmarks and airports.
 *
 * @param apiKey Mapbox access token. Server-only: must NOT be the URL-restricted
 *   `VITE_MAPBOX_API_KEY`, which Mapbox rejects when there is no `Referer` header.
 * @param textQuery Search query text
 * @param proximity Optional `SEARCH_PROXIMITY` binding value (the literal `ip`, or
 *   `"<lon>,<lat>"`). Without it, Mapbox biases partial-query ranking by the caller's
 *   IP - and in production that's whichever Cloudflare colo served the request, not the
 *   album's actual location, so the same partial search ranks differently by region.
 *   Passing a fixed value makes ranking deterministic; complete queries are unaffected.
 * @returns Parsed Search Box response
 */
export const getLocation = async (
  apiKey: string,
  textQuery: string,
  proximity?: string,
): Promise<SearchBoxResponse> => {
  if (!apiKey) {
    throw new Error('MAPBOXAPI_KEY is not configured');
  }

  const url = new URL(SEARCH_BOX_FORWARD_URL);
  url.searchParams.set('q', textQuery);
  url.searchParams.set('access_token', apiKey);
  url.searchParams.set('language', 'en');
  url.searchParams.set('limit', RESULT_LIMIT);
  // Set explicitly rather than relying on the default, which Mapbox does not document.
  // The only caller is a typeahead: PrimeVue fires `@complete` 300ms after each
  // keystroke, so most queries are partial ("Auckl", "Sydney Op"). Without autocomplete
  // mode those return poorly or not at all and the dialog feels dead.
  url.searchParams.set('auto_complete', 'true');

  if (proximity) {
    // Trimmed here because the literal `ip` check inside normalizeProximity is an exact
    // match, not covered by its own regex's whitespace tolerance - untrimmed, a trailing
    // newline would stop a valid `ip` value from matching. For a coordinate pair, that
    // regex already tolerates whitespace around the value and the comma, and the
    // canonical param is rebuilt from its captured digit groups (not this or any raw
    // string), so the operator's exact digits reach Mapbox with no stray whitespace.
    const trimmedProximity = proximity.trim();
    const normalizedProximity = normalizeProximity(trimmedProximity);
    if (normalizedProximity) {
      url.searchParams.set('proximity', normalizedProximity);
    } else {
      // Never log the value - it is operator-supplied config, not a secret, but a typo'd
      // SEARCH_PROXIMITY degrading ranking is far better than it 400-ing every search,
      // so we log the misconfiguration and proceed without the param.
      console.error(
        'SEARCH_PROXIMITY is set to an invalid value; ignoring it and searching without proximity bias.',
      );
    }
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), LOCATION_API_TIMEOUT_MS);

  try {
    // NOTE: never log this URL - `access_token` is a query parameter, so a logged URL
    // leaks the token into Worker logs.
    const response = await fetch(url.toString(), {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`Mapbox Search API returned ${response.status}`);
    }

    const data: unknown = await response.json();
    return SearchBoxResponseSchema.parse(data);
  } finally {
    clearTimeout(timeoutId);
  }
};
