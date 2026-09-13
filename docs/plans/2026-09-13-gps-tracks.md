# GPS tracks — Implementation Plan

> **For agentic workers:** Implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Do not start a task whose dependencies are unchecked.

**Goal:** Upload multiple GPX tracks per album, store them in R2, and draw them as coloured lines on a new map view of the photos page.

**Architecture:** The Worker parses GPX with the `@xmldom/xmldom` `DOMParser` already installed as a runtime global, and writes GeoJSON to a **sibling** `gps-tracks/<albumId>/` prefix — sharing the photo prefix would return tracks as photos and let one become the album cover. Tracks are served through the Worker (reusing `checkAlbumAccess`, avoiding bucket CORS) as a manifest plus one endpoint per track. **No D1 migration and no Worker config change.**

**Tech Stack:** Cloudflare Workers, Hono, Zod 4, Vue 3 + PrimeVue 5, Mapbox GL, TanStack Query, Vitest, Bun workspaces, Wrangler.

**Design spec:** [`docs/specs/2026-09-13-gps-tracks-design.md`](../specs/2026-09-13-gps-tracks-design.md)

**Follow-on:** [`2026-09-13-photo-locations-on-map.md`](./2026-09-13-photo-locations-on-map.md) pins individual photos on the map this plan builds. It depends on Task 6 here; this plan depends on nothing from it.

---

## Global Constraints

- Server request path is `routes/*-route.ts` → `controllers/*-controller.ts` → `services/*-service.ts`. Controllers extend `BaseController` and return **only** through its helpers — never bare `c.json()`.
- UI data fetching lives in Pinia setup stores, not in `composables/`.
- Zod schemas are duplicated between `ui/src/schema` and `server/src/types`. Never import across workspaces.
- Query keys are inline literals. **Every new key needs a `case` in `ui/src/mocks/setup-query-mock.ts`** — without one, tests receive `data: null` and pass.
- No real infrastructure identifiers in any tracked file. Use `${R2_BUCKET_NAME}`, `<prod-bucket>`, `example.com`.
- After every task, from the repo root: `bun run type-check`, `bun run test:all`, `bun run lint`.

## Assumption to prove before building on it

Cheap to check, expensive to discover late, and not provable by unit test.

- [x] **`@xmldom/xmldom` parses GPX under `workerd`** — **verified 2026-09-13.** The Worker boots under local Wrangler, which runs `index.ts`'s module-scope xmldom import and `globalThis` assignment. Then `GET /api/albums/<id>/gps-tracks` returned 200 — that path runs an S3 `ListObjectsV2` against real R2, and the AWS SDK parses the XML response with that same global `DOMParser`. So `parseFromString` demonstrably executes under `workerd` on real XML. GPX is the same parser and the same method.

## Task Checklist

- [x] 1. GPX-to-GeoJSON parser — S
- [x] 2. Track storage service — M
- [x] 3. Routes and controller — M
- [x] 4. Clean up tracks on album delete — XS
- [x] **Checkpoint A** — server complete, reviewed
- [x] 5. UI service, schema and store — M
- [x] 6. `AlbumTrackMap.vue` — M
- [x] 7. Third view mode — S
- [x] 8. Track manager UI — M
- [x] **Checkpoint B** — shippable

## File Structure

```
server/src/
  utils/gpx.ts                        (new)  GPX -> GeoJSON + simplification
  services/gps-track-service.ts       (new)  R2 keys, manifest, per-track read
  controllers/gps-track-controller.ts (new)
  routes/gps-track-route.ts           (new)
  types/gps-track.ts                  (new)
  controllers/base-controller.ts      checkAlbumAccess lifted here
  controllers/album-controller.ts     empty the track prefix on delete
  worker.ts                           register the route

ui/src/
  components/AlbumTrackMap.vue             (new)
  components/dialog/ManageGpsTracks.vue    (new)
  schema/gps-track.ts                      (new)
  services/gps-track-service.ts            (new)
  stores/gps-track.ts                      (new)
  views/PhotoList.vue                 third view mode (7), Edit album button (8)
  components/dialog/CreateAlbum.vue   GPS tracks row, below Album Location
  mocks/                              handlers + useQueries mock
```

