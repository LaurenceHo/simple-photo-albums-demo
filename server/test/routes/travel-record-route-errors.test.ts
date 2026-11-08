import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import app from '../../src/index';

let mockServiceBehavior: 'success' | 'error' = 'success';
/** The record most recently passed to the mocked `create`, for asserting what was saved. */
let lastCreatedPayload: Record<string, unknown> | undefined;

vi.mock('../../src/services/travel-record-service', () => ({
  default: class {
    async getAll() {
      if (mockServiceBehavior === 'error') throw new Error('DB error');
      return [];
    }
    async create(payload: Record<string, unknown>) {
      lastCreatedPayload = payload;
      if (mockServiceBehavior === 'error') throw new Error('Insert failed');
    }
    async update() {
      if (mockServiceBehavior === 'error') throw new Error('Update failed');
    }
    async delete() {
      if (mockServiceBehavior === 'error') throw new Error('Delete failed');
    }
  },
}));

let mockFlightLegsBehavior: 'two-legs' | 'not-found' | 'api-error' = 'two-legs';

vi.mock('../../src/services/flight-service', async () => {
  const { FlightNotFoundError, FlightApiError } = await import('../../src/services/flight-service');
  const airport = (name: string, country: string, lat: number, lon: number) => ({
    displayName: `${name} Airport`,
    formattedAddress: country,
    location: { latitude: lat, longitude: lon },
    country,
  });
  return {
    FlightNotFoundError,
    FlightApiError,
    default: class {
      async getFlightLegs() {
        if (mockFlightLegsBehavior === 'not-found') throw new FlightNotFoundError();
        if (mockFlightLegsBehavior === 'api-error') {
          throw new FlightApiError('AeroDataBox API returned 429');
        }
        return [
          {
            departure: airport('Narita', 'JP', 35.76, 140.39),
            destination: airport('Taoyuan', 'TW', 25.08, 121.23),
            airline: 'Scoot',
            flightNumber: 'TR 867',
            distance: 2186,
            durationMinutes: 240,
          },
          {
            departure: airport('Taoyuan', 'TW', 25.08, 121.23),
            destination: airport('Changi', 'SG', 1.36, 103.99),
            airline: 'Scoot',
            flightNumber: 'TR 867',
            distance: 3226,
            durationMinutes: 280,
          },
        ];
      }

      async getFlightByNumber() {
        return {
          departure: {
            displayName: 'A Airport',
            formattedAddress: 'A',
            location: { latitude: 0, longitude: 0 },
          },
          destination: {
            displayName: 'B Airport',
            formattedAddress: 'B',
            location: { latitude: 1, longitude: 1 },
          },
          airline: 'Test Air',
          flightNumber: 'TA1',
          distance: 100,
          durationMinutes: 60,
        };
      }
    },
  };
});

let mockIsValidCoord = true;

/** Toggles whether the mocked `verifyJwtClaim` admits the request. */
let mockIsAuthenticated = true;
/** The role the mocked `verifyJwtClaim` gives the caller. */
let mockUserRole: 'admin' | 'viewer' = 'admin';

vi.mock('../../src/utils/helpers', () => ({
  buildR2Config: () => ({}),
  emptyR2Folder: () => Promise.resolve(true),
  uploadObject: () => Promise.resolve(true),
  verifyIfIsAdmin: () => true,
  haversineDistance: () => 500,
  isValidCoordination: () => mockIsValidCoord,
}));

vi.mock('../../src/routes/auth-middleware', async (importOriginal) => {
  const { createMiddleware } = await import('hono/factory');
  const actual = await importOriginal<typeof import('../../src/routes/auth-middleware')>();
  return {
    verifyJwtClaim: createMiddleware(async (c, next) => {
      if (!mockIsAuthenticated) {
        return c.json({ message: 'Authentication failed. Please login.' }, 401);
      }
      c.set('user', { role: mockUserRole, email: 'admin@test.com' });
      await next();
    }),
    // Global middleware in src/index.ts; a pass-through keeps route tests focused.
    verifyOrigin: createMiddleware(async (c, next) => await next()),
    clearJwtCookie: () => {},
    // The real admin check, so the 403 test exercises what actually guards the paid lookup.
    verifyUserPermission: actual.verifyUserPermission,
    optionalVerifyJwtClaim: createMiddleware(async (c, next) => await next()),
  };
});

const env = {
  DB: {},
  JWT_SECRET: 'test-secret',
  RAPIDAPI_KEY: 'test-key',
};

function postRecord(body: Record<string, unknown>) {
  return app.request(
    '/api/travel-records',
    {
      method: 'POST',
      body: JSON.stringify(body),
      headers: { 'Content-Type': 'application/json' },
    },
    env,
  );
}

