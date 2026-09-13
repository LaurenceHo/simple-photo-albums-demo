import { DOMParser, type Document, type Element } from '@xmldom/xmldom';
import { Position, TrackFeature, TrackGeometry, TrackProperties } from '../types/gps-track';
import { haversineDistance } from './helpers';

/**
 * Ceiling on the points in a stored track.
 *
 * A phone or watch recording at 1 Hz produces tens of thousands of points for a day's
 * walking, which no map can render distinguishably and every viewer would have to
 * download. Simplification runs once, on upload, so the cost is never paid per view.
 */
export const MAX_TRACK_POINTS = 5000;

/**
 * Ceiling on the points Douglas-Peucker is allowed to see in one call.
 *
 * Its cost is O(n log n) when the recursion splits evenly but O(n^2) when it does not,
 * and a track that alternates side to side - a poor urban recording, or a zig-zag descent
 * - is exactly the shape that splits at an end every time. Measured on the shipped
 * implementation: 8,000 such points took 460 ms for a single pass and 15,000 took 1.4 s.
 *
 * Anything above this is thinned uniformly first. The thinning is crude, but it only ever
 * applies to a track already four times denser than anything that will be stored, and it
 * puts a ceiling on the pass: the slowest input found while tuning this was 60,000 zig-zag
 * points at 4.8 s, which thins to the full 20,000 and stays alternating. Real recordings
 * split evenly and cost far less - 200,000 points measured at 0.6 s.
 */
const MAX_SIMPLIFY_INPUT_POINTS = 20_000;

/**
 * A GPX file that cannot be turned into a track.
 *
 * Thrown rather than returned so the controller can map it to a 400: every case is the
 * uploaded file's fault, not the server's.
 */
export class GpxParseError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'GpxParseError';
  }
}

/**
 * Elements anywhere under `root` whose local name matches, regardless of namespace.
 *
 * `getElementsByTagName` is not enough: it matches on the qualified name, so it finds
 * nothing in a GPX that uses a namespace prefix (`<g:trkpt>`). Both the unprefixed and
 * default-namespaced forms are far more common, but prefixed files exist and fail
 * silently - an empty track rather than an error.
 */
const byLocalName = (root: Document | Element, localName: string): Element[] =>
  Array.from(root.getElementsByTagNameNS('*', localName));

/** Text of the first direct child with this local name, trimmed; undefined when absent. */
const childText = (parent: Element, localName: string): string | undefined => {
  for (const child of Array.from(parent.childNodes)) {
    const element = child as Element;
    if (element.localName === localName) {
      const text = element.textContent?.trim();
      return text || undefined;
    }
  }
  return undefined;
};

/**
 * One `<trkpt>`/`<rtept>` as a GeoJSON position, or null when unusable.
 *
 * Null rather than throwing: a single corrupt point in a five-thousand-point track should
 * not cost the whole upload. `parseGpxToFeature` throws only when *no* valid point
 * survives, which is the case that really means "this is not a track".
 */
const toPosition = (point: Element): Position | null => {
  const rawLatitude = point.getAttribute('lat');
  const rawLongitude = point.getAttribute('lon');

  // Checked before conversion because `Number(null)` and `Number('')` are both 0, not
  // NaN. A `<trkpt/>` with no coordinates therefore passed every check below as a valid
  // point at [0, 0] - which dragged the line to the Gulf of Guinea, added ~16,000 km to
  // the reported distance, and zoomed the map out to the whole planet.
  if (!rawLatitude?.trim() || !rawLongitude?.trim()) return null;

  const latitude = Number(rawLatitude);
  const longitude = Number(rawLongitude);

  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
  if (latitude < -90 || latitude > 90) return null;
  if (longitude < -180 || longitude > 180) return null;

  const elevation = Number(childText(point, 'ele'));
  return Number.isFinite(elevation)
    ? [longitude, latitude, elevation]
    : [longitude, latitude];
};

/**
 * Perpendicular distance from `point` to the segment `start`-`end`, in degrees.
 *
 * Planar rather than great-circle on purpose. This value is only ever compared against a
 * tolerance to decide whether a point is worth keeping, so the projection error is
 * irrelevant and a haversine call per candidate point would make simplification far more
 * expensive than the work it saves.
 */
