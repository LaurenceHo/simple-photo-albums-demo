import { z } from 'zod';
import { AlbumSchema } from './album';
import { TravelRecordSchema } from './travel-record';

export const CreateAlbumSchema = AlbumSchema.omit({
  createdAt: true,
  createdBy: true,
  updatedAt: true,
  updatedBy: true,
});
export const UpdateAlbumSchema = AlbumSchema.omit({
  createdAt: true,
  createdBy: true,
  updatedAt: true,
  updatedBy: true,
});

export const DeleteAlbumSchema = z.object({
  id: z.string(),
  year: z.string(),
});

export const CreateTagSchema = z.array(
  z.object({
    tag: z.string(),
  }),
);

export const LocationSearchSchema = z.object({
  // Mapbox's own docs claim `q` is capped at 256 characters, but that is wrong: live
  // probing of https://api.mapbox.com/search/searchbox/v1/forward found 200 chars
  // accepted and 250+ rejected, with the API's own error message naming the real limit -
  // {"message":"Query exceeded character limit of 200"}. Do not "correct" this back to
  // 256 from the docs. Without this bound, a query in the 201-256 range would reach
  // Mapbox, get its own 400, and surface to the client as a generic 500 ("Failed to fetch
  // location data") instead of a proper 400 at the validation layer.
  textQuery: z.string().min(1).max(200),
});

export const CreateTravelRecordSchema = TravelRecordSchema.omit({
  createdAt: true,
  createdBy: true,
  updatedAt: true,
  updatedBy: true,
});
export const UpdateTravelRecordSchema = TravelRecordSchema.omit({
  createdAt: true,
  createdBy: true,
  updatedAt: true,
  updatedBy: true,
});

/**
 * Inferred request types, for typing handler parameters as
 * `ValidatedJsonContext<...>` so `c.req.valid('json')` is available and typed.
 *
 * Each omits the audit fields, which the server sets from the JWT - a client must not
 * be able to supply `createdBy`/`updatedBy`.
 */
export type CreateAlbumRequest = z.infer<typeof CreateAlbumSchema>;
export type UpdateAlbumRequest = z.infer<typeof UpdateAlbumSchema>;
export type DeleteAlbumRequest = z.infer<typeof DeleteAlbumSchema>;
export type CreateTagRequest = z.infer<typeof CreateTagSchema>;
export type LocationSearchRequest = z.infer<typeof LocationSearchSchema>;
export type CreateTravelRecordRequest = z.infer<typeof CreateTravelRecordSchema>;
export type UpdateTravelRecordRequest = z.infer<typeof UpdateTravelRecordSchema>;
