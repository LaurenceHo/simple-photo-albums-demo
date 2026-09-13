import { z } from 'zod';
import { safeR2Segment } from './api-response';

/**
 * Ceiling on an uploaded GPX.
 *
 * Set by the parser's memory cost, not by the photo upload cap it used to copy. Building
 * a DOM for a GPX costs far more than the file itself - measured with the pinned
 * `@xmldom/xmldom`, one process per sample:
 *
 * | GPX   | `<trkpt>` | DOM heap |
 * | ----- | --------- | -------- |
 * | 1 MB  |    16,384 |   +31 MB |
 * | 2 MB  |    32,768 |   +39 MB |
 * | 4 MB  |    65,536 |  +121 MB |
 * | 10 MB |   163,840 |  +290 MB |
 *
 * A Worker isolate is capped at 128 MB, and the DOM is only part of what is live at that
 * moment: the buffered request body and its JSON-parsed copy are too. The old 10 MB cap
 * admitted a file whose DOM alone is twice the isolate.
 *
 * Those numbers come from Bun's JSC heap rather than workerd's V8, so they do not
 * transfer exactly - but the margin is far wider than an allocator difference explains,
 * and nothing in the test suite can catch it: `vitest.config.mts` runs plain vitest, not
 * `@cloudflare/vitest-pool-workers`.
 *
 * 2 MB costs nothing in fidelity. Anything past `MAX_SIMPLIFY_INPUT_POINTS` (20,000
 * points, roughly this size) is thinned before simplification anyway, so a larger file
 * yields exactly the same stored track - it just builds a bigger DOM to get there.
 *
 * Measured in UTF-16 code units rather than bytes, which is what `z.string().max()`
 * counts. GPX is overwhelmingly ASCII, so the two are the same in practice.
 */
export const MAX_GPX_LENGTH = 2 * 1024 * 1024;

/**
 * A GeoJSON position: `[longitude, latitude]`, optionally with elevation in metres.
 *
 * Note the order. GeoJSON is longitude first; GPX attributes are `lat` and `lon`. Getting
 * the two the wrong way round puts a New Zealand track in Somalia without erroring, so the
 * conversion happens in exactly one place - `parseGpxToFeature`.
 */
export const PositionSchema = z.union([
  z.tuple([z.number(), z.number()]),
  z.tuple([z.number(), z.number(), z.number()]),
]);

/**
 * Summary values lifted out of the GPX so the UI can label a track without downloading
 * its geometry.
 *
 * `name` comes from the GPX's own `<trk><name>` when it has one. It is deliberately
 * optional: the track's label in the UI is its `trackId` (the uploaded filename stem),
 * which is usually more meaningful than a device-generated "ACTIVE LOG".
 */
export const TrackPropertiesSchema = z.object({
  name: z.string().optional(),
  startTime: z.string().optional(),
  endTime: z.string().optional(),
  /** Great-circle length of the track, summed over the points as recorded. */
  distanceKm: z.number(),
  /** Points in the geometry as returned - after simplification, not before. */
  pointCount: z.number(),
  /** True when simplification actually dropped points. */
  simplified: z.boolean(),
});

export const LineStringGeometrySchema = z.object({
  type: z.literal('LineString'),
  coordinates: z.array(PositionSchema),
});

export const MultiLineStringGeometrySchema = z.object({
  type: z.literal('MultiLineString'),
  coordinates: z.array(z.array(PositionSchema)),
});

export const TrackGeometrySchema = z.discriminatedUnion('type', [
  LineStringGeometrySchema,
  MultiLineStringGeometrySchema,
]);

/**
 * One GPX track as a GeoJSON Feature. This is the shape stored at
 * `gps-tracks/<albumId>/<trackId>.geojson` and served by the per-track endpoint.
 *
 * A single-segment track becomes a `LineString`; a multi-segment one becomes a
 * `MultiLineString`, so a GPS dropout is a genuine gap in the rendered line rather than a
 * straight edge joining the two sides of it.
 */
export const TrackFeatureSchema = z.object({
  type: z.literal('Feature'),
  properties: TrackPropertiesSchema,
  geometry: TrackGeometrySchema,
});

/**
 * Body for `POST /api/albums/:albumId/gps-tracks`.
 *
 * The GPX arrives as a JSON string field rather than a raw XML body so that
 * `@hono/zod-validator` applies here exactly as it does on every other route. A raw body
 * would need its own size and content checks written by hand.
 *
 * `trackId` reuses the photo routes' traversal guard: it lands in an R2 key, so the same
 * rules apply.
 */
export const CreateGpsTrackSchema = z.object({
  trackId: safeR2Segment('trackId'),
  gpx: z.string().min(1).max(MAX_GPX_LENGTH),
});

export type Position = z.infer<typeof PositionSchema>;
export type TrackProperties = z.infer<typeof TrackPropertiesSchema>;
export type TrackGeometry = z.infer<typeof TrackGeometrySchema>;
export type TrackFeature = z.infer<typeof TrackFeatureSchema>;
export type CreateGpsTrackRequest = z.infer<typeof CreateGpsTrackSchema>;