---

## Task 1: GPX-to-GeoJSON parser

**Files:** `server/src/utils/gpx.ts`, `server/test/utils/gpx.test.ts`

**Interfaces:** `parseGpxToFeature(gpx: string): Feature<LineString | MultiLineString>` — pure,
throws a typed error on bad input.

First on purpose: it is the highest-risk assumption in phase 1, it is a pure function, and it can
be proven by unit test alone.

- [x] Read `<trk>/<trkseg>/<trkpt lat lon>`; fall back to `<rte>/<rtept>` when no track is present.
- [x] Single segment → `LineString`; multiple segments → `MultiLineString`.
- [x] Carry `<ele>` as a third coordinate; lift `<trk><name>` (or `<metadata><name>`), first and last `<time>`, and a haversine-summed distance into `properties`. Absence of any is not an error.
- [x] Douglas-Peucker simplification to `MAX_TRACK_POINTS` (start at 5000), preserving start and end points exactly. A phone recording at 1 Hz produces tens of thousands of points that no map needs.
- [x] Malformed XML and a document with zero usable points each throw `GpxParseError`. **A single out-of-range or unparseable point is skipped, not fatal** — the original criterion said it should throw, which would let one bad `<trkpt>` in five thousand cost the whole upload. Throwing only when no point survives matches the "one corrupt thing must not take down the rest" rule applied in task 2.
- [x] Prove xmldom parses a real GPX under local Wrangler — see the assumption above, verified at Checkpoint A.

**Verification:** `bun run --cwd server test:server`, `bun run --cwd server types:server`
**Dependencies:** None. **Scope:** S

---

## Task 2: Track storage service

**Files:** `server/src/services/gps-track-service.ts`, `server/test/services/gps-track-service.test.ts`

**Interfaces:**
```
putTrack(albumId, trackId, gpx)   parses, writes both .gpx and .geojson
listTracks(albumId)               trackId + colour + size + lastModified
getTrack(albumId, trackId)        one Feature, null when missing
deleteTrack(albumId, trackId)     removes both objects
hasTrack(albumId, trackId)        via checkIfFileExists
countTracks(albumId)              for the 20-track cap
```

- [x] Build every key through **one private helper**; reject `albumId` or `trackId` containing `/`, `.` or `..` before any R2 call.
- [x] **`listTracks` derives ids from `.geojson` keys only.** The prefix holds two objects per track; a `.gpx` reaching `R2Service.read()` throws in its `JSON.parse()`. Test that a prefix holding both yields exactly one `trackId`.
- [x] **`getTrack` reads a key rebuilt from the `trackId`,** not whatever string the listing returned — same discipline as the key helper.
- [x] `listTracks` on an empty album returns `[]`; `getTrack` on a missing id returns `null`.
- [x] **`deleteTrack` removes *both* objects for that track** — `.gpx` and `.geojson`. Leaving the `.gpx` behind is invisible (`listTracks` ignores it) but leaks storage and would resurrect the track if the id were ever re-derived from `.gpx` keys.
- [x] `deleteTrack` on a `trackId` that does not exist resolves without throwing — deleting something already gone is not an error, and the UI may race a double-click.
- [x] After `deleteTrack`, `listTracks` no longer returns that id.
- [x] Assign colours from the sorted id set so they are stable across calls — a pure function, no storage.
- [x] **Accept that adding or deleting a track re-colours its siblings.** Colour is the index in the sorted id set, so removing a track shifts every id after it down one. This is a known consequence, not a bug: the legend and the map read the same value so they never disagree, and the alternative — persisting a colour per track — is storage and drift for a cosmetic gain. Note it in the service's doc comment so nobody "fixes" it later.
- [x] **No skip-corrupt-and-continue rule.** With one read per track, a failed read is that track's error and must surface, not vanish.
- [x] Tests use `aws-sdk-client-mock`, as the existing server tests do.
- [x] **Added beyond the plan:** `TRACK_COLOURS` is an Okabe-Ito-derived palette (black and yellow dropped — both read badly as a thin line over the standard basemap), wrapping past its length so a 20-track album still gets a colour for every entry rather than `undefined`. `putTrack` writes the `.gpx` **before** the `.geojson`, so a failed second write leaves an invisible orphan rather than a listed track whose geometry 404s.

