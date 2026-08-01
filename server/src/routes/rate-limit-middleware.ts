import { createMiddleware } from 'hono/factory';
import { HonoEnv } from '../env';

/**
 * Per-IP rate limiting for unauthenticated endpoints.
 *
 * Every public read endpoint costs something real per call - D1 row reads, an R2
 * `ListObjectsV2` of up to 1000 keys, a Google token verification - and none of them
 * were metered. A single client could drive unbounded spend.
 *
 * Backed by Cloudflare's rate-limiting binding, which counts in the edge colo rather
 * than in Worker memory (an in-Worker counter is useless here: isolates are per-colo,
 * short-lived, and not shared).
 *
 * Fails **open** when the binding is absent. That is deliberate: the binding does not
 * exist in `vitest` or under some `wrangler dev` configurations, and a hard failure
 * there would take the whole API down in local development. Rate limiting is a spend
 * control, not an authorisation control - nothing else relies on it.
 */
export const rateLimit = createMiddleware<HonoEnv>(async (c, next) => {
  const limiter = c.env.RATE_LIMITER;
  if (!limiter) {
    return await next();
  }

  // CF-Connecting-IP is set by Cloudflare's edge and cannot be spoofed by the client.
  // Falling back to a single shared bucket rather than trusting X-Forwarded-For, which
  // a client can set freely and would use to sidestep the limit entirely.
  const key = c.req.header('CF-Connecting-IP') ?? 'unknown';

  try {
    const { success } = await limiter.limit({ key });
    if (!success) {
      return c.json({ code: 429, status: 'Too Many Requests', message: 'Rate limit exceeded' }, 429);
    }
  } catch (error) {
    console.error('Rate limiter unavailable, allowing request:', error);
  }

  return await next();
});
