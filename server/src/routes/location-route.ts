import { zValidator } from '@hono/zod-validator';
import { Hono } from 'hono';
import LocationController from '../controllers/location-controller';
import { HonoEnv } from '../env';
import { LocationSearchSchema } from '../types/request-schemas';
import { verifyJwtClaim, verifyUserPermission } from './auth-middleware';

const controller = new LocationController();
const app = new Hono<HonoEnv>();

// Admin-only: this proxies Mapbox Search using the server's own API key, and every
// call is billed. Location search is only reachable from admin authoring dialogs in the
// UI, so leaving it open was an unauthenticated, unmetered spend vector.
app.get(
  '/api/location/search',
  verifyJwtClaim,
  verifyUserPermission,
  zValidator('query', LocationSearchSchema),
  controller.findAll,
);

export default app;
