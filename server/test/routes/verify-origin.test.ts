import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import { HonoEnv } from '../../src/env';
import { verifyOrigin } from '../../src/routes/auth-middleware';

/**
 * Builds a minimal app with only `verifyOrigin` mounted, so these assertions are about
 * the middleware itself rather than about any route's own auth.
 */
const createApp = () => {
  const app = new Hono<HonoEnv>();
  app.use('*', verifyOrigin);
  app.get('/thing', (c) => c.json({ ok: true }));
  app.post('/thing', (c) => c.json({ ok: true }));
  app.put('/thing', (c) => c.json({ ok: true }));
  app.delete('/thing', (c) => c.json({ ok: true }));
  return app;
};

const env = { ALBUM_URL: 'https://photos.example.com' };

describe('verifyOrigin', () => {
  it('should allow a state-changing request from the app origin', async () => {
    const res = await createApp().request(
      '/thing',
      { method: 'POST', headers: { Origin: 'https://photos.example.com' } },
      env,
    );

    expect(res.status).toBe(200);
  });

  // The core CSRF assertion. Previously the only thing stopping this was that a JSON
  // content type forces a CORS preflight - a browser behaviour, with no server-side
  // check behind it.
  it.each(['POST', 'PUT', 'DELETE'])(
    'should reject a %s request from a foreign origin',
    async (method) => {
      vi.spyOn(console, 'error').mockImplementation(() => {});

      const res = await createApp().request(
        '/thing',
        { method, headers: { Origin: 'https://evil.example' } },
        env,
      );

      expect(res.status).toBe(403);
      const body = await res.json();
      expect(body.message).toBe('Cross-origin request rejected');
    },
  );

  // Safe methods carry no side effect, and blocking them would break the public
  // read-only endpoints that are meant to be reachable from anywhere.
  it('should allow a GET from a foreign origin', async () => {
    const res = await createApp().request(
      '/thing',
      { headers: { Origin: 'https://evil.example' } },
      env,
    );

    expect(res.status).toBe(200);
  });

  // Non-browser clients (curl, uptime checks) send no Origin and carry no ambient
  // cookie, so they are not the CSRF threat model.
  it('should allow a state-changing request with no Origin header', async () => {
    const res = await createApp().request('/thing', { method: 'POST' }, env);

    expect(res.status).toBe(200);
  });

  it('should allow the local dev origin when DEVELOPMENT is true', async () => {
    const res = await createApp().request(
      '/thing',
      { method: 'POST', headers: { Origin: 'http://localhost:9000' } },
      { DEVELOPMENT: 'true', ALBUM_URL: 'https://photos.example.com' },
    );

    expect(res.status).toBe(200);
  });

  it('should reject the production origin when DEVELOPMENT is true', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const res = await createApp().request(
      '/thing',
      { method: 'POST', headers: { Origin: 'https://photos.example.com' } },
      { DEVELOPMENT: 'true', ALBUM_URL: 'https://photos.example.com' },
    );

    expect(res.status).toBe(403);
  });
});