**Verification:** `bun run --cwd server test:server`
**Dependencies:** Task 1. **Scope:** M

---

## Task 3: GPS track routes and controller

**Files:** `server/src/routes/gps-track-route.ts`, `server/src/controllers/gps-track-controller.ts`,
`server/src/types/gps-track.ts`, `server/src/worker.ts`,
`server/src/controllers/base-controller.ts`, `server/test/routes/gps-track-route.test.ts`

**Interfaces:**

| Method | Path | Auth | Body / Response |
|---|---|---|---|
| `GET` | `/api/albums/:albumId/gps-tracks` | public, `checkAlbumAccess` | manifest array |
| `GET` | `/api/albums/:albumId/gps-tracks/:trackId` | public, `checkAlbumAccess` | one Feature, or 404 |
| `POST` | `/api/albums/:albumId/gps-tracks` | `verifyJwtClaim` + `verifyUserPermission` | `{ trackId, gpx }` |
| `DELETE` | `/api/albums/:albumId/gps-tracks/:trackId` | `verifyJwtClaim` + `verifyUserPermission` | — |

- [x] Lift `checkAlbumAccess` from `PhotoController`'s private method into `BaseController` (or a shared helper) so both controllers use one copy. **Do not duplicate it.**
- [x] JSON body `{ trackId, gpx }`, not raw XML, so `@hono/zod-validator` applies as on every other route. Cap the GPX string — **2 MB as shipped, not the 10 MB planned here; see the amendment below for the measurements that changed it.**
- [x] Validate `trackId` with the existing `safeR2Segment` helper from `api-response.ts`. **`:trackId` now arrives on a *public* endpoint** — previously it was admin-only on DELETE — so a crafted value (`../`, a path separator) must be rejected on the GET path before any key is built.
- [x] **Check `countTracks` only when `hasTrack` is false.** `trackId` comes from the filename, so POSTing an existing id is a replace and leaves the count unchanged; a bare count check would stop an album at 20 from ever re-uploading a corrected track.
- [x] Replacing at 20 succeeds; creating a new one at 20 returns `conflictError`.
- [x] POSTing an existing `trackId` replaces that track only — other tracks untouched.
- [x] Invalid GPX returns 400 with a useful message, not 500.
- [x] Manifest for an album with no tracks is 200 with `[]` — "no tracks" is normal, not a 404.
- [x] **DELETE removes the track and returns `ok`;** a follow-up manifest GET no longer lists it and a GET of its geometry returns 404.
- [x] **DELETE of a `trackId` that does not exist returns `notFoundError`,** not a 500 — and must not have partially deleted anything on the way there.
- [x] **DELETE validates `:trackId` through `safeR2Segment` too,** not only the GET path. It is the one route that destroys data, so a traversal here is the worst case of the three.
- [x] Deleting one track leaves the album's other tracks intact and still retrievable.
- [x] POST or DELETE by a non-admin returns 403; either GET against an unlisted album without an admin JWT returns 401/403, matching the photo list exactly.

**Verification:** `bun run --cwd server test:server`; manual against local Wrangler — POST two real
GPX files, GET the manifest, GET each track, DELETE one, then confirm the manifest lists only the
survivor and the deleted id 404s.
**Dependencies:** Task 2. **Scope:** M

---

## Task 4: Clean up tracks when an album is deleted

**Files:** `server/src/controllers/album-controller.ts`, `server/test/routes/album-route.test.ts`

**Interfaces:** none changed.

`AlbumController.delete` calls `emptyR2Folder(..., requestBody.id)`, which is prefix-based and so
does not touch `gps-tracks/<albumId>/`.

- [x] Add a second `emptyR2Folder` call for the track prefix.
- [x] Log but **do not fail** the album delete if the track prefix cannot be emptied — orphaned track objects are a smaller problem than an album that cannot be deleted.
- [x] Test asserts both prefixes are emptied.

