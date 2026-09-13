# Photo locations on the album map

**Date:** 2026-09-13
**Status:** Approved design, ready for implementation planning
**Scope:** `server/` + `ui/` + Worker config — **no D1 migration**

**Depends on:** [`2026-09-13-gps-tracks-design.md`](./2026-09-13-gps-tracks-design.md). The pin
layer is added to the `AlbumTrackMap.vue` that piece builds, above its track layers. Do not start
this until that map exists.

---

## 1. Problem

With GPS tracks in place, the album map shows where you *went* but not where each photo was
*taken*. Pinning the photos on that same map is the remaining requirement — and the app stores no
per-photo coordinates today.

## 2. Correcting the premise: this does not need a database

The original framing was that this needs "photo locations in the DB as part of metadata". It does
not. **R2 objects carry custom metadata, and the Workers R2 binding returns it inline with the
object listing** — so a photo's coordinates can travel with the photo itself and arrive in the
same call that already builds the photo list.

That matters well beyond saving a table. An earlier draft added a `photo_metadata` table to D1;
three of its tasks existed only to keep that table in step with R2, and the migration's
deploy-ordering was the highest-impact risk in the whole design. All of that is gone (§5.1).

## 3. Goals

- Per-photo coordinates, extracted from EXIF, pinned on the album map.
- A backfill path for the photos already in the bucket.
- A cap on album size, so the photo list has a bounded worst case.
- No database change.

## 4. Non-goals

- **Cross-album coordinate queries** ("every photo near here"). Accepted cost of §5.1; nothing in
  the current or planned UI asks for it. An aggregate can be built if that changes.
- **Photo pins on `AlbumMap.vue`.** That map answers a different question.
- **Reshaping the photo endpoints.** Real and worth doing, but a separate change — §9.
- **Windowing the photo list.** Conditional on a measurement, and not required to ship this — §10.

## 5. Key constraints and the facts behind them

### 5.1 `x-amz-meta-*` written over S3 is readable as `customMetadata` through the binding

The load-bearing fact, verified rather than recalled:

