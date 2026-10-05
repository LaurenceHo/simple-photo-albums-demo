import { z } from 'zod';

/**
 * A photo as the API returns it.
 *
 * `latitude`, `longitude` and `takenAt` come from the photo's R2 custom metadata, written
 * by the server-side EXIF scan. All three are optional: a photo carrying no GPS EXIF, and
 * any photo not yet scanned, simply has no coordinates. Absent means "no pin on the map",
 * never "pin at zero".
 *
 * This is a deliberate duplicate of `server/src/types/photo.ts` — the two workspaces never
 * import from each other, so both copies must be changed together.
 */
export const PhotoSchema = z.object({
  url: z.string(),
  key: z.string(), // `${albumId}/${photoId}`
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

/**
 * What the EXIF scan did with one photo.
 *
 * `noGps` is a success, not a failure: the photo was read and genuinely carries no
 * location. Reported separately from `located` so the scan can say how many photos had
 * nothing to find rather than implying something went wrong.
 *
 * Mirrors `PhotoMetadataResult` in `server/src/types/api-response.ts`.
 */
export const PhotoMetadataResultSchema = z.object({
  photoKey: z.string(),
  status: z.enum(['located', 'noGps', 'notFound', 'failed']),
  latitude: z.number().optional(),
  longitude: z.number().optional(),
  takenAt: z.string().optional(),
  message: z.string().optional(),
});

export type PhotoMetadataResult = z.infer<typeof PhotoMetadataResultSchema>;
