import { createRequire } from 'node:module';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { mergeConfig, defineConfig, configDefaults } from 'vitest/config';
import viteConfig from './vite.config';

/**
 * Absolute realpath of pinia's single entry point, so every importer resolves the
 * identical specifier. See the `resolve.alias` comment below for why this is needed.
 */
const piniaEntry = realpathSync(createRequire(import.meta.url).resolve('pinia')).replaceAll(
  '\\',
  '/',
);

export default mergeConfig(
  viteConfig,
  defineConfig({
    /*
     * Force a single `pinia` module instance under Vitest.
     *
     * Bun installs packages as symlinks into a content-addressed `.bun` store, so the app
     * resolves `ui/node_modules/pinia` while `@pinia/testing` resolves
     * `.bun/@pinia+testing@…/node_modules/pinia`. Both point at the same directory, but
     * they are different specifier paths, so Vite loads each as its own module — each with
     * its own `piniaSymbol` and its own `activePinia`. `createTestingPinia()` then called
     * `setActivePinia()` on one instance while a component's `useStore()` looked up the
     * other, so `inject(piniaSymbol)` missed and `getActivePinia()` was undefined. Every
     * component reading a store during setup threw "getActivePinia() was called but there
     * was no active Pinia" — 69 tests across 5 spec files.
     */
    resolve: {
      // Pin every `pinia` import to one absolute realpath. Without this the app resolved
      // `ui/node_modules/pinia` while @pinia/testing resolved
      // `.bun/@pinia+testing@…/node_modules/pinia` — the same directory via a different
      // symlink path, which Vite loads as a separate module with its own `piniaSymbol` and
      // its own `activePinia`.
      alias: { pinia: piniaEntry },
      dedupe: ['pinia', '@pinia/testing', 'vue'],
    },
    test: {
      setupFiles: './vitest.setup.ts',
      // Pull @pinia/testing into Vite's module graph. Left externalised, Node's ESM loader
      // gives it its own copy of pinia that no alias can reach, so `setActivePinia()` there
      // is invisible to the app's `getActivePinia()`.
      server: { deps: { inline: ['@pinia/testing'] } },
      coverage: {
        provider: 'v8',
        reportsDirectory: 'coverage',
        exclude: [
          '**/node_modules/**',
          '**/**.js',
          '**/**.d.ts',
          '*.config.*',
          '**/**/__tests__/**',
          'src/mocks/**',
          'src/schema/**',
          'src/**/index.ts',
        ],
      },
      environment: 'jsdom',
      exclude: [...configDefaults.exclude, 'e2e/**'],
      root: fileURLToPath(new URL('./', import.meta.url)),
    },
  }),
);
