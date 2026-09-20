import { Context } from 'hono';
import { HonoEnv } from '../env';
import type { PlacesSearchResult } from '../services/location-service';
import { getLocation } from '../services/location-service';
import { Place } from '../types';
import { BaseController } from './base-controller';

/**
 * A nameless suggestion is useless in a dropdown, and `PlaceSchema.displayName` is
 * `.min(1)`. Dropping the result here stops one bad entry from failing validation later
 * - an opaque 400 when the album is saved - without rejecting the whole response.
 */
const hasUsableName = (place: PlacesSearchResult): boolean =>
  place.displayName.text.trim().length > 0;

/**
 * Map one Places result onto the internal `Place` DTO.
 *
 * Only sound for results that pass `hasUsableName`: `displayName.text` is the fallback
 * for `formattedAddress`, which `PlaceSchema` declares `.min(1)`.
 */
const toPlace = (place: PlacesSearchResult): Place => {
  const { displayName, formattedAddress, location, addressComponents } = place;
  // `component.types?.` - not `component.types.` - because `types` is optional in the
  // schema. Google really does send components without it (see the note on
  // `PlacesAddressComponentSchema`), and an unguarded `.includes` would throw a TypeError
  // here, turning a parseable response into a 500 at the mapping step instead.
  const countryComponent = addressComponents?.find((component) =>
    component.types?.includes('country'),
  );
  return {
    displayName: displayName.text,
    // `||`, not `??`: Google may send this as an empty string *or* omit it, and both are
    // equally unusable against `PlaceSchema.formattedAddress`, which is `.min(1)`.
    formattedAddress: formattedAddress || displayName.text,
    // Google returns `{ latitude, longitude }` as a named object, so there is no
    // [lng, lat] array to transpose - unlike the Mapbox shape this replaced.
    location,
    // `extractCountry` in ui/src/stores/travel-records.ts counts distinct countries with a
    // `Set<string>`, so a casing flip would count 'tw' and 'TW' as two. Google's country
    // `shortText` is already an uppercase ISO code; this holds that invariant at the
    // boundary rather than trusting it.
    country: countryComponent?.shortText?.toUpperCase(),
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
      const response = await getLocation(c.env.GOOGLE_PLACES_API_KEY, textQuery);
      const places = (response.places ?? []).filter(hasUsableName).map(toPlace);
      return this.ok<Place[]>(c, 'ok', places);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      // No URL redaction here, unlike the Mapbox implementation this replaced: the Places
      // key is sent as the `X-Goog-Api-Key` header and the request URL has no query
      // string, so a `fetch` error cannot embed the credential. That holds only while the
      // key stays in the header - see the note in `location-service.ts`.
      console.error(`Location API error: ${message}`);
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
