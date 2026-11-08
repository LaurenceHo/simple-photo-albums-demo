import { Place } from '../types/place';

export class FlightNotFoundError extends Error {
  constructor(message = 'No flight data found') {
    super(message);
    this.name = 'FlightNotFoundError';
  }
}

export class FlightApiError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FlightApiError';
  }
}

export interface FlightData {
  departure: Place;
  destination: Place;
  airline: string;
  flightNumber: string;
  aircraftType?: string;
  distance: number;
  durationMinutes: number;
}

const FLIGHT_API_TIMEOUT_MS = 10_000;

export default class FlightService {
  private readonly apiKey: string;

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  /**
   * Get the first leg of a flight by flight number and date.
   * @param flightNumber Flight number (e.g., "QF123")
   * @param date Date in YYYY-MM-DD format
   * @returns Flight data for the first leg
   */
  async getFlightByNumber(flightNumber: string, date: string): Promise<FlightData> {
    const [firstLeg] = await this.getFlightLegs(flightNumber, date);
    // getFlightLegs throws on an empty result, so this only guards the type.
    if (!firstLeg) {
      throw new FlightNotFoundError();
    }
    return firstLeg;
  }

  /**
   * https://doc.aerodatabox.com/rapidapi.html#/operations/GetFlight_FlightOnSpecificDate
   *
   * Get every leg of a flight by flight number and date. One flight number can cover several
   * legs (e.g. TR867 flies NRT→TPE→SIN), and AeroDataBox returns one array element per leg,
   * in flight order.
   * @param flightNumber Flight number (e.g., "QF123")
   * @param date Date in YYYY-MM-DD format
   * @returns Flight data for each leg, never empty
   */
  async getFlightLegs(flightNumber: string, date: string): Promise<FlightData[]> {
    const sanitizedFlightNumber = flightNumber.replaceAll(/\s/g, '');
    // Encoded as well as validated upstream, so a value can never add path segments or a query.
    const url = `https://aerodatabox.p.rapidapi.com/flights/number/${encodeURIComponent(sanitizedFlightNumber)}/${encodeURIComponent(date)}`;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), FLIGHT_API_TIMEOUT_MS);

    let response: Response;
    try {
      response = await fetch(url, {
        method: 'GET',
        headers: {
          'x-rapidapi-host': 'aerodatabox.p.rapidapi.com',
          'x-rapidapi-key': this.apiKey,
        },
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeoutId);
    }

    if (!response.ok) {
      throw new FlightApiError(`AeroDataBox API returned ${response.status}`);
    }

    // AeroDataBox answers "no flight on that date" with 204 and an empty body. `response.ok`
    // is true for 204, so without this check `response.json()` throws a SyntaxError that
    // surfaces as a generic 500 instead of a not-found.
    if (response.status === 204) {
      throw new FlightNotFoundError();
    }

    const data: unknown = await response.json();

    if (!Array.isArray(data) || data.length === 0) {
      throw new FlightNotFoundError();
    }

    return data.map((flight: AeroDataBoxFlight) => toFlightData(flight, flightNumber));
  }
}

/**
 * The subset of an AeroDataBox flight element that is mapped. Every field is optional
 * because the provider omits whatever it does not know.
 */
interface AeroDataBoxAirport {
  name?: string;
  municipalityName?: string;
  countryCode?: string;
  location?: { lat?: number; lon?: number };
}

interface AeroDataBoxMovement {
  airport?: AeroDataBoxAirport;
  scheduledTime?: { utc?: string };
}

interface AeroDataBoxFlight {
  departure?: AeroDataBoxMovement;
  arrival?: AeroDataBoxMovement;
  number?: string;
  aircraft?: { model?: string };
  airline?: { name?: string };
  greatCircleDistance?: { km?: number };
}

/**
 * Map one AeroDataBox flight element (one leg) onto `FlightData`.
 * @param flight One element of the API response
 * @param requestedFlightNumber Fallback for when the element carries no flight number
 */
const toFlightData = (flight: AeroDataBoxFlight, requestedFlightNumber: string): FlightData => {
    const departureAirport = flight.departure?.airport;
    const arrivalAirport = flight.arrival?.airport;

    const departure: Place = {
      displayName: departureAirport?.name ? departureAirport?.name + ' Airport' : 'Unknown',
      formattedAddress:
        [departureAirport?.municipalityName, departureAirport?.countryCode]
          .filter(Boolean)
          .join(', ') || 'Unknown',
      location: {
        latitude: departureAirport?.location?.lat ?? 0,
        longitude: departureAirport?.location?.lon ?? 0,
      },
      country: departureAirport?.countryCode,
    };

    const destination: Place = {
      displayName: arrivalAirport?.name ? arrivalAirport?.name + ' Airport' : 'Unknown',
      formattedAddress:
        [arrivalAirport?.municipalityName, arrivalAirport?.countryCode]
          .filter(Boolean)
          .join(', ') || 'Unknown',
      location: {
        latitude: arrivalAirport?.location?.lat ?? 0,
        longitude: arrivalAirport?.location?.lon ?? 0,
      },
      country: arrivalAirport?.countryCode,
    };

    let durationMinutes = 0;
    const depTime = flight.departure?.scheduledTime?.utc;
    const arrTime = flight.arrival?.scheduledTime?.utc;
    if (depTime && arrTime) {
      const depDate = new Date(depTime);
      const arrDate = new Date(arrTime);
      durationMinutes = Math.round((arrDate.getTime() - depDate.getTime()) / 60000);
    }

    const distance = flight.greatCircleDistance?.km ?? 0;
    const aircraftType = flight.aircraft?.model;
    const airline = flight.airline?.name ?? 'Unknown';

    return {
      departure,
      destination,
      airline,
      flightNumber: flight.number ?? requestedFlightNumber,
      // Omitted rather than set to undefined: `aircraftType` is optional, and with
      // exactOptionalPropertyTypes an explicit undefined is not assignable to it.
      ...(aircraftType ? { aircraftType } : {}),
      distance: Math.round(distance),
      durationMinutes,
    };
};
