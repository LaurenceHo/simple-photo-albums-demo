import { z } from 'zod';

/**
 * GPS track schemas.
 *
 * A deliberate, separate copy of `server/src/types/gps-track.ts`. The two workspaces do
 * not import across the boundary - see CLAUDE.md - so this file has to be kept in step by
 * hand when the API shape changes.
 */

/** `[longitude, latitude]`, optionally with elevation. GeoJSON order: longitude first. */
export const PositionSchema = z.union([
  z.tuple([z.number(), z.number()]),
  z.tuple([z.number(), z.number(), z.number()]),
]);

export const TrackPropertiesSchema = z.object({
  name: z.string().optional(),
  startTime: z.string().optional(),
  endTime: z.string().optional(),
  distanceKm: z.number(),
  pointCount: z.number(),
  simplified: z.boolean(),
});

export const TrackGeometrySchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('LineString'), coordinates: z.array(PositionSchema) }),
  z.object({ type: z.literal('MultiLineString'), coordinates: z.array(z.array(PositionSchema)) }),
]);

export const TrackFeatureSchema = z.object({
  type: z.literal('Feature'),
  properties: TrackPropertiesSchema,
  geometry: TrackGeometrySchema,
});

/**
 * One row of the manifest: everything needed to draw a legend, with no geometry.
 *
 * `colour` is assigned by the server from the album's sorted track ids, so the legend
 * swatch and the map line can never disagree about a track's colour.
 */
export const TrackManifestEntrySchema = z.object({
  trackId: z.string(),
  colour: z.string(),
  size: z.number(),
  lastModified: z.string(),
});

export const TrackManifestSchema = z.array(TrackManifestEntrySchema);

export type Position = z.infer<typeof PositionSchema>;
export type TrackFeature = z.infer<typeof TrackFeatureSchema>;
export type TrackManifestEntry = z.infer<typeof TrackManifestEntrySchema>;
export type TrackManifest = z.infer<typeof TrackManifestSchema>;