const perpendicularDistance = (point: Position, start: Position, end: Position): number => {
  const [pointX, pointY] = point;
  const [startX, startY] = start;
  const [endX, endY] = end;

  const deltaX = endX - startX;
  const deltaY = endY - startY;

  if (deltaX === 0 && deltaY === 0) {
    return Math.hypot(pointX - startX, pointY - startY);
  }

  const projection =
    ((pointX - startX) * deltaX + (pointY - startY) * deltaY) / (deltaX ** 2 + deltaY ** 2);
  const clamped = Math.max(0, Math.min(1, projection));

  return Math.hypot(
    pointX - (startX + clamped * deltaX),
    pointY - (startY + clamped * deltaY),
  );
};

/** The point in `(startIndex, endIndex)` furthest from that chord, or -1 if none deviates. */
const furthestFrom = (
  points: Position[],
  startIndex: number,
  endIndex: number,
): { index: number; distance: number } => {
  const start = points[startIndex];
  const end = points[endIndex];
  if (!start || !end) return { index: -1, distance: 0 };

  let furthestDistance = 0;
  let furthestIndex = -1;

  for (let index = startIndex + 1; index < endIndex; index += 1) {
    const candidate = points[index];
    if (!candidate) continue;

    const distance = perpendicularDistance(candidate, start, end);
    if (distance > furthestDistance) {
      furthestDistance = distance;
      furthestIndex = index;
    }
  }

  return { index: furthestIndex, distance: furthestDistance };
};

/**
 * Score every point by the Douglas-Peucker tolerance at which it would survive.
 *
 * This is the usual algorithm turned inside out. Rather than taking a tolerance and
 * returning the points above it, it runs the same recursion to completion once and records
 * each point's deviation from the chord it was split from. Keeping every point scoring
 * above some value then produces exactly the set that tolerance would have produced - so
 * the caller can pick a point budget directly instead of searching for the tolerance that
 * happens to meet it.
 *
 * That search is what this replaces, and it was the expensive part: the previous code ran
 * a full pass per candidate tolerance, doubling up to sixty times, each pass starting again
 * from the original points. A 15,000-point zig-zag took 50 seconds of CPU that way, from a
 * file well inside the upload cap of the time; the same track now costs one pass, at 2.6 s.
 *
 * An explicit stack rather than recursion: a long ride can nest deeply enough to overflow
 * the call stack, and a Worker gives no useful diagnostic when it does.
 *
 * The first and last points score `Infinity`, so a simplified track always starts and ends
 * exactly where it was recorded.
 */
const significanceOf = (points: Position[]): number[] => {
  const significance = new Array<number>(points.length).fill(0);
  if (points.length === 0) return significance;

  significance[0] = Infinity;
  significance[points.length - 1] = Infinity;
  if (points.length <= 2) return significance;

  // Each frame carries its parent's score as a ceiling.
  const stack: Array<[number, number, number]> = [[0, points.length - 1, Infinity]];

  while (stack.length > 0) {
    const range = stack.pop();
    if (!range) break;

    const [startIndex, endIndex, ceiling] = range;
    const { index: furthestIndex, distance: furthestDistance } = furthestFrom(
      points,
      startIndex,
      endIndex,
    );

    // Every remaining point sits exactly on the chord, so none of them carries shape.
    if (furthestIndex === -1) continue;

    // Clamped to the parent's score so significance never grows as the tree deepens. A
    // point cannot outlive a tolerance that already discarded the range containing it,
    // and without this the kept set would not be a valid Douglas-Peucker result.
    const score = Math.min(furthestDistance, ceiling);
    significance[furthestIndex] = score;
    stack.push([startIndex, furthestIndex, score], [furthestIndex, endIndex, score]);
  }

  return significance;
};

/** Thin a segment to `limit` points, keeping the first and last. */
const decimateTo = (points: Position[], limit: number): Position[] => {
  if (points.length <= limit) return points;

  const step = points.length / limit;
  const kept: Position[] = [];

  for (let index = 0; index < limit - 1; index += 1) {
    const point = points[Math.floor(index * step)];
    if (point) kept.push(point);
  }

  const last = points.at(-1);
  if (last) kept.push(last);

  return kept;
};

