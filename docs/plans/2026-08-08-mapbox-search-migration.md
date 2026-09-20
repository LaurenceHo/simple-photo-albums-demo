# Mapbox Search Box migration — Implementation Plan

> # ⛔ SUPERSEDED — DO NOT EXECUTE THIS PLAN
>
> **This plan was completed in #131 and then reversed on 2026-09-20.** Place search runs on
> the Google Places API again; only map *rendering* is still Mapbox. See the Superseded note
> at the top of
> [`docs/specs/2026-08-08-mapbox-search-migration-design.md`](../specs/2026-08-08-mapbox-search-migration-design.md)
> for why.
>
> **Executing any part of this file will break production.** Specifically, its
> "Post-merge rollout (human)" section instructs the reader to destroy the credential the
> app now depends on:
>
> - step 4 — revoke `GOOGLE_PLACES_API_KEY` in the Google Cloud console and delete the
>   GitHub secret
> - step 5 — `wrangler versions secret delete GOOGLE_PLACES_API_KEY` on both Workers
> - step 6 — remove `GOOGLE_PLACES_API_KEY` from `server/.dev.vars`
> - step 7 — regenerate Worker types on the strength of step 6
>
> Doing any of those now 500s every admin place search, and the required-secrets guard in
> `api-build-deploy.yaml` will then refuse to deploy at all until a new key is minted.
>
> The **"Goal"** and **"Architecture"** lines immediately below are likewise inverted: the
> binding `MAPBOXAPI_KEY` was replaced *by* `GOOGLE_PLACES_API_KEY`, not the other way
> round. `MAPBOXAPI_KEY` and `SEARCH_PROXIMITY` no longer exist anywhere under `server/src`.
>
> The file is kept unedited below this banner as the historical record of how #131 was
> carried out. Read it as history, never as instructions.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Google Places `places:searchText` with Mapbox Search Box `/forward` for admin place search, so the project depends on one geo vendor.

**Architecture:** The internal `Place` DTO is frozen, so the vendor swap is confined to `location-service.ts` (fetch + Zod parse) and `location-controller.ts` (response mapping). No UI component changes, no D1 migration, no request-schema changes. The Worker binding `GOOGLE_PLACES_API_KEY` is replaced by `MAPBOXAPI_KEY` — a **second** Mapbox token, distinct from the browser's `VITE_MAPBOX_API_KEY`.

**Tech Stack:** Cloudflare Workers, Hono, Zod 4, Vitest, Bun workspaces, Wrangler.

**Design spec:** [`docs/specs/2026-08-08-mapbox-search-migration-design.md`](../specs/2026-08-08-mapbox-search-migration-design.md)

## Global Constraints

- **No `any` types.** Strict TypeScript throughout. `server/` extends `@tsconfig/strictest`.
- **Controllers must return through `BaseController` helpers** (`ok`, `clientError`, `fail`, …) — never bare `c.json()`.
- **Never commit real infrastructure identifiers** — no custom domains, R2 bucket names, Worker names, Cloudflare account IDs, D1 database names/IDs. Use `example.com`, `<prod-bucket>`, `<worker-name>`, `<db-name>`. This applies to code, comments, commit messages and PR text. `master` is mirrored to a public repo.
- **Never log the request URL from `location-service.ts`.** The Mapbox access token is a query parameter, so a logged URL leaks the token into Worker logs.
- **Server tests must run via `bun run --cwd server test:server`** — it sets `NODE_OPTIONS='--require ./test/slowbuffer-polyfill.cjs'`. Invoking `vitest` directly in `server/` drops the polyfill.
- **Zod schemas are duplicated, not shared.** Do not import across the `ui/`/`server/` workspace boundary.
- **`VITE_` prefix means public.** Vite inlines those into the client bundle. `MAPBOXAPI_KEY` must **not** carry the prefix.
- **Verification from repo root:** `bun run type-check`, `bun run test:all`, `bun run lint`, `bun run build`.
- Commit messages: imperative mood, no co-author trailer, no assistant attribution.

