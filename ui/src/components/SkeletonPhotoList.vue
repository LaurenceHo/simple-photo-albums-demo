<template>
  <div class="flex items-center pt-4" data-test-id="skeleton-page-list">
    <Skeleton class="mr-2" shape="circle" size="3rem" />
    <Skeleton class="mr-2" height="3rem" width="5rem" />
    <Skeleton height="3rem" width="80%" />
  </div>
  <div class="mt-3 flex gap-2">
    <Skeleton height="2rem" width="4rem" />
    <Skeleton height="2rem" width="4rem" />
  </div>
  <div class="mt-4 flex flex-wrap gap-1">
    <Skeleton
      v-for="(width, n) in SKELETON_WIDTHS"
      :key="n"
      :height="isXSmallDevice ? '8.75rem' : '13.75rem'"
      :width="width"
    />
  </div>
</template>

<script lang="ts" setup>
import useDevice from '@/composables/use-device';
import Skeleton from 'primevue/skeleton';

const { isXSmallDevice } = useDevice();

/** Mixed widths so the placeholder reads as justified rows, not a square grid. */
const SKELETON_WIDTHS = ['18%', '26%', '14%', '22%', '16%', '24%', '20%', '18%'];
</script>
