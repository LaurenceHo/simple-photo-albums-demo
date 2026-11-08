import { PlaceSchema } from '@/schema/place';
import { z } from 'zod';

export const TravelRecordSchema = z.object({
  id: z.string().optional(),
  travelDate: z.string(),
  departure: PlaceSchema.optional(),
  destination: PlaceSchema.optional(),
  transportType: z.enum(['flight', 'bus', 'train']),
  airline: z.string().optional(),
  flightNumber: z.string().optional(),
  aircraftType: z.string().optional(),
  durationMinutes: z.number().optional(),
  distance: z.number().optional(),
});

export type TravelRecord = z.infer<typeof TravelRecordSchema>;

/**
 * One leg of a flight, from `GET /api/travel-records/flight-legs`. A multi-leg flight
 * (e.g. TR867 NRT→TPE→SIN) has one per stop, in flight order.
 */
export const FlightLegSchema = z.object({
  departure: PlaceSchema,
  destination: PlaceSchema,
  airline: z.string(),
  flightNumber: z.string(),
  aircraftType: z.string().optional(),
  distance: z.number(),
  durationMinutes: z.number(),
});

export type FlightLeg = z.infer<typeof FlightLegSchema>;
