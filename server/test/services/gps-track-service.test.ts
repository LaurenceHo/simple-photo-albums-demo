import {
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { mockClient } from 'aws-sdk-client-mock';
import { beforeEach, describe, expect, it } from 'vitest';
import GpsTrackService, {
  albumTrackPrefix,
  InvalidTrackKeyError,
  TRACK_COLOURS,
} from '../../src/services/gps-track-service';
import { R2Config } from '../../src/services/r2-service';

const r2Mock = mockClient(S3Client);

const testR2Config: R2Config = {
  accountId: 'test-account',
  accessKey: 'test-access-key',
  secretKey: 'test-secret-key',
  cdnUrl: '',
};

const BUCKET = 'test-bucket';
const ALBUM = 'demo-album';

const gpx = (lat = -36.85, lon = 174.76): string =>
  `<gpx><trk><name>Day 1</name><trkseg>` +
  `<trkpt lat="${lat}" lon="${lon}"/><trkpt lat="${lat - 0.01}" lon="${lon + 0.01}"/>` +
  `</trkseg></trk></gpx>`;

/** A listing entry for a stored track, as R2 would report it. */
const listedTrack = (trackId: string, suffix = '.geojson') => ({
  Key: `gps-tracks/${ALBUM}/${trackId}${suffix}`,
  Size: 2048,
  LastModified: new Date('2026-04-12T00:00:00Z'),
});

describe('GpsTrackService', () => {
  let service: GpsTrackService;

  beforeEach(() => {
    r2Mock.reset();
    service = new GpsTrackService(testR2Config, BUCKET);
  });

  describe('key safety', () => {
    it.each([
      ['a path separator', 'day/1'],
      ['a backslash', 'day\\1'],
      ['a parent reference', '..'],
      ['a bare dot', '.'],
      ['an empty string', ''],
    ])('rejects a trackId containing %s, before any R2 call', async (_label, trackId) => {
      await expect(service.getTrack(ALBUM, trackId)).rejects.toThrow(InvalidTrackKeyError);
      expect(r2Mock.calls()).toHaveLength(0);
    });

    it.each([
      ['a path separator', 'a/b'],
      ['a parent reference', '..'],
      ['an empty string', ''],
    ])('rejects an albumId containing %s, before any R2 call', async (_label, albumId) => {
      await expect(service.listTracks(albumId)).rejects.toThrow(InvalidTrackKeyError);
      expect(r2Mock.calls()).toHaveLength(0);
    });

    /**
     * Every entry point, not just the two above.
     *
     * Each method builds its key through `objectKey` or `albumPrefix`, so they are all
     * guarded today - but the table is what makes that structural. A method added later
     * that assembles its own key would otherwise pass CI in silence, and an unguarded
     * `albumId` is what let an empty album id reach the bare `gps-tracks/` prefix.
     */
    const unsafeAlbumId = '../other-album';

    it.each([
      ['listTracks', (s: GpsTrackService) => s.listTracks(unsafeAlbumId)],
      ['countTracks', (s: GpsTrackService) => s.countTracks(unsafeAlbumId)],
      ['getTrack', (s: GpsTrackService) => s.getTrack(unsafeAlbumId, 'day-1')],
      ['hasTrack', (s: GpsTrackService) => s.hasTrack(unsafeAlbumId, 'day-1')],
      ['deleteTrack', (s: GpsTrackService) => s.deleteTrack(unsafeAlbumId, 'day-1')],
      // A valid GPX on purpose: `putTrack` parses before it builds the key, so an
      // unparseable one would be rejected by the parser and prove nothing about the guard.
      ['putTrack', (s: GpsTrackService) => s.putTrack(unsafeAlbumId, 'day-1', gpx())],
    ])('%s refuses an albumId that could escape the prefix', async (_label, call) => {
      await expect(call(service)).rejects.toThrow(InvalidTrackKeyError);
      expect(r2Mock.calls()).toHaveLength(0);
    });

    it('albumTrackPrefix refuses to build a prefix from an empty id', () => {
      // The bare `gps-tracks/` this used to produce matches every album's tracks, and
      // `AlbumController.delete` hands it straight to `emptyR2Folder`.
      expect(() => albumTrackPrefix('')).toThrow(InvalidTrackKeyError);
      expect(albumTrackPrefix('demo-album')).toBe('gps-tracks/demo-album/');
    });
  });

  describe('putTrack', () => {
    it('writes the original .gpx and the derived .geojson', async () => {
      r2Mock.on(PutObjectCommand).resolves({ $metadata: { httpStatusCode: 200 } });

      const feature = await service.putTrack(ALBUM, '2026-04-12-day-1', gpx());

      const puts = r2Mock.commandCalls(PutObjectCommand);
      expect(puts).toHaveLength(2);
      // .gpx first: a track is only visible once its .geojson lands, so a failure after
      // the first write leaves an invisible orphan rather than a listed, unreadable track.
      expect(puts[0]?.args[0].input.Key).toBe(`gps-tracks/${ALBUM}/2026-04-12-day-1.gpx`);
      expect(puts[1]?.args[0].input.Key).toBe(`gps-tracks/${ALBUM}/2026-04-12-day-1.geojson`);
      expect(feature.properties.name).toBe('Day 1');
    });

    it('stores the parsed feature as the .geojson body', async () => {
      r2Mock.on(PutObjectCommand).resolves({ $metadata: { httpStatusCode: 200 } });

      await service.putTrack(ALBUM, 'day-1', gpx());

      const body = r2Mock.commandCalls(PutObjectCommand)[1]?.args[0].input.Body;
      expect(JSON.parse(String(body))).toMatchObject({
        type: 'Feature',
        geometry: { type: 'LineString' },
      });
    });

    it('rejects an unparseable GPX without writing anything', async () => {
      r2Mock.on(PutObjectCommand).resolves({ $metadata: { httpStatusCode: 200 } });

      await expect(service.putTrack(ALBUM, 'day-1', 'not xml')).rejects.toThrow();
      expect(r2Mock.commandCalls(PutObjectCommand)).toHaveLength(0);
    });

    it('throws when R2 rejects a write', async () => {
      r2Mock.on(PutObjectCommand).resolves({ $metadata: { httpStatusCode: 500 } });

      await expect(service.putTrack(ALBUM, 'day-1', gpx())).rejects.toThrow(/Failed to store/);
    });
  });

  describe('listTracks', () => {
    it('returns an empty array for an album with no tracks', async () => {
      r2Mock.on(ListObjectsV2Command).resolves({});

      await expect(service.listTracks(ALBUM)).resolves.toEqual([]);
    });

    it('ignores .gpx keys, so a prefix holding both objects yields one track', async () => {
      r2Mock.on(ListObjectsV2Command).resolves({
        Contents: [listedTrack('day-1', '.gpx'), listedTrack('day-1')],
      });

      const tracks = await service.listTracks(ALBUM);

      expect(tracks).toHaveLength(1);
      expect(tracks[0]?.trackId).toBe('day-1');
    });

    it('ignores an object nested deeper than one level under the prefix', async () => {
      r2Mock.on(ListObjectsV2Command).resolves({
        Contents: [{ Key: `gps-tracks/${ALBUM}/nested/day-1.geojson`, Size: 1 }],
      });

      await expect(service.listTracks(ALBUM)).resolves.toEqual([]);
    });

    it('sorts by trackId and assigns colours by position', async () => {
      r2Mock.on(ListObjectsV2Command).resolves({
        Contents: [listedTrack('day-3'), listedTrack('day-1'), listedTrack('day-2')],
      });

      const tracks = await service.listTracks(ALBUM);

      expect(tracks.map((track) => track.trackId)).toEqual(['day-1', 'day-2', 'day-3']);
      expect(tracks.map((track) => track.colour)).toEqual([
        TRACK_COLOURS[0],
        TRACK_COLOURS[1],
        TRACK_COLOURS[2],
      ]);
    });

    it('gives the same track the same colour across calls', async () => {
      r2Mock.on(ListObjectsV2Command).resolves({
        Contents: [listedTrack('day-1'), listedTrack('day-2')],
      });

      const first = await service.listTracks(ALBUM);
      const second = await service.listTracks(ALBUM);

      expect(first).toEqual(second);
    });

    it('re-colours later tracks when an earlier one is removed — a known consequence', async () => {
      r2Mock
        .on(ListObjectsV2Command)
        .resolvesOnce({ Contents: [listedTrack('day-1'), listedTrack('day-2')] })
        .resolvesOnce({ Contents: [listedTrack('day-2')] });

      const before = await service.listTracks(ALBUM);
      const after = await service.listTracks(ALBUM);

      expect(before[1]?.colour).toBe(TRACK_COLOURS[1]);
      // day-2 is now first, so it takes the first colour. Documented, not a defect.
      expect(after[0]?.colour).toBe(TRACK_COLOURS[0]);
    });

    it('wraps the palette past its length rather than returning undefined', async () => {
      const contents = Array.from({ length: TRACK_COLOURS.length + 2 }, (_, index) =>
        listedTrack(`day-${String(index).padStart(2, '0')}`),
      );
      r2Mock.on(ListObjectsV2Command).resolves({ Contents: contents });

      const tracks = await service.listTracks(ALBUM);

      expect(tracks).toHaveLength(TRACK_COLOURS.length + 2);
      expect(tracks[TRACK_COLOURS.length]?.colour).toBe(TRACK_COLOURS[0]);
      expect(tracks.every((track) => typeof track.colour === 'string')).toBe(true);
    });
  });

  describe('countTracks', () => {
    it('counts tracks, not stored objects', async () => {
      r2Mock.on(ListObjectsV2Command).resolves({
        Contents: [
          listedTrack('day-1', '.gpx'),
          listedTrack('day-1'),
          listedTrack('day-2', '.gpx'),
          listedTrack('day-2'),
        ],
      });

      await expect(service.countTracks(ALBUM)).resolves.toBe(2);
    });
  });

  describe('getTrack', () => {
    it('reads the .geojson for the requested id', async () => {
      r2Mock.on(GetObjectCommand).resolves({
        Body: { transformToString: async () => JSON.stringify({ type: 'Feature' }) },
      } as never);

      const track = await service.getTrack(ALBUM, 'day-1');

      expect(r2Mock.commandCalls(GetObjectCommand)[0]?.args[0].input.Key).toBe(
        `gps-tracks/${ALBUM}/day-1.geojson`,
      );
      expect(track).toEqual({ type: 'Feature' });
    });

    it.each([
      ['NoSuchKey', { name: 'NoSuchKey' }],
      ['NotFound', { name: 'NotFound' }],
      ['a 404 status', { name: 'Other', $metadata: { httpStatusCode: 404 } }],
    ])('returns null when R2 reports %s', async (_label, error) => {
      r2Mock.on(GetObjectCommand).rejects(error as never);

      await expect(service.getTrack(ALBUM, 'missing')).resolves.toBeNull();
    });

    it('rethrows an error that is not a missing object', async () => {
      r2Mock.on(GetObjectCommand).rejects({ name: 'AccessDenied' } as never);

      await expect(service.getTrack(ALBUM, 'day-1')).rejects.toThrow();
    });
  });

  describe('hasTrack', () => {
    it('is true when the .geojson exists', async () => {
      r2Mock.on(HeadObjectCommand).resolves({ $metadata: { httpStatusCode: 200 } });

      await expect(service.hasTrack(ALBUM, 'day-1')).resolves.toBe(true);
    });

    it('is false when it does not', async () => {
      r2Mock.on(HeadObjectCommand).rejects({ name: 'NotFound' } as never);

      await expect(service.hasTrack(ALBUM, 'day-1')).resolves.toBe(false);
    });
  });

  describe('deleteTrack', () => {
    it('removes both the .geojson and the .gpx', async () => {
      r2Mock.on(DeleteObjectsCommand).resolves({ $metadata: { httpStatusCode: 200 } });

      await expect(service.deleteTrack(ALBUM, 'day-1')).resolves.toBe(true);

      const keys = r2Mock
        .commandCalls(DeleteObjectsCommand)[0]
        ?.args[0].input.Delete?.Objects?.map((object) => object.Key);
      expect(keys).toEqual([
        `gps-tracks/${ALBUM}/day-1.geojson`,
        `gps-tracks/${ALBUM}/day-1.gpx`,
      ]);
    });

    it('reports success for a track that is already gone', async () => {
      r2Mock.on(DeleteObjectsCommand).resolves({ $metadata: { httpStatusCode: 200 } });

      await expect(service.deleteTrack(ALBUM, 'never-existed')).resolves.toBe(true);
    });
  });

  describe('after a delete', () => {
    it('listTracks no longer returns the deleted id', async () => {
      r2Mock.on(DeleteObjectsCommand).resolves({ $metadata: { httpStatusCode: 200 } });
      r2Mock
        .on(ListObjectsV2Command)
        .resolvesOnce({ Contents: [listedTrack('day-1'), listedTrack('day-2')] })
        .resolvesOnce({ Contents: [listedTrack('day-2')] });

      expect((await service.listTracks(ALBUM)).map((track) => track.trackId)).toContain('day-1');
      await service.deleteTrack(ALBUM, 'day-1');
      expect((await service.listTracks(ALBUM)).map((track) => track.trackId)).not.toContain(
        'day-1',
      );
    });
  });
});
