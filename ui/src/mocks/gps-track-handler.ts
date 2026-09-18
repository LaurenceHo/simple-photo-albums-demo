import { delay, http, HttpResponse } from 'msw';

export const mockTrackManifest = [
  {
    trackId: '2026-04-12-day-1',
    colour: '#0072B2',
    size: 24576,
    lastModified: '2026-04-12T09:30:00.000Z',
  },
  {
    trackId: '2026-04-13-day-2',
    colour: '#D55E00',
    size: 31744,
    lastModified: '2026-04-13T10:15:00.000Z',
  },
];

export const mockTrackFeature = {
  type: 'Feature',
  properties: {
    name: 'Day 1',
    startTime: '2026-04-12T08:00:00Z',
    endTime: '2026-04-12T09:30:00Z',
    distanceKm: 8.4,
    pointCount: 3,
    simplified: false,
  },
  geometry: {
    type: 'LineString',
    coordinates: [
      [174.76, -36.85],
      [174.77, -36.86],
      [174.78, -36.87],
    ],
  },
};

/**
 * Albums deliberately left without any GPS track.
 *
 * Returning a manifest for every album made the "no tracks" states unreachable in the
 * MSW-backed dev server — including the map panel showing only the album's own location,
 * and the empty state for an album with nothing mappable at all. Most real albums have no
 * track, so this is also the more representative fixture.
 */
const ALBUMS_WITHOUT_TRACKS = new Set(['demo-album-4', 'demo-album2']);

export const getGpsTracks = http.get('*/albums/:albumId/gps-tracks', async ({ params }) => {
  await delay();

  return HttpResponse.json({
    code: 200,
    status: 'Success',
    message: 'ok',
    data: ALBUMS_WITHOUT_TRACKS.has(String(params['albumId'])) ? [] : mockTrackManifest,
  });
});

export const getGpsTrack = http.get('*/albums/:albumId/gps-tracks/:trackId', async () => {
  await delay();

  return HttpResponse.json({
    code: 200,
    status: 'Success',
    message: 'ok',
    data: mockTrackFeature,
  });
});

export const uploadGpsTrack = http.post('*/albums/:albumId/gps-tracks', async () => {
  await delay();

  return HttpResponse.json({
    code: 200,
    status: 'Success',
    message: 'Track uploaded',
    data: mockTrackFeature,
  });
});

export const deleteGpsTrack = http.delete('*/albums/:albumId/gps-tracks/:trackId', async () => {
  await delay();

  return HttpResponse.json({
    code: 200,
    status: 'Success',
    message: 'Track deleted',
  });
});
