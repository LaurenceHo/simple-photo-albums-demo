# Justified photo gallery + lightbox with info panel

**Date:** 2026-07-26
**Status:** Approved design, ready for implementation planning
**Scope:** `ui/` only — no `server/` changes

---

## 1. Problem

Photos in an album are displayed as a uniform square grid. [`SquareImage.vue`](../../ui/src/components/SquareImage.vue)
forces a 1:1 box with `object-cover`, and [`Photo.vue`](../../ui/src/components/Photo.vue)
requests `?tr=w-{n},h-{n}` — a two-dimension ImageKit transform that centre-crops to a square.
Landscape and portrait photos lose their composition.

Clicking a photo replaces the whole grid with an inline detail page rather than
opening a lightbox over it, and the EXIF/map sidebar is always visible instead of
being revealed by an info button.

## 2. Goals

1. Photos display at their **original aspect ratio**, packed into justified rows
   (the layout used by lightGallery's justified demo and Google Photos).
2. Clicking a photo opens a **full-screen lightbox** over the grid.
3. An **info button** in the lightbox toggles a panel showing EXIF details and a
   location map.

## 3. Non-goals

- The `detail` list view keeps its square thumbnails — unchanged.
- The album-level map Popover in the toolbar — unchanged.
- Virtualised / windowed scrolling. Albums are expected to reach 200–500 photos;
  `loading="lazy"` is sufficient at that size. Deferred, see §11.
- A per-photo place name (Google Photos' "Hickson Road Reserve"). The server has
  Google Places **text search** only ([`location-service.ts`](../../server/src/services/location-service.ts));
  there is no reverse geocode. Deferred, see §11.
- **Any change to `server/`, D1, or R2.** Confirmed constraint.

## 4. Key constraints and the facts behind them

### 4.1 The API returns no image dimensions

`GET /api/photos/:albumId` returns `{ url, key, size, lastModified }`
([`ui/src/schema/photo.ts`](../../ui/src/schema/photo.ts)). R2's `ListObjectsV2`
([`r2-service.ts:48`](../../server/src/services/r2-service.ts#L48)) cannot return
custom metadata, so dimensions are not available server-side without either
`HeadObject` per key (500 subrequests per album — Workers cap at 1000) or a new
store in D1.

**Decision:** aspect ratios are measured in the browser from
`img.naturalWidth / naturalHeight` and cached in `localStorage`.

**Rationale:** the client path is required regardless, because photos already in
R2 have no stored dimensions and backfilling would mean downloading and measuring
every existing object. A server-side store would therefore be *additional*
complexity layered on a client path that must exist anyway, bought only to remove
a one-time-per-album reflow. Adding it later is purely additive — nothing in this
design would be discarded.

### 4.2 ImageKit preserves aspect ratio only with a single dimension

Verified against `https://ik.imagekit.io/demo/img/image1.jpeg` (source 5232×3744):

| Transform | Result |
| --- | --- |
| `?tr=h-200` | **279 × 200** — aspect preserved |
| `?tr=w-200,h-200` | 200 × 200 — centre-cropped square |

The square grid is caused by passing both `w` and `h`. Requesting height only is
sufficient; no server change is needed for aspect-correct thumbnails.

### 4.3 ImageKit strips metadata unless `md-true` is set

Verified against the same source file:

| URL | Bytes | EXIF present |
| --- | --- | --- |
| plain (no `tr`) | 1927 KB | **no** |
| `?tr=h-320` | ~10 KB | no |
| `?tr=md-true` | 1927 KB | **yes** |

Metadata is stripped even on the untransformed URL — on the ImageKit **demo**
account.

**However:** the project owner confirmed with a screenshot that EXIF date, camera,
aperture/shutter/focal/ISO and the GPS map all render correctly today, so their
account evidently preserves metadata. Empirical evidence from the real deployment
beats the demo account.

**Decision:** append `md-true` to the EXIF-read URL anyway. It costs one query
parameter, it is provably harmless where metadata is already preserved, and it
removes the residual ambiguity about whether the confirming screenshot came from
production (ImageKit) or local development (raw R2, which ignores `tr` entirely).
This is insurance, not a fix.

`ExifReader` supports HTTP `Range` requests, but measured against the real
deployment it does not get one here — see §4.5. The ~64 KB estimate an earlier
draft of this doc gave for the EXIF read was wrong for that reason.

### 4.4 Stored photo sizes vary widely — a downscaling transform is not a no-op

**Correction:** an earlier draft of this section asserted stored photos are
already ~1080 px wide, generalised from a single 1080×720 sample, and concluded no
lightbox downscaling transform was needed. Measured directly against a real photo
in the deployment, that premise does not hold:

| Sample | Dimensions | Size |
| --- | --- | --- |
| `auckland_18.28.53.jpg` | 4000×2250 | 3,509,509 bytes (3.5 MB) |
| another sample from the same deployment | — | ~95 KB |

Stored photo sizes vary by well over an order of magnitude — `ui/src` still
contains no canvas, `toBlob`, `drawImage` or watermarking code, and photos still
carry a baked-in watermark applied outside the application before upload, but
camera-resolution originals are evidently still present for at least some photos.

**Consequences:**

- **A downscaling transform is a genuine reduction — but it is not applied.**
  `?tr=h-1600,md-true` measured 432 KB against 1927 KB plain for the same
  ~5232×3744 demo source used in §4.2/4.3 — roughly 4.5×, not a no-op. It was
  shipped briefly and then **reverted**: see §4.7 for why the bytes were not worth
  the cost. The measurement is recorded here because it is the reusable half of
  that trade-off — anyone revisiting it needs the number, not just the outcome.
- **One URL for the `<img>` and the EXIF read, not two.** `PhotoDetail.vue`'s
  `<img src>` and its `ExifReader.load` call both now use the same
  `sharedPhotoUrl()` builder (`ui/src/utils/photo-url.ts`). They previously did not:
  the `<img>` loaded the plain URL while a separate `exifUrl()` builder loaded
  `?tr=md-true` for the EXIF read only. Two different query strings are two
  different browser cache keys, so the same photo was downloaded in full *twice*
  per view — measured on the 3.5 MB sample above, ~7 MB total instead of ~3.5 MB —
  and the second download was serial, blocking latency (the `<img>` sits behind a
  spinner that only clears once the EXIF read's `finally` block runs), not
  background cost. One URL makes the second fetch a guaranteed cache hit.
- **Thumbnail transforms remain worthwhile regardless.** `h-320` / `h-640` are
  genuine reductions against any stored size, whether that is a multi-megabyte
  original or the ~95 KB sample above.

### 4.5 EXIF reads cost a full download, not a Range request

**Correction:** an earlier draft of this section asserted `ExifReader` issues HTTP
`Range` requests
([`file-loaders.js:84`](../../ui/node_modules/exifreader/src/file-loaders.js#L84))
and confirmed a `206` response from ImageKit, concluding the EXIF read costs only
~64 KB. Measured against the real deployment, that does not hold either: the read
returns a full `200` response, not a `206` partial one — likely because the
request is cross-origin (the ImageKit CDN vs. the app's own origin), and Range
support does not help if the response served is never partial to begin with. The
EXIF read costs a full file download, exactly like the `<img>` did before this fix
— which is exactly why §4.4's fix routes both through the identical URL rather
than trying to make the EXIF read cheaper on its own.

### 4.6 ImageKit is production-only

[`ui/.env`](../../ui/.env) sets `VITE_IMAGEKIT_CDN_URL` to `https://ik.imagekit.io/…`
for production but to the raw `pub-….r2.dev` bucket for development. `?tr=`
parameters are silently ignored by R2, so local development downloads full
originals. This is already true today and is not a regression. Aspect-ratio
measurement is unaffected — `naturalWidth`/`naturalHeight` are correct either way.

### 4.7 The lightbox downscale was reverted: correctness beat bytes

§4.4's fix originally shipped as `lightboxUrl()` → `?tr=h-1600,md-true`, solving the
double download *and* taking the ~4.5× reduction. That over-reached and was reverted
to `sharedPhotoUrl()` → `?tr=md-true` (no dimension transform).

The downscale is what broke it. `PhotoInfoPanel` derives its "W × H" line and the
megapixels figure from `naturalWidth`/`naturalHeight`, read off the very `<img>` that
loads this URL. Transform the URL and those describe the *downscaled copy*, so a
4000×2250 original would be reported to the user as ~1600 px wide. Showing wrong
metadata is a worse defect than the bytes it saves, and the EXIF `Image Width` /
`Image Height` fallback does not rescue it — that is read from the same transformed
file.

**Open question, if the bytes are ever wanted back:** EXIF `PixelXDimension` /
`PixelYDimension` may survive ImageKit's resize describing the *original*. If so,
`h-1600` could return alongside correct dimensions. Two things to settle first — one
measurement (do those tags survive the resize, and do they hold pre-resize values?),
and a code change, since `PhotoInfoPanel` reads `Image Width` / `Image Height` (the
JPEG SOF dimensions, which always describe the actual bytes) rather than either
`PixelXDimension` tag.

## 5. Chosen approach: CSS flexbox justified rows

Each photo is a flex item in a `flex-wrap` container:

```text
flex-grow:  <ratio>
flex-basis: <ratio × targetRowHeight>px
```

Every item in a row lands at the same height. For a row of width `W` with items of
ratio `r_i` and total basis `B = Σ(r_i · H)`, free space `F = W − B` is distributed
in proportion to `flex-grow`:

```text
w_i = r_i·H + F·(r_i / Σr) = r_i · (H + F/Σr)
h_i = w_i / r_i = H + F/Σr        ← identical for every item in the row
```

### Alternatives considered

| Approach | Rejected because |
| --- | --- |
| JS row-packing (measure → pack → assign explicit sizes) | Needs a `ResizeObserver` and a recompute loop to own and test, with measure/layout re-entrancy risk. Its main advantage — being virtualisation-ready — serves a goal that is explicitly out of scope. Swapping to it later is contained within one component. |
| CSS `columns` masonry | Orders photos top-to-bottom per column, so photo 2 appears below photo 1 rather than beside it. Wrong reading order and does not match either reference. |
| Native CSS `masonry` | Not shipping unflagged in Safari or Firefox. |

## 6. Layout mechanics

Container in [`PhotoList.vue`](../../ui/src/views/PhotoList.vue), item root in
[`Photo.vue`](../../ui/src/components/Photo.vue):

JavaScript supplies **only the ratio**, as a CSS custom property. Every size is
then derived in CSS, so the row height stays in media queries and no resize
listener is needed:

```html
<div class="justified-grid">
  <!-- one per photo; --ratio is the only inline value -->
  <div :style="{ '--ratio': r }" class="photo-cell relative min-w-0">
    <img class="h-full w-full rounded-md object-cover" decoding="async" />
  </div>

  <!-- ×6: absorb the final row's free space -->
  <i aria-hidden="true" class="h-0 grow-[10] basis-0" />
</div>
```

```css
.justified-grid {
  display: flex;
  flex-wrap: wrap;
  gap: 0.25rem;
  --photo-row-height: 105px;
}
@media (min-width: 640px)  { .justified-grid { --photo-row-height: 150px; } }
@media (min-width: 1024px) { .justified-grid { --photo-row-height: 190px; } }
@media (min-width: 1280px) { .justified-grid { --photo-row-height: 220px; } }

.photo-cell {
  flex-grow: var(--ratio, 1.5);
  flex-basis: calc(var(--ratio, 1.5) * var(--photo-row-height, 150px));
  aspect-ratio: var(--ratio, 1.5);
  min-width: 0;
}
```

Both custom properties carry fallbacks: without one on `--photo-row-height`, a cell
rendered outside `.justified-grid` resolves `flex-basis` to `0`, and `min-width: 0`
plus `aspect-ratio` then collapses it to zero height in Safari.

### What these numbers actually produce

Row height is a *target*; the photos-per-row count falls out of it and the container
width. For 3:2 photos:

| Viewport | Container | `H` | 3:2 per row | Each photo | Today |
| --- | --- | --- | --- | --- | --- |
| 360px phone | ~360px | 105px | **2** | ~178 × 119 | 2 (`grid-cols-2`), 176 × 176 square |
| 768px tablet | ~730px | 150px | 3 | ~240 × 160 | 3 (`grid-cols-3`) |
| 1280px laptop | ~1240px | 190px | 4 | ~305 × 203 | 4 (`grid-cols-4`) |
| 1535px desktop | ~1500px | 220px | **4** | ~370 × 247 | 6 (`grid-cols-6`), ~250px square |

Phone and tablet density match today's grid. **Desktop is deliberately less dense** —
4 larger photos per row instead of 6 small ones — which is closer to the lightGallery
and Google Photos references and is the point of the change. Rows also vary naturally:
portrait photos have a smaller basis, so a row of portraits packs 3 where a row of
landscapes packs 2.

`--photo-row-height` is the single tuning knob. If desktop feels too sparse after
seeing it, lowering the `1280px` value to ~150px restores roughly 6 per row.

**`aspect-ratio` sits on the wrapper, not the `<img>`.** This keeps the
absolutely-positioned select button and album-cover icon anchored to the correct
box and avoids sub-pixel gaps between the image and its container.

**Final-row spacers.** Flexbox stretches the last row to full width, making its
photos taller than every other row. Six trailing `basis-0; grow-[10]` elements fix
this: `basis-0` means they can never force an extra row, and `grow-[10]` against a
photo's `grow-[1.5]` means they absorb roughly 97% of the leftover space, so the
last row keeps a normal height. `h-0` keeps them out of the vertical flow.

**Thumbnail URLs** become a fixed pair, identical at every breakpoint:

```text
src    = <url>?tr=h-320
srcset = <url>?tr=h-320 1x, <url>?tr=h-640 2x
```

Two ImageKit variants total. `x` descriptors depend only on device pixel ratio, so
no `sizes` attribute and no breakpoint detection in JavaScript is required. `h-640`
covers the largest row height (220px) at 2× DPR, and both 320 and 640 sit well
below any stored photo's size — multi-megapixel original or pre-scaled copy alike
— so each is a real reduction (§4.4).

**Loading priority:** the first 12 items render with `loading="eager"` and
`fetchpriority="high"`; every item after that uses `loading="lazy"`. This fills the
first screenful without waiting on the intersection observer, while keeping the
remaining 200–500 images off the initial network path.

The `onMounted` → `getElementById` → `clientWidth` measurement in
[`Photo.vue:136-141`](../../ui/src/components/Photo.vue#L136-L141) is deleted — the
transform no longer depends on the rendered element width.

## 7. Components

### 7.1 New: `ui/src/composables/use-photo-aspect-ratios.ts`

Non-data composable, consistent with the existing convention that
`ui/src/composables/` holds non-data helpers such as `use-device.ts`.

```ts
getRatio(key: string): number              // cached value, else the album's default
setRatio(key: string, w: number, h: number): void
```

- `DEFAULT_RATIO = 1.5` (3:2) — the seed default, used only until an album has
  enough measurements of its own.
- **Adaptive per-album default.** `getRatio` derives the album id from the key's
  `<albumId>/<photoId>` prefix. Once **5 or more** photos in that album are measured,
  unmeasured photos in the same album fall back to the **median of the measured
  ratios** rather than to 1.5.

  This matters because the placeholder ratio is what determines how far a cell moves
  when its image loads. An album of portrait photos is the worst case for a fixed
  1.5 default: every cell starts at 1.5 and settles at ~0.667, shrinking to ~44% of
  its placeholder width, so the whole page re-packs. With an adaptive default that
  album stabilises after 5 photos instead of shifting all 200. The median — not the
  mean — so a single panorama cannot drag the default.

  Two properties this must have:

  - **Frozen once set.** A default that kept drifting as more photos loaded would
    itself shift the layout, defeating the purpose. It is computed once, when the
    album crosses 5 samples, and never revised.
  - **O(1) lookup.** Samples accumulate in a per-album list as ratios are measured,
    so `getRatio` reads a precomputed value. Scanning the whole ratio map per cell
    would be O(n²) across a 500-photo album.

  On hydration, album defaults are rebuilt from persisted ratios, so a revisited
  album has its placeholder ready before a single image loads.
- Module-level `reactive(new Map<string, number>())`, hydrated from `localStorage`
  once on first use.
- Ratios clamped to `[0.4, 3.0]`.

  **This crops extreme photos in the grid, by decision.** A 6:1 panorama is laid out
  and displayed at 3:1, and because the `<img>` uses `object-cover`, its sides are cut
  off in the thumbnail. It opens uncropped in the lightbox, which uses
  `object-contain`. The alternative — no clamp — would give that panorama an entire
  row at roughly a quarter of the normal height, producing very short, odd rows. This
  matches Google Photos' behaviour and was chosen explicitly in preference to both
  the unclamped option and letterboxing out-of-range cells.
- Writes debounced (~500 ms) to avoid a `localStorage` write per image load.
- Capped at 5000 entries, oldest insertion dropped first (~200 KB of the 5 MB quota).
- All `localStorage` access wrapped in `try/catch`: Safari private mode throws on
  write, and corrupt JSON must not break the gallery. Both degrade to in-memory only.

**Why a default ratio is load-bearing at all:** an unloaded item with zero height
never enters the viewport, so `loading="lazy"` never fires, so it never reports a
ratio. Reserving plausible space breaks that deadlock.

### 7.2 New: `ui/src/components/PhotoInfoPanel.vue`

Purely presentational. Props: `photo: Photo`, `exifTags: Partial<ExifData>`,
`naturalWidth: number`, `naturalHeight: number`, `isPanorama: boolean`. Emits nothing.

Sections, each rendered only when its data exists — all lifted from the existing
`PhotoDetail` sidebar with no behavioural change:

1. Filename, `W × H`, megapixels, file size.
2. Local date/time.
3. Camera make/model, lens, and the `f/… | shutter | focal | ISO | EV` line.
4. `PhotoLocationMap` when EXIF GPS is present.

Megapixels and file size are new to this panel, matching the Google Photos
reference. Both values already exist — `photo.size` is on the schema and
[`Photo.vue:106`](../../ui/src/components/Photo.vue#L106) already formats it.

### 7.3 Changed: `ui/src/components/PhotoDetail.vue` → lightbox

Filename retained to keep the diff and the existing spec file focused.

- Wrapped in `<Teleport to="body">`; root is
  `fixed inset-0 z-[1100] bg-black/95` with `role="dialog"`, `aria-modal="true"`,
  and `:aria-label="photoFileName"`. `1100` matches PrimeVue 4's modal layer, which
  sits above its overlay/menu layers (1000) and below Toast (1200) — so existing
  dialogs stack correctly and toasts stay visible over the lightbox.
- Top bar: filename and `(3/47)` on the left; `[info] [edit (admin)] [close]` on
  the right.
- Stage: `flex items-center justify-center`, image as
  `max-h-full max-w-full object-contain`. **This deletes the 55-line `imageStyles`
  computed** — `object-contain` does the same job natively. `naturalWidth` /
  `naturalHeight` are still captured; the info panel needs them.
- **Display image, EXIF read and `PanoramaViewer` share one URL.** All three use
  `sharedPhotoUrl()` → `?tr=md-true` (§4.4/§4.5) — not the plain URL, and not
  separately-built URLs. `md-true` keeps metadata working per §4.3's finding that
  ImageKit strips it by default. Using the identical string at every call site
  means every fetch after the first is a cache hit rather than another full
  download. Deliberately **no** dimension transform, so `naturalWidth` /
  `naturalHeight` describe the true original — see §4.7.
- Previous/next chevrons at mid-left and mid-right, hidden when the album holds
  one photo. **Minimum 44 × 44 px touch targets** so they are usable on a phone.
- **No swipe gesture.** Deferred by decision — the chevrons work on touch, and adding
  a carousel to the stage would collide with `PanoramaViewer`'s own touch handling.
- Info panel: 360px drawer sliding from the right at `lg+`; bottom sheet below
  that. The stage gets `lg:mr-[360px]` while open so the image narrows rather than
  being covered, matching the reference. Open/closed state persisted in
  `localStorage`.
- Keyboard: existing `←` / `→` / `Esc` behaviour preserved; `i` toggles the panel.
- `document.body` gets `overflow-hidden` on mount, removed on unmount.
- Focus moves into the dialog on open and is restored to the originating
  thumbnail on close; `Tab` is trapped within the dialog.
- The `PanoramaViewer` branch for 360° photos is preserved unchanged.

### 7.4 Changed: `ui/src/views/PhotoList.vue`

The grid stops unmounting when a photo opens:

```html
<div v-if="!showPhotoUploader">…toolbar + justified grid…</div>
<UploadPhotos v-else … />
<PhotoDetail v-if="photoId" … />   <!-- overlays the grid -->
```

The `?photo=<id>` query parameter is unchanged, so deep links, `closePhotoDetail`
and browser-back keep working exactly as they do now.

### 7.5 Changed: `ui/src/components/Photo.vue`

The `grid` branch swaps `SquareImage` for the §6 aspect-ratio item and drops the
`onMounted` width measurement. The `detail` branch is untouched. `alt` text
improves from `photo image <key>` to the filename without its extension.

### 7.6 Changed: `ui/src/components/PhotoLocationMap.vue`

The hardcoded `id="photo-location-map"` plus `getElementById` is replaced by
`useId()` (Vue 3.5+) and a template ref.

**Why this is required, not incidental:** today the grid unmounts when the detail
view opens, so only one map can exist at a time. Once the grid stays mounted
beneath the lightbox, the toolbar's album Popover map and the lightbox's photo map
can be alive simultaneously, and `getElementById` would bind Mapbox to the wrong
node.

### 7.7 Changed: `ui/src/components/SkeletonPhotoList.vue`

The grid skeleton becomes rows of mixed-width blocks so the loading state matches
the justified layout instead of a square grid.

### 7.8 Unchanged

`SquareImage.vue` (still used by the list view, `Album.vue` and `Carousel.vue`),
`PanoramaViewer.vue`, all stores, all services, all schemas.

## 8. Data flow

```text
photoStore.photosInAlbum ──▶ PhotoList (flex-wrap container)
                                │
                                ├─▶ Photo × N
                                │     getRatio(key) ─▶ flex-grow / flex-basis
                                │     img @load ─────▶ setRatio(key, w, h) ─▶ localStorage
                                │
                                └─▶ PhotoDetail (Teleport, when ?photo= is set)
                                      ExifReader.load(url + '?tr=md-true')
                                      └─▶ PhotoInfoPanel (exifTags, natural dims)
                                            └─▶ PhotoLocationMap (useId)
```

## 9. Error handling

| Case | Behaviour |
| --- | --- |
| Thumbnail fails to load | The cell keeps its cached or default ratio and shows a neutral `bg-surface-200 dark:bg-surface-800` fill, so the row does not collapse or re-pack. (`NoImagePlaceholder.vue` exists in the tree but is referenced nowhere, so it is not relied on here.) |
| `localStorage` unavailable or corrupt | Caught; ratios stay in memory for the session. |
| `naturalWidth` or `naturalHeight` is 0 | `setRatio` rejects the value; the default ratio is retained. |
| EXIF missing or unreadable | Existing `try/catch` retained; info panel omits absent sections. Already covered by `photo-detail.spec.ts`. |
| Ratio outside `[0.4, 3.0]` | Clamped before storage. |

## 10. Testing

**New**

- `use-photo-aspect-ratios.spec.ts` — default ratio; clamping at both bounds;
  round-trip persistence; recovery from corrupt JSON; `localStorage` throwing on
  write; entry-cap pruning.
- `photo-info-panel.spec.ts` — each section renders only when its data is present;
  the map appears only with GPS EXIF; megapixel and file-size formatting.
- `photo.spec.ts` — grid item derives `flex-grow` / `flex-basis` from a cached
  ratio; falls back to 3:2 when uncached; `@load` writes through to the cache.

**Updated: `photo-detail.spec.ts`**

- Add: overlay renders with `role="dialog"`; info panel toggles via button and via
  `i`; body scroll lock applied on mount and removed on unmount; EXIF is requested
  with `md-true`.
- Preserve: keyboard navigation, photo-not-found toast, EXIF-absent handling.
- **Remove three tests** that assert on the deleted `imageStyles` computed —
  [`:289`](../../ui/src/components/__tests__/photo-detail.spec.ts#L289),
  [`:319`](../../ui/src/components/__tests__/photo-detail.spec.ts#L319),
  [`:342`](../../ui/src/components/__tests__/photo-detail.spec.ts#L342) — replaced by
  assertions on the rendered dimension string. The `1000 x 1000` text check at
  `:323` survives, relocated to the info panel.

No new query keys are introduced, so `ui/src/mocks/setup-query-mock.ts` needs no
new `case`.

**Commands**, from the repo root: `bun run type-check`, `bun run test:all`,
`bun run lint`, `bun run build`.

## 11. Accepted risks and deferred work

| Risk | Mitigation |
| --- | --- |
| Rows shift as ratios resolve on the first view of an album | 3:2 default reserves space; `localStorage` makes every later visit and reload stable; the first screenful loads eagerly with `fetchpriority="high"`. Accepted as a one-time-per-album effect — the alternative is a server-side dimension store (§4.1). |
| 500 `<img>` nodes in the DOM | `loading="lazy"` plus `decoding="async"`. Virtualisation is the answer if this proves insufficient — deferred. |
| Local development downloads full originals | Pre-existing behaviour of the raw-R2 dev CDN (§4.4). |
| Production EXIF may already be stripped | Verification task in §4.3, fixed by §7.3. |

**Deferred, each its own future piece of work**

1. Persist dimensions server-side (D1 `photos` table) to eliminate first-visit
   reflow. Requires migration, upload-path capture, move/rename/delete
   synchronisation, and a backfill for existing objects.
2. Per-photo reverse geocode for a place name above the map. Requires a new
   endpoint, a Geocoding API key scope, and caching.
3. Virtualised scrolling, if albums grow past ~500 photos.