## Prerequisite (human, before Task 1)

Create a **second** Mapbox public token (`pk.*`) at
<https://account.mapbox.com/access-tokens/>.

**Scopes: accept the defaults, change nothing.** Search Box and Geocoding do not appear in
Mapbox's scopes table at all — they are not gated by a scope, so any valid public token
works. A new `pk.*` token carries all four public scopes (`styles:tiles`, `styles:read`,
`fonts:read`, `datasets:read`) by default.

**URL restriction: leave it empty.** Per Mapbox: *"If you use an access token with URL
restrictions to make a Mapbox API request in Terminal, Postman, or a similar tool, you
will receive a `403` error since the request originated from an unauthorized URL."* A
Cloudflare Worker `fetch` is exactly that case — no `Referer`, no `Origin`. This is why
the browser's URL-restricted `VITE_MAPBOX_API_KEY` cannot be reused here.

Verify the token before wiring it in. A terminal sends no `Referer`, so this doubles as a
check that no URL restriction is set:

```bash
curl -s -o /dev/null -w "%{http_code}\n" \
  "https://api.mapbox.com/search/searchbox/v1/forward?q=Auckland%20Airport&access_token=pk.YOUR_TOKEN&limit=1&auto_complete=true"
```

`200` = good. `403` = a URL restriction is set. `401` = invalid or revoked token.

Then add it to `server/.dev.vars` (gitignored):

```properties
MAPBOXAPI_KEY=pk.your_second_mapbox_token
SEARCH_PROXIMITY=174.7633,-36.8485
```

`SEARCH_PROXIMITY` is optional (`"<longitude>,<latitude>"`). It pins place-search ranking
so local and production agree; without it Mapbox ranks partial queries by the calling
datacentre's IP. See design spec §5.6 for the measurements behind this.

Leave `GOOGLE_PLACES_API_KEY` in `.dev.vars` until Task 4 confirms the migration works.

**Before merging** (not now), the same value must exist as a `MAPBOXAPI_KEY` secret on
the **`prod`** GitHub environment — the deploy workflow uploads it on merge, and an absent
secret uploads an empty string, which deploys a Worker whose search 500s on every call.
See "Post-merge rollout" at the end of this plan.

## File Structure

| File | Responsibility after this change |
| --- | --- |
| `server/src/services/location-service.ts` | Build the Search Box `/forward` request; parse the GeoJSON response through Zod. Knows Mapbox, knows nothing about `Place`. |
| `server/src/controllers/location-controller.ts` | Map a parsed Mapbox feature onto the internal `Place` DTO. Knows `Place`, knows nothing about HTTP details of Mapbox. |
| `server/src/env.ts` | Worker binding types. `MAPBOXAPI_KEY` replaces `GOOGLE_PLACES_API_KEY`. |
| `server/worker-configuration.d.ts` | Generated by `wrangler types`. Never hand-edited. |

---

### Task 1: Swap the server adapter to Mapbox Search Box `/forward`

The service signature, the controller mapping and the env binding are mutually dependent — changing one alone fails `tsc`. They land together as one reviewable unit: *"search hits Mapbox and still returns the same `Place[]`"*.

**Files:**
- Modify: `server/src/services/location-service.ts` (full rewrite)
- Modify: `server/src/controllers/location-controller.ts:16-30`
- Modify: `server/src/env.ts:23` and `server/src/env.ts:42`
- Modify: `server/src/routes/location-route.ts:11-13` (comment)
- Test: `server/test/services/location-service.test.ts` (full rewrite)
- Test: `server/test/routes/location-route.test.ts:46-48, 73-100, 103, 114`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `getLocation(apiKey: string, textQuery: string): Promise<SearchBoxResponse>` — note the **two**-parameter signature; the Google-only `maskFields` third parameter is removed.
  - `export type SearchBoxResponse = { features?: Array<{ properties: { name: string; full_address?: string; place_formatted?: string; coordinates: { longitude: number; latitude: number }; context?: { country?: { name?: string; country_code?: string } } } }> }`
  - `export type SearchBoxFeature` — one element of `features`.
  - The `Place` DTO is **unchanged**: `{ displayName: string; formattedAddress: string; location: { latitude: number; longitude: number }; country?: string }`.

