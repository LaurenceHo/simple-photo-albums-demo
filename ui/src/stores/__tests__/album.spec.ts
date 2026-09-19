import type { Album } from '@/schema';
import { useQuery, useQueryClient } from '@tanstack/vue-query';
import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { nextTick, ref, type Ref } from 'vue';
import { useRouter } from 'vue-router';
import { useAlbumStore } from '../album';

vi.mock('@tanstack/vue-query', () => ({
  useQuery: vi.fn(),
  useQueryClient: vi.fn(),
}));

vi.mock('vue-router', () => ({
  useRouter: vi.fn(),
}));

vi.mock('@/services/album-service', () => ({
  AlbumService: {
    getAlbumsByYear: vi.fn(),
  },
}));

vi.mock('@/utils/helper', () => ({
  getDataFromLocalStorage: vi.fn(),
  sortByKey: vi.fn((data) => data),
}));

/** An album with every field set, so a test only has to state what it cares about. */
const buildAlbum = (album: Partial<Album>): Album => ({
  id: '0',
  albumName: 'Album',
  year: '2023',
  albumCover: '',
  description: '',
  tags: [],
  isUnlisted: false,
  ...album,
});

/** Points the mocked query at a ref the test can reassign, as a refetch would. */
const mockQueryData = (data: Ref<Album[] | undefined>) => {
  (useQuery as Mock).mockReturnValue({
    data,
    isFetching: ref(false),
    isError: ref(false),
    refetch: vi.fn(),
  });
};

describe('AlbumStore', () => {
  const mockRouter = {
    push: vi.fn(),
    currentRoute: {
      value: {
        params: { year: '2023' },
      },
    },
  };

  const mockQueryClient = {
    fetchQuery: vi.fn(),
  };

  beforeEach(() => {
    setActivePinia(createPinia());
    vi.clearAllMocks();
    (useRouter as Mock).mockReturnValue(mockRouter);
    (useQueryClient as Mock).mockReturnValue(mockQueryClient);
    mockQueryData(ref([]));
  });

  it('should initialize with default state', () => {
    const store = useAlbumStore();
    expect(store.selectedYear).toBe('na');
    expect(store.filterState.searchKey).toBe('');
    expect(store.filterState.unlistedOnly).toBe(false);
  });

  it('should update selectedYear', () => {
    const store = useAlbumStore();
    store.setSelectedYear('2024');
    expect(store.selectedYear).toBe('2024');
  });

  it('should set searchKey', () => {
    const store = useAlbumStore();
    store.setSearchKey('test');
    expect(store.filterState.searchKey).toBe('test');
  });

  it('should clear filters', () => {
    const store = useAlbumStore();
    store.setSearchKey('test');
    store.setUnlistedOnly(true);
    store.clearFilters();
    expect(store.filterState.searchKey).toBe('');
    expect(store.filterState.unlistedOnly).toBe(false);
  });

  it('should set current album', () => {
    const store = useAlbumStore();
    const mockAlbum = { id: '1', albumName: 'Test' } as Partial<Album> as Album;
    store.setCurrentAlbum(mockAlbum);
    expect(store.currentAlbum).toEqual(mockAlbum);
  });

  it('should check if photo is album cover', () => {
    const store = useAlbumStore();
    store.setCurrentAlbum({ albumCover: 'cover.jpg' } as Partial<Album> as Album);
    expect(store.isAlbumCover('cover.jpg')).toBe(true);
    expect(store.isAlbumCover('other.jpg')).toBe(false);
  });

  it('keeps the active filters when a refetch replaces the album data', async () => {
    // Only `Alpha` satisfies all three filters at once: it is unlisted, tagged
    // `holiday`, and its name matches the search term. Each of the others fails
    // exactly one filter, so no single broken filter can still yield this result.
    const albums = [
      buildAlbum({ id: '1', albumName: 'Alpha', isUnlisted: true, tags: ['holiday'] }),
      buildAlbum({ id: '2', albumName: 'Alpine', isUnlisted: false, tags: ['holiday'] }),
      buildAlbum({ id: '3', albumName: 'Alto', isUnlisted: true, tags: ['work'] }),
      buildAlbum({ id: '4', albumName: 'Delta', isUnlisted: true, tags: ['holiday'] }),
    ];
    const data = ref<Album[] | undefined>([]);
    mockQueryData(data);

    const store = useAlbumStore();

    // The data has to land in its own tick. Setting it alongside the filters would let
    // the filter watcher alone produce the right answer, and the test would then pass
    // with the data watcher deleted outright.
    data.value = albums;
    await nextTick();

    store.setUnlistedOnly(true);
    store.setSelectedTags(['holiday']);
    store.setSearchKey('al');
    await nextTick();
    expect(store.filteredAlbums.map((album) => album.id)).toEqual(['1']);

    // Editing or deleting an album refetches the same year, replacing the query data.
    // The filters the user set have to survive that, so the refetch has to change the
    // content — replaying the same albums could not distinguish a stale list.
    data.value = [
      ...albums.filter((album) => album.id !== '1'),
      buildAlbum({ id: '5', albumName: 'Alps', isUnlisted: true, tags: ['holiday'] }),
    ];
    await nextTick();
    expect(store.filteredAlbums.map((album) => album.id)).toEqual(['5']);
  });

  it('yields an empty list when a filter changes with no album data', async () => {
    // The filter watcher used to be guarded by `data.value?.length`. Dropping that
    // guard has to leave both empty cases alone, including the `|| []` branch.
    const data = ref<Album[] | undefined>([]);
    mockQueryData(data);

    const store = useAlbumStore();
    store.setSearchKey('anything');
    await nextTick();
    expect(store.filteredAlbums).toEqual([]);

    data.value = undefined;
    await nextTick();
    store.setUnlistedOnly(true);
    await nextTick();
    expect(store.filteredAlbums).toEqual([]);
  });
});
