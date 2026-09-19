import { setupQueryMocks } from '@/mocks/setup-query-mock';
import type { Album, UserPermission } from '@/schema';
import { useAlbumStore, useDialogStore, useUserConfigStore } from '@/stores';
import AlbumList from '@/views/AlbumList.vue';
import { createTestingPinia } from '@pinia/testing';
import { mount, VueWrapper } from '@vue/test-utils';
import PrimeVue from 'primevue/config';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { nextTick, reactive, ref } from 'vue';
import { type RouteLocationNormalizedLoadedGeneric, useRoute } from 'vue-router';

const mockPush = vi.fn();

vi.mock('vue-router', () => ({
  useRoute: vi.fn(() => reactive({ params: {} })),
  useRouter: vi.fn(() => ({
    push: mockPush,
    currentRoute: ref({ params: {} }),
  })),
}));

vi.mock('primevue/usetoast', () => ({
  useToast: vi.fn(() => ({
    add: vi.fn(),
  })),
}));

vi.mock('@tanstack/vue-query', () => ({
  useQuery: vi.fn(),
  useMutation: vi.fn(),
  useQueryClient: vi.fn(),
}));

vi.mock('@/utils/helper', async () => {
  const actual = await vi.importActual('@/utils/helper');
  return {
    ...actual,
    getDataFromLocalStorage: vi.fn(),
  };
});

/**
 * Builds `count` albums named `Album 01`..`Album NN`, already in ascending name order.
 * They all carry `tag1` so that filtering by it keeps the list long enough to page.
 */
const buildAlbums = (count: number): Album[] =>
  Array.from({ length: count }, (_, index) => ({
    id: String(index + 1),
    albumName: `Album ${String(index + 1).padStart(2, '0')}`,
    year: '2023',
    albumCover: '',
    description: '',
    tags: ['tag1'],
    isUnlisted: false,
  }));

/**
 * The `first` index the view has bound to the Paginator. `Paginator: true` stubs the
 * component without its inherited props, so the binding arrives as a plain attribute.
 */
const paginatorFirst = (paginator: VueWrapper): number => Number(paginator.attributes('first'));

/** Name of the first album the paginated list currently renders. */
const firstRenderedAlbumName = (wrapper: VueWrapper): string | undefined => {
  const albums = wrapper.findAllComponents({ name: 'Album' });
  return albums.length > 0 ? (albums[0]!.props('albumItem') as Album).albumName : undefined;
};

