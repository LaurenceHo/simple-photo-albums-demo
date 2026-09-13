import type { ApiResponse, ResponseStatus } from '@/schema';
import type { TrackFeature, TrackManifest } from '@/schema/gps-track';
import { ApiBaseUrl } from '@/services/api-base-url';
import { BaseApiRequestService } from '@/services/base-api-request-service';

const trackBase = (albumId: string) =>
  `${ApiBaseUrl}/albums/${encodeURIComponent(albumId)}/gps-tracks`;

export const GpsTrackService = {
  /** The album's track manifest - ids, colours, sizes. No geometry. */
  getTracks: async (albumId: string): Promise<ApiResponse<TrackManifest>> => {
    const response = await BaseApiRequestService.perform('GET', trackBase(albumId));
    if (!response.ok) {
      throw new Error(response.statusText);
    }
    return response.json();
  },

  /**
   * One track's geometry.
   *
   * Fetched per track rather than as one merged collection, so replacing a single track
   * invalidates only its own cache entry and a viewer never downloads tracks they have
   * toggled off.
   */
  getTrack: async (albumId: string, trackId: string): Promise<ApiResponse<TrackFeature>> => {
    const response = await BaseApiRequestService.perform(
      'GET',
      `${trackBase(albumId)}/${encodeURIComponent(trackId)}`,
    );
    if (!response.ok) {
      throw new Error(response.statusText);
    }
    return response.json();
  },

  /**
   * Upload a GPX, creating or replacing the track at `trackId`.
   *
   * The GPX travels as a JSON string field rather than a raw body so the Worker can
   * validate it with the same Zod pipeline as every other endpoint.
   *
   * **Returns the envelope on failure too**, unlike the two reads above. The interesting
   * failures here are 400 (the GPX would not parse) and 409 (the album is at its track
   * cap), and both carry a message naming the actual problem. Throwing on `!response.ok`
   * discarded it before the body was ever read, so the dialog fell back to a generic
   * "Could not upload" and the user was told nothing. Reads keep throwing, because
   * TanStack Query turns that into `isError` and there is no message worth surfacing.
   */
  uploadTrack: async (
    albumId: string,
    trackId: string,
    gpx: string,
  ): Promise<ApiResponse<TrackFeature>> => {
    const response = await BaseApiRequestService.perform('POST', trackBase(albumId), {
      trackId,
      gpx,
    });
    return response.json();
  },

  deleteTrack: async (albumId: string, trackId: string): Promise<ResponseStatus> => {
    const response = await BaseApiRequestService.perform(
      'DELETE',
      `${trackBase(albumId)}/${encodeURIComponent(trackId)}`,
    );
    return response.json();
  },
};
