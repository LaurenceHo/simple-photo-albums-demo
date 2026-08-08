import { Context } from 'hono';
import { HonoEnv } from '../env';
import type { SearchBoxFeature } from '../services/location-service';
import { getLocation } from '../services/location-service';
import { Place } from '../types';
import { BaseController } from './base-controller';

/**
 * A nameless suggestion is useless in a dropdown, and `PlaceSchema.displayName` is
 * `.min(1)`. Dropping the feature here stops one bad result from failing validation later
 * - an opaque 400 when the album is saved - without rejecting the whole response.
 */
const hasUsableName = (feature: SearchBoxFeature): boolean =>
  feature.properties.name.trim().length > 0;

/**
 * Map one Mapbox Search Box feature onto the internal `Place` DTO.
 *
 * Only sound for features that pass `hasUsableName`: `name` is the final fallback for
 * `formattedAddress`, which `PlaceSchema` declares `.min(1)`.
 */
const toPlace = (feature: SearchBoxFeature): Place => {
  const { properties } = feature;
  return {
    displayName: properties.name,
    // `||`, not `??`: Mapbox sends these as empty strings rather than omitting them, and
    // an empty `formattedAddress` fails `PlaceSchema`'s `.min(1)`.
    formattedAddress: properties.full_address || properties.place_formatted || properties.name,
    // `properties.coordinates`, NOT `geometry.coordinates`: the latter is a
    // [longitude, latitude] array, and reading it as [lat, lng] silently puts every pin
    // in the wrong hemisphere.
    location: {
      latitude: properties.coordinates.latitude,
      longitude: properties.coordinates.longitude,
    },
    // `extractCountry` in ui/src/stores/travel-records.ts counts distinct countries with a
    // `Set<string>`, so a casing flip would count 'nz' and 'NZ' as two.
    country: properties.context?.country?.country_code?.toUpperCase(),
  };
};

export default class LocationController extends BaseController {
  /** Find places by keyword. */
  findAll = async (c: Context<HonoEnv>) => {
    const textQuery = c.req.query('textQuery');
    if (!textQuery?.trim()) {
      return this.clientError(c, 'textQuery parameter is required');
    }
    try {
      const response = await getLocation(c.env.MAPBOXAPI_KEY, textQuery, c.env.SEARCH_PROXIMITY);
      const places = (response.features ?? []).filter(hasUsableName).map(toPlace);
      return this.ok<Place[]>(c, 'ok', places);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      // `location-service` never constructs a message containing the request URL, but a
      // runtime `fetch` error is not under our control and could embed it - the Mapbox
      // access token is a query parameter, so an unredacted log would leak it straight into
      // Worker logs, which `wrangler.ci.toml` retains at 100% (`head_sampling_rate = 1`).
      const redactedMessage = message.replace(/access_token=[^&\s]*/gi, 'access_token=REDACTED');
      console.error(`Location API error: ${redactedMessage}`);
      return this.fail(c, 'Failed to fetch location data');
    }
  };

  findOne = async (_c: Context) => {
    throw new Error('Method not implemented.');
  };

  create = async (_c: Context) => {
    throw new Error('Method not implemented.');
  };

  delete = async (_c: Context) => {
    throw new Error('Method not implemented.');
  };

  update = async (_c: Context) => {
    throw new Error('Method not implemented.');
  };
}
