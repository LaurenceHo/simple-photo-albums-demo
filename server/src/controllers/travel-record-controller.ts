import { Context } from 'hono';
import { HonoEnv, ValidatedJsonContext, ValidatedQueryContext } from '../env';
import FlightService, { FlightData, FlightNotFoundError } from '../services/flight-service';
import TravelRecordService from '../services/travel-record-service';
import {
  CreateTravelRecordRequest,
  FlightLegsQuery,
  UpdateTravelRecordRequest,
} from '../types/request-schemas';
import { TravelRecord } from '../types/travel-record';
import { UserPermission } from '../types/user-permission';
import { toCoordinates } from '../utils/coordinates';
import { haversineDistance, isValidCoordination } from '../utils/helpers';
import { BaseController } from './base-controller';

export default class TravelRecordController extends BaseController {
  findAll = async (c: Context<HonoEnv>) => {
    const travelRecordService = new TravelRecordService(c.env.DB);
    try {
      const travelRecords: TravelRecord[] = await travelRecordService.getAll();
      return this.ok<TravelRecord[]>(c, 'ok', travelRecords);
    } catch (err: any) {
      console.error(`Failed to fetch travel records from D1: ${err.message}`);
      return this.fail(c, 'Failed to query travel records');
    }
  };

  /**
   * Every leg flown under a flight number on a date, so the UI can let the traveller pick
   * the one they were on - a multi-leg flight like TR867 (NRT→TPE→SIN) has one per stop.
   */
  findFlightLegs = async (c: ValidatedQueryContext<FlightLegsQuery>) => {
    const { flightNumber, date } = c.req.valid('query');
    const apiKey = c.env.RAPIDAPI_KEY;
    if (!apiKey) {
      return this.fail(c, 'RAPIDAPI_KEY is not configured');
    }

    try {
      const legs = await new FlightService(apiKey).getFlightLegs(flightNumber, date);
      return this.ok<FlightData[]>(c, 'ok', legs);
    } catch (err: unknown) {
      if (err instanceof FlightNotFoundError) {
        return this.notFoundError(c, 'No flight data found for the given flight number and date');
      }
      console.error(`Flight API error: ${err instanceof Error ? err.message : String(err)}`);
      return this.fail(c, 'Failed to fetch flight data from provider');
    }
  };

  create = async (c: ValidatedJsonContext<CreateTravelRecordRequest>) => {
    const body = c.req.valid('json');
    const user = c.get('user') as UserPermission;
    const userEmail = user?.email ?? 'unknown';
    const travelRecordService = new TravelRecordService(c.env.DB);

    const isFlightApiMode =
      body.transportType === 'flight' && body.flightNumber && !body.departure && !body.destination;

    let distance = 0;
    let flightData: Partial<TravelRecord> = {};

    if (isFlightApiMode && body.flightNumber) {
      // Flight API mode: auto-populate from AeroDataBox
      const apiKey = c.env.RAPIDAPI_KEY;
      if (!apiKey) {
        return this.fail(c, 'RAPIDAPI_KEY is not configured');
      }

      try {
        const flightService = new FlightService(apiKey);
        const date = body.travelDate.substring(0, 10);
        const result = await flightService.getFlightByNumber(body.flightNumber, date);

        flightData = {
          departure: result.departure,
          destination: result.destination,
          airline: result.airline,
          flightNumber: result.flightNumber,
          aircraftType: result.aircraftType,
          distance: result.distance,
          durationMinutes: result.durationMinutes,
        };
        distance = result.distance;
      } catch (err: any) {
        console.error(`Flight API error: ${err.message}`);
        if (err instanceof FlightNotFoundError) {
          return this.notFoundError(c, 'No flight data found for the given flight number and date');
        }
        return this.fail(c, 'Failed to fetch flight data from provider');
      }
    } else if (body.departure && body.destination) {
      // Manual mode: calculate distance from coordinates
      if (
        !isValidCoordination(body.departure.location.latitude, body.departure.location.longitude) ||
        !isValidCoordination(
          body.destination.location.latitude,
          body.destination.location.longitude,
        )
      ) {
        return this.fail(c, 'Invalid coordinates');
      }

      // The flight lookup falls back to (0, 0) for an airport the provider has no
      // coordinates for. Taken at face value that draws the route to the Gulf of Guinea and
      // inflates the distance by thousands of km, so it is refused like any unknown location.
      if (
        !toCoordinates(body.departure.location.latitude, body.departure.location.longitude) ||
        !toCoordinates(body.destination.location.latitude, body.destination.location.longitude)
      ) {
        return this.clientError(c, 'Departure and destination must have a known location');
      }

      if (body.transportType === 'flight' && body.distance && body.distance > 0) {
        // A leg from the flight lookup carries the provider's great-circle distance; keep it,
        // as the server-side flight mode does, rather than recomputing it.
        distance = Math.round(body.distance);
      } else {
        const rawDistance = haversineDistance(
          body.departure.location.latitude,
          body.departure.location.longitude,
          body.destination.location.latitude,
          body.destination.location.longitude,
        );

        distance = Math.round(rawDistance);
      }
    }

    const payload: TravelRecord = {
      ...body,
      ...flightData,
      id: crypto.randomUUID(),
      distance,
      createdBy: userEmail,
      updatedBy: userEmail,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    try {
      await travelRecordService.create(payload);
      return this.ok(c, 'Travel record created');
    } catch (err: any) {
      console.error(`Failed to create travel record in D1: ${err.message}`);
      return this.fail(c, 'Failed to create travel record');
    }
  };

  update = async (c: ValidatedJsonContext<UpdateTravelRecordRequest>) => {
    const body = c.req.valid('json');
    const user = c.get('user') as UserPermission;
    const userEmail = user?.email ?? 'unknown';
    const travelRecordService = new TravelRecordService(c.env.DB);

    const id = body.id;
    if (!id) {
      return this.clientError(c, 'Record ID is required for update');
    }
    // `id` is the WHERE key, not a SET field. createdAt/createdBy are already absent
    // from the schema, so only `id` needs removing here.
    const { id: _id, ...rest } = body;
    const payload: Partial<TravelRecord> = {
      ...rest,
      updatedBy: userEmail,
      updatedAt: new Date().toISOString(),
    };

    try {
      await travelRecordService.update(id, payload);
      return this.ok(c, 'Travel record updated');
    } catch (err: any) {
      console.error(`Failed to update travel record in D1: ${err.message}`);
      return this.fail(c, 'Failed to update travel record');
    }
  };

  delete = async (c: Context<HonoEnv>) => {
    const recordId = c.req.param('recordId');
    if (!recordId) {
      return this.clientError(c, 'Record ID is required');
    }
    console.log('##### Delete travel record: %s', recordId);
    const travelRecordService = new TravelRecordService(c.env.DB);

    try {
      await travelRecordService.delete(recordId);
      return this.ok(c, 'Travel record deleted');
    } catch (err: any) {
      console.error(`Failed to delete travel record in D1: ${err.message}`);
      return this.fail(c, 'Failed to delete travel record');
    }
  };

  findOne = async (_c: Context) => {
    throw new Error('Method not implemented.');
  };
}
