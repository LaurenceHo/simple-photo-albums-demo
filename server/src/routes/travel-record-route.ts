import { zValidator } from '@hono/zod-validator';
import { Hono } from 'hono';
import TravelRecordController from '../controllers/travel-record-controller';
import { HonoEnv } from '../env';
import {
  CreateTravelRecordSchema,
  FlightLegsQuerySchema,
  UpdateTravelRecordSchema,
} from '../types/request-schemas';
import { verifyJwtClaim, verifyUserPermission } from './auth-middleware';

const controller = new TravelRecordController();
const app = new Hono<HonoEnv>();

app.get('/api/travel-records', controller.findAll);

// Admin-only: every call spends the server's AeroDataBox (RapidAPI) quota, and it is only
// reachable from the admin "new travel record" dialog.
app.get(
  '/api/travel-records/flight-legs',
  verifyJwtClaim,
  verifyUserPermission,
  zValidator('query', FlightLegsQuerySchema),
  controller.findFlightLegs,
);

app.post(
  '/api/travel-records',
  verifyJwtClaim,
  verifyUserPermission,
  zValidator('json', CreateTravelRecordSchema),
  controller.create,
);

app.put(
  '/api/travel-records',
  verifyJwtClaim,
  verifyUserPermission,
  zValidator('json', UpdateTravelRecordSchema),
  controller.update,
);

app.delete(
  '/api/travel-records/:recordId',
  verifyJwtClaim,
  verifyUserPermission,
  controller.delete,
);

export default app;
