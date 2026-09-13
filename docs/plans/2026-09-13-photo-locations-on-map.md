# Photo locations on the album map — Implementation Plan

> **For agentic workers:** Implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Do not start a task whose dependencies are unchecked.

**Goal:** Carry each photo's EXIF coordinates in R2 custom metadata, and pin the photos on the album map above the GPS tracks.

**Architecture:** Photo coordinates live in **R2 custom metadata**, not D1: `x-amz-meta-*` written over the S3 API is readable as `customMetadata` through the native Workers binding, so move, rename and delete stay consistent for free. The Worker — not the browser — reads 128 KB from R2 and parses the EXIF, which keeps whole photos off the wire and removes the bucket CORS question. **No D1 migration.**

**Tech Stack:** Cloudflare Workers, Hono, Zod 4, Vue 3 + PrimeVue 5, Mapbox GL, TanStack Query, Vitest, Bun workspaces, Wrangler.

**Design spec:** [`docs/specs/2026-09-13-photo-locations-on-map-design.md`](../specs/2026-09-13-photo-locations-on-map-design.md)

**Depends on:** [`2026-09-13-gps-tracks.md`](./2026-09-13-gps-tracks.md) — Task 5 here adds a pin layer to the `AlbumTrackMap.vue` that plan builds, above the track layers it adds with an explicit `beforeId`. Do not start Task 5 until that map exists. Tasks 1–4 and the cap task have no such dependency and can run earlier.

---

## Global Constraints

- Server request path is `routes/*-route.ts` → `controllers/*-controller.ts` → `services/*-service.ts`. Controllers extend `BaseController` and return **only** through its helpers — never bare `c.json()`.
- UI data fetching lives in Pinia setup stores, not in `composables/`.
- Zod schemas are duplicated between `ui/src/schema` and `server/src/types`. Never import across workspaces.
- No real infrastructure identifiers in any tracked file. Use `${R2_BUCKET_NAME}`, `<prod-bucket>`, `example.com`.
- After every task, from the repo root: `bun run type-check`, `bun run test:all`, `bun run lint`.

## Assumption to prove before building on it

Cheap to check, expensive to discover late, and not provable by unit test. The only fallback is
browser extraction, which reintroduces the CORS and bandwidth problems this design avoids.

- [ ] **`exifreader` runs under `workerd`** — gates Task 3. Verify with one real geotagged JPEG before writing the rest of that task.

## Task Checklist

