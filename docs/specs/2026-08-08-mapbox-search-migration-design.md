# Migrate place search from Google Places to Mapbox Search Box

**Date:** 2026-08-08
**Status:** Approved design, ready for implementation planning
**Scope:** `server/` + config/docs — **no `ui/src` component changes**, no D1 migration

---

## 1. Problem

The app calls two mapping vendors for one concern. Maps are drawn with Mapbox
(`mapbox-gl` in [`PhotoLocationMap.vue`](../../ui/src/components/PhotoLocationMap.vue)
and [`AlbumMap.vue`](../../ui/src/views/AlbumMap.vue)), but place *search* goes to
Google Places via [`location-service.ts`](../../server/src/services/location-service.ts).

That means two vendor accounts, two billing surfaces, and two API keys to rotate for
what is a single feature: "let an admin pick a location".

**Goal:** move place search to Mapbox so the project depends on one geo vendor.

## 2. Correcting the premise: this is forward search, not reverse geocoding

The task was raised as "migrate reverse geocoding". There is no reverse geocoding in
this codebase.

[`getLocation()`](../../server/src/services/location-service.ts) calls
`https://places.googleapis.com/v1/places:searchText` — **forward** search (text → place).
Its only consumers are two admin authoring dialogs, both driving a PrimeVue
`AutoComplete`:

- [`CreateAlbum.vue`](../../ui/src/components/dialog/CreateAlbum.vue) — album location
- [`CreateTravelRecords.vue`](../../ui/src/components/dialog/CreateTravelRecords.vue) —
  travel departure and destination

Per-photo reverse geocode (lat/lng → place name) is recorded as **deferred** in
[the lightbox design, §11](2026-07-26-justified-photo-gallery-lightbox-design.md).
It remains deferred. This design does not add it.

## 3. Goals

1. Place search runs against Mapbox instead of Google Places.
2. POI-quality results are preserved — landmarks and airports must still be findable.
3. `GOOGLE_PLACES_API_KEY` is removed from the project entirely.

## 4. Non-goals

- **Reverse geocoding.** Still deferred (§2).
- **Any change to the `Place` shape**, and therefore no D1 migration and no
  `ui/src/schema` or `server/src/types` churn. See §6.
- **Any change to map rendering.** `mapbox-gl` and `VITE_MAPBOX_API_KEY` are untouched.
- **Google OAuth login.** `VITE_GOOGLE_CLIENT_ID` stays — it is unrelated to Places
  and is still used by [`Login.vue`](../../ui/src/views/Login.vue) and
  [`auth-controller.ts`](../../server/src/controllers/auth-controller.ts).
- Category filters, or ranking derived from the *end user's* location. YAGNI.
- ~~Proximity biasing~~ — **this was a non-goal and is no longer.** Live verification
  showed the absence of an explicit proximity makes production ranking
  non-deterministic. See §5.6.

## 5. Key constraints and the facts behind them

### 5.1 Mapbox Geocoding v6 cannot do POI — Search Box can

