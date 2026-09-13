import { zValidator } from '@hono/zod-validator';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import GpsTrackController from '../controllers/gps-track-controller';
import { HonoEnv } from '../env';
import { CreateGpsTrackSchema, MAX_GPX_LENGTH } from '../types/gps-track';
import { verifyJwtClaim, verifyUserPermission } from './auth-middleware';

const controller = new GpsTrackController();
const app = new Hono<HonoEnv>();

// Reads are public, but the handlers run `checkAlbumAccess`, so an unlisted album's
// tracks are gated exactly as its photos are.
app.get('/api/albums/:albumId/gps-tracks', controller.findAll);
app.get('/api/albums/:albumId/gps-tracks/:trackId', controller.findOne);

// A JSON body rather than raw XML, so `zValidator` applies here as on every other route.
//
// `bodyLimit` sits ahead of it because Zod's `MAX_GPX_LENGTH` check only runs once Hono
// has buffered and JSON-parsed the whole body - a 100 MB upload was fully materialised in
// the Worker before anything rejected it. Twice `MAX_GPX_LENGTH`, since JSON escaping
// inflates the GPX on the way in; the schema remains the authority on the GPX itself, and
// its comment explains why that number is what it is.
app.post(
  '/api/albums/:albumId/gps-tracks',
  verifyJwtClaim,
  verifyUserPermission,
  bodyLimit({
    maxSize: 2 * MAX_GPX_LENGTH,
    onError: (c) => c.json({ code: 413, status: 'Error', message: 'The GPX file is too large' }, 413),
  }),
  zValidator('json', CreateGpsTrackSchema),
  controller.create,
);

app.delete(
  '/api/albums/:albumId/gps-tracks/:trackId',
  verifyJwtClaim,
  verifyUserPermission,
  controller.delete,
);

export default app;