**Verification:** `bun run --cwd server test:server`
**Dependencies:** Task 3. **Scope:** XS

### Checkpoint A: server complete

- [x] Root `type-check`, `test:all`, `lint` pass
- [x] The Worker boots under local Wrangler and `GET /gps-tracks` returns 200 with `[]` for an album that has none — routing, D1, R2 and the xmldom-under-`workerd` assumption all confirmed live.
- [x] **Round-trip verified 2026-09-13** against the real dev bucket: POST returned the parsed feature ("Waterfront loop"), the manifest listed it with its colour, the per-track GET returned 12KB of geometry, DELETE returned 200, and the manifest came back empty. The test object was removed afterwards.
- [ ] Reviewed before UI work starts

---

## Task 5: UI track service, schema and store

**Files:** `ui/src/schema/gps-track.ts`, `ui/src/services/gps-track-service.ts`,
`ui/src/stores/gps-track.ts`, `ui/src/stores/index.ts`, `ui/src/mocks/gps-track-handler.ts`,
`ui/src/mocks/handlers.ts`, `ui/src/mocks/setup-query-mock.ts`

**Interfaces:**
```
useQuery(['gpsTracks', albumId])            -> manifest, drives the legend immediately
useQueries over the manifest's ids
  -> ['gpsTrack', albumId, trackId]         -> per-track geometry, cached independently
```

`useQueries` is confirmed exported by `@tanstack/vue-query` 5.102.8.

- [x] Zod schemas for the manifest and the Feature — a **separate copy** from the server's.
- [x] Store follows the Pinia setup-store pattern in `stores/photo.ts`; expose a derived legend list `{ trackId, name, colour, visible }` and a `toggleTrack` action.
- [x] **Add `case 'gpsTracks'` and `case 'gpsTrack'` to `setup-query-mock.ts`.** Without them the queries fall to `default` and tests receive `data: null` instead of failing.
- [x] **Extend `setup-query-mock.ts` to mock `useQueries`** — it mocks `useQuery` only today. Roughly ten lines mapping over the options array and reusing `createBaseMockQueryReturn` per entry. Add a test proving a component using it receives data rather than `null`.
- [x] MSW handlers in `gps-track-handler.ts`, registered in `handlers.ts`.
- [x] Upload and delete invalidate the manifest key; a replace also invalidates only that track's geometry key.
- [x] An empty manifest is a normal, non-error state.

**Verification:** `bun run --cwd ui test:unit`; `bun run --cwd ui msw`
**Dependencies:** Task 3. **Scope:** M

---

## Task 6: `AlbumTrackMap.vue`

**Files:** `ui/src/components/AlbumTrackMap.vue`, `ui/src/components/__tests__/album-track-map.spec.ts`

**Interfaces:** props `{ albumId: string }`; reads the store from Task 5.

- [x] **One source and one `line` layer per track**, coloured from the manifest's `colour`.
- [x] Per-track visibility via `setLayoutProperty(layerId, 'visibility', 'none' | 'visible')` — simpler than a data-driven filter, and no source rebuild. Toggling off and on must not refetch geometry.
- [x] **Add every track layer with an explicit `beforeId`,** as `AlbumMap.vue` does with `addLayer(spec, 'clusters')`. The photo-locations plan's pin layer must sit above them; fixing the ordering contract now avoids wedging it later.
- [x] Fit bounds **once**, after the initially-visible tracks have loaded, so the map never jumps.
- [x] Reuse `AlbumMap.vue`'s patterns: `line-join`/`line-cap: round`, zoom-interpolated `line-width`, the same dark-mode popup handling.
- [x] Show the album `place` as a marker when present; show an empty-state message rather than a blank map when there is nothing to draw.
- [x] **No admin affordance in this component.** The empty state is a plain message and the legend is display plus visibility toggles only — track management is reached through the album dialog (Task 8), not from the map.
- [x] A track whose geometry query fails shows an error on that legend row; other tracks still render.
- [x] Clean up the map instance and every layer and source in `onUnmounted`, as `PhotoLocationMap` and `AlbumMap` both do.
- [x] Container carries `role="group"` and an `aria-label`, matching `PhotoInfoPanel`. Legend toggles are real buttons with accessible names — never colour alone.
- [x] **Do not extend `PhotoLocationMap.vue`** — it is a single-marker map used in two places and stays that way.

