import { z } from 'zod';

/**
 * A photo as the API returns it.
 *
 * `latitude`, `longitude` and `takenAt` come from the object's R2 custom metadata, which
 * the EXIF scan writes. They are optional because a photo is only scanned once, and
 * because a photo may simply carry no GPS EXIF at all: absent means "no pin", never
 * "pin at zero". The bounds are the real coordinate ranges, so a corrupted metadata
 * value is rejected here as well as at the point it is parsed.
 */
export const PhotoSchema = z.object({
  url: z.string().min(1),
  key: z.string().min(1),
  size: z.number().optional(),
  lastModified: z.string().optional(),
  latitude: z.number().min(-90).max(90).optional(),
  longitude: z.number().min(-180).max(180).optional(),
  takenAt: z.string().optional(),
  /**
   * Whether the EXIF scan found GPS in this photo.
   *
   * Three-valued on purpose: `true` and `false` both mean "scanned", while **absent**
   * means "never scanned". Without that distinction a photo that genuinely carries no
   * location is indistinguishable from one not yet read, and every re-scan would read
   * every un-located photo again, forever.
   *
   * Read it as "scanned", not as "has a location": a photo scanned before zeroed (0, 0)
   * fixes were rejected comes back `true` with no coordinates.
   */
  hasGps: z.boolean().optional(),
});

export type Photo = z.infer<typeof PhotoSchema>;
