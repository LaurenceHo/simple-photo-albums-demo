import { zValidator } from '@hono/zod-validator';
import { Hono } from 'hono';
import PhotoController from '../controllers/photo-controller';
import { HonoEnv } from '../env';
import {
  MovePhotosRequestSchema,
  PhotosRequestSchema,
  RenamePhotoRequestSchema,
  UploadPhotoQuerySchema,
} from '../types/api-response';
import { verifyJwtClaim, verifyUserPermission } from './auth-middleware';

const controller = new PhotoController();
const app = new Hono<HonoEnv>();

// POST, not GET: this mints a presigned upload credential, so it must not present as a
// safe, side-effect-free method. `verifyOrigin` only guards non-safe methods, so as a GET
// it was exempt from the CSRF check and any cross-site page could trigger it using a
// logged-in admin's cookie. (Note a bodyless POST is still preflight-exempt under CORS —
// the server-side Origin check, not the preflight, is what closes this.)
app.post(
  '/api/photos/upload/:albumId',
  verifyJwtClaim,
  verifyUserPermission,
  zValidator('query', UploadPhotoQuerySchema),
  controller.create,
);

app.get('/api/photos/:year/:albumId', controller.findAll);

// Move requires a destination; delete below does not. Hence the two schemas.
app.put(
  '/api/photos',
  verifyJwtClaim,
  verifyUserPermission,
  zValidator('json', MovePhotosRequestSchema),
  controller.update,
);

app.put(
  '/api/photos/rename',
  verifyJwtClaim,
  verifyUserPermission,
  zValidator('json', RenamePhotoRequestSchema),
  controller.rename,
);

app.delete(
  '/api/photos',
  verifyJwtClaim,
  verifyUserPermission,
  zValidator('json', PhotosRequestSchema),
  controller.delete,
);

export default app;