describe('AlbumList.vue', () => {
  const createWrapper = (storeOverrides = {}): VueWrapper => {
    return mount(AlbumList, {
      global: {
        plugins: [
          PrimeVue,
          createTestingPinia({
            createSpy: vi.fn,
            stubActions: false,
            initialState: {
              album: {
                selectedYear: 'na',
                filterState: {
                  searchKey: '',
                  selectedTags: [],
                  unlistedOnly: false,
                  sortOrder: 'desc',
                },
                filteredAlbums: [],
                filteredAlbumsByYear: null,
              },
              dialog: {
                dialogStates: {
                  renamePhoto: false,
                  movePhoto: false,
                  deletePhoto: false,
                  updateAlbum: false,
                  createAlbumTag: false,
                  showAlbumTags: false,
                  createTravelRecords: false,
                  showTravelRecords: false,
                },
              },
              ...storeOverrides,
            },
          }),
        ],
        stubs: {
          Button: true,
          SelectYear: true,
          SelectTags: true,
          Paginator: true,
          Panel: true,
          ToggleSwitch: true,
          Skeleton: true,
          Carousel: true,
          Album: true,
          ScrollTop: true,
          CreateAlbum: true,
          CreateAlbumTag: true,
          ShowAlbumTags: true,
          Toast: true,
        },
      },
    });
  };

  /**
   * Mounts the list holding `count` albums and, unless `first` is 0, moves the paginator
   * there. Every pagination test needs this same setup.
   */
  const mountPagedList = async ({ count = 45, first = 40 } = {}) => {
    const wrapper = createWrapper();
    const albumStore = useAlbumStore();
    albumStore.filteredAlbums = buildAlbums(count);
    await nextTick();

    // Looked up on each use rather than held: a refetch unmounts the Paginator and
    // mounts a fresh one, which is the very thing some of these tests exercise.
    const paginator = () => wrapper.findComponent({ name: 'Paginator' });
    if (first > 0) {
      await paginator().vm.$emit('update:first', first);
      await nextTick();
    }

    return { wrapper, albumStore, paginator };
  };

  beforeEach(() => {
    setupQueryMocks();
    vi.clearAllMocks();
    vi.mocked(useRoute).mockReset();
    vi.mocked(useRoute).mockReturnValue(
      reactive({ params: {} }) as RouteLocationNormalizedLoadedGeneric,
    );
  });

  it('renders the component', () => {
    const wrapper = createWrapper();
    expect(wrapper.exists()).toBe(true);
  });

  it('toggles sort order when the sort button is clicked', async () => {
    const wrapper = createWrapper();
    const albumStore = useAlbumStore();

    const sortButton = wrapper.findComponent({ name: 'Button' });
    await sortButton.trigger('click');
    expect(albumStore.filterState.sortOrder).toBe('asc');
    await sortButton.trigger('click');
    expect(albumStore.filterState.sortOrder).toBe('desc');
  });

  it('returns to the first page when the sort order is toggled', async () => {
    // The query has to hold the same 45 albums: toggling sort re-runs the store's
    // `applyFilters`, and a shorter result would clamp the page rather than reset it,
    // so this would pass without the reset watcher.
    setupQueryMocks({ useQuery: { data: ref(buildAlbums(45)) } });
    const { wrapper, albumStore, paginator } = await mountPagedList();

    await wrapper.findComponent({ name: 'Button' }).trigger('click');
    await nextTick();

    expect(albumStore.filteredAlbums).toHaveLength(45);
    expect(paginatorFirst(paginator())).toBe(0);
  });

  it('updates selected year when a year is selected', async () => {
    const wrapper = createWrapper();
    const albumStore = useAlbumStore();

    const selectYear = wrapper.findComponent({ name: 'SelectYear' });
    await selectYear.vm.$emit('select-year', '2023');
    expect(mockPush).toHaveBeenCalledWith({
      name: 'albumsByYear',
      params: { year: '2023' },
    });

    const mockRouteResult = vi.mocked(useRoute).mock.results[0];
    expect(mockRouteResult).toBeDefined();
    const mockRoute = mockRouteResult!.value as ReturnType<typeof useRoute>;
    mockRoute.params.year = '2022';
    await nextTick();
    expect(albumStore.selectedYear).toBe('2022');
  });

  it('updates selected tags when tags are selected', async () => {
    const wrapper = createWrapper();
    const albumStore = useAlbumStore();

    const selectTags = wrapper.findComponent({ name: 'SelectTags' });
    await selectTags.vm.$emit('select-tags', ['tag1', 'tag2']);
    expect(albumStore.setSelectedTags).toHaveBeenCalledWith(['tag1', 'tag2']);
    expect(albumStore.filterState.selectedTags).toEqual(['tag1', 'tag2']);
  });

  it('pages through the album list when the paginator moves', async () => {
    const { wrapper, paginator } = await mountPagedList({ first: 0 });
    expect(firstRenderedAlbumName(wrapper)).toBe('Album 01');

    // `v-model:first` is the single source of truth, so the paginator drives the slice.
    await paginator().vm.$emit('update:first', 40);
    await nextTick();
    expect(firstRenderedAlbumName(wrapper)).toBe('Album 41');
    expect(wrapper.findAllComponents({ name: 'Album' })).toHaveLength(5);
  });

  it('returns to the first page when the selected year changes', async () => {
    const { wrapper, albumStore, paginator } = await mountPagedList();
    expect(firstRenderedAlbumName(wrapper)).toBe('Album 41');

    albumStore.setSelectedYear('2022');
    await nextTick();

    expect(paginatorFirst(paginator())).toBe(0);
    expect(firstRenderedAlbumName(wrapper)).toBe('Album 01');
  });

  it('keeps the paginator and the list in step across a refetch', async () => {
    // The reported bug: fetching unmounts the Paginator, so it remounts at page 1 while
    // the view (cached by <keep-alive>) still held a later page.
    const isFetching = ref(false);
    setupQueryMocks({ useQuery: { isFetching } });
    const { wrapper, albumStore, paginator } = await mountPagedList();
    expect(firstRenderedAlbumName(wrapper)).toBe('Album 41');

    isFetching.value = true;
    await nextTick();
    expect(paginator().exists()).toBe(false);

    albumStore.setSelectedYear('2022');
    isFetching.value = false;
    await nextTick();

    expect(paginatorFirst(paginator())).toBe(0);
    expect(firstRenderedAlbumName(wrapper)).toBe('Album 01');
  });

  it('falls back to the last page when the album list shrinks past it', async () => {
    // Deleting an album refetches the same year, so neither the year nor a filter
    // changes. Without a clamp `firstIndex` runs past the end and the list renders empty.
    const { wrapper, albumStore, paginator } = await mountPagedList({ count: 41 });
    expect(firstRenderedAlbumName(wrapper)).toBe('Album 41');

    albumStore.filteredAlbums = buildAlbums(40);
    await nextTick();

    expect(paginatorFirst(paginator())).toBe(20);
    expect(firstRenderedAlbumName(wrapper)).toBe('Album 21');
    expect(wrapper.text()).not.toContain('No results.');
  });

  it('returns to the first page when the filters change', async () => {
    // Every album carries `tag1`, so the filter below keeps all 45 and the page can only
    // move because of the reset watcher, not because the list shrank past it.
    setupQueryMocks({ useQuery: { data: ref(buildAlbums(45)) } });
    const { albumStore, paginator } = await mountPagedList();

    // Filtering never refetches, so the paginator is not remounted. Only the watcher
    // brings it back to the first page.
    albumStore.setSelectedTags(['tag1']);
    await nextTick();

    expect(albumStore.filteredAlbums).toHaveLength(45);
    expect(paginatorFirst(paginator())).toBe(0);
  });

  it('displays featured albums when available', async () => {
    const wrapper = createWrapper();
    await wrapper.vm.$nextTick();
    // The featured albums are now wrapped in a Panel component
    const panel = wrapper.findComponent({ name: 'CollapsiblePanel' });
    expect(panel.exists()).toBe(true);
    expect(panel.attributes('data-test-id')).toBe('featured-albums-panel');
  });

  it('displays a skeleton loader when fetching albums', async () => {
    setupQueryMocks({
      useQuery: {
        isFetching: ref(true),
      },
    });

    // Ensure useRoute returns a reactive object with a valid params.year
    vi.mocked(useRoute).mockReturnValue(
      reactive({ params: { year: 'na' } }) as unknown as RouteLocationNormalizedLoadedGeneric,
    );
    const wrapper = createWrapper();
    await wrapper.vm.$nextTick();
    expect(wrapper.findAllComponents({ name: 'Skeleton' }).length).toBeGreaterThan(0);
  });

  it('displays "No results" when no albums are available', async () => {
    setupQueryMocks({
      useQuery: {
        data: ref([]),
      },
    });
    const wrapper = createWrapper();
    const albumStore = useAlbumStore();

    albumStore.setSortOrder('desc'); // Trigger applyFilters
    await wrapper.vm.$nextTick();
    expect(wrapper.text()).toContain('No results.');
  });

  it('displays the correct number of albums', async () => {
    const wrapper = createWrapper();
    const albumStore = useAlbumStore();
    albumStore.filteredAlbums = [
      {
        id: '1',
        albumName: 'Album 1',
        year: '2023',
        albumCover: '',
        description: '',
        tags: [],
        isUnlisted: false,
      },
      {
        id: '2',
        albumName: 'Album 2',
        year: '2023',
        albumCover: '',
        description: '',
        tags: [],
        isUnlisted: false,
      },
      {
        id: '3',
        albumName: 'Album 3',
        year: '2023',
        albumCover: '',
        description: '',
        tags: [],
        isUnlisted: false,
      },
    ];

    albumStore.setSortOrder('desc'); // Trigger applyFilters
    await wrapper.vm.$nextTick();
    expect(wrapper.findAllComponents({ name: 'Album' }).length).toBe(3);
  });

  it('shows the unlisted album toggle for admin users', async () => {
    const wrapper = createWrapper();
    const albumStore = useAlbumStore();
    const userStore = useUserConfigStore();
    userStore.setUserPermission({ role: 'admin' } as UserPermission);
    await wrapper.vm.$nextTick();

    const toggleSwitch = wrapper.findComponent({ name: 'ToggleSwitch' });
    expect(toggleSwitch.exists()).toBe(true);
    await toggleSwitch.vm.$emit('update:modelValue', true);
    expect(albumStore.filterState.unlistedOnly).toBe(true);
  });

  it('renders CreateAlbum dialog when updateAlbum is true', async () => {
    const wrapper = createWrapper();
    const dialogStore = useDialogStore();

    dialogStore.setDialogState('updateAlbum', true);
    await wrapper.vm.$nextTick();
    expect(wrapper.findComponent({ name: 'CreateAlbum' }).exists()).toBe(true);
  });

  it('renders CreateAlbumTag dialog when createAlbumTag is true', async () => {
    const wrapper = createWrapper();
    const dialogStore = useDialogStore();

    dialogStore.setDialogState('createAlbumTag', true);
    await wrapper.vm.$nextTick();
    expect(wrapper.findComponent({ name: 'CreateAlbumTag' }).exists()).toBe(true);
  });

  it('renders ShowAlbumTags dialog when showAlbumTags is true', async () => {
    const wrapper = createWrapper();
    const dialogStore = useDialogStore();

    dialogStore.setDialogState('showAlbumTags', true);
    await wrapper.vm.$nextTick();
    expect(wrapper.findComponent({ name: 'ShowAlbumTags' }).exists()).toBe(true);
  });
});