- [ ] **Step 1: Replace the service test file with the Mapbox suite**

Overwrite `server/test/services/location-service.test.ts`:

```ts
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
});
```

- [ ] **Step 2: Run the service tests to verify they fail**

```bash
bun run --cwd server test:server location-service
```

If the filter is not passed through to Vitest, drop it and run the whole suite —
`bun run --cwd server test:server`. Always go through this script: it carries the
`NODE_OPTIONS` SlowBuffer polyfill that a bare `vitest` invocation loses.

Expected: FAIL. The current `getLocation` posts to `places.googleapis.com`, so the URL, param and error-message assertions all fail.

- [ ] **Step 3: Rewrite the service**

Overwrite `server/src/services/location-service.ts`:

```ts
import { z } from 'zod';

const LOCATION_API_TIMEOUT_MS = 10_000;
const SEARCH_BOX_FORWARD_URL = 'https://api.mapbox.com/search/searchbox/v1/forward';

/** Endpoint maximum. */
const RESULT_LIMIT = '10';

/**
 * Zod schema for the Mapbox Search Box `/forward` GeoJSON response.
 *
 * Only the fields mapped onto `Place` are declared - Zod strips unknown keys, so the
 * rest of the Search Box payload (`maki`, `poi_category`, `metadata`, `mapbox_id`, ...)
 * is discarded at the boundary rather than carried around. Dropping `mapbox_id` is
 * deliberate: nothing persisted to D1 then identifies a Mapbox record.
 */
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

const SearchBoxResponseSchema = z.object({
  features: z.array(SearchBoxFeatureSchema).optional(),
});

export type SearchBoxResponse = z.infer<typeof SearchBoxResponseSchema>;
export type SearchBoxFeature = z.infer<typeof SearchBoxFeatureSchema>;

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
 * @returns Parsed Search Box response
 */
export const getLocation = async (
  apiKey: string,
  textQuery: string,
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
```

- [ ] **Step 4: Run the service tests to verify they pass**

```bash
bun run --cwd server test:server location-service
```

Expected: PASS, all 10 tests.

- [ ] **Step 5: Update the env binding**

In `server/src/env.ts`, line 23, inside `interface Env`:

```ts
  MAPBOXAPI_KEY?: string;
```

replacing `GOOGLE_PLACES_API_KEY?: string;`.

In `server/src/env.ts`, line 42, inside `type Bindings`:

```ts
  MAPBOXAPI_KEY: string;
```

replacing `GOOGLE_PLACES_API_KEY: string;`.

Leave `VITE_GOOGLE_CLIENT_ID` in both — it is Google OAuth login, unrelated to Places.

- [ ] **Step 6: Add the controller mapping tests**

In `server/test/routes/location-route.test.ts`, replace the `'should return correct location'` test (lines 73-100) with the four tests below, and update the two stale error-string references.

Replace the comment at lines 46-48 with:

```ts
  // Regression guard for the unauthenticated-billing hole: this endpoint proxies Mapbox
  // Search on the server's own API key, so an anonymous caller could previously run up
  // an unbounded bill.
```

Replace lines 73-100 with:

```ts
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
```

Then update the two stale vendor strings:

- Line 103: `new Error('Google Places API returned 403')` → `new Error('Mapbox Search API returned 403')`
- Line 114: `new Error('GOOGLE_PLACES_API_KEY is not configured')` → `new Error('MAPBOXAPI_KEY is not configured')`

- [ ] **Step 7: Run the route tests to verify they fail**

```bash
bun run --cwd server test:server location-route
```

Expected: FAIL. The controller still reads `response.places`, so `data` comes back as `[]` and the mapping assertions fail.

- [ ] **Step 8: Rewrite the controller mapping**

In `server/src/controllers/location-controller.ts`, change the import on line 3:

