import { Hono } from 'hono';
import { setCookie } from 'hono/cookie';
import { randomBytes } from 'node:crypto';
import AuthController from '../controllers/auth-controller';
import { HonoEnv } from '../env';

const controller = new AuthController();
const app = new Hono<HonoEnv>();

app.get('/api/auth/csrf', async (c) => {
  const state = randomBytes(16).toString('hex');

  setCookie(c, 'csrf_state', state, {
    httpOnly: true,
    secure: true,
    // Must match the auth cookie's policy - see AUTH_COOKIE_SAME_SITE in
    // auth-middleware.ts for why this is 'Lax' rather than 'None' or 'Strict'.
    sameSite: 'Lax',
    path: '/',
    maxAge: 300,
  });
  return c.json({ state });
});

app.get('/api/auth/user-info', controller.readUserInfoFromToken);

app.post('/api/auth/verify-id-token', controller.verifyIdToken);

app.post('/api/auth/logout', controller.logout);

export default app;
