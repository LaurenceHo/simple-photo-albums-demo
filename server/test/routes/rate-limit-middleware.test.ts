import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import { HonoEnv } from '../../src/env';
import { rateLimit } from '../../src/routes/rate-limit-middleware';

const createApp = () => {
  const app = new Hono<HonoEnv>();
  app.use('*', rateLimit);
  app.get('/thing', (c) => c.json({ ok: true }));
  return app;
};

describe('rateLimit', () => {
  it('should allow the request when under the limit', async () => {
    const limit = vi.fn().mockResolvedValue({ success: true });

    const res = await createApp().request('/thing', {}, { RATE_LIMITER: { limit } });

    expect(res.status).toBe(200);
    expect(limit).toHaveBeenCalledWith({ key: 'unknown' });
  });

  it('should return 429 when over the limit', async () => {
    const limit = vi.fn().mockResolvedValue({ success: false });

    const res = await createApp().request('/thing', {}, { RATE_LIMITER: { limit } });

    expect(res.status).toBe(429);
    const body = await res.json();
    expect(body.code).toBe(429);
  });

  // CF-Connecting-IP is set by Cloudflare's edge. X-Forwarded-For is client-settable and
  // must not be used, or a caller could rotate it to sidestep the limit entirely.
  it('should bucket by CF-Connecting-IP and ignore X-Forwarded-For', async () => {
    const limit = vi.fn().mockResolvedValue({ success: true });

    await createApp().request(
      '/thing',
      { headers: { 'CF-Connecting-IP': '203.0.113.7', 'X-Forwarded-For': '198.51.100.1' } },
      { RATE_LIMITER: { limit } },
    );

    expect(limit).toHaveBeenCalledWith({ key: '203.0.113.7' });
  });

  // Fails open by design: the binding is absent in tests and some local wrangler
  // configs, and rate limiting is a spend control rather than an authorisation control.
  it('should allow the request when the binding is absent', async () => {
    const res = await createApp().request('/thing', {}, {});

    expect(res.status).toBe(200);
  });

  it('should allow the request when the limiter throws', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const limit = vi.fn().mockRejectedValue(new Error('limiter unavailable'));

    const res = await createApp().request('/thing', {}, { RATE_LIMITER: { limit } });

    expect(res.status).toBe(200);
  });
});
