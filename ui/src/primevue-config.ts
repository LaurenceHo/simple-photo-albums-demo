import { definePreset } from '@primevue/themes';
import Aura from '@primevue/themes/aura';
import type { PrimeVueConfiguration } from 'primevue/config';

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
export const primeVueOptions: PrimeVueConfiguration = {
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
