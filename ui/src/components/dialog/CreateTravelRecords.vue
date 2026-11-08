<template>
  <Dialog
    v-model:visible="dialogStates.createTravelRecords"
    :closable="false"
    class="w-80"
    data-test-id="show-travel-records-dialog"
    modal
  >
    <template #header>
      <span class="text-lg font-semibold">New travel records</span>
    </template>
    <form @submit.prevent="validateAndSubmit" @reset.prevent="onReset">
      <div class="mb-4 pb-4">
        <FloatLabel>
          <DatePicker
            v-model="travelDate"
            :disabled="isBusy"
            :invalid="v$.travelDate.$invalid"
            dateFormat="yy-mm-dd"
            fluid
            name="travel-date"
          />
          <label for="travel-date">Travel date</label>
        </FloatLabel>
        <small v-if="v$.travelDate.$invalid" class="p-error">Travel date is required</small>
      </div>
      <div class="mb-4 pb-4">
        <FloatLabel>
          <InputText
            id="flight-number"
            v-model="flightNumber"
            :disabled="isBusy"
            :invalid="v$.flightNumber.$invalid"
            class="w-full"
          />
          <label for="flight-number">Flight number</label>
        </FloatLabel>
        <small v-if="v$.flightNumber.$invalid" class="p-error">Flight number is required</small>
        <small v-if="isFlightApiMode" class="mt-1 block text-yellow-600">
          Departure and destination will be auto-populated from flight data.
        </small>
      </div>
      <div v-if="isFlightApiMode && flightLegs.length > 1" class="mb-4 pb-4">
        <FloatLabel>
          <Select
            v-model="selectedLeg"
            :disabled="isBusy"
            :invalid="!selectedLeg"
            :optionLabel="formatLeg"
            :options="flightLegs"
            aria-labelledby="flight-leg-label"
            class="w-full"
            labelId="flight-leg"
          />
          <label id="flight-leg-label" for="flight-leg">Flight leg</label>
        </FloatLabel>
        <small class="mt-1 block" data-test-id="flight-leg-hint">
          This flight has {{ flightLegs.length }} legs. Choose the one you flew.
        </small>
      </div>
      <div v-if="!isFlightApiMode" class="mb-4 pb-4">
        <FloatLabel>
          <AutoComplete
            v-model="selectedDeparture"
            :disabled="isBusy"
            :invalid="!isFlightApiMode && v$.departure.$invalid"
            :loading="isSearchingDeparture"
            :suggestions="placeSuggestions"
            class="w-full"
            input-class="w-full"
            input-id="departure"
            option-label="displayName"
            @complete="(e) => searchPlace(e, 'departure')"
          >
            <template #option="{ option }">
              <div class="flex flex-col">
                <span class="font-bold">{{ option?.displayName }}</span>
                <span class="text-sm text-gray-600">{{ option?.formattedAddress }}</span>
              </div>
            </template>
            <template #empty>
              <div class="text-gray-500 italic">No suggestion found</div>
            </template>
          </AutoComplete>
          <label for="departure">Departure</label>
        </FloatLabel>
        <small v-if="!isFlightApiMode && v$.departure.$invalid" class="p-error">
          Departure is required
        </small>
      </div>
      <div v-if="!isFlightApiMode" class="mb-4">
        <FloatLabel>
          <AutoComplete
            v-model="selectedDestination"
            :disabled="isBusy"
            :invalid="!isFlightApiMode && v$.destination.$invalid"
            :loading="isSearchingDestination"
            :suggestions="placeSuggestions"
            class="w-full"
            input-class="w-full"
            input-id="destination"
            option-label="displayName"
            @complete="(e) => searchPlace(e, 'destination')"
          >
            <template #option="{ option }">
              <div class="flex flex-col">
                <span class="font-bold">{{ option?.displayName }}</span>
                <span class="text-sm text-gray-600">{{ option?.formattedAddress }}</span>
              </div>
            </template>
            <template #empty>
              <div class="text-gray-500 italic">No suggestion found</div>
            </template>
          </AutoComplete>
          <label for="destination">Destination</label>
        </FloatLabel>
        <small v-if="!isFlightApiMode && v$.destination.$invalid" class="p-error">
          Destination is required
        </small>
      </div>
      <div v-if="!isFlightApiMode" class="mb-4">
        <Select
          v-model="selectedTransportType"
          :options="transportTypes"
          class="w-full"
          optionLabel="name"
        />
      </div>
      <div class="flex justify-end">
        <Button
          :disabled="isBusy"
          class="mr-2"
          data-test-id="cancel-button"
          label="Cancel"
          text
          @click="onReset"
        />
        <Button
          :disabled="v$.$invalid || isBusy || isAwaitingLegChoice"
          :loading="isCreatingRecord || isLookingUpLegs"
          label="Save"
          type="submit"
        />
      </div>
    </form>
  </Dialog>