The [Geocoding v6](https://docs.mapbox.com/api/search/geocoding/) `feature_type` enum is:

```
address | street | place | locality | neighborhood | district | postcode | region | country
```

There is **no `poi`** type. v5 had one; v6 dropped it.

This rules v6 out. The existing server test fixture searches `'Sydney Opera House'`, and
[`TravelRecordSchema`](../../server/src/types/travel-record.ts) carries
`transportType: 'flight'`, `airline` and `flightNumber` — so travel departures and
destinations are airports. Against v6, "Sydney Opera House" returns the *suburb
containing* the Opera House, and "Auckland Airport" returns Auckland.

**Decision:** use the [Search Box API](https://docs.mapbox.com/api/search/search-box/),
which returns `feature_type: "poi"`.

### 5.2 Use `/forward`, not `/suggest` + `/retrieve`

Search Box offers both a session-based two-call flow and a single-call `/forward`
endpoint.

| | `/forward` | `/suggest` + `/retrieve` |
| --- | --- | --- |
| Calls per search | 1 | 2 |
| `session_token` required | No | Yes |
| Coordinates in first response | Yes | No — only after `/retrieve` |
| UI changes needed | None | AutoComplete must hold a session token and call retrieve on select |
| Billing unit | Per request | Per session |

`/suggest` + `/retrieve` is cheaper per session when a user types many characters before
selecting. This is an admin-only dialog used a handful of times a month, so that saving
is immaterial, while the session plumbing — a second route, a second UI service method,
token lifecycle across component state — is real, permanent complexity.

**Decision:** `GET https://api.mapbox.com/search/searchbox/v1/forward`. It is a
structural drop-in for `places:searchText`.

### 5.3 A second Mapbox token is required

`VITE_MAPBOX_API_KEY` is a public `pk.*` token with URL restrictions configured in the
Mapbox dashboard ([`README.md`](../../README.md)). URL restrictions are enforced against
the `Referer`/`Origin` header. A `fetch` from a Cloudflare Worker sends neither, so a
URL-restricted token is rejected server-side.

**Decision:** a **separate** Mapbox token, stored as Worker secret `MAPBOXAPI_KEY`.

- **No `VITE_` prefix.** The README's existing convention is that a `VITE_`-prefixed
  variable is public and reaches the browser bundle; a non-prefixed one is a Worker
  secret. Search runs server-side, so this token must never reach the bundle.
- The token needs **no URL restriction** (it is never sent from a browser) but should be
  scoped to search and independently rotatable, so a leak of one token does not force
  rotation of the other.
- The route stays proxied and admin-only, so the token is not exposed to clients.

**Known, accepted consideration — observability traces.** `server/wrangler.ci.toml`
enables `[observability.traces]` with `head_sampling_rate = 1` and `persist = true`.
Mapbox accepts `access_token` **only** as a query parameter (§6.1), and
[`location-service.ts`](../../server/src/services/location-service.ts)'s "never log this
URL" comment only covers the Worker's own `console` output — it says nothing about
whether a Cloudflare Workers trace span independently records the outbound subrequest
URL. If it does, the token would be retained in account-scoped observability data outside
any code path this migration controls. This is **unverified** and worth checking directly
against a captured trace rather than assumed either way. The mitigation already in place
is the one described above: `MAPBOXAPI_KEY` is a separate, search-scoped, independently
rotatable token, so a leak via this path would not also expose `VITE_MAPBOX_API_KEY` or
require rotating it.

### 5.4 Data storage sits outside Search Box's stated terms — accepted

Search Box docs state that returned data *"is only available for temporary use"* and that
storing position data requires contacting Mapbox sales. There is **no `permanent`
parameter** for Search Box (Geocoding v6 has one, but v6 cannot do POI — §5.1, so the two
requirements cannot both be met by any single Mapbox product).

This app persists the selected place into D1 via `AlbumSchema.place` and
`TravelRecordSchema.departure`/`destination`.

**Decision:** accept and proceed. Reviewed and accepted by the project owner on
2026-08-08, on these grounds:

- Google Places' terms impose a comparable restriction (only Place IDs may be cached
  indefinitely), so the project is already in this position. The migration does not
  change the exposure.
- The restriction targets bulk extraction of a competing POI database, not a private
  album app storing a few dozen rows.

**Mitigation, at zero cost:** `mapbox_id` is **not persisted**. Freezing the `Place` DTO
(§6) means the stored record is a name, an address string and coordinates — no
identifier tying a row back to a Mapbox record.

### 5.5 Rate limits are not a concern

Search Box permits 10 requests/second. Neither dialog sets `AutoComplete`'s `delay` prop,
so PrimeVue's default of **300 ms** applies — a ceiling of ~3.3 requests/second per
field. The route is reachable only by an authenticated admin
([`verifyJwtClaim` + `verifyUserPermission`](../../server/src/routes/location-route.ts)),
so there is no anonymous path to it.

Note that `location-route.ts` does **not** use the
[`rateLimit`](../../server/src/routes/rate-limit-middleware.ts) middleware — that is
applied to unauthenticated public endpoints. Auth is the spend control here, which is the
existing deliberate design. No throttling work is required by this migration.

### 5.6 An explicit `proximity` is required, or production ranking is non-deterministic

**Discovered by live verification, not by the unit tests** — mocks return fixtures we
wrote, so they can never surface a ranking problem.

Mapbox applies an **implicit IP-based proximity bias** when `proximity` is omitted.
Proven: `proximity=ip` returns byte-identical results to omitting the parameter.

That matters because the `AutoComplete` fires every 300 ms (§5.5), so most requests are
*partial* queries like `Auckl`. Measured top result for `"Auckl"`, varying only the
caller's location across real Cloudflare edge coordinates:

| Origin | Top result |
| --- | --- |
| unset (and `proximity=ip`) | The Makeup Place … Auckland by Aya **(AU)** |
| SYD Sydney | Auckland Lai and Co **(AU)** |
| AKL Auckland | Auckland Town Hall **(NZ)** |
| SIN Singapore | Auckland Road **(SG)** — a street in Singapore |
| LAX Los Angeles | Auckland Domain **(NZ)** |
| LHR London | Auckland Motors **(GB)** — a UK garage |
| NRT Tokyo | Auckland Domain **(NZ)** |

**Five distinct top results from one query string.** A deployed Worker's outbound fetch
leaves from whichever Cloudflare colo serves the request, so production ranking varies by
colo and can change without a deploy — and never matches what a developer sees locally.

A second measurement showed the local-testing position is the *least* representative:
for `"Sydney Op"`, every origin except Sydney itself returns `Sydney Opera House` first,
while from Sydney local businesses (`Sydney Ophthalmic Specialists`) crowd it out.

The control query `"Auckland"` (complete) returned the same single result from all eight
origins. **The instability is confined to partial queries**, which is what makes the fix
cheap: a proximity hint only breaks ties on ambiguous partials and does not distort a
fully-typed search for Japan, France or Qatar.

**Decision:** add an optional `SEARCH_PROXIMITY` Worker binding (`"<lon>,<lat>"`, or the
literal `ip`). Unset preserves today's behaviour, so it is a safe default. Set, it makes
local and production ranking identical and stable. A present-but-malformed value is
logged and ignored rather than passed through — a typo'd secret degrading ranking is far
better than one that 400s every search.

### 5.7 Merge-gate result: `formattedAddress` quality against live Mapbox

Plan Task 4 Step 3 required recording the actual `formattedAddress` for five queries
through the local Worker against live Mapbox, and stopping if any was materially terser
than Google's. This has now been run:

| Query | Mapbox `formattedAddress` | `country` |
| --- | --- | --- |
| `Auckl` | 301-317 Queen Street, Auckland 1010, New Zealand | NZ |
| `Sydney Op` | Sydney 2000, Australia | AU |
| `Auckland Airport` | Ray Emery Drive, Auckland 2022, New Zealand | NZ |
| `Sydney Opera House` | Sydney 2000, Australia | AU |
| `Auckland` | Auckland, New Zealand | NZ |

**Every result across all five queries populated `country`**, so `extractCountry` in
[`ui/src/stores/travel-records.ts`](../../ui/src/stores/travel-records.ts) always takes
its first branch (`if (place?.country) return place.country;`) and never reaches the
comma-splitting `formattedAddress` fallback that could pollute its distinct-country
`Set<string>`.

On terseness: one result (`Sydney Opera House`) is terser than Google's `Bennelong Point,
Sydney NSW 2000, Australia`; `Auckland` matches Google exactly; `Auckland Airport` is
richer than the old fixture. **Accepted — no code change.**

## 6. Design: freeze the `Place` DTO, confine the change to one adapter

The internal DTO is unchanged in both workspaces
([`server/src/types/place.ts`](../../server/src/types/place.ts),
[`ui/src/schema/place.ts`](../../ui/src/schema/place.ts)):

```ts
{ displayName: string; formattedAddress: string;
  location: { latitude: number; longitude: number }; country?: string }
```

Because the DTO is frozen, the vendor swap is invisible above the controller: **no UI
component changes, no D1 migration, no request-schema changes.**

### 6.1 Request

```
GET https://api.mapbox.com/search/searchbox/v1/forward
  ?q={textQuery}&access_token={MAPBOXAPI_KEY}&language=en&limit=10&auto_complete=true
  [&proximity={SEARCH_PROXIMITY}]
```

`proximity` is sent only when `SEARCH_PROXIMITY` is set and valid (§5.6).

`language=en` preserves the current `languageCode: 'en'` behaviour. `limit=10` is the
endpoint maximum, matching the existing unbounded-ish suggestion list.

`auto_complete=true` is set **explicitly because Mapbox does not document this
parameter's default**. The sole caller is a typeahead — PrimeVue fires `@complete` 300 ms
after each keystroke (§5.5), so the great majority of queries are partial strings like
`Auckl` or `Sydney Op`. Without autocomplete mode those match poorly or not at all, and
the dialog appears broken until a complete name is typed. Setting it explicitly removes
the dependency on an undocumented default entirely.

The `maskFields` parameter is **removed** from `getLocation`'s signature — it existed
only to build the Google-specific `X-Goog-FieldMask` header and has no Mapbox analogue.

**`q`'s real character limit is 200, not the 256 Mapbox's own docs claim.** Live probing
of `https://api.mapbox.com/search/searchbox/v1/forward` found 200 characters accepted and
250/255/256/257 all rejected, and the API's own error names the true limit:
`{"message":"Query exceeded character limit of 200"}`. `LocationSearchSchema.textQuery`
(`server/src/types/request-schemas.ts`) enforces `.max(200)` for exactly this reason — do
**not** "correct" it back to 256 from the published docs. Without this bound, a query in
the 201-256 range would reach Mapbox, get its own 400, and surface to the client as a
generic 500 ("Failed to fetch location data") instead of a proper 400 at the validation
layer.

The docs also claim a "max 20 tokens" limit on `q`. That is **not** enforced on
`/forward` — live-verified with 21 tokens (83 characters) and 30 tokens (89 characters),
both returning `200`. Only the character limit is real; no token-count guard is needed.

### 6.2 Response mapping

Mapbox returns a GeoJSON `FeatureCollection`. Per feature:

| `Place` field | Source | Notes |
| --- | --- | --- |
| `displayName` | `properties.name` | Required by the Mapbox schema |
| `formattedAddress` | `properties.full_address` \|\| `properties.place_formatted` \|\| `properties.name` | Both optional; see below |
| `location.latitude` | `properties.coordinates.latitude` | **Not** `geometry.coordinates` |
| `location.longitude` | `properties.coordinates.longitude` | **Not** `geometry.coordinates` |
| `country` | `properties.context?.country?.country_code?.toUpperCase()` | Optional, ISO 3166 alpha-2 |

`country_code` is upper-cased because
[`extractCountry`](../../ui/src/stores/travel-records.ts) feeds it into a `Set<string>` to
count distinct countries visited — a casing flip would count `nz` and `NZ` as two
countries. Mapbox's documented examples show uppercase (`"US"`), matching Google's
`shortText`, and existing D1 rows hold `NZ`; the call costs nothing and removes the
dependency on that continuing to hold.

Two traps to encode as tests:

1. **`geometry.coordinates` is a `[longitude, latitude]` array.** `properties.coordinates`
   is a named object. Reading the array and assuming `[lat, lng]` silently places every
   pin in the wrong hemisphere. Always read `properties.coordinates`.
2. **`formattedAddress` must be non-empty, and the fallback chain uses `||`, not `??`.**
   `PlaceSchema` declares it `.min(1)`, but `full_address` and `place_formatted` are both
   optional in the Mapbox response — a bare POI can carry neither. Mapbox also sends
   `full_address` as an **empty string** rather than omitting it, and `??` only falls
   through on `null`/`undefined` — it would pass that empty string straight into
   `PlaceSchema`'s `.min(1)` and fail validation. `||` treats an empty string as falsy
   too, so the chain correctly falls through to `place_formatted`, then to
   `properties.name`, which is required, so the mapper cannot emit an empty string.
3. **A blank `name` is filtered out before mapping, not mapped through.** `displayName`
   is `properties.name`, and `PlaceSchema.displayName` is also `.min(1)` — no fallback
   exists for it, unlike `formattedAddress`. `location-controller.ts`'s `hasUsableName`
   drops any feature whose `name` is empty or whitespace-only before it reaches `toPlace`.
   This was added in response to an earlier review: a nameless suggestion is useless in a
   dropdown anyway, and filtering out one bad feature is better than either emitting an
   invalid `Place` (an opaque 400 when the album is later saved) or failing the whole
   search because of one malformed result.

`context` is documented as required but each of its members is optional, so `country`
resolution must be fully optional-chained.

### 6.3 Error handling

Unchanged in shape from the current implementation: a 10 s `AbortController` timeout,
throw on non-OK status, and parse through Zod so an unexpected payload fails at the
boundary rather than producing a malformed `Place`. Only the message strings change:

- `'GOOGLE_PLACES_API_KEY is not configured'` → `'MAPBOXAPI_KEY is not configured'`
- `` `Google Places API returned ${status}` `` → `` `Mapbox Search API returned ${status}` ``

[`location-controller.ts`](../../server/src/controllers/location-controller.ts) keeps
returning through `BaseController.fail()` on error, as required by the project's
controller contract.

## 7. Files changed

**Server**

| File | Change |
| --- | --- |
| [`services/location-service.ts`](../../server/src/services/location-service.ts) | Rewrite: GET with query params, new GeoJSON Zod schema, drop `maskFields` |
| [`controllers/location-controller.ts`](../../server/src/controllers/location-controller.ts) | Remap response per §6.2; drop the field-mask argument |
| [`env.ts`](../../server/src/env.ts) | Replace `GOOGLE_PLACES_API_KEY` with `MAPBOXAPI_KEY` in **both** interfaces (optional and required) |
| `worker-configuration.d.ts` | **Regenerate** via `wrangler types` — never hand-edit |
| [`routes/location-route.ts`](../../server/src/routes/location-route.ts) | Comment references "Google Places"; update to Mapbox |

**Tests**

| File | Change |
| --- | --- |
| [`test/services/location-service.test.ts`](../../server/test/services/location-service.test.ts) | Rewrite — every assertion is Google-specific (URL, `X-Goog-*` headers, POST body) |
| [`test/routes/location-route.test.ts`](../../server/test/routes/location-route.test.ts) | Asserts the literal string `'GOOGLE_PLACES_API_KEY is not configured'` |
| [`ui/src/mocks/location-handler.ts`](../../ui/src/mocks/location-handler.ts) | **No change.** Verified: it returns the internal `Place` DTO, not a vendor payload |

**Config and docs**

| File | Change |
| --- | --- |
| [`.github/workflows/api-build-deploy.yaml`](../../.github/workflows/api-build-deploy.yaml) | Swap the `GOOGLE_PLACES_API_KEY` env + `put_secret` lines for `MAPBOXAPI_KEY` |
| [`.github/workflows/api-demo-build-deploy.yaml`](../../.github/workflows/api-demo-build-deploy.yaml) | Same, with the demo's placeholder value |
| [`README.md`](../../README.md) | Secrets list and setup instructions |
| [`server/README.md`](../../server/README.md) | `.dev.vars` example |

**Not changed:** any `ui/src` component, `ui/src/schema/place.ts`,
`server/src/types/place.ts`, `request-schemas.ts`, D1 schema, and the CSP in
[`ui/src/main.ts`](../../ui/src/main.ts) — which already allows `api.mapbox.com`, and is
irrelevant here anyway since the call is server-side.

## 8. Testing strategy

Tests are written before the implementation, per the project's TDD practice.

**`getLocation` unit tests** — replacing the Google-shaped suite:

1. Calls the correct URL with `q`, `access_token`, `language`, `limit` and
   `auto_complete=true` query params.
2. Throws `'MAPBOXAPI_KEY is not configured'` on an empty key, **without** calling `fetch`.
3. Throws `` `Mapbox Search API returned ${status}` `` for 400/401/404/429/500/503.
4. Passes an `AbortSignal` to `fetch`.
5. Rejects a malformed payload via Zod.
6. Accepts an empty `features` array.
7. Accepts a feature with neither `full_address` nor `place_formatted`.
8. Accepts a feature with no `context`.
9. URL-encodes a query containing spaces and `&`.

**Controller mapping tests** — the regression-critical ones:

10. **Latitude and longitude are not transposed.** Use a fixture whose lat and lng are
    unmistakably distinct and hemisphere-specific (e.g. Sydney, `lat -33.85`, `lng 151.21`)
    so a swap cannot pass.
11. `formattedAddress` falls back `full_address` → `place_formatted` → `name`, and is
    never empty.
12. `country` is `undefined` when `context.country` is absent, and never throws.
12a. A lowercase `country_code` is normalised to uppercase.
13. A POI-shaped payload maps correctly — the reason for choosing this endpoint (§5.1).
    Note the Zod schema deliberately does **not** declare `feature_type`: nothing in the
    mapping branches on it, so parsing it would be dead weight. Test 10's Sydney Opera
    House fixture is a POI payload and serves as this test.

**Verification**, from the repo root: `bun run type-check`, `bun run test:all`,
`bun run lint`, `bun run build`. Server tests must run via
`bun run --cwd server test:server` so the SlowBuffer polyfill is loaded.

## 9. Rollout

1. Create a second Mapbox token, no URL restriction.
2. Store it as a GitHub environment secret named `MAPBOXAPI_KEY`, and add the same
   variable to local `server/.dev.vars`.
3. Merge. `api-build-deploy.yaml` matches `server/src/**`, so the Worker redeploys.
4. Verify a POI search ("Auckland Airport") and a partial search ("Auckl") from the album
   dialog against production.
5. Once confirmed, delete the `GOOGLE_PLACES_API_KEY` GitHub secret and revoke the key in
   the Google Cloud console.
6. Delete the orphaned Worker secret: `bunx wrangler secret delete GOOGLE_PLACES_API_KEY
   --name "<worker-name>"`. `wrangler versions secret put` only ever adds, so removing the
   CI line leaves the old binding live on the deployed Worker.

**Rollback:** revert the merge commit. The Google secret must still exist in GitHub at
that point, which is why step 5 comes only after step 4.

## 10. Risks

| Risk | Mitigation |
| --- | --- |
| Lat/lng transposed via `geometry.coordinates` | Hemisphere-specific fixture in test 10 (§8) |
| Existing stored `Place` rows differ in quality from new Mapbox results | DTO is frozen; old rows keep working. No backfill, no migration. |
| URL-restricted token used by mistake on the Worker | Distinct secret name, documented in §5.3 and both READMEs |
| POI coverage differs from Google in some regions | Accepted; verified against a real query at rollout step 4 |

## 11. Deferred

- Per-photo reverse geocoding via
  `https://api.mapbox.com/search/searchbox/v1/reverse` — now cheap to add, since the
  vendor, the token and the response parser will all exist. Still out of scope here.
- `proximity` biasing to make suggestions relevant to the album's other photos.
