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
  textQuery: z.string().min(1),
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
