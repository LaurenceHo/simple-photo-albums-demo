# GPS tracks on the photos page

**Date:** 2026-09-13
**Status:** Approved design, ready for implementation planning
**Scope:** `server/` + `ui/` — **no D1 migration, no Worker config change**

**Follow-on:** [`2026-09-13-photo-locations-on-map-design.md`](./2026-09-13-photo-locations-on-map-design.md)
pins individual photos on the map this piece builds. It depends on this one; this one does not
depend on it.

---

## 1. Problem

The photos page shows exactly one location: the album `place` chosen at album creation, rendered
as a small Mapbox map inside a `Popover` in `PhotoList.vue`. For an album that is a trip rather
than a single spot, that is the wrong unit — it says "Tokyo" for three weeks of walking.

This piece adds the route itself: upload a GPX track, store it in R2 alongside the photos, and
display it. Pinning the individual photos on that map is a separate piece, deliberately, because
it needs nothing from this one beyond the map component and it would otherwise hold this work up.

## 2. Goals

- Multiple GPS tracks per album, uploaded as GPX, stored in R2, drawn as coloured lines.
- A map view on the photos page that is a peer of the existing grid and detail views.
- Track management reachable from where album location is already set — which also means making the album editable from inside it, which it is not today.
- Ships without any database or Worker-binding change.

## 3. Non-goals

- **Formats other than GPX.** Every consumer tracker exports GPX; each extra format is a parser
  with its own edge cases. Revisit only if a real file forces it.
- **Renaming a track after upload.** The label is the filename; re-uploading replaces it. A rename
  is a copy-and-delete across two R2 objects for little gain.
- **Photo pins.** The follow-on piece.
- **Tracks on `AlbumMap.vue`.** That map answers a different question.

## 4. Key constraints and the facts behind them

### 4.1 `@xmldom/xmldom` already runs in the Worker

