import { useQueries, useQuery, useQueryClient } from '@tanstack/vue-query';
import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { computed, nextTick, ref } from 'vue';
import { useGpsTrackStore } from '../gps-track';

vi.mock('@tanstack/vue-query', () => ({
  useQuery: vi.fn(),
  useQueries: vi.fn(),
  useQueryClient: vi.fn(),
}));

vi.mock('@/services/gps-track-service', () => ({
  GpsTrackService: {
    getTracks: vi.fn(),
    getTrack: vi.fn(),
    uploadTrack: vi.fn(),
    deleteTrack: vi.fn(),
  },
}));

/**
 * One shared, mutable ref - not a fresh `ref(...)` per call.
 *
 * The store watches `currentAlbum.id` to clear per-album state, and a ref that can never
 * change makes those watchers unreachable: they were the one untested part of the fix for
 * uploads landing in the wrong album.
 */
const currentAlbum = vi.hoisted(() => ({ value: null as unknown }));

vi.mock('@/stores/album', async () => {
  const { ref: createRef } = await import('vue');
  currentAlbum.value = createRef({ id: 'demo-album', year: '2026' });
  return { useAlbumStore: () => ({ currentAlbum: currentAlbum.value }) };
});

/** Navigate to a different album, as the router does. */
const viewAlbum = async (id: string) => {
  (currentAlbum.value as { value: { id: string; year: string } }).value = { id, year: '2026' };
  await nextTick();
};

const manifest = [
  { trackId: 'day-1', colour: '#0072B2', size: 10, lastModified: 'a' },
  { trackId: 'day-2', colour: '#D55E00', size: 20, lastModified: 'b' },
];

const feature = (name: string, distanceKm: number) => ({
  type: 'Feature',
  properties: { name, distanceKm, pointCount: 2, simplified: false },
  geometry: { type: 'LineString', coordinates: [] },
});

/** Wire the query mocks with a manifest and a per-track geometry result. */
const givenTracks = (
  tracks: typeof manifest,
  geometry: Array<{ data?: unknown; isLoading?: boolean; isError?: boolean }>,
) => {
  (useQuery as Mock).mockReturnValue({
    data: ref(tracks),
    isFetching: ref(false),
    isError: ref(false),
    refetch: vi.fn(),
  });
  (useQueries as Mock).mockReturnValue(
    computed(() =>
      geometry.map((entry) => ({
        data: entry.data,
        isLoading: entry.isLoading ?? false,
        isError: entry.isError ?? false,
      })),
    ),
  );
};

describe('useGpsTrackStore', () => {
  const invalidateQueries = vi.fn();
  const removeQueries = vi.fn();

  beforeEach(() => {
    setActivePinia(createPinia());
    vi.clearAllMocks();
    (useQueryClient as Mock).mockReturnValue({ invalidateQueries, removeQueries });
  });

  describe('legend', () => {
    it('labels a track with the GPX name once geometry loads', () => {
      givenTracks(manifest, [{ data: feature('Day One', 8.4) }, { data: feature('Day Two', 12) }]);

      const store = useGpsTrackStore();

      expect(store.legend[0]?.label).toBe('Day One');
      expect(store.legend[0]?.distanceKm).toBe(8.4);
    });

    it('falls back to the trackId while geometry is still loading', () => {
      givenTracks(manifest, [{ isLoading: true }, { isLoading: true }]);

      const store = useGpsTrackStore();

      // The legend renders immediately from the manifest; the label upgrades later.
      expect(store.legend[0]?.label).toBe('day-1');
      expect(store.legend[0]?.isLoading).toBe(true);
    });

    it('marks a track whose geometry failed, without affecting the others', () => {
      givenTracks(manifest, [{ isError: true }, { data: feature('Day Two', 12) }]);

      const store = useGpsTrackStore();

      expect(store.legend[0]?.isError).toBe(true);
      expect(store.legend[1]?.isError).toBe(false);
      expect(store.legend[1]?.label).toBe('Day Two');
    });

    it('keeps the server-assigned colour, so the swatch matches the map line', () => {
      givenTracks(manifest, [{ data: feature('a', 1) }, { data: feature('b', 2) }]);

      const store = useGpsTrackStore();

      expect(store.legend.map((item) => item.colour)).toEqual(['#0072B2', '#D55E00']);
    });
  });

  describe('renderableTracks', () => {
    it('includes only tracks whose geometry has loaded', () => {
      givenTracks(manifest, [{ data: feature('Day One', 8.4) }, { isLoading: true }]);

      const store = useGpsTrackStore();

      expect(store.renderableTracks).toHaveLength(1);
      expect(store.renderableTracks[0]?.trackId).toBe('day-1');
    });

    it('drops a track that has been toggled off', () => {
      givenTracks(manifest, [{ data: feature('a', 1) }, { data: feature('b', 2) }]);

      const store = useGpsTrackStore();
      store.toggleTrack('day-1');

      expect(store.renderableTracks.map((track) => track.trackId)).toEqual(['day-2']);
      expect(store.legend[0]?.visible).toBe(false);
    });

    it('toggling twice restores the track', () => {
      givenTracks(manifest, [{ data: feature('a', 1) }, { data: feature('b', 2) }]);

      const store = useGpsTrackStore();
      store.toggleTrack('day-1');
      store.toggleTrack('day-1');

      expect(store.renderableTracks).toHaveLength(2);
    });
  });

  describe('hasTracks', () => {
    it('is false for an album with none', () => {
      givenTracks([], []);

      expect(useGpsTrackStore().hasTracks).toBe(false);
    });

    it('is true as soon as the manifest has an entry, before geometry loads', () => {
      givenTracks(manifest, [{ isLoading: true }, { isLoading: true }]);

      expect(useGpsTrackStore().hasTracks).toBe(true);
    });
  });

  describe('mutations', () => {
    it('invalidates both the track geometry and the manifest after an upload', async () => {
      const { GpsTrackService } = await import('@/services/gps-track-service');
      (GpsTrackService.uploadTrack as Mock).mockResolvedValue({ code: 200 });
      givenTracks(manifest, [{ data: feature('a', 1) }, { data: feature('b', 2) }]);

      await useGpsTrackStore().uploadTrack('day-1', '<gpx/>');

      // Replacing reuses the id, so without the geometry invalidation the map would keep
      // drawing the previous line from cache.
      expect(invalidateQueries).toHaveBeenCalledWith({
        queryKey: ['gpsTrack', 'demo-album', 'day-1'],
      });
      expect(invalidateQueries).toHaveBeenCalledWith({
        queryKey: ['gpsTracks', 'demo-album'],
      });
    });

    it('does not invalidate when the upload failed', async () => {
      const { GpsTrackService } = await import('@/services/gps-track-service');
      (GpsTrackService.uploadTrack as Mock).mockResolvedValue({ code: 400 });
      givenTracks(manifest, [{ data: feature('a', 1) }, { data: feature('b', 2) }]);

      await useGpsTrackStore().uploadTrack('day-1', 'bad');

      expect(invalidateQueries).not.toHaveBeenCalled();
    });

    it('removes the geometry cache entry and refreshes the manifest after a delete', async () => {
      const { GpsTrackService } = await import('@/services/gps-track-service');
      (GpsTrackService.deleteTrack as Mock).mockResolvedValue({ code: 200 });
      givenTracks(manifest, [{ data: feature('a', 1) }, { data: feature('b', 2) }]);

      await useGpsTrackStore().deleteTrack('day-1');

      expect(removeQueries).toHaveBeenCalledWith({
        queryKey: ['gpsTrack', 'demo-album', 'day-1'],
      });
      expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: ['gpsTracks', 'demo-album'] });
    });
  });
});

