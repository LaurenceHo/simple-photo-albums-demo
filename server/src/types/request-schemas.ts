import { z } from 'zod';
import { safeR2Segment } from './api-response';
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

/**
 * Body for `DELETE /api/albums`.
 *
 * `id` is guarded rather than a bare string because the handler feeds it straight into an
 * R2 prefix. A plain `z.string()` admitted `''`, which made the track cleanup empty the
 * bare `gps-tracks/` prefix - every album's tracks, from a request that named none of
 * them, answered with 200. Same class of bug as `MovePhotosRequestSchema` in
 * `api-response.ts`.
 */
export const DeleteAlbumSchema = z.object({
  id: safeR2Segment('id'),
  year: z.string(),
});

export const CreateTagSchema = z.array(
  z.object({
    tag: z.string(),
  }),
);

export const LocationSearchSchema = z.object({
  // A defensive bound on an admin typeahead, not a vendor limit: Google publishes no
  // character cap for `textQuery`. The 200 was measured against Mapbox, which this no
  // longer calls, and is kept only because nothing legitimate types a 200-character place
  // name and an unbounded field would forward junk to a billed endpoint. Without a bound
  // here, an over-long query would surface as a generic 500 ("Failed to fetch location
  // data") instead of a 400 at the validation layer.
  textQuery: z.string().min(1).max(200),
});

export const FlightLegsQuerySchema = z.object({
  // Restricted because it ends up in a billed provider URL: a flight number is a 2-3
  // character airline designator, an optional space, 1-4 digits and an optional suffix
  // letter (VN786, TR 867, 3K123, QF1). Anything else - `../x`, `?a=b` - is refused here.
  flightNumber: z
    .string()
    .trim()
    .regex(/^[A-Z0-9]{2,3} ?\d{1,4}[A-Z]?$/i),
  // The calendar date the traveller picked, already local - not an ISO instant. `z.iso.date()`
  // also rejects impossible dates such as 2026-99-99, which the provider would answer with
  // an error that surfaced as a 500.
  date: z.iso.date(),
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
export type FlightLegsQuery = z.infer<typeof FlightLegsQuerySchema>;
export type UpdateTravelRecordRequest = z.infer<typeof UpdateTravelRecordSchema>;