/** Reduce a track to `MAX_TRACK_POINTS`, or reject it when that is impossible. */
const simplifySegments = (segments: Position[][]): Position[][] => {
  const total = (candidate: Position[][]) =>
    candidate.reduce((sum, segment) => sum + segment.length, 0);

  if (total(segments) <= MAX_TRACK_POINTS) return segments;

  /*
   * Rejected rather than stored oversize.
   *
   * The first and last point of every segment are always kept, so `2 x segmentCount` is
   * the floor however hard the track is simplified - a file with more segments than half
   * the budget can never fit inside it. Checked before any of the work below, because no
   * amount of it can change the answer.
   *
   * The previous code had no such check: it returned its last attempt regardless, which
   * stored and served geometry well past the advertised ceiling, and when no point had
   * been dropped it reported `simplified: false` too - claiming the file was under a cap
   * it had just blown through. A 400 naming the problem is better than silently discarding
   * segments, since the upload is admin-initiated and the file can simply be re-exported.
   */
  if (segments.length * 2 > MAX_TRACK_POINTS) {
    throw new GpxParseError(
      `This GPX has ${segments.length} separate track segments, which cannot be reduced to ` +
        `${MAX_TRACK_POINTS} points. Export it as fewer, longer segments.`,
    );
  }

  // Bound the input so the scoring pass below cannot go quadratic on a huge track.
  const inputTotal = total(segments);
  const bounded =
    inputTotal <= MAX_SIMPLIFY_INPUT_POINTS
      ? segments
      : segments.map((segment) =>
          decimateTo(
            segment,
            Math.max(2, Math.floor((segment.length * MAX_SIMPLIFY_INPUT_POINTS) / inputTotal)),
          ),
        );

  /*
   * Score once, then keep the best `MAX_TRACK_POINTS` across the whole track.
   *
   * Ranking globally rather than giving each segment its own share is deliberate, and
   * carries over the intent of the shared tolerance this replaces: a long segment and a
   * short one in the same file end up at the same fidelity, instead of the short one being
   * held to a tolerance that would have smoothed the long one flat.
   */
  const scores = bounded.map(significanceOf);
  const candidates: Array<[segment: number, point: number, score: number]> = [];

  bounded.forEach((segment, segmentIndex) => {
    segment.forEach((_, pointIndex) => {
      candidates.push([segmentIndex, pointIndex, scores[segmentIndex]?.[pointIndex] ?? 0]);
    });
  });

  // The equality arm matters: endpoints all score `Infinity`, and `Infinity - Infinity` is
  // NaN, which makes a comparator return garbage and the sort order implementation-defined.
  candidates.sort((a, b) => (a[2] === b[2] ? 0 : b[2] - a[2]));

  const keep = bounded.map((segment) => new Array<boolean>(segment.length).fill(false));
  for (const [segmentIndex, pointIndex] of candidates.slice(0, MAX_TRACK_POINTS)) {
    const flags = keep[segmentIndex];
    if (flags) flags[pointIndex] = true;
  }

  return bounded.map((segment, segmentIndex) =>
    segment.filter((_, pointIndex) => keep[segmentIndex]?.[pointIndex] === true),
  );
};

/** Great-circle length of every segment, summed. Gaps between segments do not count. */
const totalDistanceKm = (segments: Position[][]): number => {
  let distance = 0;

  for (const segment of segments) {
    for (let index = 1; index < segment.length; index += 1) {
      const previous = segment[index - 1];
      const current = segment[index];
      if (!previous || !current) continue;

      distance += haversineDistance(previous[1], previous[0], current[1], current[0]);
    }
  }

  return distance;
};

/**
 * Positions grouped by container element, dropping containers that cannot form a line.
 *
 * Tracks (`<trkseg><trkpt>`) and routes (`<rte><rtept>`) differ only in their tag names,
 * so both go through here.
 *
 * The threshold is two points, not one: RFC 7946 requires a LineString to hold at least
 * two positions, so a one-point segment was invalid GeoJSON. It also counted against the
 * point budget while being impossible to simplify, which is how a file of thousands of
 * one-point segments used to defeat `MAX_TRACK_POINTS` entirely.
 */
