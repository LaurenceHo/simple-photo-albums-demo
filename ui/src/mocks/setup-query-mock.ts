import { mockFeaturedAlbums } from '@/mocks/aggregate-handler';
import { mockAlbums } from '@/mocks/album-handler';
import { mockTrackFeature, mockTrackManifest } from '@/mocks/gps-track-handler';
import { mockPhotoResponse } from '@/mocks/photos-handler';
import { mockTravelRecords } from '@/mocks/travel-records-handler';
import {
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
} from '@tanstack/vue-query';
import { vi } from 'vitest';
import { ref, unref } from 'vue';

interface QueryOptions {
  queryKey: (string | string[] | undefined)[];
  queryFn: () => Promise<unknown>;
  enabled?: boolean | undefined;
  refetchOnWindowFocus?: boolean;
  refetchOnReconnect?: boolean;
}

/**
 * Fixture for a query key, or null when nothing matches.
 *
 * Shared by the `useQuery` and `useQueries` mocks so a key resolves to the same data
 * whichever hook asked for it.
 */
const dataForKey = (queryKey: unknown): unknown => {
  const key = Array.isArray(queryKey) ? queryKey[0] : queryKey;
  switch (key) {
    case 'fetchAlbumsByYears':
      return mockAlbums;
    case 'featured-albums':
      return mockFeaturedAlbums;
    case 'getTravelRecords':
      return mockTravelRecords;
    case 'gpsTracks':
      return mockTrackManifest;
    case 'photos':
      return mockPhotoResponse;
    case 'gpsTrack':
      return mockTrackFeature;
    default:
      return null;
  }
};

interface MutationOptions {
  mutationFn?: (...args: unknown[]) => Promise<unknown>;
  onSuccess?: (result: unknown) => Promise<void>;
  onError?: (err: unknown) => Promise<void>;
}

type QueryReturnOverrides = Partial<Record<string, unknown>>;

export const createBaseMockQueryReturn = <T>(data: T, overrides?: QueryReturnOverrides) => {
  const defaultQueryState = {
    data: ref(data),
    isError: ref(false),
    isFetching: ref(false),
    error: ref(null),
    refetch: vi.fn(),
  };

  return {
    ...defaultQueryState,
    ...overrides,
    data: overrides?.data ?? defaultQueryState.data,
    isError: overrides?.isError ?? defaultQueryState.isError,
    isFetching: overrides?.isFetching ?? defaultQueryState.isFetching,
    error: overrides?.error ?? defaultQueryState.error,
    refetch: overrides?.refetch ?? defaultQueryState.refetch,
  } as ReturnType<typeof useQuery>;
};

export const setupQueryMocks = (
  overrides: {
    useQuery?: QueryReturnOverrides;
    useQueryClient?: Partial<QueryClient>;
  } = {},
) => {
  vi.mocked(useQuery).mockImplementation(((options: QueryOptions) => {
    const data = dataForKey(unref(options.queryKey));
    // An unrecognised key resolves to null rather than failing, so a new query added
    // without a case here yields `data: null` and its tests pass while testing nothing.
    // Adding the case is not optional - see CLAUDE.md.
    return data === null
      ? createBaseMockQueryReturn(null)
      : createBaseMockQueryReturn(data, overrides.useQuery);
  }) as unknown as typeof useQuery);

  vi.mocked(useMutation).mockImplementation(((options: MutationOptions) => {
    const isPending = ref(false);
    const isError = ref(false);
    const isSuccess = ref(false);
    const error = ref(null);

    const executeMutation = async (...args: unknown[]) => {
      isPending.value = true;
      isError.value = false;
      isSuccess.value = false;
      error.value = null;
      try {
        const result = options.mutationFn ? await options.mutationFn(...args) : undefined;
        isSuccess.value = true;
        if (options.onSuccess) await options.onSuccess(result);
        return result;
      } catch (err: unknown) {
        isError.value = true;
        error.value = err as null;
        if (options.onError) await options.onError(err);
        throw err;
      } finally {
        isPending.value = false;
      }
    };

    const mutate = (...args: unknown[]) => {
      void executeMutation(...args).catch(() => undefined);
    };

    return {
      mutate,
      mutateAsync: executeMutation,
      isPending,
      isError,
      isSuccess,
      error,
    } as ReturnType<typeof useMutation>;
  }) as unknown as typeof useMutation);

  vi.mocked(useQueryClient).mockReturnValue(
    (overrides.useQueryClient || {
      invalidateQueries: vi.fn(),
      removeQueries: vi.fn(),
    }) as QueryClient,
  );
};