- `x-amz-meta-*` headers written through R2's S3-compatible API **map to** `customMetadata` in the
  Workers binding ([R2 S3 extensions](https://developers.cloudflare.com/r2/api/s3/extensions/)).
  R2 applies RFC 2047 encoding automatically, so this is not the ASCII-only trap raw S3 has.
- `list()` accepts `include: ['customMetadata']` and returns it inline
  ([Workers API reference](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/)).

So photo coordinates live on the photo object as `latitude` / `longitude` / `takenAt`, and arrive
with the listing that already builds the photo list.

**What this buys over a D1 table:**

- **Move and rename already go through `CopyObject`, which carries user metadata; delete removes
  the object and its metadata together.** No post-R2 write to sequence, no "log-but-do-not-fail"
  reasoning, no stale-row failure mode, no maintenance code at all.
- No migration, so no manual `wrangler d1 execute` that must land before the Worker deploys.
- One source of truth. A photo cannot exist with coordinates attached to a since-deleted key.

### 5.2 `list({ include })` returns a variable page size — pagination is mandatory

`limit` maxes at 1000, but the Workers API reference states: *"if you request data, you may
receive fewer than `limit` results in your response to accommodate metadata."*

So the page size with `include: ['customMetadata']` is **variable and can be below 1000**. Any
read of the photo list must loop on `truncated` / `cursor`.

**At this repo's real scale the loop will almost certainly run once.** The largest album holds
roughly 300 photos, and three short metadata keys per object will not push 300 results past a page
boundary. Write the loop anyway: it is about five lines, the exact reduction is undocumented, and
the failure mode is an album silently losing photos with nothing to see. Cheap insurance against
an invisible bug.

Note also that `findAll` today passes `MaxKeys: 1000` with **no pagination at all**, so an album
over 1000 photos would already be silently truncated — the loop closes that too.

### 5.3 The Worker extracts the EXIF, not the browser

The Worker reads each photo's first 128 KB from R2 via the native binding, parses EXIF with
`exifreader`, and writes the coordinates back as custom metadata. One code path serves both
callers — the UI after an upload, and the admin backfill over existing photos.

Better than the browser doing it:

- The backfill no longer downloads every full photo to the client (a 300-photo album at up to
  10 MB each is ~3 GB), so the R2 bucket CORS question disappears with it.
- No coupling to presigned-URL signing. Signing `Metadata` into the presigned PUT works, but the
  client must then send the exact signed `x-amz-meta-*` headers or the PUT fails with
  `SignatureDoesNotMatch` — a sharp edge for a one-line change in the uploader.
- The UI needs no EXIF code in the upload path at all.

Costs: one `CopyObject`-in-place per photo (R2 cannot update metadata without a copy), and
`exifreader` becomes a server dependency as well as a UI one. **It must be proven to run under
`workerd` before anything is built on it** — the only fallback is browser extraction, which
reintroduces both problems above.

### 5.4 Both R2 APIs are used, deliberately

Once the native binding is added, the Worker reaches R2 two ways: the **native binding** for
listing (the only way to get custom metadata in one call) and the existing **S3 API via
`@aws-sdk/client-s3`** for everything else. Presigned upload URLs are why the S3 client cannot
simply be dropped — the native binding cannot mint them.

The alternative to the binding is N `HeadObject` calls per photo-list request, for every visitor
on every page load. Not viable. The duality is deliberate and warrants a comment in
`r2-service.ts`.

There is currently **no `[[r2_buckets]]` binding** in `wrangler.ci.toml` — it must be added, to
both the default and `[env.production]` blocks, using the existing `${R2_BUCKET_NAME}`
placeholder.

### 5.5 A 1000-photo cap is a guard rail, not the fix for anything

**The largest album currently holds about 300 photos.** A 1000 cap is therefore roughly 3×
headroom and is not expected to fire — no existing album is at risk of being locked, and the
number can stay round rather than being tuned.

The cap looks like it should buy more than it does:

- **It does not remove the pagination requirement.** Per §5.2 the page size is variable and can be
  below 1000, so even a capped album may list in several pages.
- **It does not make the photo list fast.** A large list is a rendering problem whatever the
  ceiling is — see §10.

What it does buy is a bounded worst case for the response payload, the DOM, and the pin count.

**The cap is approximate by construction.** The upload endpoint mints one presigned URL per file
and `uploadFiles` fires them in parallel, so fifty requests against a 990-photo album all see 990
and all pass. Enforce primarily in the UI, where the batch size is known up front; the server
check is a backstop for "far over", not "exactly at". Building coordination to make it exact is
not warranted for a single-admin app.

**An album already over the cap must not be locked** — the check gates adding, never deleting or
moving. That is a correctness rule regardless of current data.

## 6. Design: the coordinate flow

```
upload (presigned PUT, unchanged)
        |
        v
POST /api/albums/:albumId/photos/metadata   <- also the backfill's entry point
        |
        +-- Worker reads first 128 KB from R2 via the binding
        +-- exifreader parses GPS + DateTimeOriginal
        +-- CopyObject in place, MetadataDirective: 'REPLACE'
        |
        v
GET photo list -> env.BUCKET.list({ include: ['customMetadata'] }), paginated
        |
        v
Photo { …, latitude?, longitude?, takenAt? } -> clustered pin layer
```

A photo with no GPS gets an explicit `hasGps=false` marker, so a re-scan skips it rather than
re-reading it forever.

The pin layer is a clustered `symbol` layer on `AlbumTrackMap.vue`, reusing `AlbumMap.vue`'s
cluster setup and added **above** the track layers that piece one added with an explicit
`beforeId`. Clicking a pin opens the photo in the lightbox through the existing `?photo=` param.

## 7. Files changed

**Server**
- `src/utils/exif-gps.ts` *(new)* — EXIF GPS sign handling
- `src/controllers/photo-controller.ts` — binding-based paginated listing, metadata endpoint, cap
- `src/routes/photo-route.ts` — the metadata endpoint
- `src/services/r2-service.ts`, `src/env.ts`, `wrangler.ci.toml` — native binding
- `src/constants.ts` — `MAX_PHOTOS_PER_ALBUM`
- `src/types/photo.ts` — optional coordinates
- `package.json` — `exifreader`

**UI**
- `src/components/dialog/ScanPhotoLocations.vue` *(new)*
- `src/components/AlbumTrackMap.vue` — pin layer
- `src/schema/photo.ts` — optional coordinates
- `src/stores/upload.ts` — post-upload metadata call, cap
- `src/views/PhotoList.vue` — scan action, cap

## 8. Testing strategy

One assumption is proven before anything is built on it, against local Wrangler rather than unit
tests alone: **`exifreader` runs under `workerd`** with a real geotagged JPEG.

Two failure modes are specifically tested because they fail *silently* otherwise:

- **A truncated list response with a cursor** must yield every photo (§5.2). A single-page test
  passes while the bug is live.
- **`CopyObject` dropping `ContentType` or metadata** on move and rename — a photo returning as
  `application/octet-stream`, or losing its pin.

## 9. Deferred: reshape the photo endpoints

The photo routes are inconsistent with the rest of the API and with the GPS routes:

| Today | Target |
|---|---|
| `GET /api/photos/:year/:albumId` | `GET /api/albums/:albumId/photos` |
| `POST /api/photos/upload/:albumId?filename=` | `POST /api/albums/:albumId/photos/:photoName/upload-url` |
| `PUT /api/photos` (move, ids in body) | `PUT /api/albums/:albumId/photos/:photoName` |
| `PUT /api/photos/rename` (ids in body) | same, with the new name in the body |
| `DELETE /api/photos` (ids in body) | `DELETE /api/albums/:albumId/photos/:photoName` |

**`:year` in the list route is dead.** `PhotoController.findAll` reads only `albumId` — the year
segment is accepted and never used, consistent with CLAUDE.md's note that year is filter/display
metadata, not a path component.

**Deliberately out of scope.** The UI and Worker deploy through separate path-filtered workflows
(`ui/src/**` → Pages, `server/src/**` → Worker), so a breaking path change opens a window where
one deployed artifact is talking to the other's old contract. That hazard deserves a change where
it is the only thing that can go wrong.

The GPS endpoints are already in the target shape, so nothing built here has to be redone. When it
is done, it goes in three steps, never one atomic rename: add new routes alongside the old and
deploy the Worker; point the UI and MSW handlers at them and deploy the UI; remove the old routes
and deploy the Worker.

## 10. Deferred: windowing the photo list

Raised while sizing the cap, and **conditional on a measurement that has not been taken**. Not
required to ship this piece.

Image loading is already well handled — `Photo.vue` does `loading="lazy"` with the first 12 cells
eager, `fetchpriority`, `decoding="async"` and CDN `srcset`, and `use-photo-aspect-ratios.ts`
caches measured ratios in `localStorage`. That pipeline needs no change.

What is missing is **windowing**: every photo gets a live component instance whether or not it is
on screen. At 300 photos that is 300 instances with seven computed properties each, and for an
admin 600 PrimeVue `Button` instances in the selection overlay. Meaningfully heavy, but a long way
from pathological — **so this is a hypothesis to test, not a defect to fix.** Profile a real
300-photo album first; if it renders acceptably, park this. Optimising an unmeasured page is how a
codebase acquires complexity it did not need.

Should measurement justify acting, two moves:

- **`content-visibility: auto`** on `.photo-cell`, which lets the browser skip layout, paint and
  style for off-screen cells while keeping them in the DOM — so find-in-page, the scrollbar and
  the justified flex layout keep working, which full virtualisation would break.
  [Baseline](https://developer.mozilla.org/en-US/docs/Web/CSS/content-visibility) since September
  2024. **Verify, do not assume:** off-screen cells get `contain: size`, which zeroes intrinsic
  size, and `.photo-cell` is sized by an explicit `flex-basis: calc(…)` plus `aspect-ratio`. MDN
  documents no interaction either way, so check all three browsers.
- **`selectedPhotos` as a `Set`.** `isPhotoSelected` is `selectedPhotos.value.includes(...)`,
  reactive on the selection, so one click invalidates it on every mounted cell — ~15,000 string
  comparisons at 300 photos and 50 selected.

## 11. Risks

| Risk | Impact | Mitigation |
|---|---|---|
| `exifreader` does not run under `workerd` | High — the only fallback is browser extraction, which reintroduces the CORS and bandwidth problems | Prove with a single-photo round trip against local Wrangler **before** building the rest |
| `list({ include })` page size is variable and not documented in exact terms | Low at ~300 photos (one page expected), but an album silently loses photos if it ever bites | Loop on `truncated`/`cursor` regardless — five lines, invisible failure mode. Test against a mocked truncated response |
| `CopyObject` drops `ContentType` or custom metadata on move/rename | Medium — photos break or lose pins | Explicit test. S3 defaults to `MetadataDirective: 'COPY'`; verify R2 honours it |
| The native binding is added but not deployed before the listing change | Medium — the Worker reads a binding that is not there | Binding task ships on its own first; `wrangler.ci.toml` is in the Worker path filter |
| Deferred windowing work is built without evidence it is needed | Medium — complexity added to a page that was already fast enough | §10 gates it on a profile |

## 12. Open questions

| Question | Default assumed |
|---|---|
| Photo pins clickable from `AlbumMap.vue` too? | No — out of scope |
| Is 1000 the right album cap? | **Resolved 2026-09-13:** largest album is ~300, so 1000 is ~3× headroom and non-binding. Keep the round number |
| Is the deferred windowing work worth doing at all? | **Open — decide from a profile, not from this document** (§10) |
