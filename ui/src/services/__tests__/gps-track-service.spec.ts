import { ApiBaseUrl } from '@/services/api-base-url';
import { BaseApiRequestService } from '@/services/base-api-request-service';
import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { GpsTrackService } from '../gps-track-service';

vi.mock('@/services/base-api-request-service', () => ({
  BaseApiRequestService: {
    perform: vi.fn(),
  },
}));

/**
 * A real `Response`, not a `{ ok, json }` literal.
 *
 * The bug these tests exist for was invisible to a hand-rolled stub: the service threw on
 * `!response.ok` before the body was read, and every test above this layer mocked the
 * resolved envelope directly, so nothing ever exercised a non-2xx response at all.
 */
const apiResponse = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

describe('GpsTrackService', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  describe('uploadTrack', () => {
    it('posts the GPX as a JSON field', async () => {
      (BaseApiRequestService.perform as Mock).mockResolvedValue(
        apiResponse(200, { code: 200, status: 'Success', message: 'Track uploaded' }),
      );

      await GpsTrackService.uploadTrack('demo-album', 'day-1', '<gpx/>');

      expect(BaseApiRequestService.perform).toHaveBeenCalledWith(
        'POST',
        `${ApiBaseUrl}/albums/demo-album/gps-tracks`,
        { trackId: 'day-1', gpx: '<gpx/>' },
      );
    });

    it('returns the envelope for a 409 so the cap message reaches the user', async () => {
      const message = 'This album already has the maximum of 20 GPS tracks.';
      (BaseApiRequestService.perform as Mock).mockResolvedValue(
        apiResponse(409, { code: 409, status: 'Error', message }),
      );

      const result = await GpsTrackService.uploadTrack('demo-album', 'day-21', '<gpx/>');

      // Not a throw. The store branches on `code`, and the dialog renders `message` -
      // neither runs if this rejects, and the user sees a generic failure instead.
      expect(result.code).toBe(409);
      expect(result.message).toBe(message);
    });

    it('returns the envelope for a 400 so the parse failure reaches the user', async () => {
      (BaseApiRequestService.perform as Mock).mockResolvedValue(
        apiResponse(400, {
          code: 400,
          status: 'Error',
          message: 'The GPX file contains no track points',
        }),
      );

      const result = await GpsTrackService.uploadTrack('demo-album', 'day-1', 'nonsense');

      expect(result.code).toBe(400);
      expect(result.message).toBe('The GPX file contains no track points');
    });
  });

  describe('deleteTrack', () => {
    it('returns the envelope for a failed delete rather than throwing', async () => {
      (BaseApiRequestService.perform as Mock).mockResolvedValue(
        apiResponse(500, { code: 500, status: 'Error', message: 'Failed to delete GPS track' }),
      );

      const result = await GpsTrackService.deleteTrack('demo-album', 'day-1');

      expect(result.code).toBe(500);
      expect(result.message).toBe('Failed to delete GPS track');
    });

    it('encodes the track id into the path', async () => {
      (BaseApiRequestService.perform as Mock).mockResolvedValue(
        apiResponse(200, { code: 200, status: 'Success', message: 'Track deleted' }),
      );

      await GpsTrackService.deleteTrack('demo-album', 'a b#1');

      expect(BaseApiRequestService.perform).toHaveBeenCalledWith(
        'DELETE',
        `${ApiBaseUrl}/albums/demo-album/gps-tracks/a%20b%231`,
      );
    });
  });

  describe('reads', () => {
    // Deliberately different from the mutations: TanStack Query turns a throw into
    // `isError`, and a failed manifest or geometry fetch has no message worth showing.
    it('throws when the manifest request fails', async () => {
      (BaseApiRequestService.perform as Mock).mockResolvedValue(
        apiResponse(500, { code: 500, status: 'Error', message: 'nope' }),
      );

      await expect(GpsTrackService.getTracks('demo-album')).rejects.toThrow();
    });

    it('throws when a geometry request fails', async () => {
      (BaseApiRequestService.perform as Mock).mockResolvedValue(
        apiResponse(404, { code: 404, status: 'Error', message: 'nope' }),
      );

      await expect(GpsTrackService.getTrack('demo-album', 'day-1')).rejects.toThrow();
    });
  });
});
