import { delay, http, HttpResponse } from 'msw';

const imageCDNUrl = import.meta.env.VITE_IMAGEKIT_CDN_URL;

export const getPhotos = http.get('/api/photos/**', async ({ params }) => {
  await delay();

  if (params[0] === 'na/demo-album-4') {
    return HttpResponse.json({
      code: 200,
      status: 'Success',
      message: 'ok',
      data: {
        album: {
          id: 'demo-album-4',
          year: 'na',
          albumName: 'This is demo album 4',
          description: 'This is an album description',
          albumCover: 'demo-album-4/2024-05-02 18.28.53.jpg',
          isUnlisted: false,
          isFeatured: true,
          place: {
            formattedAddress: 'Valencia, Spain',
            displayName: 'Valencia',
            location: {
              latitude: 39.4699075,
              longitude: -0.3762881,
            },
          },
          tags: [],
        },
        photos: [
          {
            url: `${imageCDNUrl}/demo-album-4/2026-01-02_08.44.59.jpg`,
            key: 'demo-album-4/2024-05-02 18.28.53.jpg',
            size: 3509509,
            lastModified: '2024-07-24T21:49:42.000Z',
          },
          {
            url: `${imageCDNUrl}/demo-album-4/batch_roofs-8449752.jpg`,
            key: 'demo-album-4/batch_roofs-8449752.jpg',
            size: 125865,
            lastModified: '2024-07-24T21:49:42.000Z',
          },
          {
            url: `${imageCDNUrl}/demo-album-4/boat_111_640.jpg`,
            key: 'demo-album-4/boat_111_640.jpg',
            size: 74720,
            lastModified: '2024-07-24T21:49:42.000Z',
          },
          {
            url: `${imageCDNUrl}/demo-album-4/fog_640.jpg`,
            key: 'demo-album-4/fog_640.jpg',
            size: 59295,
            lastModified: '2024-07-24T21:49:42.000Z',
          },
          {
            url: `${imageCDNUrl}/demo-album-4/horse-640.jpg`,
            key: 'demo-album-4/horse-640.jpg',
            size: 46704,
            lastModified: '2024-07-24T21:49:42.000Z',
          },
          {
            url: `${imageCDNUrl}/demo-album-4/mountains-8419249_640.jpg`,
            key: 'demo-album-4/mountains-8419249_640.jpg',
            size: 40501,
            lastModified: '2024-07-24T21:49:42.000Z',
          },
          {
            url: `${imageCDNUrl}/demo-album-4/sheep-7943526_1280.jpg`,
            key: 'demo-album-4/sheep-7943526_1280.jpg',
            size: 211220,
            lastModified: '2024-07-24T21:49:42.000Z',
          },
          {
            url: `${imageCDNUrl}/demo-album-4/train-8517089_640.jpg`,
            key: 'demo-album-4/train-8517089_640.jpg',
            size: 73966,
            lastModified: '2024-07-24T21:49:42.000Z',
          },
        ],
      },
    });
  }
  return HttpResponse.json({
    code: 200,
    status: 'Success',
    message: 'ok',
    data: {
      album: {
        id: 'demo-album3',
        year: 'na',
        albumName: 'this is demo-album-3',
        description: '',
        albumCover: 'demo-album3/batch_dog-8378909.jpg',
        isUnlisted: false,
        isFeatured: false,
        place: {
          formattedAddress: 'George Town, Penang, Malaysia',
          displayName: 'George Town',
          location: {
            latitude: 5.4141307,
            longitude: 100.3287506,
          },
        },
        tags: ['testtag1'],
      },
      photos: [
        {
          url: `${imageCDNUrl}/demo-album3/batch_berlin.jpg`,
          key: 'demo-album3/batch_berlin-8429780.jpg',
          size: 180940,
          lastModified: '2024-07-24T21:49:44.000Z',
          latitude: 5.410131,
          longitude: 100.324751,
          takenAt: '2024-07-24T09:03:00',
          hasGps: true,
        },
        {
          url: `${imageCDNUrl}/demo-album3/batch_bird-8360220.jpg`,
          key: 'demo-album3/batch_bird-8360220.jpg',
          size: 97523,
          lastModified: '2024-07-24T21:49:44.000Z',
          latitude: 5.414131,
          longitude: 100.326751,
          takenAt: '2024-07-24T09:06:00',
          hasGps: true,
        },
        {
          url: `${imageCDNUrl}/demo-album3/batch_castle-8033915.jpg`,
          key: 'demo-album3/batch_castle-8033915.jpg',
          size: 75139,
          lastModified: '2024-07-24T21:49:44.000Z',
          latitude: 5.418131,
          longitude: 100.322751,
          takenAt: '2024-07-24T09:09:00',
          hasGps: true,
        },
        {
          url: `${imageCDNUrl}/demo-album3/batch_cat-8282097.jpg`,
          key: 'demo-album3/batch_cat-8282097.jpg',
          size: 120824,
          lastModified: '2024-07-24T21:49:44.000Z',
          latitude: 5.422131,
          longitude: 100.324751,
          takenAt: '2024-07-24T09:12:00',
          hasGps: true,
        },
        {
          url: `${imageCDNUrl}/demo-album3/batch_dog-8378909.jpg`,
          key: 'demo-album3/batch_dog-8378909.jpg',
          size: 188466,
          lastModified: '2024-07-24T21:49:44.000Z',
          latitude: 5.406131,
          longitude: 100.332751,
          takenAt: '2024-07-24T09:15:00',
          hasGps: true,
        },
        {
          url: `${imageCDNUrl}/demo-album3/batch_elks-8430545.jpg`,
          key: 'demo-album3/batch_elks-8430545.jpg',
          size: 133452,
          lastModified: '2024-07-24T21:49:44.000Z',
          latitude: 5.410131,
          longitude: 100.328751,
          takenAt: '2024-07-24T09:18:00',
          hasGps: true,
        },
        {
          url: `${imageCDNUrl}/demo-album3/batch_field-8419729.jpg`,
          key: 'demo-album3/batch_field-8419729.jpg',
          size: 143020,
          lastModified: '2024-07-24T21:49:44.000Z',
          latitude: 5.414131,
          longitude: 100.330751,
          takenAt: '2024-07-24T09:21:00',
          hasGps: true,
        },
        {
          url: `${imageCDNUrl}/demo-album3/batch_flamingo-8353373.jpg`,
          key: 'demo-album3/batch_flamingo-8353373.jpg',
          size: 82580,
          lastModified: '2024-07-24T21:49:44.000Z',
          latitude: 5.418131,
          longitude: 100.332751,
          takenAt: '2024-07-24T09:24:00',
          hasGps: true,
        },
        {
          url: `${imageCDNUrl}/demo-album3/batch_giraffe-8435321.jpg`,
          key: 'demo-album3/batch_giraffe-8435321.jpg',
          size: 155955,
          lastModified: '2024-07-24T21:49:44.000Z',
          latitude: 5.422131,
          longitude: 100.328751,
          takenAt: '2024-07-24T09:27:00',
          hasGps: true,
        },
        {
          url: `${imageCDNUrl}/demo-album3/batch_moutains-8445767.jpg`,
          key: 'demo-album3/batch_moutains-8445767.jpg',
          size: 89840,
          lastModified: '2024-07-24T21:49:44.000Z',
          latitude: 5.406131,
          longitude: 100.336751,
          takenAt: '2024-07-24T09:30:00',
          hasGps: true,
        },
        {
          url: `${imageCDNUrl}/demo-album3/batch_pine-hills-8419433.jpg`,
          key: 'demo-album3/batch_pine-hills-8419433.jpg',
          size: 114174,
          lastModified: '2024-07-24T21:49:44.000Z',
          latitude: 5.410131,
          longitude: 100.338751,
          takenAt: '2024-07-24T09:33:00',
          hasGps: true,
        },
        {
          url: `${imageCDNUrl}/demo-album3/batch_port-8431044.jpg`,
          key: 'demo-album3/batch_port-8431044.jpg',
          size: 128145,
          lastModified: '2024-07-24T21:49:44.000Z',
          latitude: 5.414131,
          longitude: 100.334751,
          takenAt: '2024-07-24T09:36:00',
          hasGps: true,
        },
        {
          url: `${imageCDNUrl}/demo-album3/batch_roofs-8449752.jpg`,
          key: 'demo-album3/batch_roofs-8449752.jpg',
          size: 125865,
          lastModified: '2024-07-24T21:49:44.000Z',
          latitude: 5.418131,
          longitude: 100.336751,
          takenAt: '2024-07-24T09:39:00',
          hasGps: true,
        },
        {
          url: `${imageCDNUrl}/demo-album3/batch_sailboats-8337698.jpg`,
          key: 'demo-album3/batch_sailboats-8337698.jpg',
          size: 81574,
          lastModified: '2024-07-24T21:49:44.000Z',
          latitude: 5.422131,
          longitude: 100.338751,
          takenAt: '2024-07-24T09:42:00',
          hasGps: true,
        },
        {
          url: `${imageCDNUrl}/demo-album3/batch_sandpiper-8429874.jpg`,
          key: 'demo-album3/batch_sandpiper-8429874.jpg',
          size: 101573,
          lastModified: '2024-07-24T21:49:44.000Z',
          hasGps: false,
        },
        {
          url: `${imageCDNUrl}/demo-album3/batch_winter-8433264.jpg`,
          key: 'demo-album3/batch_winter-8433264.jpg',
          size: 127010,
          lastModified: '2024-07-24T21:49:44.000Z',
          hasGps: false,
        },
        {
          url: `${imageCDNUrl}/demo-album3/bridge-8420945_1280.jpg`,
          key: 'demo-album3/bridge-8420945_1280.jpg',
          size: 272207,
          lastModified: '2024-07-24T21:49:44.000Z',
        },
        {
          url: `${imageCDNUrl}/demo-album3/cat-8438334_1280.jpg`,
          key: 'demo-album3/cat-8438334_1280.jpg',
          size: 222425,
          lastModified: '2024-07-24T21:49:44.000Z',
        },
        {
          url: `${imageCDNUrl}/demo-album3/eagle-8262555_1280.jpg`,
          key: 'demo-album3/eagle-8262555_1280.jpg',
          size: 140045,
          lastModified: '2024-07-24T21:49:44.000Z',
        },
        {
          url: `${imageCDNUrl}/demo-album3/sheep-7943526_1280.jpg`,
          key: 'demo-album3/sheep-7943526_1280.jpg',
          size: 211220,
          lastModified: '2024-10-06T02:50:50.000Z',
        },
      ],
    },
  });
});