**Verification:** `bun run --cwd ui test:unit`; manual — three GPX files render as three continuous
lines at every zoom level.
**Dependencies:** Task 5. **Scope:** M

---

## Task 7: Third view mode in `PhotoList.vue`

**Files:** `ui/src/views/PhotoList.vue`, `ui/src/views/__tests__/photo-list.spec.ts`

**Interfaces:** `photoStyle: 'grid' | 'detail' | 'map'`, carried in `?photoStyle=` as today.

- [x] Add `'map'` to the `SelectButton` options with an `IconMap2`-family icon; render `AlbumTrackMap` when selected.
- [x] **Audit `photoStyle`'s three existing consumers** — the `justified-grid` vs `grid-cols` class, `EAGER_PHOTO_COUNT`, and `Photo.vue`'s `v-if="photoStyle === 'grid'"`. Guard the photo grid container on `photoStyle !== 'map'` so `'map'` never flows into `Photo.vue` at all.
- [x] Validate `route.query.photoStyle` against the three known values; fall back to `grid`. Today an arbitrary `?photoStyle=xyz` silently falls through to the detail layout.
- [x] Hide (not disable) the `map` option when the album has no tracks and the user is not an admin.
- [x] Selecting `map` writes `?photoStyle=map`; a reload restores it.

**Verification:** `bun run --cwd ui test:unit`; manual — all three modes, plus deep-linking each.
**Dependencies:** Task 6. **Scope:** S

---

## Task 8: Track manager UI

**Files:** `ui/src/components/dialog/ManageGpsTracks.vue`, `ui/src/components/dialog/index.ts`,
`ui/src/components/dialog/CreateAlbum.vue`, `ui/src/views/PhotoList.vue`, `ui/src/stores/dialog.ts`,
`ui/src/components/dialog/__tests__/manage-gps-tracks.spec.ts`

**Interfaces:** a new `manageGpsTracks` key in the dialog store.

### Two surfaces, and which rows live where

The word "row" means two different things below. They are not the same list and they are not in
the same place.

```
┌─ Edit Album (existing dialog) ──────────────────┐
│  …                                              │
│  Album Tag        [ tags select…        ]  [+]  │
│  Featured album   ( toggle )                   │
│  Album Location   [ Tokyo, Japan        ]       │
│  ┌───────────────────────────────────┐          │
│  │  (place map preview)              │          │
│  └───────────────────────────────────┘          │
│                                                 │
│  GPS tracks       3 tracks              [Manage]│ <- ONE summary row
│                                                 │
│              [ Reset ]  [ Save ]                │
└─────────────────────────────────────────────────┘
                     │ [Manage]
                     v
┌─ Manage GPS tracks (new dialog) ────────────────┐
│  ● 2026-04-12-day-1      8.4 km          [🗑]   │ <- one row PER TRACK
│  ● 2026-04-13-day-2     12.1 km          [🗑]   │
│  ● 2026-04-14-day-3      6.7 km          [🗑]   │
│  ─────────────────────────────────────────────  │
│  Drop .gpx files here, or browse                │
│              [ Done ]                           │
└─────────────────────────────────────────────────┘
```

**Below Album Location there is a single summary row** — a count and a button — exactly like the
Album Tag row above it. The per-track list is **not** in the album dialog; it is inside the
`ManageGpsTracks` dialog that button opens, together with the uploader.

### Entry points