</template>

<script lang="ts" setup>
import type { FlightLeg, Place } from '@/schema';
import { TravelRecordSchema } from '@/schema/travel-record';
import { LocationService } from '@/services/location-service';
import { TravelRecordService } from '@/services/travel-record-service';
import { useDialogStore, useTravelRecordsStore } from '@/stores';
import { toLocalDateString } from '@/utils/helper';
import { useMutation } from '@tanstack/vue-query';
import { useVuelidate } from '@vuelidate/core';
import { helpers, required, requiredIf } from '@vuelidate/validators';
import { storeToRefs } from 'pinia';
import { AutoComplete, Button, DatePicker, Dialog, FloatLabel, InputText, Select } from 'primevue';
import { useToast } from 'primevue/usetoast';
import { computed, ref, watch } from 'vue';

const transportTypes = [
  { name: 'Flight', code: 'flight' },
  { name: 'Train', code: 'train' },
  {
    name: 'Bus',
    code: 'bus',
  },
];
const toast = useToast();

const dialogStore = useDialogStore();
const { dialogStates } = storeToRefs(dialogStore);
const { refetchTravelRecords } = useTravelRecordsStore();

const travelDate = ref();
const selectedDeparture = ref<Place | null>(null);
const selectedDestination = ref<Place | null>(null);
const placeSuggestions = ref([] as Place[]);
const isSearchingDeparture = ref(false);
const isSearchingDestination = ref(false);
const selectedTransportType = ref({ name: 'Flight', code: 'flight' });
const flightNumber = ref('');

const normalizedFlightNumber = computed(() => flightNumber.value.trim());
const isFlightApiMode = computed(() => !!normalizedFlightNumber.value);

// Legs returned by the flight lookup. Only shown when there is more than one - a single leg
// is saved straight away - and cleared whenever the flight number or date changes, so a
// leg from a previous lookup can never be saved against a different date.
const flightLegs = ref<FlightLeg[]>([]);
const selectedLeg = ref<FlightLeg | null>(null);
const isAwaitingLegChoice = computed(() => flightLegs.value.length > 1 && !selectedLeg.value);

const formatLeg = (leg: FlightLeg) =>
  `${leg.departure.displayName} → ${leg.destination.displayName}`;

const clearFlightLegs = () => {
  flightLegs.value = [];
  selectedLeg.value = null;
};

watch([normalizedFlightNumber, travelDate], clearFlightLegs);

// Inputs and Cancel are locked while a lookup or save is in flight, so the form cannot change
// underneath a request that will act on it.
const isBusy = computed(() => isCreatingRecord.value || isLookingUpLegs.value);
const departure = computed(() => selectedDeparture.value?.displayName || '');
const destination = computed(() => selectedDestination.value?.displayName || '');

const rules = computed(() => ({
  travelDate: {
    required: helpers.withMessage('This field is required.', required),
  },
  flightNumber: {
    required: helpers.withMessage('Flight number is required.', requiredIf(isFlightApiMode)),
  },
  departure: {
    required: helpers.withMessage(
      'This field is required.',
      requiredIf(() => !isFlightApiMode.value),
    ),
  },
  destination: {
    required: helpers.withMessage(
      'This field is required.',
      requiredIf(() => !isFlightApiMode.value),
    ),
  },
}));

const v$ = useVuelidate(rules, { travelDate, flightNumber, departure, destination });

const searchPlace = async (event: { query: string }, field: 'departure' | 'destination') => {
  if (event.query) {
    // Set searching state based on field
    if (field === 'departure') {
      isSearchingDeparture.value = true;
    } else {
      isSearchingDestination.value = true;
    }
    const { data } = await LocationService.searchPlaces(event.query);
    // Set searching states to false after data is returned
    isSearchingDeparture.value = false;
    isSearchingDestination.value = false;
    placeSuggestions.value = data ?? [];
  } else {
    placeSuggestions.value = [];
    // Reset searching states when query is empty
    isSearchingDeparture.value = false;
    isSearchingDestination.value = false;
  }
};

