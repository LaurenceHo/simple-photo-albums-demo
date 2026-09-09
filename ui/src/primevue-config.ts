import { definePreset } from '@primeuix/themes';
import Aura from '@primeuix/themes/aura';
import type { PrimeVueConfiguration } from 'primevue/config';

/**
 * PrimeVue 5 reads a PrimeUI licence key from `options.license` at runtime
 * (`@primevue/core/config` calls `registerLicense()` with it), but as of 5.0.1 the
 * shipped `PrimeVueConfiguration` type does not declare the property. Widening it
 * here keeps the options object fully typed instead of falling back to a cast.
 *
 * Drop this alias once upstream adds `license` to `PrimeVueConfiguration`.
 */
type PrimeVueConfigurationWithLicense = PrimeVueConfiguration & {
  /** PrimeUI licence key. Verified offline in the browser, so it ships in the bundle. */
  license?: string;
};

const myThemePreset = definePreset(Aura, {
  semantic: {
    primary: {
      50: '{sky.50}',
      100: '{sky.100}',
      200: '{sky.200}',
      300: '{sky.300}',
      400: '{sky.400}',
      500: '{sky.500}',
      600: '{sky.600}',
      700: '{sky.700}',
      800: '{sky.800}',
      900: '{sky.900}',
      950: '{sky.950}',
    },
  },
});

/**
 * The `app.use(PrimeVue, ...)` options object, pulled out of `main.ts` so it can be
 * imported and asserted on in a plain unit test. `main.ts` calls `app.mount()` at
 * module scope, so importing it directly (or re-exporting this object from it) drags
 * that side effect along - which is exactly what made an earlier attempt at this test
 * flaky and required deleting it. This module has no such side effect.
 *
 * The lightbox overlay sits at z-1100 (PrimeVue's modal band). PrimeVue's default
 * overlay/menu band is 1000, so a menu opened from inside the lightbox generated
 * ~1001 and rendered behind the backdrop - invisible. Raising the overlay/menu band
 * above the modal band is the correct ordering anyway: a dropdown opened from within
 * a modal must stack above that modal.
 */
export const primeVueOptions: PrimeVueConfigurationWithLicense = {
  // PrimeVue 5+ requires a PrimeUI licence (a free community tier exists). It is
  // verified offline in the browser, so it is not a secret - but it must be present
  // at BUILD time or PrimeVue logs a warning and paints an "invalid licence" banner.
  license: import.meta.env.VITE_PRIMEUI_LICENSE,
  theme: {
    preset: myThemePreset,
    options: {
      darkModeSelector: '.dark',
      cssLayer: {
        name: 'primevue',
        order: 'theme, base, primevue',
      },
    },
  },
  zIndex: {
    modal: 1100,
    overlay: 1200,
    menu: 1200,
    tooltip: 1300,
  },
};
