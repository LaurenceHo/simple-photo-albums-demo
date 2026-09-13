import type { TrackFeature, TrackManifest, TrackManifestEntry } from '@/schema/gps-track';
import { GpsTrackService } from '@/services/gps-track-service';
import { useAlbumStore } from '@/stores/album';
import { useQueries, useQuery, useQueryClient } from '@tanstack/vue-query';
import { defineStore, storeToRefs } from 'pinia';
import { computed, ref, watch } from 'vue';

/** A manifest row plus whatever its geometry query knows so far. */
export interface TrackLegendItem extends TrackManifestEntry {
  /** The GPX's own `<trk><name>` once geometry loads, else the id the file was saved as. */
  label: string;
  distanceKm: number | undefined;
  isLoading: boolean;
  isError: boolean;
  visible: boolean;
}

/** A loaded, visible track ready to hand to Mapbox. */
export interface RenderableTrack {
  trackId: string;
  colour: string;
  feature: TrackFeature;
}

const fetchManifest = async (albumId: string): Promise<TrackManifest> => {
  const { data, code, message } = await GpsTrackService.getTracks(albumId);

  if (code !== 200) {
    console.error('Error fetching GPS tracks:', message);
    return [];
  }
  return data ?? [];
};

export const useGpsTrackStore = defineStore('gpsTrack', () => {
  const queryClient = useQueryClient();
  const { currentAlbum } = storeToRefs(useAlbumStore());

  /**
   * Album the track surfaces are acting on, when it is not the one being viewed.
   *
   * The map view always means `currentAlbum`. The album dialog does not: opened from the
   * album list it edits `albumToBeUpdate`, which may be an album that was never opened, so
   * keying off `currentAlbum` there would list and upload tracks against the wrong album.
   * `CreateAlbum.vue` sets this while it is open and clears it on close.
   */
  const overrideAlbumId = ref('');

  const albumId = computed(() => overrideAlbumId.value || currentAlbum.value.id);

  const setAlbumId = (id: string) => {
    overrideAlbumId.value = id;
  };

  /**
   * Tracks the viewer has switched off, by id.
   *
   * Hidden rather than visible ids, so a newly uploaded track shows by default without
   * anything having to add it here.
   */
  const hiddenTrackIds = ref<Set<string>>(new Set());

  const manifestKey = computed(() => ['gpsTracks', albumId.value]);

  const {
    data: manifestData,
    isFetching: isFetchingTracks,
    isError,
    refetch: refetchTracks,
  } = useQuery({
    queryKey: manifestKey,
    queryFn: () => fetchManifest(albumId.value),
    enabled: computed(() => !!albumId.value),
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });

  const tracks = computed<TrackManifest>(() => manifestData.value ?? []);

  /**
   * One query per track, rather than one merged request.
   *
   * Geometry never changes for a given id - replacing a track writes a new object under
   * the same id and the mutation below invalidates just that key - so it is cached
   * indefinitely and toggling a track off and on again refetches nothing.
   */
  const geometryResults = useQueries({
    queries: computed(() =>
      tracks.value.map((track) => ({
        queryKey: ['gpsTrack', albumId.value, track.trackId],
        queryFn: async (): Promise<TrackFeature | null> => {
          const { data, code } = await GpsTrackService.getTrack(albumId.value, track.trackId);
          return code === 200 ? (data ?? null) : null;
        },
        staleTime: Infinity,
        refetchOnWindowFocus: false,
        refetchOnReconnect: false,
      })),
    ),
  });

  const legend = computed<TrackLegendItem[]>(() =>
    tracks.value.map((track, index) => {
      const result = geometryResults.value[index];
      const feature = result?.data ?? undefined;

      return {
        ...track,
        label: feature?.properties.name ?? track.trackId,
        distanceKm: feature?.properties.distanceKm,
        isLoading: result?.isLoading ?? true,
        isError: result?.isError ?? false,
        visible: !hiddenTrackIds.value.has(track.trackId),
      };
    }),
  );

  /** Loaded and visible tracks, in manifest order. */
  const renderableTracks = computed<RenderableTrack[]>(() =>
    tracks.value.flatMap((track, index) => {
      const feature = geometryResults.value[index]?.data;
      if (!feature || hiddenTrackIds.value.has(track.trackId)) return [];
      return [{ trackId: track.trackId, colour: track.colour, feature }];
    }),
  );

  const hasTracks = computed(() => tracks.value.length > 0);

  const toggleTrack = (trackId: string) => {
    const next = new Set(hiddenTrackIds.value);
    if (next.has(trackId)) {
      next.delete(trackId);
    } else {
      next.add(trackId);
    }
    hiddenTrackIds.value = next;
  };

  const invalidateManifest = async () => {
    await queryClient.invalidateQueries({ queryKey: ['gpsTracks', albumId.value] });
  };

  /**
   * Upload or replace one track.
   *
   * Invalidates the manifest and, when replacing, that track's geometry key as well -
   * the id is unchanged, so without the second invalidation the map would keep drawing
   * the old line from cache.
   */
  const uploadTrack = async (trackId: string, gpx: string) => {
    const result = await GpsTrackService.uploadTrack(albumId.value, trackId, gpx);
    if (result.code === 200) {
      await queryClient.invalidateQueries({
        queryKey: ['gpsTrack', albumId.value, trackId],
      });
      await invalidateManifest();
    }
    return result;
  };

  const deleteTrack = async (trackId: string) => {
    const result = await GpsTrackService.deleteTrack(albumId.value, trackId);
    if (result.code === 200) {
      queryClient.removeQueries({ queryKey: ['gpsTrack', albumId.value, trackId] });
      await invalidateManifest();
    }
    return result;
  };

  // Visibility is per album. Without this, hiding "day-1" in one album would hide a
  // same-named track in the next album opened.
  watch(albumId, () => {
    hiddenTrackIds.value = new Set();
  });

  /**
   * Drop the override whenever the viewed album changes.
   *
   * Defence in depth. `CreateAlbum.vue` clears it in `onUnmounted`, but a stale override
   * here is not a cosmetic bug - it silently redirects uploads and deletes at another
   * album, which is exactly what happened when the clearing was left to a watcher that
   * the dialog's own `v-if` tore down first. Navigating to a different album is an
   * unambiguous signal that any dialog-scoped target is finished with.
   */
  watch(
    () => currentAlbum.value.id,
    () => {
      overrideAlbumId.value = '';
    },
  );

  return {
    // refs
    tracks,
    legend,
    renderableTracks,
    hasTracks,
    isFetchingTracks,
    isError,
    // actions
    refetchTracks,
    setAlbumId,
    toggleTrack,
    uploadTrack,
    deleteTrack,
  };
});
