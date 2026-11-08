import type { ApiResponse, FlightLeg, ResponseStatus, TravelRecord } from '@/schema';
import { ApiBaseUrl } from '@/services/api-base-url';
import { BaseApiRequestService } from '@/services/base-api-request-service';

export const TravelRecordService = {
  getTravelRecords: async (): Promise<ApiResponse<TravelRecord[]>> => {
    const response = await BaseApiRequestService.perform('GET', `${ApiBaseUrl}/travel-records`);
    if (!response.ok) {
      throw new Error(response.statusText);
    }
    return response.json();
  },

  /**
   * Every leg flown under `flightNumber` on `date` (`YYYY-MM-DD`, the picked local date).
   * A 404 - the flight does not operate that day - resolves with its envelope rather than
   * throwing, so the caller can tell "no such flight" apart from a failed request.
   */
  lookupFlightLegs: async (flightNumber: string, date: string): Promise<ApiResponse<FlightLeg[]>> => {
    const params = new URLSearchParams({ flightNumber, date });
    const response = await BaseApiRequestService.perform(
      'GET',
      `${ApiBaseUrl}/travel-records/flight-legs?${params.toString()}`,
    );
    if (!response.ok && response.status !== 404) {
      throw new Error(response.statusText);
    }
    return response.json();
  },

  createTravelRecord: async (travelRecord: TravelRecord): Promise<ResponseStatus> => {
    const response = await BaseApiRequestService.perform(
      'POST',
      `${ApiBaseUrl}/travel-records`,
      travelRecord,
    );
    if (!response.ok) {
      throw new Error(response.statusText);
    }
    return response.json();
  },

  updateTravelRecord: async (travelRecord: TravelRecord): Promise<ResponseStatus> => {
    const response = await BaseApiRequestService.perform(
      'PUT',
      `${ApiBaseUrl}/travel-records`,
      travelRecord,
    );
    if (!response.ok) {
      throw new Error(response.statusText);
    }
    return response.json();
  },

  deleteTravelRecord: async (recordId: string): Promise<ResponseStatus> => {
    const encodedRecordId = encodeURIComponent(recordId);
    const response = await BaseApiRequestService.perform(
      'DELETE',
      `${ApiBaseUrl}/travel-records/${encodedRecordId}`,
    );
    if (!response.ok) {
      throw new Error(response.statusText);
    }
    return response.json();
  },
};