- [ ] 1. Add the native `[[r2_buckets]]` binding — XS
- [ ] 2. Read photos through the binding, with metadata and pagination — M
- [ ] 3. Worker-side EXIF extraction endpoint — M
- [ ] 4. UI: extract after upload, backfill existing photos — M
- [ ] 5. Photo pins on the album map — M *(requires the GPS tracks plan's Task 6)*
- [ ] 6. Cap an album at 1000 photos — M *(independent; can run any time)*
- [ ] **Checkpoint** — complete

## File Structure

```
server/src/
  utils/exif-gps.ts                 (new)  EXIF GPS sign handling
  controllers/photo-controller.ts   binding listing, metadata endpoint, cap
  routes/photo-route.ts             the metadata endpoint
  services/r2-service.ts, env.ts    native binding
  constants.ts                      MAX_PHOTOS_PER_ALBUM
  types/photo.ts                    optional coordinates
server/wrangler.ci.toml             [[r2_buckets]] in both blocks

ui/src/
  components/dialog/ScanPhotoLocations.vue  (new)
  components/AlbumTrackMap.vue        pin layer, above the track layers
  schema/photo.ts                     optional coordinates
  stores/upload.ts                    post-upload metadata call, cap
  views/PhotoList.vue                 scan action, cap
```

---
## Task 1: Add the native R2 binding

**Files:** `server/wrangler.ci.toml`, `server/wrangler.toml` (gitignored), `server/src/env.ts`

**Interfaces:** `BUCKET: R2Bucket` in both `Env` and `Bindings`.

There is currently **no `[[r2_buckets]]` binding** — the Worker reaches R2 only over the S3 API.

- [ ] Add the binding to `wrangler.toml` (local dev) and to **both** the default and `[env.production]` blocks of `wrangler.ci.toml`.
- [ ] Use the existing `${R2_BUCKET_NAME}` placeholder — `bucket_name` is substituted by `envsubst` exactly like the D1 names. **Never a literal.** No new GitHub secret is needed.
- [ ] Add `BUCKET: R2Bucket` to `Env` and `Bindings` in `env.ts`.
- [ ] Confirm `env.BUCKET.list({ limit: 1 })` returns under `bun run --cwd server start:wrangler`.

Purely additive: nothing reads the binding yet and the S3 path is untouched. `wrangler.ci.toml`
**is** in the deploy path filter, so this alone ships the binding — which is the point, since
Task 2 needs it present.

**Verification:** `bun run --cwd server types:server`
**Dependencies:** None. **Scope:** XS

---

## Task 2: Read photos through the binding, with metadata and pagination

**Files:** `server/src/controllers/photo-controller.ts`, `server/src/services/r2-service.ts`,
`server/src/types/photo.ts`, `ui/src/schema/photo.ts`,
`server/test/controllers/photo-controller.spec.ts`

**Interfaces:** `Photo` gains optional `latitude`, `longitude`, `takenAt`. Update `PhotoSchema` on
**both** sides — separate copies.

- [ ] Switch `findAll`'s listing from S3 `ListObjectsV2` to `env.BUCKET.list({ prefix, startAfter, include: ['customMetadata'] })`, mapping `R2Object` → `Photo` (`uploaded` → `lastModified`, CDN `url` as today).
- [ ] **Loop on `truncated` / `cursor` until exhausted.** With `include` the docs state you *"may receive fewer than `limit` results to accommodate metadata"*, so page size is variable. `findAll` today passes `MaxKeys: 1000` with no pagination, so albums over 1000 photos are already silently truncated — this fixes it. **Test against a mocked truncated response carrying a cursor**; a single-page test passes while the bug is live.
- [ ] Parse coordinates defensively: validate latitude to [-90, 90] and longitude to [-180, 180]. A malformed or absent value yields a photo with no coordinates, never a `NaN` that reaches the map.
- [ ] **Wrap `syncAlbumCover` in its own try/catch.** It *writes* to D1 on an ordinary photo-list GET, inside the same `try` whose `catch` returns `this.fail`. Pre-existing sharp edge; this is the change that rewrites the code around it. A thrown error from it must still yield a 200 with the full list.
- [ ] Confirm by test that a **moved photo keeps its coordinates** through `CopyObject`, and that move, rename and delete need no other changes.
- [ ] A photo with no custom metadata is returned exactly as today, with the new fields absent.
- [ ] Add a comment in `r2-service.ts` explaining why both R2 APIs exist (spec §5.4).

**Verification:** `bun run --cwd server test:server` && `bun run --cwd ui test:unit`
**Dependencies:** Task 1. **Scope:** M

---

## Task 3: Worker-side EXIF extraction endpoint

**Files:** `server/src/routes/photo-route.ts`, `server/src/controllers/photo-controller.ts`,
`server/src/utils/exif-gps.ts`, `server/src/services/r2-service.ts`, `server/package.json`,
`server/test/controllers/photo-controller.spec.ts`

**Interfaces:** `POST /api/albums/:albumId/photos/metadata`, admin-only, body
`{ photoKeys: string[] }` capped at 50, returning a per-key result.

- [ ] **Prove `exifreader` runs under `workerd` first** — one real geotagged JPEG through local Wrangler, before writing the rest of this task. This is this plan's version of the GPS tracks plan's xmldom risk, and the only fallback is browser extraction, which reintroduces the CORS and bandwidth problems.
- [ ] `bun add exifreader` in `server/`.
- [ ] Read each object's first 128 KB via `env.BUCKET.get(key, { range: { offset: 0, length: 131072 } })`. Verify 128 KB is enough against a real JPEG from the bucket, and document the fallback to a larger range if a camera writes EXIF late.
- [ ] Extract the `GPSLatitudeRef === 'S'` / `GPSLongitudeRef === 'W'` sign handling into `server/src/utils/exif-gps.ts`. The logic mirrors `PhotoInfoPanel.vue`'s; this copy is the server's — leave the UI one alone.
- [ ] Write `latitude` / `longitude` / `takenAt` back with `CopyObject` in place, `MetadataDirective: 'REPLACE'`.
- [ ] **Preserve `ContentType` on the copy** — a photo must not come back as `application/octet-stream`.
- [ ] A photo with no GPS gets an explicit `hasGps=false` marker, so a re-scan skips it rather than re-reading it forever.
- [ ] Validate `photoKeys` entries with `safeR2Segment`; non-admin returns 403.
- [ ] One photo failing to parse is reported in its result entry and does not abort the batch.

**Verification:** `bun run --cwd server test:server`; manual against local Wrangler.
**Dependencies:** Task 2. **Scope:** M

---

## Task 4: UI — extract after upload, and backfill existing photos

**Files:** `ui/src/stores/upload.ts`, `ui/src/services/photo-service.ts`,
`ui/src/components/dialog/ScanPhotoLocations.vue`, `ui/src/views/PhotoList.vue`

**Interfaces:** `PhotoService.extractPhotoMetadata(albumId, photoKeys)`.

Two callers, one endpoint. **The UI parses no EXIF and downloads no photos** for either path — so
no R2 bucket CORS is needed.

- [ ] `stores/upload.ts` calls the endpoint once with every successfully uploaded key after `uploadFiles` finishes.
- [ ] A failed metadata call **must not** mark the photo upload as failed — the photo is in R2 and the scan can fix it later.
- [ ] Admin "Scan photo locations" action batching 50 at a time over photos with neither coordinates nor the `hasGps=false` marker.
- [ ] Visible progress and a cancel button that stops mid-batch.
- [ ] Re-running the scan on an already-scanned album is close to a no-op — it must not re-process photos already marked as having no GPS.
- [ ] After uploading geotagged photos, their pins appear on the map view without a page reload.

**Verification:** `bun run --cwd ui test:unit`; manual against a real album with mixed geotagged
and non-geotagged photos.
**Dependencies:** Task 3. **Scope:** M

---

## Task 5: Photo pins on the album map

**Files:** `ui/src/components/AlbumTrackMap.vue`, `ui/src/components/__tests__/album-track-map.spec.ts`

**Interfaces:** none new — reads `photosInAlbum` from the photo store.

- [ ] Build a GeoJSON `FeatureCollection` from `photosInAlbum` entries that have coordinates.
- [ ] Add a clustered `symbol` layer reusing `AlbumMap.vue`'s cluster / cluster-count / unclustered-point setup.
- [ ] **Add the pin layer last**, above every track layer, which the GPS tracks plan's Task 6 adds with an explicit `beforeId`. Pins must always render above the lines.
- [ ] Clicking a pin opens that photo in the lightbox via the existing `?photo=` query param.
- [ ] Hover popup shows a thumbnail, as `AlbumMap`'s popup already does.
- [ ] An album with coordinates but no tracks still shows pins, and bounds fit the pins instead.
- [ ] Legend gains a pins on/off toggle alongside the per-track toggles.

**Verification:** `bun run --cwd ui test:unit`; manual with an album of 50+ geotagged photos and
two tracks.
**Dependencies:** Task 4 (which chains back through 3 → 2 → 1), plus the GPS tracks plan's Task 6. **Scope:** M


---

## Task 6: Cap an album at 1000 photos *(independent)*

**Files:** `server/src/controllers/photo-controller.ts`, `server/src/constants.ts`,
`ui/src/stores/upload.ts`, `ui/src/views/PhotoList.vue`, tests for each

**Interfaces:** `MAX_PHOTOS_PER_ALBUM = 1000` — one named constant per workspace (separate copies,
per the no-cross-workspace-import rule).

**Read spec §5.5 before implementing.** The cap is deliberately approximate under parallel uploads
and deliberately does not gate deletes or moves. Do not "fix" either. It also does **not** remove
the pagination requirement in Task 2.

- [ ] Confirmed 2026-09-13: the largest album is ~300 photos, so no existing album is near the cap.
- [ ] UI (primary): hide the upload button at the cap. `photosInAlbum.length` is already in the store, so this needs no new request.
- [ ] UI: reject a batch that would push the album over, naming how many slots remain, **before any request is made**.
- [ ] API (backstop): `PhotoController.create` checks the album's object count before minting a presigned URL; returns `conflictError` at or over the cap. One R2 list per presign — a cheap Class A op, but note it is per-file because the endpoint is per-file.
- [ ] Confirm an album already over the cap can still have photos deleted and moved out.

**Verification:** `bun run --cwd server test:server` && `bun run --cwd ui test:unit`
**Dependencies:** None — this can run before, during or after the other five. **Scope:** M


### Checkpoint: complete

- [ ] Root `type-check`, `test:all`, `lint`, `build` pass
- [ ] Geotagged photos appear as pins above the track lines, and clicking one opens the lightbox
- [ ] The backfill has been run once against a real album with mixed geotagged and non-geotagged photos
- [ ] `.husky/pre-push` passes

---

## Post-merge rollout (human)

No migration and no manual database step — that is the main thing this design bought (spec §5.1).

1. **Task 1 must deploy before Task 2.** The binding has to exist before code reads it. `wrangler.ci.toml` is in the Worker workflow's path filter, so merging Task 1 on its own ships it.
2. **Run the backfill scan once per existing album** after Task 4 lands, from the admin UI. Until then, older photos simply have no pins — nothing breaks.
3. **Rollback:** revert the merge commit. Custom metadata written to R2 objects is inert to a reverted Worker — an older build ignores fields it does not read — so there is no state to unwind.