const validateAndSubmit = async () => {
  const isFormCorrect = await v$.value.$validate();
  if (!isFormCorrect) {
    return;
  }
  // Flight mode is two-step: look the legs up first, unless the user is choosing from a
  // lookup that already returned several.
  if (isFlightApiMode.value && !selectedLeg.value) {
    lookupLegs();
    return;
  }
  createRecord();
};

/** The flight number and date currently in the form, or null without a valid date. */
const currentLookupInput = () =>
  travelDate.value instanceof Date
    ? { flightNumber: normalizedFlightNumber.value, date: toLocalDateString(travelDate.value) }
    : null;

const { isPending: isLookingUpLegs, mutate: lookupLegs } = useMutation({
  mutationFn: async () => {
    const input = currentLookupInput();
    if (!input) {
      throw new TypeError('Travel date must be selected');
    }
    const response = await TravelRecordService.lookupFlightLegs(input.flightNumber, input.date);
    // Returned with the response so onSuccess can tell whether the form still matches it.
    return { response, input };
  },
  onSuccess: ({ response, input }) => {
    // The inputs are disabled while this runs, but Cancel-then-reopen or any other change
    // must still never save legs looked up for a different flight or date.
    const current = currentLookupInput();
    if (current?.flightNumber !== input.flightNumber || current.date !== input.date) {
      return;
    }
    const legs = response.code === 200 ? (response.data ?? []) : [];
    if (legs.length === 0) {
      toast.add({
        severity: 'warn',
        summary: 'Flight not found',
        detail: 'No flight found for that flight number on that date.',
        life: 3000,
      });
      return;
    }
    if (legs.length === 1) {
      selectedLeg.value = legs[0] ?? null;
      createRecord();
      return;
    }
    flightLegs.value = legs;
    selectedLeg.value = null;
  },
  onError: () => {
    toast.add({
      severity: 'error',
      summary: 'Error',
      detail: 'Error while looking up the flight. Please try again later.',
      life: 3000,
    });
  },
});

const { isPending: isCreatingRecord, mutate: createRecord } = useMutation({
  mutationFn: () => {
    const transportType = TravelRecordSchema.shape.transportType.parse(
      selectedTransportType.value?.code,
    );

    if (!(travelDate.value instanceof Date)) {
      throw new TypeError('Travel date must be selected');
    }
    // Send the picked calendar date, not a UTC instant: the server looks the flight up by
    // this date, and serialising local midnight to UTC shifts it a day back east of UTC.
    const localTravelDate = toLocalDateString(travelDate.value);

    if (isFlightApiMode.value) {
      // Flight mode: save the leg the lookup returned (or the user chose), with the
      // provider's great-circle distance, which the server keeps for flights.
      const leg = selectedLeg.value;
      if (!leg) {
        throw new TypeError('A flight leg must be selected');
      }
      const travelRecord = {
        travelDate: localTravelDate,
        transportType: 'flight' as const,
        departure: leg.departure,
        destination: leg.destination,
        airline: leg.airline,
        flightNumber: leg.flightNumber,
        aircraftType: leg.aircraftType,
        durationMinutes: leg.durationMinutes,
        distance: leg.distance,
      };
      return TravelRecordService.createTravelRecord(travelRecord);
    }

    // Manual mode: departure and destination required
    if (!selectedDeparture.value || !selectedDestination.value) {
      throw new Error('Departure and destination must be selected');
    }

    const travelRecord = {
      travelDate: localTravelDate,
      departure: selectedDeparture.value,
      destination: selectedDestination.value,
      transportType,
    };
    return TravelRecordService.createTravelRecord(travelRecord);
  },
  onSuccess: async () => {
    toast.add({
      severity: 'success',
      summary: 'Success',
      detail: `Travel record created.`,
      life: 3000,
    });
    await refetchTravelRecords();
    onReset();
  },
  onError: () => {
    toast.add({
      severity: 'error',
      summary: 'Error',
      detail: 'Error while creating travel record. Please try again later.',
      life: 3000,
    });
  },
});

const onReset = () => {
  dialogStore.setDialogState('createTravelRecords', false);
  travelDate.value = '';
  selectedDeparture.value = null;
  selectedDestination.value = null;
  flightNumber.value = '';
  clearFlightLegs();
};
</script>
