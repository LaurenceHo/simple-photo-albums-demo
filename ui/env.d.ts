/// <reference types="vite/client" />

/**
 * Build-time environment variables. Vite inlines these into the bundle, so every value
 * here is public - none of them may hold a secret. See `.env.example` for the full list
 * and `.github/workflows/web-app-build-deploy.yaml` for how CI supplies them.
 *
 * All are optional: a missing value is a deploy-configuration problem, not a type error,
 * and the code that reads each one handles `undefined` on its own terms.
 */
interface ImportMetaEnv {
  /** Application title shown in the header and the document title. */
  readonly VITE_ALBUM_APP_TITLE?: string;
  /** Base URL for publicly served static files. */
  readonly VITE_STATIC_FILES_URL?: string;
  /** ImageKit CDN base URL used to build photo transformation URLs. */
  readonly VITE_IMAGEKIT_CDN_URL?: string;
  /** Base URL of the Cloudflare Worker API (production only - DEV hardcodes localhost). */
  readonly VITE_WORKER_API_URL?: string;
  /** Mapbox public access token for the map and place search. */
  readonly VITE_MAPBOX_API_KEY?: string;
  /** Google OAuth client id used for admin sign-in. */
  readonly VITE_GOOGLE_CLIENT_ID?: string;
  /** Google Analytics measurement id. Unset disables analytics. */
  readonly VITE_GTAG_ID?: string;
  /** Default map centre latitude. */
  readonly VITE_MAP_CENTRE_LAT?: string;
  /** Default map centre longitude. */
  readonly VITE_MAP_CENTRE_LNG?: string;
  /**
   * PrimeUI licence key (PrimeVue 5+). Verified offline in the browser, so it is
   * embedded in the built bundle and is not a secret - but it must be present at
   * BUILD time or PrimeVue paints an "invalid licence" banner.
   */
  readonly VITE_PRIMEUI_LICENSE?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