/**
 * Regression tests for a bug that shipped: `overrideAlbumId` stayed pinned to the
 * last-edited album, so after opening Edit on one album every later upload and delete -
 * from any album - silently targeted that first one.
 */
describe('useGpsTrackStore album targeting', () => {
  const invalidateQueries = vi.fn();
  const removeQueries = vi.fn();

  beforeEach(() => {
    setActivePinia(createPinia());
    vi.clearAllMocks();
    (useQueryClient as Mock).mockReturnValue({ invalidateQueries, removeQueries });
    givenTracks(manifest, [{ data: feature('a', 1) }, { data: feature('b', 2) }]);
  });

  it('targets the viewed album by default', async () => {
    const { GpsTrackService } = await import('@/services/gps-track-service');
    (GpsTrackService.uploadTrack as Mock).mockResolvedValue({ code: 200 });

    await useGpsTrackStore().uploadTrack('day-1', '<gpx/>');

    expect(GpsTrackService.uploadTrack).toHaveBeenCalledWith('demo-album', 'day-1', '<gpx/>');
  });

  it('targets the overridden album while the album dialog owns it', async () => {
    const { GpsTrackService } = await import('@/services/gps-track-service');
    (GpsTrackService.uploadTrack as Mock).mockResolvedValue({ code: 200 });

    const store = useGpsTrackStore();
    store.setAlbumId('other-album');
    await store.uploadTrack('day-1', '<gpx/>');

    expect(GpsTrackService.uploadTrack).toHaveBeenCalledWith('other-album', 'day-1', '<gpx/>');
  });

  it('falls back to the viewed album once the override is released', async () => {
    const { GpsTrackService } = await import('@/services/gps-track-service');
    (GpsTrackService.deleteTrack as Mock).mockResolvedValue({ code: 200 });

    const store = useGpsTrackStore();
    store.setAlbumId('other-album');
    // What `CreateAlbum.vue` does in onUnmounted. Leaving this out is precisely the bug:
    // deletes kept hitting 'other-album' from every other album's UI.
    store.setAlbumId('');
    await store.deleteTrack('day-1');

    expect(GpsTrackService.deleteTrack).toHaveBeenCalledWith('demo-album', 'day-1');
  });

  it('releases a stale override when the viewed album changes', async () => {
    const { GpsTrackService } = await import('@/services/gps-track-service');
    (GpsTrackService.uploadTrack as Mock).mockResolvedValue({ code: 200 });

    const store = useGpsTrackStore();
    // The dialog set this and was torn down by its own `v-if` before it could clear it -
    // the shipped bug. Navigating away is the backstop, and it had no test.
    store.setAlbumId('other-album');
    await viewAlbum('a-third-album');
    await store.uploadTrack('day-1', '<gpx/>');

    expect(GpsTrackService.uploadTrack).toHaveBeenCalledWith('a-third-album', 'day-1', '<gpx/>');
  });

  it('does not carry hidden tracks across albums', async () => {
    const store = useGpsTrackStore();
    store.toggleTrack('day-1');
    expect(store.legend[0]?.visible).toBe(false);

    await viewAlbum('another-album');

    // Without the reset, hiding "day-1" here would hide a same-named track in every album
    // opened afterwards, with no visible cause.
    expect(store.legend[0]?.visible).toBe(true);
  });
});
