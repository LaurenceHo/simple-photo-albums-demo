import { primeVueOptions } from '@/primevue-config';
import { mount } from '@vue/test-utils';
import AutoComplete from 'primevue/autocomplete';
import Button from 'primevue/button';
import Card from 'primevue/card';
import Checkbox from 'primevue/checkbox';
import PrimeVue from 'primevue/config';
import Divider from 'primevue/divider';
import InputText from 'primevue/inputtext';
import Message from 'primevue/message';
import MultiSelect from 'primevue/multiselect';
import ProgressBar from 'primevue/progressbar';
import Select from 'primevue/select';
import Skeleton from 'primevue/skeleton';
import Tag from 'primevue/tag';
import { describe, expect, it } from 'vitest';
import type { Component } from 'vue';

/**
 * Upgrade guard for PrimeVue major versions.
 *
 * `type-check`, `lint` and `build` all pass without rendering a single component, so
 * none of them would catch a PrimeVue release that renames a component's root class,
 * changes its DOM, or fails to apply the styled theme. This mounts one instance of
 * every PrimeVue component the app actually uses, through the real `primeVueOptions`,
 * and asserts each still produces its documented root class.
 *
 * If a future upgrade breaks one of these, the failure names the component instead of
 * showing up as a blank area in the running app.
 */
const COMPONENTS: ReadonlyArray<readonly [name: string, component: Component, rootClass: string]> =
  [
    ['AutoComplete', AutoComplete, '.p-autocomplete'],
    ['Button', Button, '.p-button'],
    ['Card', Card, '.p-card'],
    ['Checkbox', Checkbox, '.p-checkbox'],
    ['Divider', Divider, '.p-divider'],
    ['InputText', InputText, '.p-inputtext'],
    ['Message', Message, '.p-message'],
    ['MultiSelect', MultiSelect, '.p-multiselect'],
    ['ProgressBar', ProgressBar, '.p-progressbar'],
    ['Select', Select, '.p-select'],
    ['Skeleton', Skeleton, '.p-skeleton'],
    ['Tag', Tag, '.p-tag'],
  ];

describe('PrimeVue v5 rendering', () => {
  it.each(COMPONENTS)('renders %s with its root class', (_name, component, rootClass) => {
    const wrapper = mount(component, { global: { plugins: [[PrimeVue, primeVueOptions]] } });

    expect(wrapper.find(rootClass).exists()).toBe(true);
    wrapper.unmount();
  });

  // The styled theme turns the `definePreset` tokens in `primevue-config.ts` into CSS
  // custom properties. If `primevue` and `@primeuix/themes` ever resolve to mismatched
  // majors of the @primeuix/styled engine, the preset silently stops being applied.
  // Asserting the app's own sky primary palette - rather than merely that some `--p-`
  // variable exists - is what makes this fail in that case.
  //
  // Note the assertion is over every style PrimeVue injected during this file, not just
  // this mount: PrimeVue injects each theme once per document, so it cannot be scoped to
  // a single mount. It still holds that a broken theme emits this mapping nowhere.
  it('applies the custom sky primary palette as CSS custom properties', () => {
    const wrapper = mount(Button, { global: { plugins: [[PrimeVue, primeVueOptions]] } });
    const styles = [...document.querySelectorAll('style')].map((s) => s.textContent ?? '').join('');

    expect(styles).toMatch(/--p-primary-500:\s*var\(--p-sky-500\)/);
    expect(styles).toMatch(/--p-sky-500:\s*#0ea5e9/i);
    wrapper.unmount();
  });
});
