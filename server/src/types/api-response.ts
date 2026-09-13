import { z } from 'zod';
import { Album } from './album';
import { PhotoSchema } from './photo';

export const PhotoResponseSchema = z.object({
  photos: z.array(PhotoSchema),
  album: z.custom<Album>(),
});

/**
 * A single R2 key segment.
 *
 * Every photo key is composed as `<albumId>/<photoKey>`, so a segment containing a
 * path separator or resolving to a parent lets a request address objects outside the
 * album prefix - copying, deleting, or minting a presigned upload URL for an
 * arbitrary bucket key.
 *
 * This forbids the traversal constructs rather than allowlisting characters, on
 * purpose: existing photo filenames in R2 may legitimately contain spaces, brackets
 * or non-ASCII characters, and an allowlist would break moving or deleting them.
 */
export const safeR2Segment = (label: string) =>
  z
    .string()
    .min(1)
    .refine((value) => !/[/\\]/.test(value) && value !== '.' && value !== '..', {
      message: `${label} must not contain a path separator or refer to a parent directory`,
    });

/**
 * Body for `DELETE /api/photos`. No destination - delete only needs to know what to
 * remove.
 */
export const PhotosRequestSchema = z.object({
  albumId: safeR2Segment('albumId'),
  destinationAlbumId: safeR2Segment('destinationAlbumId').optional(),
  photoKeys: z.array(safeR2Segment('photoKey')),
});

/**
 * Body for `PUT /api/photos` (move), where `destinationAlbumId` is **required**.
 *
 * Separate from `PhotosRequestSchema` because the move handler copies to
 * `${destinationAlbumId}/${photoKey}` and then deletes the source. With the field merely
 * optional, a request omitting it copied every photo to the literal prefix
 * `undefined/`, `r2Service.copy` reported success, and the originals were deleted -
 * silently relocating photos to a garbage prefix. The UI never sent such a request, but
 * the contract permitted it.
 */
export const MovePhotosRequestSchema = PhotosRequestSchema.extend({
  destinationAlbumId: safeR2Segment('destinationAlbumId'),
});

export const RenamePhotoRequestSchema = z.object({
  albumId: safeR2Segment('albumId'),
  newPhotoKey: safeR2Segment('newPhotoKey'),
  currentPhotoKey: safeR2Segment('currentPhotoKey'),
});

/**
 * Query for `POST /api/photos/upload/:albumId`.
 *
 * `mimeType` is an enum rather than a free string because it is passed straight into
 * the presigned PUT's `ContentType`. An unconstrained value lets an admin publish
 * `text/html` to a public CDN origin, which is stored XSS on the CDN hostname.
 */
export const UploadPhotoQuerySchema = z.object({
  filename: safeR2Segment('filename'),
  mimeType: z.enum(['image/jpeg', 'image/png', 'image/webp', 'image/avif', 'image/gif']),
});

const ResponseStatusSchema = z.object({
  code: z.number(),
  status: z.string(),
  message: z.string().optional(),
});

// eslint-disable-next-line @typescript-eslint/no-unused-vars
const ApiResponseSchema = ResponseStatusSchema.extend({
  data: z.any().optional(),
});

export type RenamePhotoRequest = z.infer<typeof RenamePhotoRequestSchema>;
export type PhotosRequest = z.infer<typeof PhotosRequestSchema>;
export type MovePhotosRequest = z.infer<typeof MovePhotosRequestSchema>;
export type UploadPhotoQuery = z.infer<typeof UploadPhotoQuerySchema>;
export type PhotoResponse = z.infer<typeof PhotoResponseSchema>;
export type ResponseStatus = z.infer<typeof ResponseStatusSchema>;
export type ApiResponse<T> = z.infer<typeof ApiResponseSchema> & { data?: T };