```ts
import type { SearchBoxFeature } from '../services/location-service';
```

and replace lines 16-30 (the `getLocation` call and the `.map()`) with:

```ts
      const response = await getLocation(c.env.MAPBOXAPI_KEY, textQuery);
      const places: Place[] = (response.features ?? []).map((feature: SearchBoxFeature) => {
        const { properties } = feature;
        return {
          displayName: properties.name,
          // `full_address` and `place_formatted` are both optional - a bare POI can
          // carry neither. `PlaceSchema.formattedAddress` is `.min(1)`, so the chain
          // terminates at `name`, which the Mapbox schema guarantees is present.
          formattedAddress: properties.full_address ?? properties.place_formatted ?? properties.name,
          // `properties.coordinates`, NOT `geometry.coordinates`: the latter is a
          // [longitude, latitude] array and reading it as [lat, lng] silently puts
          // every pin in the wrong hemisphere.
          location: {
            latitude: properties.coordinates.latitude,
            longitude: properties.coordinates.longitude,
          },
          // Upper-cased defensively. `extractCountry` in ui/src/stores/travel-records.ts
          // feeds this into a `Set<string>` to count distinct countries visited, so a
          // casing flip would silently double-count ('nz' and 'NZ' as two countries).
          // Mapbox's examples show uppercase, matching Google's `shortText` - existing
          // D1 rows hold 'NZ' - but one call removes the dependency on that holding.
          country: properties.context?.country?.country_code?.toUpperCase(),
        };
      });
```