GPX is XML. `@xmldom/xmldom` is already a server dependency and its `DOMParser` is already
installed as a Worker runtime global in [`index.ts:5`](../../server/src/index.ts#L5) for the AWS
SDK. XML parsing in the Worker is proven in this codebase, so the Worker parses the GPX and writes
GeoJSON — no new UI dependency, and the browser does the parse work zero times per view instead of
once per view.

This also suits `R2Service.read()`, which ends in `JSON.parse()`: it can serve GeoJSON unchanged
but could not serve raw GPX without a new method.

### 4.2 Tracks are served through the Worker, not the CDN

Photos load through `<img>`, which needs no CORS. A `fetch()` to the CDN origin **would** need an
R2 bucket CORS policy. Serving tracks through the Worker sidesteps that, and reuses
`PhotoController.checkAlbumAccess` so an unlisted album's tracks are protected by exactly the same
rule as its photos. A CDN fetch would have no such check.

### 4.3 Track objects must not share the photo prefix

`PhotoController.findAll` lists with `Prefix: '<albumId>/'`, and `syncAlbumCover` then sets
`albumCover: photos[0]?.key` — R2 lists lexicographically. So a track stored under `<albumId>/`
would be returned **as a photo** and could **silently become the album cover**.

Tracks therefore live under a sibling top-level prefix:

```
gps-tracks/<albumId>/<trackId>.gpx        <- the original upload, kept for reprocessing
gps-tracks/<albumId>/<trackId>.geojson    <- the derived Feature, one per track
```

`findAll` is then not touched at all. The cost: `emptyR2Folder` in album delete is prefix-based,
so it must be called for the track prefix too or deleting an album orphans its tracks.

`trackId` is the filename stem run through the same sanitising rule as photo filenames
(`[^a-zA-Z0-9._\- ]` → `_`), so re-uploading a file replaces that track and leaves the others
alone. An album is capped at 20 tracks.

## 5. Design

### 5.1 A manifest plus per-track geometry

| Method | Path | Auth | Body / Response |
|---|---|---|---|
| `GET` | `/api/albums/:albumId/gps-tracks` | public, `checkAlbumAccess` | manifest array (`[]` when none) |
| `GET` | `/api/albums/:albumId/gps-tracks/:trackId` | public, `checkAlbumAccess` | one GeoJSON `Feature`, or 404 |
| `POST` | `/api/albums/:albumId/gps-tracks` | admin | `{ trackId, gpx }` |
| `DELETE` | `/api/albums/:albumId/gps-tracks/:trackId` | admin | — |

**Not one merged `FeatureCollection`.** That was the first design and was worse on three counts:
replacing one track invalidated the album's whole geometry cache; every visitor downloaded every
track to look at one (20 simplified tracks is 2–3 MB); and a corrupt object had to be
skipped-and-logged mid-merge, meaning a track that silently never renders. Per-track queries make
each of those a non-issue, and a bad track surfaces as that query's error state.

**The manifest needs no stored metadata.** `trackId` comes from the `.geojson` key, `colour` is a
pure function of the sorted id set, and `size`/`lastModified` the listing already returns. No
sidecar objects, no S3 user metadata, no `HeadObject` calls.

- **Legend label** is the `trackId` — the filename stem the user chose, usually better than a
  GPX's internal `<trk><name>` ("ACTIVE LOG", "Track 001"). The parser still lifts `<trk><name>`
  into the Feature's properties, so the legend can upgrade once geometry arrives.
- **Map bounds** are fitted once, after the initially-visible set loads. Default is all-visible,
  so that is one fit and no jump — bounds need not be known up front.

**The 20-track cap applies to creates, not replaces.** `trackId` is derived from the filename, so
POSTing an existing id is a replace and leaves the count unchanged. Check the count only when the
track does not already exist; otherwise an album at the cap could never re-upload a corrected
track.

### 5.2 Colours

The manifest endpoint sorts tracks by `trackId` and assigns each a colour from a fixed palette.
The UI uses that colour for both the map layer's `line-color` and the legend swatch — one source
of truth, stable across reloads, no storage.

**Known consequence: adding or deleting a track re-colours its siblings.** Colour is the index in
the sorted id set, so removing a track shifts every id after it down one, and uploading a track
that sorts early shifts everything after it. Accepted: the legend and the map read the same value
so they can never disagree, and the alternative — persisting a colour per track — is storage plus
drift for a purely cosmetic gain. It is recorded here so it is understood as a design consequence
rather than filed as a bug.

### 5.3 The map as a third view mode

`photoStyle` becomes `grid | detail | map`, carried in `?photoStyle=` exactly as today, reusing
the URL round-trip that already works. The existing `Popover` album-place map stays as it is — it
answers "where is this album?", not "where did we walk?".

One source and one `line` layer **per track**, so per-track visibility is
`setLayoutProperty(layerId, 'visibility', …)` rather than a data-driven filter, and no source is
ever rebuilt. **Track layers are added with an explicit `beforeId`,** as `AlbumMap.vue` already
does — the follow-on piece's photo-pin layer must sit above them, and fixing that contract now
avoids wedging it later.

### 5.4 Where tracks are managed from

**The album dialog is the primary entry point**, below the existing "Album Location" field. A
track is the same kind of thing as `place` — album-level location metadata — so it belongs where
`place` is set. From the album list the route is already the kebab menu's "Edit Album", which
opens that same dialog with `albumToBeUpdated` set, so the row is enabled there; no separate menu
item is added.

**There is no track-specific entry point anywhere else. Instead, the photos page gains "Edit
album".** Today it has no way to edit the album at all — `EditAlbumButton` is rendered only by
`Album.vue`, the card on the list page — so changing a name, description, tag or location means
navigating back out. That is a real gap independent of this feature, and closing it makes a
track-specific shortcut unnecessary: Edit album → GPS tracks → Manage, the same path as from the
album list.

Earlier drafts gave tracks a button in the admin `Toolbar`, then a control on the map's legend.
Both were shortcuts that no other piece of album metadata has — `place`, the thing a track is most
like, has never had one. Fixing the underlying gap beats special-casing tracks. It also leaves
`ManageGpsTracks` with exactly one host and one trigger, and keeps the map component free of admin
affordances.

The cost is one more level from the map — Edit album → GPS tracks → Manage — which is the same
depth the album list already has, paid rarely.

**It launches a separate dialog rather than embedding an uploader**, following the Album Tag row
that already does exactly this. The reason is a boundary worth keeping clean: the album dialog is
a **staged form** — values held until submit, discarded by `@reset.prevent="resetAlbum"` — while
track upload and delete are **immediate CRUD** against R2. Embedded, Reset could not undo an
uploaded track and Cancel could not undo a deleted one.

**The row is disabled in create mode.** `POST /api/albums/:albumId/gps-tracks` needs an album that
exists. `albumToBeUpdate?.id` already distinguishes the modes, so the guard costs nothing; show
"Save the album first" rather than hiding the row, so the capability stays discoverable.

## 6. Files changed

**Server**
- `src/utils/gpx.ts` *(new)* — GPX → GeoJSON, Douglas-Peucker simplification
- `src/services/gps-track-service.ts` *(new)*
- `src/controllers/gps-track-controller.ts`, `src/routes/gps-track-route.ts` *(new)*
- `src/types/gps-track.ts` *(new)*
- `src/controllers/base-controller.ts` — `checkAlbumAccess` lifted here from `PhotoController`
- `src/controllers/album-controller.ts` — empty the track prefix on delete
- `src/worker.ts` — register the route

**UI**
- `src/components/AlbumTrackMap.vue`, `src/components/dialog/ManageGpsTracks.vue` *(new)*
- `src/schema/gps-track.ts`, `src/services/gps-track-service.ts`, `src/stores/gps-track.ts` *(new)*
- `src/views/PhotoList.vue` — third view mode, plus an "Edit album" button and the `CreateAlbum` dialog (§5.4)
- `src/components/dialog/CreateAlbum.vue` — GPS tracks row
- `src/mocks/` — new handlers, and `setup-query-mock.ts` extended for `useQueries`

## 7. Testing strategy

One assumption is proven before anything is built on it, against local Wrangler rather than unit
tests alone: **`@xmldom/xmldom` parses GPX under `workerd`**.

Two failure modes are specifically tested because they fail *silently* otherwise:

- **`useQueries` left unmocked.** `setup-query-mock.ts` mocks `useQuery` only and switches on
  `queryKey[0]`; an unregistered key returns `data: null` and the test passes. Both new keys need
  cases, and the file needs extending for `useQueries`.
- **A `.gpx` key reaching `R2Service.read()`.** The prefix holds two objects per track, and
  `JSON.parse()` on GPX throws. `listTracks` must derive ids from `.geojson` keys only.

## 8. Risks

| Risk | Impact | Mitigation |
|---|---|---|
| `@xmldom/xmldom` behaves differently in the Worker than in Node tests | High — GPX upload fails only in production | Parser task is first and pure; verify against local Wrangler, not just unit tests |
| A new query key without a `setup-query-mock` case, or `useQueries` unmocked | Medium — tests pass with `data: null` | Explicit criteria, including a test proving `useQueries` returns data |
| A nested dialog (track manager over the album dialog) mis-stacks in PrimeVue | Low | `createAlbumTag` already does this; match whatever it does |
| `photoStyle=map` leaking into `Photo.vue` | Low | Guard the grid container on `photoStyle !== 'map'` |

## 9. Open questions

| Question | Default assumed |
|---|---|
| Renameable tracks after upload? | No — the label is the filename; re-upload replaces |
| Map view falls back to album `place` when there is nothing to draw? | Yes — never show an empty map for an album that has a location |
| Keep the original `.gpx` alongside the derived GeoJSON? | Yes — costs almost nothing, lets the parser be re-applied later |
| Is 20 the right track cap? | Yes — a multi-week trip as one file per day is ~20. Guard rail, not a constraint anything lives near |
