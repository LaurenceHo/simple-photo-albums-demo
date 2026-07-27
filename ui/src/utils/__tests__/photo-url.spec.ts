import {
  detailThumbnailUrl,
  filmstripThumbnailUrl,
  photoFileName,
  sharedPhotoUrl,
  thumbnailSrcSet,
  thumbnailUrl,
} from '@/utils/photo-url';
import { describe, expect, it } from 'vitest';

const BASE = 'https://ik.imagekit.io/abc/album-1/photo.jpg';

describe('photo-url', () => {
  it('requests a height-only thumbnail so ImageKit preserves the aspect ratio', () => {
    expect(thumbnailUrl(BASE)).toBe(`${BASE}?tr=h-320`);
  });

  it('requests a fixed width AND height for the filmstrip, so ImageKit centre-crops a uniform box', () => {
    // Two dimensions (unlike the height-only grid thumbnail above) is deliberate:
    // the filmstrip is a uniform index of identically-sized boxes, so a portrait
    // photo must crop to the same box a landscape photo does, not stay 3x narrower.
    expect(filmstripThumbnailUrl(BASE)).toBe(`${BASE}?tr=w-288,h-192`);
  });

  it('builds a filmstrip thumbnail url correctly when the url already has a query string', () => {
    const signed = `${BASE}?token=xyz`;
    expect(filmstripThumbnailUrl(signed)).toBe(`${signed}&tr=w-288,h-192`);
  });

  it('offers a 2x thumbnail via srcset', () => {
    expect(thumbnailSrcSet(BASE)).toBe(`${BASE}?tr=h-320 1x, ${BASE}?tr=h-640 2x`);
  });

  it('appends with & when the url already has a query string', () => {
    const signed = `${BASE}?token=xyz`;
    expect(thumbnailUrl(signed)).toBe(`${signed}&tr=h-320`);
  });

  it('returns an empty string unchanged rather than producing a bare query string', () => {
    expect(thumbnailUrl('')).toBe('');
    expect(sharedPhotoUrl('')).toBe('');
    expect(filmstripThumbnailUrl('')).toBe('');
  });

  it('returns an empty srcset rather than a malformed " 1x,  2x" candidate list', () => {
    // The guard inside withTransformation is not enough here: composing two empty
    // results into a template literal would still emit descriptors.
    expect(thumbnailSrcSet('')).toBe('');
  });

  it('builds a srcset correctly when the url already has a query string', () => {
    const signed = `${BASE}?token=xyz`;
    expect(thumbnailSrcSet(signed)).toBe(`${signed}&tr=h-320 1x, ${signed}&tr=h-640 2x`);
  });

  describe('sharedPhotoUrl', () => {
    it('requests the full-resolution, metadata-preserving image - no dimension transform', () => {
      // `md-true` only, deliberately no `h-`/`w-` transform: this URL backs the
      // lightbox `<img>`, the EXIF read, and PanoramaViewer, so `naturalWidth`/
      // `naturalHeight` must reflect the true original resolution, not a
      // downscaled copy. `md-true` keeps the EXIF/date/camera/GPS tags the info
      // panel reads working.
      expect(sharedPhotoUrl(BASE)).toBe(`${BASE}?tr=md-true`);
    });

    it('appends with & when the url already has a query string', () => {
      const signed = `${BASE}?token=xyz`;
      expect(sharedPhotoUrl(signed)).toBe(`${signed}&tr=md-true`);
    });

    it('returns an empty string unchanged rather than producing a bare query string', () => {
      expect(sharedPhotoUrl('')).toBe('');
    });
  });

  describe('detailThumbnailUrl', () => {
    it('requests a fixed square box, matching the size the list row asked for', () => {
      expect(detailThumbnailUrl(BASE, 80)).toBe(`${BASE}?tr=w-80,h-80`);
      expect(detailThumbnailUrl(BASE, 100)).toBe(`${BASE}?tr=w-100,h-100`);
    });

    it('appends with & rather than a second ? when the url already has a query string', () => {
      // This is the exact bug the hand-built `${url}?tr=...` string in Photo.vue
      // had: a second bare `?` produces a malformed URL. Routing through the
      // shared `withTransformation` builder (like every other builder in this
      // file) is what fixes it.
      const signed = `${BASE}?token=xyz`;
      expect(detailThumbnailUrl(signed, 80)).toBe(`${signed}&tr=w-80,h-80`);
    });

    it('returns an empty string unchanged rather than producing a bare query string', () => {
      expect(detailThumbnailUrl('', 80)).toBe('');
    });
  });

  describe('photoFileName', () => {
    it('strips the <albumId>/ prefix from a well-formed key', () => {
      expect(photoFileName('album/photo.jpg')).toBe('photo.jpg');
    });

    it('only strips the first segment, for a key with extra path segments', () => {
      expect(photoFileName('album/sub/photo.jpg')).toBe('sub');
    });

    it('falls back to an empty string for a key with no /, rather than undefined', () => {
      // Plain `key.split('/')[1]` is undefined here, and callers that feed the
      // result into a regex `.replace()` (the alt-text helper) would throw.
      expect(photoFileName('photo.jpg')).toBe('');
    });

    it('falls back to an empty string for a key with a trailing / and nothing after it', () => {
      expect(photoFileName('album/')).toBe('');
    });
  });
});
