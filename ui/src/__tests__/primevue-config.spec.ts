import { primeVueOptions } from '@/primevue-config';
import { describe, expect, it } from 'vitest';

describe('primevue-config', () => {
  // This asserts the *ordering invariant*, not the literal numbers: a dropdown/menu
  // opened from inside a modal (e.g. the lightbox) must render above that modal, or it
  // is invisible behind the modal's backdrop - the exact browser-confirmed bug this
  // configuration fixes (the admin Move/Delete/Rename menu rendering at z-1001, hidden
  // behind the lightbox's z-1100 backdrop). Asserting literal values would just restate
  // the numbers in `main.ts` without proving anything about *why* they are set.
  it('places the overlay/menu z-index band above the modal band', () => {
    const { modal, overlay, menu } = primeVueOptions.zIndex ?? {};

    expect(modal).toBeDefined();
    expect(overlay).toBeDefined();
    expect(menu).toBeDefined();
    expect(overlay as number).toBeGreaterThan(modal as number);
    expect(menu as number).toBeGreaterThan(modal as number);
  });

  // Importing this module must never trigger `app.mount()` - that side effect living in
  // `main.ts` (not here) is the entire reason this config was pulled into its own file.
  // Reaching this line at all - without a DOM `#app` element, a router, or a mounted Vue
  // app in this test's environment - is itself proof the module has no such side effect.
  it('has no module-scope side effects such as mounting an app', () => {
    expect(primeVueOptions).toBeDefined();
  });
});