const segmentsFrom = (
  document: Document,
  containerTag: string,
  pointTag: string,
): Position[][] =>
  byLocalName(document, containerTag)
    .map((container) =>
      byLocalName(container, pointTag)
        .map(toPosition)
        .filter((position): position is Position => position !== null),
    )
    .filter((segment) => segment.length >= 2);

/** First `<name>` on a `<trk>`, else the document `<metadata><name>`. */
const trackName = (document: Document): string | undefined => {
  const [track] = byLocalName(document, 'trk');
  if (track) {
    const name = childText(track, 'name');
    if (name) return name;
  }

  const [metadata] = byLocalName(document, 'metadata');
  return metadata ? childText(metadata, 'name') : undefined;
};

/**
 * First and last `<time>` among the track points, in document order.
 *
 * Read from the points rather than `<metadata><time>`, which records when the file was
 * written and can be days after the walk it describes.
 */
const trackTimes = (document: Document): { startTime?: string; endTime?: string } => {
  const times = byLocalName(document, 'trkpt')
    .map((point) => childText(point, 'time'))
    .filter((time): time is string => time !== undefined);

  const [startTime] = times;
  const endTime = times.at(-1);

  return {
    ...(startTime ? { startTime } : {}),
    ...(endTime ? { endTime } : {}),
  };
};

/**
 * Turn GPX text into a GeoJSON Feature.
 *
 * Pure: no I/O, no globals. `DOMParser` is imported from `@xmldom/xmldom` rather than
 * taken off `globalThis` - the global exists in the Worker only because `index.ts`
 * installs it for the AWS SDK, and depending on that would make this untestable outside a
 * Worker and quietly broken if that polyfill ever moved.
 *
 * @param gpx Raw GPX file contents.
 * @returns A `LineString` feature for a single-segment track, `MultiLineString` otherwise.
 * @throws {GpxParseError} If the text is not valid XML, or holds no usable track point.
 */
export const parseGpxToFeature = (gpx: string): TrackFeature => {
  if (typeof gpx !== 'string' || gpx.trim().length === 0) {
    throw new GpxParseError('The GPX file is empty');
  }

  let document: Document;
  try {
    // xmldom 0.9 throws on malformed markup rather than returning a partial document, so
    // this catch is the whole "is it XML" check.
    document = new DOMParser().parseFromString(gpx, 'text/xml');
  } catch (error) {
    throw new GpxParseError('The file is not valid XML', { cause: error });
  }

  // A `<rte>` is a planned path rather than a recorded one, so it is only a fallback - but
  // a file holding only a route is still a line worth drawing, and rejecting it would be
  // surprising.
  const tracks = segmentsFrom(document, 'trkseg', 'trkpt');
  const segments = tracks.length > 0 ? tracks : segmentsFrom(document, 'rte', 'rtept');

  if (segments.length === 0) {
    // Covers both "no usable points at all" and "only isolated single points", since a
    // lone point cannot form a line and is filtered out by `segmentsFrom`.
    throw new GpxParseError('The GPX file contains no track segment with two or more points');
  }

  const distanceKm = totalDistanceKm(segments);
  const simplifiedSegments = simplifySegments(segments);

  const originalCount = segments.reduce((sum, segment) => sum + segment.length, 0);
  const pointCount = simplifiedSegments.reduce((sum, segment) => sum + segment.length, 0);

  const [onlySegment] = simplifiedSegments;
  const geometry: TrackGeometry =
    simplifiedSegments.length === 1 && onlySegment
      ? { type: 'LineString', coordinates: onlySegment }
      : { type: 'MultiLineString', coordinates: simplifiedSegments };

  const name = trackName(document);
  const properties: TrackProperties = {
    ...(name ? { name } : {}),
    ...trackTimes(document),
    distanceKm,
    pointCount,
    simplified: pointCount < originalCount,
  };

  return { type: 'Feature', properties, geometry };
};
