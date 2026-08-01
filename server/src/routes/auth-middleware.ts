import { Context } from 'hono';
import { getCookie, setCookie } from 'hono/cookie';
import { createMiddleware } from 'hono/factory';
import { HonoEnv } from '../env';
import { UserPermission } from '../types/user-permission';
import { verifyJwt } from '../utils/jwt';

/**
 * `SameSite` policy for the auth cookie.
 *
 * `Lax` requires the UI and the API to share a registrable domain - for example
 * `photos.example.com` (UI) and `api.example.com` (API), which are cross-*origin* but
 * same-*site*, so the browser still sends the cookie. This has been confirmed to hold
 * for the production deployment: `ALBUM_URL` and `VITE_WORKER_API_URL` are two
 * subdomains of one registrable domain. Local development also qualifies, since
 * `localhost:9000` and `localhost:8787` differ only by port.
 *
 * If the API is ever moved to a different registrable domain - a bare `*.workers.dev`
 * URL, say, which is a separate site from `*.pages.dev` - the browser will silently drop
 * this cookie and every login will appear to succeed but leave the user logged out. In
 * that topology this must go back to `'None'`. Note the PR demo environment *is* that
 * topology (`*.pages.dev` UI against a `*.workers.dev` API); it does not surface as a
 * regression only because demo login is deliberately non-functional - the demo web build
 * is given no `VITE_GOOGLE_CLIENT_ID`.
 *
 * `'None'` is precisely what makes a cookie eligible for cross-site requests, which is
 * why `verifyOrigin` below exists regardless of the value chosen here: the CSRF control
 * is the server-side Origin check, not this attribute.
 *
 * Not `Strict`: that would drop the cookie on top-level navigations coming from Google's
 * OAuth redirect, breaking the login round-trip.
 */
const AUTH_COOKIE_SAME_SITE = 'Lax' as const;

/** Shared attributes, so the set and clear paths cannot drift apart. */
const AUTH_COOKIE_OPTIONS = {
  httpOnly: true,
  secure: true,
  sameSite: AUTH_COOKIE_SAME_SITE,
  path: '/',
} as const;

export const setJwtCookies = async (c: Context, token: string) => {
  const expiresIn = 1000 * 60 * 60 * 24 * 7; // 7 days
  setCookie(c, 'jwt', token, {
    ...AUTH_COOKIE_OPTIONS,
    expires: new Date(Date.now() + expiresIn),
  });
  c.header('Cache-Control', 'private');
};

/** Expire the auth cookie. Attributes must match `setJwtCookies` or the browser keeps it. */
export const clearJwtCookie = (c: Context) => {
  setCookie(c, 'jwt', '', { ...AUTH_COOKIE_OPTIONS, maxAge: 0 });
};

/**
 * Clean cookie and return 401
 * @param c Context
 * @param message Message to return
 * @param code HTTP status code
 */
export const cleanJwtCookie = (c: Context, message: string, code = 401) => {
  clearJwtCookie(c);
  return c.json({ message }, code as any);
};

/**
 * Reject state-changing requests that do not come from the app's own origin.
 *
 * CSRF defence that does not depend on the cookie's `SameSite` value or on the
 * browser's CORS preflight. Previously the only thing preventing a cross-site POST was
 * that `Content-Type: application/json` forces a preflight which the CORS middleware
 * then fails - true, but it made a cookie attribute and a CORS config load-bearing for
 * an authorisation decision, with no server-side check behind them.
 *
 * `Origin` is set by the browser on every request with a side effect and cannot be
 * spoofed by page JavaScript. A request with no `Origin` at all is allowed through:
 * that covers non-browser clients (curl, monitoring) which carry no ambient cookie and
 * so are not the CSRF threat model.
 */
export const verifyOrigin = createMiddleware<HonoEnv>(async (c, next) => {
  const safeMethods = new Set(['GET', 'HEAD', 'OPTIONS']);
  if (safeMethods.has(c.req.method)) {
    return await next();
  }

  const origin = c.req.header('Origin');
  if (!origin) {
    return await next();
  }

  const allowed =
    c.env.DEVELOPMENT === 'true' ? 'http://localhost:9000' : (c.env.ALBUM_URL ?? '');

  if (origin !== allowed) {
    console.error(`Rejected cross-origin state-changing request from ${origin}`);
    return c.json({ message: 'Cross-origin request rejected' }, 403);
  }

  return await next();
});

/**
 * Verify JWT claim
 */
export const verifyJwtClaim = createMiddleware<HonoEnv>(async (c, next) => {
  const token = getCookie(c, 'jwt');
  if (token) {
    try {
      const user = await verifyJwt<UserPermission>(token, c.env.JWT_SECRET);
      c.set('user', user);
      return await next();
    } catch (error) {
      console.error('JWT verification failed:', error);
      return cleanJwtCookie(c, 'Authentication failed. Please login.');
    }
  } else {
    return cleanJwtCookie(c, 'Authentication failed. Please login.');
  }
});

export const optionalVerifyJwtClaim = createMiddleware<HonoEnv>(async (c, next) => {
  const token = getCookie(c, 'jwt');
  if (token) {
    try {
      const user = await verifyJwt<UserPermission>(token, c.env.JWT_SECRET);
      c.set('user', user);
    } catch (error) {
      console.error('Optional JWT verification failed:', error);
      // Ignore invalid token
    }
  }
  return await next();
});

export const verifyUserPermission = createMiddleware<HonoEnv>(async (c, next) => {
  const user = c.get('user') as UserPermission;
  if (user?.role !== 'admin') {
    return c.json({ message: 'Unauthorized action' }, 403);
  }
  return await next();
});