**Primary: the album dialog**, directly below the existing "Album Location" field at
[`CreateAlbum.vue:139-168`](../../ui/src/components/dialog/CreateAlbum.vue#L139-L168). A GPS track
is the same *kind* of thing as `place` — album-level location metadata — so it belongs where
`place` is set, not only on the photos page.

**It follows the Album Tag pattern exactly.** That row
([`CreateAlbum.vue:105-123`](../../ui/src/components/dialog/CreateAlbum.vue#L105-L123)) is a
summary field plus a `Button` that opens a **separate** dialog via
`dialogStore.setDialogState('createAlbumTag', true)`. Do the same: a "GPS tracks (2)" summary and
a button that opens `ManageGpsTracks`.

**Do not embed the uploader as a form field.** The album dialog is a *staged* form — values are
held until submit, and `@reset.prevent="resetAlbum"` discards them. Track upload and delete are
*immediate* CRUD against R2, so an embedded uploader would leave Reset unable to undo an uploaded
track, and Cancel unable to undo a deleted one. Launching a separate dialog keeps the
staged/immediate boundary clean — which is exactly why tags already work this way.

**Disable the row in create mode.** `POST /api/albums/:albumId/gps-tracks` needs an album that
exists, and on the create path it does not yet. `albumToBeUpdate?.id` already distinguishes the
two modes — it drives the `'Edit' : 'New'` header and the disabled album-id input — so the guard
is free. Show "Save the album first" rather than hiding the row, so the capability is
discoverable.

**There is no track-specific second entry point, because the photos page gets "Edit album"
instead.**

Today the photos page has **no way to edit the album at all** — `EditAlbumButton` is rendered only
by `Album.vue`, the card on the list page, so changing a name, description, tag or location means
navigating back out. That is a real gap independent of this feature, and closing it makes a
track-specific shortcut unnecessary: Edit album → GPS tracks → Manage, the same path as from the
album list.

Earlier drafts put a track button in the admin `Toolbar`, then moved it onto the map's legend.
Both were attempts to give tracks a shortcut that no other piece of album metadata has — and
`place`, the thing a track is most like, has never had one. Fixing the underlying gap beats
special-casing tracks.

**What this buys:**

- `ManageGpsTracks` has exactly **one host** (`CreateAlbum.vue`) and one trigger, so there is no
  second path to keep in step.
- Task 6 keeps a plain empty-state message with no admin affordance inside the map component.
- Album name, description, tags, location, unlisted and featured all become editable from inside
  the album, which is worth having on its own.

**The cost is one more level from the map** — Edit album → GPS tracks → Manage. That is the same
depth the album list already has, and it is paid rarely: a track is uploaded once and corrected
occasionally.

#### Making the album editable from the photos page

- [x] Add an "Edit album" button to the admin `Toolbar`'s `#start` slot in `PhotoList.vue`, beside "Upload photos" (`IconEdit`).
- [x] It calls `setAlbumToBeUpdated(currentAlbum)` then `setDialogState('updateAlbum', true)` — the same two calls `EditAlbum.vue`'s `setAlbum` makes.
- [x] Render `<CreateAlbum v-if="dialogStates.updateAlbum" />` in `PhotoList.vue`; it is currently rendered only by [`AlbumList.vue:84`](../../ui/src/views/AlbumList.vue#L84).
- [x] **A button, not the `⋮` menu.** `EditAlbumButton` also carries "Delete Album", which from inside the album would delete what you are looking at and strand you on a dead route. Offer only Edit here.
- [x] Saving updates the album shown on the page — name, description, tags and location must refresh without a reload.

**From the album list, the route is already ⋮ → "Edit Album".** That menu item calls `setAlbum`
in [`EditAlbum.vue`](../../ui/src/components/button/EditAlbum.vue), which sets
`albumToBeUpdated` and opens the same dialog — so `albumToBeUpdate.id` is populated and the GPS
tracks row is **enabled**. The row is only ever disabled on the "New Album" path.

**Do not add a "GPS tracks" item to that ⋮ menu.** It would be a third entry point to the same
dialog, one click shallower, at the cost of another place to keep in step. The two above are
enough. This is a decision, not an oversight.

#### Wiring

- [x] Add `'manageGpsTracks'` to `stores/dialog.ts` in **all three places** — the `DialogKey` union, the `DialogStates` interface, and the `dialogStates` ref initialiser. Missing the initialiser leaves the state `undefined` rather than `false`.
- [x] Export `ManageGpsTracks` from the `components/dialog/index.ts` barrel, alphabetically, matching the existing entries.
- [x] Render `<ManageGpsTracks v-if="dialogStates.manageGpsTracks" :album-id="albumToBeUpdate.id" />` in **one** host: `CreateAlbum.vue`, co-located with its only trigger.

#### In the album dialog — **one summary row only**

- [x] **The track store needed an explicit album id.** It keys off `currentAlbum`, but the album dialog opened from the album list edits `albumToBeUpdate` — a different album entirely — so it would have listed and uploaded tracks against the wrong one. `setAlbumId` is set while the dialog is open and cleared on close, so the map view still falls back to `currentAlbum`.

- [x] A single row below "Album Location": a label, a count ("3 tracks" / "No tracks yet"), and a Manage button. **No track list and no uploader here.**
- [x] Disabled in create mode with "Save the album first", since the upload endpoint needs an album that exists. `albumToBeUpdate?.id` already distinguishes the modes.
- [x] The count reads from the manifest query, so it updates when the inner dialog changes something.

#### Not in the map view, and not a track button in the toolbar

- [x] `AlbumTrackMap.vue` gets **no** manage affordance — no legend control, no empty-state call to action. Its empty state is a plain message. This is a decision, not an oversight.
- [x] The `Toolbar` gains an **"Edit album"** button, not a "Manage tracks" one. Tracks are reached through the album dialog like every other piece of album metadata.

#### In `ManageGpsTracks` — **the per-track rows and the uploader**

- [x] One row per track: colour swatch, name, distance.
- [x] **Each row has a delete button.** This is the only way to remove a track — there is no delete affordance on the map legend or anywhere else, so if this is missed the feature has no delete at all.
- [x] **Deleting asks for confirmation first,** naming the track. It destroys an uploaded file and there is no undo — the only recovery is re-uploading the original GPX.
- [x] The row shows a pending state while the request is in flight and its button is disabled, so a double-click cannot fire two deletes.
- [x] On success the row disappears, `['gpsTracks', albumId]` is invalidated, and the line vanishes from the map without a page reload.
- [x] On failure the row returns to its normal state and surfaces the server's message — the track is still there and must still be listed.
- [x] **Deleting the last track** leaves the dialog in its empty state and the map in the empty state from Task 6, not a broken or blank map.
- [x] Below the list, an upload area accepting **multiple** `.gpx` files at once, each read with `FileReader.readAsText` and POSTed as its own track, with per-file status mirroring the photo uploader.
- [x] Reject non-`.gpx` and files over the size cap client-side, with a clear message, before any request. (2 MB as shipped — see the amendment below.)
- [x] One file failing does not abandon the rest — report each outcome independently.
- [x] Warn when a file's `trackId` already exists and will replace that track.
- [x] Surface the server's 20-track cap message rather than a generic failure.

#### Nesting

- [x] `ManageGpsTracks` opens on top of the modal album dialog. Confirm PrimeVue stacks them correctly and that closing the inner one does not dismiss the outer — the `createAlbumTag` dialog already does this, so match whatever it does.
- [x] Closing the inner dialog returns to the album dialog with its staged form values intact — nothing typed into name, description or location is lost.

**Verification:** `bun run --cwd ui test:unit`; manual with both servers — upload three files,
delete one, replace one.
**Dependencies:** Task 5. **Scope:** M

### Checkpoint B: shippable

- [x] Root `type-check`, `test:all`, `lint`, `build` pass — 525 UI + 494 server tests after the review passes
- [x] Against a real bucket: upload several tracks, toggle them, reload, delete the album, confirm every track object is gone
- [x] Upload, storage and display are all working. **This plan is complete** — the photo-pin follow-on is a separate document and a separate decision.

---

## Post-merge rollout (human)

Nothing manual. No migration, no new binding, no new secret — this plan ships entirely through
the normal path filters (`server/src/**` → Worker, `ui/src/**` → Pages).

**Rollback:** revert the merge commit. Track objects left in R2 under `gps-tracks/` are inert to a
reverted Worker, which simply never lists that prefix. They can be deleted at leisure or left for
a re-landing.

---

## Amendment: what two review passes changed (2026-09-14)

Recorded here rather than edited into the tasks above, so the plan still reads as what was
planned and this reads as what shipped. Only behaviour a reader of the spec would otherwise
be wrong about is listed; internal tidying lives in the commits.

### The upload cap is 2 MB, and deliberately does not match the photo cap

Task 5 planned 10 MB "matching the photo upload cap". That copies a number from a different
problem. Building a DOM for a GPX costs far more than the file, measured with the pinned
`@xmldom/xmldom`, one process per sample:

| GPX   | `<trkpt>` | DOM heap |
| ----- | --------- | -------- |
| 1 MB  |    16,384 |   +31 MB |
| 2 MB  |    32,768 |   +39 MB |
| 4 MB  |    65,536 |  +121 MB |
| 10 MB |   163,840 |  +290 MB |

A Worker isolate is capped at 128 MB, and the DOM is not the only thing live at that moment —
the buffered body and its JSON-parsed copy are too. The 10 MB cap admitted a file whose DOM
alone is twice the isolate.

Those figures come from Bun's JSC heap, not workerd's V8, so they do not transfer exactly.
They are not confirmable here either: `vitest.config.mts` runs plain vitest, not
`@cloudflare/vitest-pool-workers`, so nothing in the suite exercises the real memory limit.
The margin is far wider than an allocator difference explains, which is what makes the call
safe without that confirmation.

**The lower cap costs no fidelity.** Anything past `MAX_SIMPLIFY_INPUT_POINTS` (20,000) is
thinned before simplification, so a larger upload yields an identical stored track — it just
builds a bigger DOM to get there. `bodyLimit` sits ahead of `zValidator` at twice the schema
cap, because the schema check only runs once Hono has buffered and parsed the whole body.

### Simplification scores once instead of searching for a tolerance

Task 2 said "Douglas-Peucker simplification to `MAX_TRACK_POINTS`", which the first
implementation read as: pick a tolerance, run a pass, double the tolerance, repeat. That has
two faults the plan did not anticipate.

- **It did not enforce the cap.** The search returned its last attempt whether or not the
  budget was met. A GPX of 20,000 one-point segments stored all 20,000 points *and* reported
  `simplified: false`.
- **It was quadratic and repeated.** Douglas-Peucker degrades to O(n²) when the furthest
  point from the chord is next to an end every time — exactly what a side-to-side track does
  — and the search re-ran a full pass per candidate tolerance. Measured: 8,000 such points
  took 15 s, 15,000 took 50 s, from a file well inside the upload cap of the time.

Each point is now scored once by the tolerance at which it would survive, and the best 5,000
are kept: the same result, one pass, meeting the budget exactly. 15,000 zig-zag points take
2.6 s. Input above 20,000 points is thinned uniformly first to bound that pass.

### Two new rejections, both user-visible

- **A segment needs two points.** RFC 7946 requires at least two positions for a LineString,
  so a one-point segment was invalid GeoJSON as well as unsimplifiable. Such segments are
  dropped; a file left with none is a 400.
- **A file with more segments than half the budget is a 400.** The first and last point of
  every segment are always kept, so `2 × segmentCount` is the floor — past ~2500 segments the
  budget cannot be met at any tolerance. Rejecting with a message that names the problem beats
  silently discarding segments, since the upload is admin-initiated and re-exportable.

### The UI surfaces the server's message

Task 5 and Task 8 assumed the 400 naming a parse failure and the 409 naming the track cap
would reach the user. They did not: both mutations threw on `!response.ok` before reading the
body, so the dialog fell back to a generic failure and the store's `code !== 200` branch was
unreachable in production. The mutations now return the envelope on failure; the two reads
still throw, which is what TanStack Query's `isError` path expects.

### Checkpoint B

Both boxes left open above were completed. The real-bucket round trip ran against the dev
bucket — upload, parse, manifest, per-track fetch, delete, empty manifest — and the test
objects were removed afterwards. Final gates: `type-check`, `lint`, `test:all`, `build`, and
1,019 tests (525 ui, 494 server).
