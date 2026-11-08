import { VueQueryPlugin } from '@tanstack/vue-query';
import 'mapbox-gl/dist/mapbox-gl.css';
import { createPinia } from 'pinia';
import PrimeVue from 'primevue/config';
import ConfirmationService from 'primevue/confirmationservice';
import ToastService from 'primevue/toastservice';
import Tooltip from 'primevue/tooltip';
import { createApp } from 'vue';
import App from './App.vue';
import './assets/justified-grid.css';
import './assets/primevue-override.css';
import { primeVueOptions } from './primevue-config';
import router from './router';

declare global {
  var dataLayer: IArguments[];
  var gtag: ((...args: unknown[]) => void) | undefined;
}

const prepareApp = async () => {
  // Both are dynamic imports so MSW never ships in the production bundle.
  const [{ worker }, { HttpNetworkFrame }] = await Promise.all([
    import('./mocks/browser'),
    import('msw/experimental'),
  ]);
  return worker.start({
    // MSW 3 reports unhandled "frames" (HTTP requests and WebSocket connections)
    // rather than plain requests; only HTTP frames carry a `Request` to inspect.
    onUnhandledFrame: ({ frame, defaults }) => {
      const ignoredUrls = [
        'chrome-extension://',
        'https://fonts.gstatic.com',
        'https://api.mapbox.com',
        'https://events.mapbox.com',
      ];

      // Check if the request URL starts with any of the ignored URLs
      if (
        frame instanceof HttpNetworkFrame &&
        ignoredUrls.some((url) => frame.data.request.url.startsWith(url))
      ) {
        return;
      }

      defaults.warn();
    },
  });
};

const pinia = createPinia();
const app = createApp(App);

app.use(PrimeVue, primeVueOptions);
app.use(router);
app.use(VueQueryPlugin);
app.use(pinia);
app.use(ToastService);
app.use(ConfirmationService);
app.directive('tooltip', Tooltip);

if (import.meta.env.MODE === 'MSW') {
  prepareApp().then(() => {
    app.mount('#app');
  });
} else {
  app.mount('#app');
}

const gtagId = import.meta.env.VITE_GTAG_ID;
if (gtagId) {
  globalThis.dataLayer = globalThis.dataLayer || [];

  // Must use traditional function (not arrow) so `arguments` is available — gtag.js expects raw arguments pushed to dataLayer
  globalThis.gtag = function () {
    // eslint-disable-next-line prefer-rest-params
    globalThis.dataLayer.push(arguments);
  };

  globalThis.gtag('js', new Date());
  globalThis.gtag('config', gtagId);

  const script = document.createElement('script');
  script.async = true;
  script.src = `https://www.googletagmanager.com/gtag/js?id=${gtagId}`;
  document.head.appendChild(script);
} else {
  console.warn('VITE_GTAG_ID is not defined');
}

router.afterEach((to) => {
  if (globalThis.gtag) {
    globalThis.gtag('event', 'page_view', {
      page_title: document.title,
      page_location: globalThis.location.href,
      page_path: to.fullPath,
    });
  }
});