**Historical note:** the code block above (this step's original instruction) uses `??`.
The implementation that actually landed uses `||`: Mapbox sends `full_address` as an
**empty string** rather than omitting it, and `??` only falls through on `null`/
`undefined`, so it would pass that empty string straight into `PlaceSchema`'s `.min(1)`
and fail validation. `||` treats an empty string as falsy too, so the chain correctly
falls through to `place_formatted`. This block is left as originally written rather than
edited to match, since it is a record of what was instructed at the time — see design
spec §6.2 for the corrected mapping.

The `maskFields` argument is gone — the Google field-mask has no Mapbox analogue.

- [ ] **Step 9: Update the route comment**

In `server/src/routes/location-route.ts`, replace the comment on lines 11-13:

```ts
// Admin-only: this proxies Mapbox Search using the server's own API key, and every
// call is billed. Location search is only reachable from admin authoring dialogs in the
// UI, so leaving it open was an unauthenticated, unmetered spend vector.
```

- [ ] **Step 10: Run the full server suite to verify it passes**

```bash
bun run --cwd server test:server
```

Expected: PASS. Confirm no source or test file still references Google Places:

```powershell
Get-ChildItem -Path src,test -Recurse -Include *.ts |
  Select-String -Pattern 'GOOGLE_PLACES','googleapis' |
  ForEach-Object { "$($_.Path):$($_.LineNumber)" }
```

Run from `server/`. Expected: no output.

Do **not** substitute `findstr /S /I /C:"GOOGLE_PLACES" src\*.ts test\*.ts` — verified on
this repo, `findstr /S` given two path filespecs searches only the **first** and silently
reports nothing for the second, so it misses every match under `test\`. A completeness
check that under-reports is worse than none.

- [ ] **Step 11: Type-check**

```bash
bun run --cwd server types:server
```

Expected: clean. If `MAPBOXAPI_KEY` is reported missing on `c.env`, `worker-configuration.d.ts` is stale — that is fixed in Task 2; `env.ts`'s `Bindings` type is what `HonoEnv` actually uses, so this should pass regardless.

- [ ] **Step 12: Commit**

```bash
git add server/src/services/location-service.ts server/src/controllers/location-controller.ts \
        server/src/env.ts server/src/routes/location-route.ts \
        server/test/services/location-service.test.ts server/test/routes/location-route.test.ts
git commit -m "Replace Google Places search with Mapbox Search Box forward endpoint"
```

---

### Task 2: Regenerate the Worker type definitions

`worker-configuration.d.ts` is tracked in git but generated by Wrangler from the local (gitignored) `wrangler.toml` and `.dev.vars`. It still declares `GOOGLE_PLACES_API_KEY` in three places.

**Files:**
- Modify: `server/worker-configuration.d.ts` (generated — never hand-edited)

**Interfaces:**
- Consumes: `MAPBOXAPI_KEY` present in `server/.dev.vars` (see Prerequisite).
- Produces: nothing consumed by later tasks.

- [ ] **Step 1: Confirm the local secret is in place**

`server/.dev.vars` must already contain `MAPBOXAPI_KEY=pk...` (Prerequisite). Without it, Wrangler will not emit the binding and the regenerated file will be wrong.

- [ ] **Step 2: Regenerate**

```bash
cd server && bunx wrangler types
```

Note this is **not** `bun run types:server` — that script is `tsc --noEmit`, a type-check, not a generator.

- [ ] **Step 3: Verify the generated diff**

```bash
git diff server/worker-configuration.d.ts
```

Expected: `MAPBOXAPI_KEY` newly present in the two `Env` interfaces and in the `ProcessEnv` `Pick<...>` union. `VITE_GOOGLE_CLIENT_ID` must remain.

`GOOGLE_PLACES_API_KEY` is still declared too, in all three places — **and that is
expected here, not a bug.** The Prerequisite section above instructs leaving
`GOOGLE_PLACES_API_KEY` in `.dev.vars` until Task 4 confirms the migration works against
live Mapbox, and `wrangler types` reads `.dev.vars` and reflects whatever is currently
there — it cannot regenerate a binding away while the variable that produces it is still
set. The old key is removed only in post-merge rollout (end of this plan), which now ends
with a step that re-runs `wrangler types` and commits the result, so the dead binding does
not linger in the tracked file indefinitely.

- [ ] **Step 4: Type-check and commit**

```bash
bun run type-check
git add server/worker-configuration.d.ts
git commit -m "Regenerate Worker types for the MAPBOXAPI_KEY binding"
```

---

### Task 3: Update CI workflows and documentation

**Files:**
- Modify: `.github/workflows/api-build-deploy.yaml:64, 86`
- Modify: `.github/workflows/api-demo-build-deploy.yaml:70-75, 92`
- Modify: `README.md:71-76, 84-94`
- Modify: `server/README.md:51`

**Interfaces:**
- Consumes: the binding name `MAPBOXAPI_KEY` established in Task 1.
- Produces: nothing consumed by later tasks.

- [ ] **Step 1: Update the production workflow**

In `.github/workflows/api-build-deploy.yaml`, line 64, replace:

```yaml
          GOOGLE_PLACES_API_KEY: ${{ secrets.GOOGLE_PLACES_API_KEY }}
```

with:

```yaml
          MAPBOXAPI_KEY: ${{ secrets.MAPBOXAPI_KEY }}
```

and line 86, replace:

```bash
          put_secret GOOGLE_PLACES_API_KEY "$GOOGLE_PLACES_API_KEY"
```

with:

```bash
          put_secret MAPBOXAPI_KEY "$MAPBOXAPI_KEY"
```

Do **not** add `MAPBOXAPI_KEY` to the `for required in ...` guard on line 71. That guard is for secrets whose absence breaks the Worker at every request (`JWT_SECRET`, R2 keys). A missing search token degrades one admin dialog and surfaces as a 500 from `location-controller`, matching how `RAPIDAPI_KEY` is treated today.

**Historical note:** the guidance above turned out to be wrong and was reversed in the final
merge review. `RAPIDAPI_KEY` and `MAPBOXAPI_KEY` are not equivalent cases: `RAPIDAPI_KEY`
already existed as a secret before this PR, so its presence on `prod` was never in question
here. `MAPBOXAPI_KEY` is a **brand-new secret name** introduced by this same PR — the exact
moment a rename requires a human to create the new secret on `prod` before merging (see the
Prerequisite section above). If that step is missed, `put_secret MAPBOXAPI_KEY ""` succeeds,
the deploy succeeds, and every place search 500s at request time with no deploy-time signal.
Failing the deploy loudly is strictly better than shipping a Worker whose search is silently
dead, so `MAPBOXAPI_KEY` **was** added to the guard. This note is left in place, rather than
edited away, as a record of the reasoning that changed.

Also add the optional proximity binding alongside it — in the `env:` block:

```yaml
          SEARCH_PROXIMITY: ${{ vars.SEARCH_PROXIMITY }}
```

and in the `run:` block:

```bash
          put_secret SEARCH_PROXIMITY "$SEARCH_PROXIMITY"
```

Note `vars.` not `secrets.` — a map centre is configuration, not a credential. It is also
optional: unset uploads an empty string, which `location-service` treats as "no proximity"
and ignores, restoring the default IP-biased behaviour. See design spec §5.6.

- [ ] **Step 2: Update the demo workflow**

In `.github/workflows/api-demo-build-deploy.yaml`, line 74, replace:

```yaml
          GOOGLE_PLACES_API_KEY: 'unused-in-demo'
```

with:

```yaml
          MAPBOXAPI_KEY: 'unused-in-demo'
```

and line 92, replace:

```bash
          put_secret GOOGLE_PLACES_API_KEY "$GOOGLE_PLACES_API_KEY"
```

with:

```bash
          put_secret MAPBOXAPI_KEY "$MAPBOXAPI_KEY"
```

Update the comment on lines 70-72 so it still reads correctly:

```yaml
          # These three gate features that are intentionally non-functional in the demo
          # (no Google login, no place search, no flight lookup). Unlike JWT_SECRET, a
          # placeholder grants no authority - it only makes the upstream call fail.
```

Do **not** add `SEARCH_PROXIMITY` to the demo workflow. Demo search is deliberately
non-functional (the token is the literal `unused-in-demo`), so a ranking hint would be
inert. Omitting the binding entirely is correct.

- [ ] **Step 3: Update the root README**

In `README.md`, append to the "Mapbox API key" section (after line 76):

```markdown
#### Two Mapbox tokens are required

| Variable | Used by | Restriction |
| --- | --- | --- |
| `VITE_MAPBOX_API_KEY` | The browser, for map tiles | Public `pk.*`, **URL-restricted** to your own domain |
| `MAPBOXAPI_KEY` | The Worker, for place search | Public `pk.*`, **no URL restriction** |

They must be **separate tokens**. A URL restriction is enforced against the `Referer`
header, and a `fetch` from a Cloudflare Worker sends none — so the URL-restricted token
is rejected server-side. Keeping them separate also means a leak of the public one does
not force rotation of the server one.

`MAPBOXAPI_KEY` has no `VITE_` prefix on purpose: it is a Worker secret and must never
reach the client bundle.

#### `SEARCH_PROXIMITY` (optional)

Place search sends partial queries as you type, and Mapbox ranks those by the caller's IP
when given no hint. A deployed Worker calls out from whichever Cloudflare datacentre
serves the request, so ranking varies by datacentre and will not match what you see
locally — typing `Auckl` returned a New Zealand result, a Singaporean road or a British
garage depending on origin.

Set `SEARCH_PROXIMITY` to `"<longitude>,<latitude>"` to make ranking deterministic:

```properties
SEARCH_PROXIMITY=174.7633,-36.8485
```

Leave it unset to keep the IP-biased default. It only breaks ties on partial queries —
fully-typed searches are unaffected, so this does not bias searches for other countries.
An invalid value is logged and ignored rather than sent.
```

In `README.md`, line 92, replace `GOOGLE_PLACES_API_KEY` with `MAPBOXAPI_KEY` in the list of confidential Worker secrets:

```markdown
carry a `VITE_` prefix: `JWT_SECRET`, `R2_ACCESS_KEY`, `R2_SECRET_KEY`, `MAPBOXAPI_KEY`,
```

- [ ] **Step 4: Update the server README**

In `server/README.md`, line 51, replace:

```properties
   GOOGLE_PLACES_API_KEY=your_google_places_api_key
```

with:

```properties
   MAPBOXAPI_KEY=your_server_side_mapbox_token
   SEARCH_PROXIMITY=174.7633,-36.8485
```

and add a short note under the block explaining that `SEARCH_PROXIMITY` is **optional**
(`"<longitude>,<latitude>"`): it makes place-search ranking deterministic instead of
biased by the calling datacentre's IP, and only affects partial queries typed into the
autocomplete. Cross-reference design spec §5.6.

- [ ] **Step 5: Verify no stale references remain**

Run from the repo root:

```powershell
Get-ChildItem -Path server\src,server\test,ui\src,.github,README.md,server\README.md -Recurse -File |
  Select-String -Pattern 'GOOGLE_PLACES' |
  ForEach-Object { "$($_.Path):$($_.LineNumber)" }
```

Expected: no output.

`docs/` is excluded on purpose — the design spec and this plan describe the migration and
must keep naming the old variable. `server/worker-configuration.d.ts` is excluded because
Task 2 owns it.

- [ ] **Step 6: Commit**

```bash
git add .github/workflows/api-build-deploy.yaml .github/workflows/api-demo-build-deploy.yaml \
        README.md server/README.md
git commit -m "Point CI secrets and setup docs at MAPBOXAPI_KEY"
```

---

### Task 4: Full verification and manual smoke test

**Files:** none modified (unless verification surfaces a defect).

**Interfaces:**
- Consumes: everything from Tasks 1-3.
- Produces: confidence that the branch is mergeable.

- [ ] **Step 1: Run the full check suite from the repo root**

```bash
bun run type-check
bun run test:all
bun run lint
bun run build
```

Expected: all four clean. These are the same checks `.husky/pre-push` runs, so a failure here blocks the push anyway.

- [ ] **Step 2: Start both local servers**

Two terminals, from the repo root:

```bash
bun run --cwd server start:wrangler
```

```bash
bun run dev
```

The UI needs both: `ui/src/services/api-base-url.ts` hardcodes `http://localhost:8787/api` in DEV, and the Worker only allows CORS from `localhost:9000` when `DEVELOPMENT=true` is set in `server/.dev.vars`.

- [x] **Step 3: Smoke-test POI search — completed, results below**

Log in at <http://localhost:9000/login>, open the create-album dialog, and type into **Album Location**.

For each query, **write down the `formattedAddress` actually shown on the second line of
the suggestion** ([`CreateAlbum.vue:156`](../../ui/src/components/dialog/CreateAlbum.vue#L156)).
"Results appeared" is not enough: `full_address || place_formatted || name` can resolve to
something far terser than Google returned (e.g. `New Zealand` where Google gave
`Auckland, New Zealand`), which is a visible regression in the dialog, in the stored album
record, and in `extractCountry`'s comma-splitting fallback.

| Query | Expected | Address shown | `country` |
| --- | --- | --- | --- |
| `Auckl` | **Partial query.** Auckland appears. Proves `auto_complete=true` works — the typeahead sends partial strings on almost every keystroke. | 301-317 Queen Street, Auckland 1010, New Zealand | NZ |
| `Sydney Op` | **Partial query.** The Opera House appears. | Sydney 2000, Australia | AU |
| `Auckland Airport` | The airport itself — not just "Auckland". This is the reason Geocoding v6 was rejected. | Ray Emery Drive, Auckland 2022, New Zealand | NZ |
| `Sydney Opera House` | The Opera House, addressed at Bennelong Point. | Sydney 2000, Australia | AU |
| `Auckland` | The city, `country` resolving to `NZ` (uppercase). | Auckland, New Zealand | NZ |

If any address is materially terser than Google's, stop and reconsider the fallback chain
in the controller before merging.

**Result:** run against live Mapbox through the local Worker. `Sydney Opera House` is
terser than Google's `Bennelong Point, Sydney NSW 2000, Australia`; `Auckland` matches
Google exactly; `Auckland Airport` is richer than the old fixture. Every query populated
`country`. **Accepted — no code change.** See design spec §5.7 for the same table and the
`extractCountry` implication.

- [ ] **Step 4: Verify the map pin, not just the list**

Select `Sydney Opera House`. The `PhotoLocationMap` below the field must centre on Sydney Harbour — **not** on a point in the Indian Ocean or central Asia. A transposed lat/lng is immediately obvious here and is the single most likely defect in this migration.

- [ ] **Step 5: Smoke-test the travel dialog**

Open the create-travel-record dialog and confirm both **Departure** and **Destination** autocomplete return airports (e.g. `AKL`, `Auckland Airport`, `Sydney Airport`).

- [ ] **Step 6: Push the branch and open a PR**

```bash
git push -u origin feature/mapbox-search-migration
```

Open the PR against `master`. Keep real infrastructure identifiers out of the title and body.

---

## Post-merge rollout (human)

1. Add `MAPBOXAPI_KEY` to the **`prod`** GitHub environment secrets before merging — the deploy workflow uploads it on merge, and an absent secret uploads an empty string. (Enforced since the final merge review: `api-build-deploy.yaml`'s required-secrets guard now fails the deploy if this is missing, rather than shipping a Worker whose search silently 500s.)
2. Merge. `api-build-deploy.yaml` filters on `server/src/**`, so the Worker redeploys automatically.
3. Verify `Auckland Airport` returns the airport in production. **Do this before step 4** — the Google secret must still exist in both GitHub and the Google Cloud console at this point so a revert of the merge commit can still reach a working `GOOGLE_PLACES_API_KEY` if the Mapbox migration needs to be rolled back.
4. **Only then** delete the `GOOGLE_PLACES_API_KEY` GitHub secret (on the `prod` environment) and revoke the key in the Google Cloud console.
5. Delete the now-orphaned Worker secret on **both** Workers, prod and demo. `wrangler
   versions secret put` only ever adds a key — it was used to upload `GOOGLE_PLACES_API_KEY`
   by both `api-build-deploy.yaml` (a real, billable credential) and
   `api-demo-build-deploy.yaml` (the literal placeholder `'unused-in-demo'`). This PR stops
   both workflows from uploading that key, but dropping a line from a workflow's `run:`
   block does not prune the key already stored on either deployed Worker — the same
   additive-not-pruning mechanic already noted for `SEARCH_PROXIMITY` in the prod workflow
   ("clearing the repo variable does not clear an already-uploaded value"). Left alone, both
   Workers keep a live `GOOGLE_PLACES_API_KEY` binding that nothing reads any more:

   ```bash
   cd server && bunx wrangler versions secret delete GOOGLE_PLACES_API_KEY --name "<worker-name>" --env=""
   cd server && bunx wrangler versions secret delete GOOGLE_PLACES_API_KEY --name "<demo-worker-name>" --env=""
   ```

   Substitute the real Worker names at the terminal — never commit them. `--env=""` matches
   the flag both workflows' `put_secret` function already uses to upload secrets, so this
   targets the same binding. The demo Worker's copy was never a real credential, so deleting
   it is not gated on step 3/4 the way the prod deletion is — it can be done at any time,
   but doing it in the same pass is the easiest way to not forget it.
6. Remove `GOOGLE_PLACES_API_KEY` from local `server/.dev.vars`.
7. Re-run `bunx wrangler types` in `server/` now that `GOOGLE_PLACES_API_KEY` is gone from
   `.dev.vars`, and commit the regenerated `server/worker-configuration.d.ts`. `wrangler
   types` mechanically reflects whatever is currently in `.dev.vars` (see Task 2 Step 3) —
   `GOOGLE_PLACES_API_KEY` stayed declared through Task 2 only because the variable was
   still set there, not because the type-check or anything under `server/src` depended on
   it (`env.ts`'s `Bindings` never mentioned it after Task 1). This step is what actually
   removes it, so it does not linger in the tracked file indefinitely.

**Rollback:** revert the merge commit. The Google secret must still exist in GitHub at that point — which is why step 4 comes after step 3.