export const movePhotos = http.put('/api/photos', async () => {
  await delay();

  return HttpResponse.json({
    code: 200,
    status: 'Success',
    message: 'ok',
  });

  // return new HttpResponse(null, {
  //   status: 500,
  //   statusText: 'Error',
  // });
});

export const deletePhotos = http.delete('/api/photos', async () => {
  await delay();

  return HttpResponse.json({
    code: 200,
    status: 'Success',
    message: 'ok',
  });
});

export const renamePhoto = http.put('/api/photos/rename', async () => {
  await delay();

  return HttpResponse.json({
    code: 200,
    status: 'Success',
    message: 'ok',
  });
});

export const uploadPhotos = http.post('/api/photos/upload/**', async () => {
  await delay();

  return HttpResponse.json({
    code: 200,
    status: 'Success',
    message: 'ok',
  });
});

/**
 * Fixture for the photo store's `['photos', id, year]` query, used by `setupQueryMocks`.
 *
 * Deliberately mixed: photos with coordinates (so the map has pins to draw), photos
 * scanned and found to have none, and photos never scanned (so the scan dialog has
 * something to offer). A fixture where every photo is located would let a pin filter that
 * drops nothing pass its tests.
 */
export const mockPhotoResponse = {
  album: {
    id: 'demo-album3',
    year: 'na',
    albumName: 'this is demo-album-3',
    description: '',
    albumCover: 'demo-album3/batch_dog-8378909.jpg',
    isUnlisted: false,
    isFeatured: false,
    place: {
      formattedAddress: 'George Town, Penang, Malaysia',
      displayName: 'George Town',
      location: { latitude: 5.4141307, longitude: 100.3287506 },
    },
    tags: ['testtag1'],
  },
  photos: [
    {
      url: `${imageCDNUrl}/demo-album3/batch_berlin.jpg`,
      key: 'demo-album3/batch_berlin-8429780.jpg',
      size: 180940,
      lastModified: '2024-07-24T21:49:44.000Z',
      latitude: 5.4101307,
      longitude: 100.3247506,
      takenAt: '2024-07-24T09:03:00',
      hasGps: true,
    },
    {
      url: `${imageCDNUrl}/demo-album3/batch_bird-8360220.jpg`,
      key: 'demo-album3/batch_bird-8360220.jpg',
      size: 97523,
      lastModified: '2024-07-24T21:49:44.000Z',
      latitude: 5.4181307,
      longitude: 100.3327506,
      takenAt: '2024-07-24T09:06:00',
      hasGps: true,
    },
    {
      url: `${imageCDNUrl}/demo-album3/batch_castle-8033915.jpg`,
      key: 'demo-album3/batch_castle-8033915.jpg',
      size: 75139,
      lastModified: '2024-07-24T21:49:44.000Z',
      hasGps: false,
    },
    {
      url: `${imageCDNUrl}/demo-album3/batch_cat-8282097.jpg`,
      key: 'demo-album3/batch_cat-8282097.jpg',
      size: 120824,
      lastModified: '2024-07-24T21:49:44.000Z',
    },
  ],
};
