import { describe, expect, it } from 'vitest';
import { GpxParseError, MAX_TRACK_POINTS, parseGpxToFeature } from '../../src/utils/gpx';

/** Wrap track points in a minimal, unnamespaced GPX document. */
const gpxWithSegments = (segments: string[]): string =>
  `<gpx><trk><trkseg>${segments.join('</trkseg><trkseg>')}</trkseg></trk></gpx>`;

const trkpt = (lat: number, lon: number, children = ''): string =>
  `<trkpt lat="${lat}" lon="${lon}">${children}</trkpt>`;

describe('parseGpxToFeature', () => {
  describe('geometry', () => {
    it('produces a LineString for a single-segment track', () => {
      const feature = parseGpxToFeature(
        gpxWithSegments([`${trkpt(-36.85, 174.76)}${trkpt(-36.86, 174.77)}`]),
      );

      expect(feature.type).toBe('Feature');
      expect(feature.geometry.type).toBe('LineString');
      // GeoJSON is longitude-first, the reverse of the GPX attributes.
      expect(feature.geometry.coordinates).toEqual([
        [174.76, -36.85],
        [174.77, -36.86],
      ]);
    });

    it('produces a MultiLineString for a multi-segment track', () => {
      const feature = parseGpxToFeature(
        gpxWithSegments([
          `${trkpt(-36.85, 174.76)}${trkpt(-36.86, 174.77)}`,
          `${trkpt(-36.9, 174.8)}${trkpt(-36.91, 174.81)}`,
        ]),
      );

      expect(feature.geometry.type).toBe('MultiLineString');
      expect(feature.geometry.coordinates).toHaveLength(2);
    });

    it('carries elevation as a third coordinate when present', () => {
      const feature = parseGpxToFeature(
        gpxWithSegments([`${trkpt(-36.85, 174.76, '<ele>42.5</ele>')}${trkpt(-36.86, 174.77)}`]),
      );

      expect(feature.geometry.coordinates[0]).toEqual([174.76, -36.85, 42.5]);
      expect(feature.geometry.coordinates[1]).toEqual([174.77, -36.86]);
    });

    it('drops a segment that holds no usable point rather than emitting an empty one', () => {
      const feature = parseGpxToFeature(
        gpxWithSegments([`${trkpt(-36.85, 174.76)}${trkpt(-36.86, 174.77)}`, '']),
      );

      expect(feature.geometry.type).toBe('LineString');
    });
  });

  describe('namespaces', () => {
    it('reads a default-namespaced GPX', () => {
      const feature = parseGpxToFeature(
        '<gpx xmlns="http://www.topografix.com/GPX/1/1"><trk><trkseg>' +
          `${trkpt(-36.85, 174.76)}${trkpt(-36.86, 174.77)}` +
          '</trkseg></trk></gpx>',
      );

      expect(feature.geometry.coordinates).toHaveLength(2);
    });

    it('reads a prefixed GPX, which a qualified-name lookup would silently miss', () => {
      const feature = parseGpxToFeature(
        '<g:gpx xmlns:g="http://www.topografix.com/GPX/1/1"><g:trk><g:trkseg>' +
          '<g:trkpt lat="-36.85" lon="174.76"/><g:trkpt lat="-36.86" lon="174.77"/>' +
          '</g:trkseg></g:trk></g:gpx>',
      );

      expect(feature.geometry.coordinates).toHaveLength(2);
    });
  });

  describe('properties', () => {
    it('lifts the track name', () => {
      const feature = parseGpxToFeature(
        '<gpx><trk><name>Day 1</name><trkseg>' +
          `${trkpt(-36.85, 174.76)}${trkpt(-36.86, 174.77)}` +
          '</trkseg></trk></gpx>',
      );

      expect(feature.properties.name).toBe('Day 1');
    });

    it('falls back to the metadata name', () => {
      const feature = parseGpxToFeature(
        '<gpx><metadata><name>Coast walk</name></metadata><trk><trkseg>' +
          `${trkpt(-36.85, 174.76)}${trkpt(-36.86, 174.77)}` +
          '</trkseg></trk></gpx>',
      );

      expect(feature.properties.name).toBe('Coast walk');
    });

    it('omits the name when the file has none', () => {
      const feature = parseGpxToFeature(
        gpxWithSegments([`${trkpt(-36.85, 174.76)}${trkpt(-36.86, 174.77)}`]),
      );

      expect(feature.properties.name).toBeUndefined();
    });

    it('takes start and end times from the first and last points, not the metadata', () => {
      const feature = parseGpxToFeature(
        '<gpx><metadata><time>2030-01-01T00:00:00Z</time></metadata><trk><trkseg>' +
          trkpt(-36.85, 174.76, '<time>2026-04-12T08:00:00Z</time>') +
          trkpt(-36.86, 174.77, '<time>2026-04-12T09:30:00Z</time>') +
          '</trkseg></trk></gpx>',
      );

      expect(feature.properties.startTime).toBe('2026-04-12T08:00:00Z');
      expect(feature.properties.endTime).toBe('2026-04-12T09:30:00Z');
    });

    it('computes a great-circle distance', () => {
      // One degree of latitude is ~111 km.
      const feature = parseGpxToFeature(
        gpxWithSegments([`${trkpt(-36, 174)}${trkpt(-37, 174)}`]),
      );

      expect(feature.properties.distanceKm).toBeGreaterThan(110);
      expect(feature.properties.distanceKm).toBeLessThan(112);
    });

    it('does not count the gap between segments in the distance', () => {
      const oneSegment = parseGpxToFeature(
        gpxWithSegments([`${trkpt(-36, 174)}${trkpt(-37, 174)}`]),
      );
      const twoSegments = parseGpxToFeature(
        gpxWithSegments([`${trkpt(-36, 174)}${trkpt(-37, 174)}`, `${trkpt(-40, 174)}${trkpt(-40, 174)}`]),
      );

      expect(twoSegments.properties.distanceKm).toBeCloseTo(oneSegment.properties.distanceKm, 5);
    });
  });

  describe('route fallback', () => {
    it('uses <rte><rtept> when the file holds no track', () => {
      const feature = parseGpxToFeature(
        '<gpx><rte><rtept lat="-36.85" lon="174.76"/><rtept lat="-36.86" lon="174.77"/></rte></gpx>',
      );

      expect(feature.geometry.type).toBe('LineString');
      expect(feature.geometry.coordinates).toHaveLength(2);
    });

    it('prefers a track over a route when both are present', () => {
      const feature = parseGpxToFeature(
        '<gpx><rte><rtept lat="0" lon="0"/><rtept lat="1" lon="1"/></rte>' +
          `<trk><trkseg>${trkpt(-36.85, 174.76)}${trkpt(-36.86, 174.77)}</trkseg></trk></gpx>`,
      );

      expect(feature.geometry.coordinates[0]).toEqual([174.76, -36.85]);
    });
  });

  describe('invalid input', () => {
    it.each([
      ['an empty string', ''],
      ['whitespace only', '   \n  '],
    ])('throws GpxParseError for %s', (_label, input) => {
      expect(() => parseGpxToFeature(input)).toThrow(GpxParseError);
    });

    it.each([
      ['an unclosed tag', '<gpx><trk'],
      ['a mismatched tag', '<gpx><trk></gpxx>'],
      ['text that is not XML', 'hello world'],
    ])('throws GpxParseError for %s', (_label, input) => {
      expect(() => parseGpxToFeature(input)).toThrow(GpxParseError);
      expect(() => parseGpxToFeature(input)).toThrow(/not valid XML/);
    });

    it('throws when the document is valid XML but holds no track point', () => {
      expect(() => parseGpxToFeature('<gpx><metadata><name>Empty</name></metadata></gpx>')).toThrow(
        /no track segment with two or more points/,
      );
    });

    it('throws when every point is out of range', () => {
      expect(() =>
        parseGpxToFeature(gpxWithSegments([`${trkpt(91, 0)}${trkpt(0, 181)}`])),
      ).toThrow(/no track segment with two or more points/);
    });
  });

  describe('tolerating bad points', () => {
    it('skips an out-of-range point instead of failing the whole track', () => {
      const feature = parseGpxToFeature(
        gpxWithSegments([`${trkpt(-36.85, 174.76)}${trkpt(91, 174.77)}${trkpt(-36.87, 174.78)}`]),
      );

      expect(feature.geometry.coordinates).toEqual([
        [174.76, -36.85],
        [174.78, -36.87],
      ]);
    });

    it('skips a point with unparseable attributes', () => {
      const feature = parseGpxToFeature(
        gpxWithSegments([
          `${trkpt(-36.85, 174.76)}<trkpt lat="north" lon="east"/>${trkpt(-36.87, 174.78)}`,
        ]),
      );

      expect(feature.geometry.coordinates).toHaveLength(2);
    });

    /**
     * `Number(null)` and `Number('')` are both 0, not NaN, so these points used to survive
     * every finiteness and range check as a valid position at [0, 0] - putting a leg of
     * the track in the Gulf of Guinea and roughly 16,000 km into `distanceKm`.
     */
    it.each([
      ['no coordinate attributes at all', '<trkpt/>'],
      ['empty coordinate attributes', '<trkpt lat="" lon=""/>'],
      ['whitespace coordinate attributes', '<trkpt lat="  " lon="  "/>'],
      ['only a latitude', '<trkpt lat="-36.86"/>'],
    ])('drops a point with %s rather than placing it at [0, 0]', (_label, badPoint) => {
      const feature = parseGpxToFeature(
        gpxWithSegments([`${trkpt(-36.85, 174.76)}${badPoint}${trkpt(-36.87, 174.78)}`]),
      );

      expect(feature.geometry.coordinates).toEqual([
        [174.76, -36.85],
        [174.78, -36.87],
      ]);
      // The distance is the giveaway: Auckland to Null Island and back is ~32,000 km.
      expect(feature.properties.distanceKm).toBeLessThan(10);
    });

    it('keeps a genuine point on the equator or the prime meridian', () => {
      const feature = parseGpxToFeature(
        gpxWithSegments([`${trkpt(0, 0)}${trkpt(0.01, 0.01)}`]),
      );

      // Guards the fix above from being written as "drop anything that reads as zero".
      expect(feature.geometry.coordinates).toEqual([
        [0, 0],
        [0.01, 0.01],
      ]);
    });

    it('ignores an unparseable elevation rather than emitting NaN', () => {
      const feature = parseGpxToFeature(
        gpxWithSegments([`${trkpt(-36.85, 174.76, '<ele>high</ele>')}${trkpt(-36.86, 174.77)}`]),
      );

      expect(feature.geometry.coordinates[0]).toEqual([174.76, -36.85]);
    });
  });

  describe('simplification', () => {
    /** A wiggly line long enough to need simplifying. */
    const longTrack = (points: number): string => {
      const parts: string[] = [];
      for (let index = 0; index < points; index += 1) {
        const latitude = -36.85 - index * 0.0001;
        const longitude = 174.76 + index * 0.0001 + (index % 2 === 0 ? 0.00005 : 0);
        parts.push(trkpt(Number(latitude.toFixed(6)), Number(longitude.toFixed(6))));
      }
      return gpxWithSegments([parts.join('')]);
    };

    it('leaves a track under the cap untouched', () => {
      const feature = parseGpxToFeature(longTrack(100));

      expect(feature.geometry.coordinates).toHaveLength(100);
      expect(feature.properties.pointCount).toBe(100);
      expect(feature.properties.simplified).toBe(false);
    });

    it('brings a track over the cap below it', () => {
      const feature = parseGpxToFeature(longTrack(MAX_TRACK_POINTS * 3));

      expect(feature.properties.pointCount).toBeLessThanOrEqual(MAX_TRACK_POINTS);
      expect(feature.properties.simplified).toBe(true);
      expect(feature.properties.pointCount).toBe(feature.geometry.coordinates.length);
    });

    it('preserves the exact start and end points when simplifying', () => {
      const points = MAX_TRACK_POINTS * 3;
      const feature = parseGpxToFeature(longTrack(points));
      const coordinates = feature.geometry.coordinates as number[][];

      const expectedLast = Number((-36.85 - (points - 1) * 0.0001).toFixed(6));
      expect(coordinates[0]?.[1]).toBeCloseTo(-36.85, 6);
      expect(coordinates[coordinates.length - 1]?.[1]).toBeCloseTo(expectedLast, 6);
    });

    /**
     * A zig-zag whose detour dominates its end-to-end span.
     *
     * The previous fixture for this was a near-straight line, so its simplified form was
     * about as long as the original and the assertion passed just as happily against an
     * implementation that measured *after* simplification. Here the recorded path is
     * hundreds of thousands of km while the simplified chord is a couple of hundred, so
     * only the correct ordering can pass.
     */
    const zigZagTrack = (points: number): string => {
      const parts: string[] = [];
      for (let index = 0; index < points; index += 1) {
        const latitude = -36.85 - index * 0.0001;
        const longitude = 174.76 + (index % 2 === 0 ? 0 : 0.5);
        parts.push(trkpt(Number(latitude.toFixed(6)), longitude));
      }
      return gpxWithSegments([parts.join('')]);
    };

    it('reports the distance of the track as recorded, not of the simplified line', () => {
      const feature = parseGpxToFeature(zigZagTrack(MAX_TRACK_POINTS + 1000));

      // Each 0.5-degree swing is ~44 km, so the recorded path is on the order of 600,000
      // km. The stored line spans ~1.5 degrees of latitude - under 200 km however few
      // points survive - so measuring after simplification cannot reach this number.
      expect(feature.properties.pointCount).toBeLessThanOrEqual(MAX_TRACK_POINTS);
      expect(feature.properties.distanceKm).toBeGreaterThan(10_000);
    });
  });

  /**
   * Simplification keeps the first and last point of every segment, so the floor is two
   * points per segment however coarse the tolerance becomes. A file with enough segments
   * therefore cannot meet the budget at all.
   *
   * This used to return the last attempt regardless: the geometry was stored and served
   * well past `MAX_TRACK_POINTS`, and when no point had been dropped it reported
   * `simplified: false` too - claiming the file was under a cap it had just blown through.
   */
  describe('the point cap for a track that cannot be simplified into it', () => {
    const segmentsOf = (count: number, pointsEach: number): string => {
      const segments: string[] = [];
      for (let segment = 0; segment < count; segment += 1) {
        const parts: string[] = [];
        for (let point = 0; point < pointsEach; point += 1) {
          parts.push(trkpt(-36.85 - segment * 0.01 - point * 0.001, 174.76 + point * 0.001));
        }
        segments.push(parts.join(''));
      }
      return gpxWithSegments(segments);
    };

    it('rejects a track with more segments than the budget can hold', () => {
      // 6000 segments floor at 12,000 points - more than twice the cap.
      expect(() => parseGpxToFeature(segmentsOf(6000, 2))).toThrow(GpxParseError);
      expect(() => parseGpxToFeature(segmentsOf(6000, 2))).toThrow(/separate track segments/);
    });

    it('never stores geometry above the cap', () => {
      const feature = parseGpxToFeature(segmentsOf(2000, 8));

      // 2000 segments floor at 4000 points, so this one is reducible - and must actually
      // have been reduced, not merely accepted.
      expect(feature.properties.pointCount).toBeLessThanOrEqual(MAX_TRACK_POINTS);
      expect(feature.properties.simplified).toBe(true);
    });

    /**
     * The nastier shape: single-point segments are not simplifiable at all, so 20,000 of
     * them used to sail past the cap *and* report `simplified: false`. They are now
     * dropped as invalid GeoJSON - RFC 7946 requires two positions for a LineString.
     */
    it('rejects a file of one-point segments rather than storing them', () => {
      expect(() => parseGpxToFeature(segmentsOf(20_000, 1))).toThrow(
        /no track segment with two or more points/,
      );
    });

    /**
     * A zig-zag is the worst case for Douglas-Peucker: the furthest point from the chord
     * is next to an end every time, so the recursion never splits evenly and the pass
     * degrades to O(n^2).
     *
     * The original code compounded that by running a full pass per candidate tolerance,
     * doubling up to sixty times from the original points. Measured on it: 8,000 points
     * took 15 s and 15,000 took 50 s, from a file well inside the 10 MB upload cap.
     * Scoring once removes the repetition, and thinning the input caps the single pass.
     *
     * 8,000 points took 15 s on the original code and ~0.8 s now, so the threshold sits
     * between the two with an order of magnitude either side. The generous ceiling is
     * deliberate - this asserts the complexity class, not a
     * benchmark, so it should not flake on a slow or loaded machine. Anything quadratic
     * and repeated lands two orders of magnitude above it.
     */
    it('simplifies a zig-zag without the quadratic blow-up', () => {
      const parts: string[] = [];
      for (let index = 0; index < 8_000; index += 1) {
        parts.push(trkpt(Number((-36.85 - index * 0.0001).toFixed(6)), 174.76 + (index % 2) * 0.5));
      }

      const start = performance.now();
      const feature = parseGpxToFeature(gpxWithSegments([parts.join('')]));
      const elapsed = performance.now() - start;

      expect(feature.properties.pointCount).toBeLessThanOrEqual(MAX_TRACK_POINTS);
      expect(elapsed).toBeLessThan(5_000);
    });

    /**
     * The thinning guard, which nothing else reaches.
     *
     * Every other fixture here sits under `MAX_SIMPLIFY_INPUT_POINTS`, and the 20,000-point
     * one above is made of *one-point* segments that `segmentsFrom` discards before
     * simplification ever runs. So the branch that bounds the scoring pass - the thing that
     * makes the complexity assertion above hold at all - had no coverage.
     */
    it('thins a track past the input ceiling, keeping every segment and its endpoints', () => {
      const segmentCount = 3;
      const pointsEach = 9_000; // 27,000 total, comfortably past the 20,000 ceiling.
      const segments: string[] = [];

      for (let segment = 0; segment < segmentCount; segment += 1) {
        const parts: string[] = [];
        for (let point = 0; point < pointsEach; point += 1) {
          parts.push(
            trkpt(
              Number((-36.85 - segment - point * 0.0001).toFixed(6)),
              Number((174.76 + point * 0.0001).toFixed(6)),
            ),
          );
        }
        segments.push(parts.join(''));
      }

      const feature = parseGpxToFeature(gpxWithSegments(segments));
      const lines = feature.geometry.coordinates as number[][][];

      expect(feature.geometry.type).toBe('MultiLineString');
      expect(lines).toHaveLength(segmentCount);
      expect(feature.properties.pointCount).toBeLessThanOrEqual(MAX_TRACK_POINTS);
      expect(feature.properties.simplified).toBe(true);

      // Thinning must not cost a segment its ends - the stored track has to start and
      // finish where it was recorded, however aggressively the middle is dropped.
      lines.forEach((line, index) => {
        expect(line.length).toBeGreaterThanOrEqual(2);
        expect(line[0]?.[1]).toBeCloseTo(-36.85 - index, 6);
        expect(line[line.length - 1]?.[1]).toBeCloseTo(
          Number((-36.85 - index - (pointsEach - 1) * 0.0001).toFixed(6)),
          6,
        );
      });
    });

    it('drops a stray one-point segment but keeps the usable ones', () => {
      const feature = parseGpxToFeature(
        gpxWithSegments([
          `${trkpt(-36.85, 174.76)}${trkpt(-36.86, 174.77)}`,
          trkpt(-36.9, 174.8),
          `${trkpt(-36.95, 174.85)}${trkpt(-36.96, 174.86)}`,
        ]),
      );

      expect(feature.geometry.type).toBe('MultiLineString');
      expect(feature.geometry.coordinates).toHaveLength(2);
    });
  });
});