function putRecord(body: Record<string, unknown>) {
  return app.request(
    '/api/travel-records',
    {
      method: 'PUT',
      body: JSON.stringify(body),
      headers: { 'Content-Type': 'application/json' },
    },
    env,
  );
}

describe('Travel record route - error paths', () => {
  beforeEach(() => {
    mockServiceBehavior = 'success';
    mockIsValidCoord = true;
    mockIsAuthenticated = true;
    mockUserRole = 'admin';
    mockFlightLegsBehavior = 'two-legs';
    lastCreatedPayload = undefined;
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /* ------------------------------------------------------------------ */
  /* findAll errors                                                      */
  /* ------------------------------------------------------------------ */
  describe('GET /api/travel-records', () => {
    it('should return 500 when service throws', async () => {
      mockServiceBehavior = 'error';
      const res = await app.request('/api/travel-records', {}, env);

      expect(res.status).toBe(500);
      const body = await res.json();
      expect(body.message).toBe('Failed to query travel records');
    });
  });

  /* ------------------------------------------------------------------ */
  /* flight legs lookup                                                  */
  /* ------------------------------------------------------------------ */
  describe('GET /api/travel-records/flight-legs', () => {
    const getLegs = (query: string) =>
      app.request(`/api/travel-records/flight-legs?${query}`, {}, env);

    it('should return every leg of a multi-leg flight, in order', async () => {
      const res = await getLegs('flightNumber=TR867&date=2026-11-07');

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data).toHaveLength(2);
      expect(body.data[0].departure.country).toBe('JP');
      expect(body.data[1].departure.country).toBe('TW');
      expect(body.data[1].destination.country).toBe('SG');
    });

    it('should return 404 when the flight does not operate that day', async () => {
      mockFlightLegsBehavior = 'not-found';
      const res = await getLegs('flightNumber=TR867&date=2026-11-08');

      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body.message).toBe('No flight data found for the given flight number and date');
    });

    it('should return 500 when the provider fails', async () => {
      mockFlightLegsBehavior = 'api-error';
      const res = await getLegs('flightNumber=TR867&date=2026-11-07');

      expect(res.status).toBe(500);
      const body = await res.json();
      expect(body.message).toBe('Failed to fetch flight data from provider');
    });

    it.each([
      ['a UTC instant instead of a date', { flightNumber: 'TR867', date: '2026-11-06T13:00:00.000Z' }],
      ['an impossible date', { flightNumber: 'TR867', date: '2026-02-30' }],
      ['a missing flight number', { date: '2026-11-07' }],
      ['a path traversal', { flightNumber: '../x', date: '2026-11-07' }],
      ['an injected query', { flightNumber: 'TR867?a=b', date: '2026-11-07' }],
      ['a slash', { flightNumber: 'TR/867', date: '2026-11-07' }],
      ['an over-long value', { flightNumber: 'TOOLONG12345', date: '2026-11-07' }],
    ])('should return 400 for %s', async (_case, query) => {
      const res = await getLegs(new URLSearchParams(query).toString());

      expect(res.status).toBe(400);
    });

    it.each(['TR867', 'TR 867', '3K123', 'QF1'])(
      'should accept a real flight number (%s)',
      async (flightNumber) => {
        const res = await getLegs(
          `flightNumber=${encodeURIComponent(flightNumber)}&date=2026-11-07`,
        );

        expect(res.status).toBe(200);
      },
    );

    // Each lookup spends the server's RapidAPI quota, so anonymous callers must be refused.
    it('should return 401 when the caller is not authenticated', async () => {
      mockIsAuthenticated = false;
      const res = await getLegs('flightNumber=TR867&date=2026-11-07');

      expect(res.status).toBe(401);
    });

    it('should return 403 when a signed-in caller is not an admin', async () => {
      mockUserRole = 'viewer';
      const res = await getLegs('flightNumber=TR867&date=2026-11-07');

      expect(res.status).toBe(403);
    });
  });

  /* ------------------------------------------------------------------ */
  /* create errors                                                       */
  /* ------------------------------------------------------------------ */
  describe('POST /api/travel-records', () => {
    const taoyuan = {
      displayName: 'Taoyuan Airport',
      formattedAddress: 'Taipei, TW',
      location: { latitude: 25.08, longitude: 121.23 },
    };
    const changi = {
      displayName: 'Changi Airport',
      formattedAddress: 'Singapore, SG',
      location: { latitude: 1.36, longitude: 103.99 },
    };

    it('should keep the provider distance sent with a flight leg', async () => {
      const res = await postRecord({
        travelDate: '2026-11-07',
        transportType: 'flight',
        flightNumber: 'TR 867',
        departure: taoyuan,
        destination: changi,
        distance: 3226,
      });

      expect(res.status).toBe(200);
      // haversineDistance is mocked to 500, so 3226 can only have come from the request
      expect(lastCreatedPayload?.distance).toBe(3226);
    });

    it('should calculate the distance for a record that sends none', async () => {
      const res = await postRecord({
        travelDate: '2026-11-07',
        transportType: 'train',
        departure: taoyuan,
        destination: changi,
      });

      expect(res.status).toBe(200);
      expect(lastCreatedPayload?.distance).toBe(500);
    });

    it('should refuse an airport the provider had no coordinates for (0, 0)', async () => {
      const res = await postRecord({
        travelDate: '2026-11-07',
        transportType: 'flight',
        flightNumber: 'TR 867',
        departure: { ...taoyuan, location: { latitude: 0, longitude: 0 } },
        destination: changi,
        distance: 3226,
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.message).toBe('Departure and destination must have a known location');
      expect(lastCreatedPayload).toBeUndefined();
    });

    it('should return 500 when service create throws', async () => {
      mockServiceBehavior = 'error';
      const res = await postRecord({
        travelDate: '2025-01-15T00:00:00Z',
        transportType: 'bus',
        departure: {
          displayName: 'A',
          formattedAddress: 'A',
          location: { latitude: 0.5, longitude: 0.5 },
        },
        destination: {
          displayName: 'B',
          formattedAddress: 'B',
          location: { latitude: 1, longitude: 1 },
        },
      });

      expect(res.status).toBe(500);
      const body = await res.json();
      expect(body.message).toBe('Failed to create travel record');
    });

    it('should return 500 when coordinates are invalid in manual mode', async () => {
      mockIsValidCoord = false;
      const res = await postRecord({
        travelDate: '2025-01-15T00:00:00Z',
        transportType: 'train',
        departure: {
          displayName: 'A',
          formattedAddress: 'A',
          location: { latitude: 999, longitude: 999 },
        },
        destination: {
          displayName: 'B',
          formattedAddress: 'B',
          location: { latitude: 999, longitude: 999 },
        },
      });

      expect(res.status).toBe(500);
      const body = await res.json();
      expect(body.message).toBe('Invalid coordinates');
    });

    it('should create record with zero distance when no departure/destination and not flight API', async () => {
      const res = await postRecord({
        travelDate: '2025-01-15T00:00:00Z',
        transportType: 'bus',
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.message).toBe('Travel record created');
    });
  });

  /* ------------------------------------------------------------------ */
  /* update                                                              */
  /* ------------------------------------------------------------------ */
  describe('PUT /api/travel-records', () => {
    it('should update travel record successfully', async () => {
      const res = await putRecord({
        id: 'record-1',
        travelDate: '2025-01-15T00:00:00Z',
        transportType: 'flight',
        departure: {
          displayName: 'A',
          formattedAddress: 'A',
          location: { latitude: 0, longitude: 0 },
        },
        destination: {
          displayName: 'B',
          formattedAddress: 'B',
          location: { latitude: 1, longitude: 1 },
        },
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.message).toBe('Travel record updated');
    });

    it('should return 400 when id is missing', async () => {
      const res = await putRecord({
        travelDate: '2025-01-15T00:00:00Z',
        transportType: 'bus',
        departure: {
          displayName: 'A',
          formattedAddress: 'A',
          location: { latitude: 0, longitude: 0 },
        },
        destination: {
          displayName: 'B',
          formattedAddress: 'B',
          location: { latitude: 1, longitude: 1 },
        },
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.message).toBe('Record ID is required for update');
    });

    it('should return 500 when service update throws', async () => {
      mockServiceBehavior = 'error';
      const res = await putRecord({
        id: 'record-1',
        travelDate: '2025-01-15T00:00:00Z',
        transportType: 'bus',
        departure: {
          displayName: 'A',
          formattedAddress: 'A',
          location: { latitude: 0, longitude: 0 },
        },
        destination: {
          displayName: 'B',
          formattedAddress: 'B',
          location: { latitude: 1, longitude: 1 },
        },
      });

      expect(res.status).toBe(500);
      const body = await res.json();
      expect(body.message).toBe('Failed to update travel record');
    });
  });

  /* ------------------------------------------------------------------ */
  /* delete                                                              */
  /* ------------------------------------------------------------------ */
  describe('DELETE /api/travel-records/:recordId', () => {
    it('should delete travel record successfully', async () => {
      const res = await app.request('/api/travel-records/record-1', { method: 'DELETE' }, env);

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.message).toBe('Travel record deleted');
    });

    it('should return 500 when service delete throws', async () => {
      mockServiceBehavior = 'error';
      const res = await app.request('/api/travel-records/record-1', { method: 'DELETE' }, env);

      expect(res.status).toBe(500);
      const body = await res.json();
      expect(body.message).toBe('Failed to delete travel record');
    });
  });
});
