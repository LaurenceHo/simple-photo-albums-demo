import type { Context } from 'hono';
import { UserPermission } from './types/user-permission';

/**
 * Cloudflare rate-limiting binding.
 *
 * Declared locally because it is still an `unsafe` binding and so is not emitted into
 * `worker-configuration.d.ts` by `wrangler types`.
 */
export interface RateLimiter {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

export interface Env {
  DB: D1Database;
  RATE_LIMITER?: RateLimiter;
  REGION_NAME: string;
  VITE_IMAGEKIT_CDN_URL: string;
  R2_BUCKET_NAME: string;
  R2_ACCESS_KEY?: string;
  R2_SECRET_KEY?: string;
  JWT_SECRET?: string;
  MAPBOXAPI_KEY?: string;
  SEARCH_PROXIMITY?: string;
  VITE_GOOGLE_CLIENT_ID?: string;
  ALBUM_URL?: string;
  RAPIDAPI_KEY?: string;
  ENVIRONMENT?: string;
  DEVELOPMENT?: string;
  CLOUDFLARE_ACCOUNT_ID?: string;
}

export type Bindings = {
  DB: D1Database;
  /** Optional: absent in tests and in some local wrangler configs. See rate-limit-middleware.ts. */
  RATE_LIMITER?: RateLimiter;
  REGION_NAME: string;
  VITE_IMAGEKIT_CDN_URL: string;
  R2_BUCKET_NAME: string;
  R2_ACCESS_KEY: string;
  R2_SECRET_KEY: string;
  JWT_SECRET: string;
  MAPBOXAPI_KEY: string;
  SEARCH_PROXIMITY?: string;
  VITE_GOOGLE_CLIENT_ID: string;
  ALBUM_URL: string;
  RAPIDAPI_KEY: string;
  ENVIRONMENT: string;
  DEVELOPMENT: string;
  CLOUDFLARE_ACCOUNT_ID: string;
};

export type HonoEnv = {
  Bindings: Bindings;
  Variables: {
    user?: UserPermission;
  };
};

/**
 * Context for a handler mounted behind `zValidator('json', schema)`.
 *
 * Typing the handler parameter with this makes `c.req.valid('json')` available and
 * typed as `T`. Handlers must read the request body through that, never through
 * `c.req.json()`: `zValidator` rejects malformed *declared* fields but Zod strips
 * unknown keys rather than erroring, so re-reading the raw body reintroduces every
 * key the schema meant to discard - which is how arbitrary keys used to reach the
 * SQL builder in `D1Service`.
 */
export type ValidatedJsonContext<T> = Context<HonoEnv, string, { out: { json: T } }>;

/** As `ValidatedJsonContext`, for `zValidator('query', schema)`. */
export type ValidatedQueryContext<T> = Context<HonoEnv, string, { out: { query: T } }>;
