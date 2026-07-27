/**
 * ImageKit URL builders, plus `photoFileName` - the one non-URL helper here.
 * Every builder below and `photoFileName` both start from the same photo
 * (its `url`, or its `<albumId>/<file>` `key`), so this is the single home
 * for photo-key-derived strings rather than splitting that concern into a
 * second utils file.
 *
 * ImageKit resizes only when a `tr` transformation is present, and it preserves
 * the source aspect ratio only when a single dimension is given — `h-320` yields
 * a 320px-tall image at its natural width, whereas `w-320,h-320` centre-crops to
 * a square. It also strips all metadata by default, including EXIF GPS, unless
 * `md-true` is set.
 *
 * In development `VITE_IMAGEKIT_CDN_URL` points at a raw R2 bucket, which ignores
 * these parameters and serves the original. That is expected.
 */

/**
 * File name portion of a photo's `<albumId>/<file>` R2 key, with the album id
 * prefix stripped.
 *
 * Falls back to `''` for a malformed key with no `/`, rather than `undefined`:
 * plain `key.split('/')[1]` is `undefined` on such input, and feeding that into
 * a `.replace()` call (as the alt-text helper does) would throw.
 */
export const photoFileName = (key: string): string => key.split('/')[1] ?? '';

/** Thumbnail height in CSS pixels; covers the largest row height at 1x. */
const THUMBNAIL_HEIGHT = 320;

/** Thumbnail height for 2x displays. */
const THUMBNAIL_HEIGHT_2X = 640;

/**
 * Filmstrip thumbnail box, at 2x of the 144x96 (`sm+`) CSS box so it stays sharp on
 * HiDPI screens. Unlike the grid thumbnail, this specifies *both* dimensions on
 * purpose: a single dimension preserves the source aspect ratio (right for the
 * justified grid), but the filmstrip needs every thumbnail to be an identical
 * fixed box regardless of the source photo's orientation, which requires
 * ImageKit to centre-crop server-side. One box size is reused at every
 * breakpoint (the smaller `below-sm` box is just this same image scaled down by
 * CSS), so only one cropped variant is ever cached.
 */
const FILMSTRIP_THUMBNAIL_WIDTH = 288;
const FILMSTRIP_THUMBNAIL_HEIGHT = 192;

/**
 * Append an ImageKit transformation to a photo URL.
 *
 * @param url Base CDN URL. An empty value is returned unchanged.
 * @param transformation `tr` value, for example `h-320`.
 * @returns The URL with the transformation appended.
 */
const withTransformation = (url: string, transformation: string): string => {
  if (!url) {
    return url;
  }
  const separator = url.includes('?') ? '&' : '?';
  return `${url}${separator}tr=${transformation}`;
};

/** Grid thumbnail: height-constrained so the aspect ratio survives. */
export const thumbnailUrl = (url: string): string =>
  withTransformation(url, `h-${THUMBNAIL_HEIGHT}`);

/**
 * Lightbox filmstrip thumbnail: a fixed, centre-cropped box (both `w` and `h`
 * given), not an aspect-preserving thumbnail - the filmstrip is a uniform index
 * of identically-sized boxes, not a justified layout, so a portrait photo must
 * crop to the same box a landscape photo does rather than rendering 3x narrower.
 */
export const filmstripThumbnailUrl = (url: string): string =>
  withTransformation(url, `w-${FILMSTRIP_THUMBNAIL_WIDTH},h-${FILMSTRIP_THUMBNAIL_HEIGHT}`);

/**
 * List-row thumbnail: a fixed, centre-cropped square (both `w` and `h` given,
 * same value) matching `SquareImage`'s own fixed CSS box for the detail/list
 * layout. `size` is device-dependent (a smaller box on narrow screens), so
 * this takes it as a parameter rather than a module constant like the two
 * builders above.
 */
export const detailThumbnailUrl = (url: string, size: number): string =>
  withTransformation(url, `w-${size},h-${size}`);

/**
 * `srcset` using `x` descriptors, which depend only on device pixel ratio.
 *
 * The empty-URL guard has to be repeated here: `withTransformation` returns ''
 * unchanged, but composing two of those into a template literal would yield
 * " 1x,  2x" — a malformed candidate list — rather than ''.
 */
export const thumbnailSrcSet = (url: string): string => {
  if (!url) {
    return url;
  }
  const oneX = withTransformation(url, `h-${THUMBNAIL_HEIGHT}`);
  const twoX = withTransformation(url, `h-${THUMBNAIL_HEIGHT_2X}`);
  return `${oneX} 1x, ${twoX} 2x`;
};

/**
 * Full-resolution, metadata-preserving photo URL. The single builder behind
 * every `PhotoDetail.vue` call site that needs this photo's actual bytes: the
 * `<img>` `src`, `ExifReader.load`, and `PanoramaViewer`'s `imageUrl`.
 *
 * Two invariants, both load-bearing:
 *
 * - **All three call sites must use this one builder.** Two different query
 *   strings are two different browser cache keys, so a second builder means a
 *   second full download of the same photo per view. The "same URL" test in
 *   `photo-detail.spec.ts` guards this.
 * - **No dimension transform.** `naturalWidth`/`naturalHeight` are read off
 *   this `<img>` to render `PhotoInfoPanel`'s "W x H" and megapixels, so a
 *   downscale here silently understates both. `md-true` alone, keeping the EXIF
 *   ImageKit strips by default. A downscale was tried and reverted — design doc
 *   §4.7 has the measured trade-off and what it would take to revisit.
 *
 * In development, `VITE_IMAGEKIT_CDN_URL` points at the raw R2 bucket, which
 * ignores `tr` params entirely — every call site still resolves to the
 * identical string there, so the de-duplication holds in local dev too.
 */
export const sharedPhotoUrl = (url: string): string => withTransformation(url, 'md-true');
