import CreateTravelRecordsDialog from '@/components/dialog/CreateTravelRecords.vue';
import { setupQueryMocks } from '@/mocks/setup-query-mock';
import type { FlightLeg, Place } from '@/schema';
import { LocationService } from '@/services/location-service';
import { TravelRecordService } from '@/services/travel-record-service';
import { useDialogStore } from '@/stores';
import { createTestingPinia } from '@pinia/testing';
import type { VueWrapper } from '@vue/test-utils';
import { flushPromises, mount } from '@vue/test-utils';
import AutoComplete from 'primevue/autocomplete';
import PrimeVue from 'primevue/config';
import InputText from 'primevue/inputtext';
import { useToast } from 'primevue/usetoast';
import { beforeEach, describe, expect, it, vi } from 'vitest';

interface TravelRecordsVm {
  travelDate: Date | null;
  selectedDeparture: Place | null;
  selectedDestination: Place | null;
  flightNumber: string;
  flightLegs: FlightLeg[];
  selectedLeg: FlightLeg | null;
  createRecord: () => void;
  lookupLegs: () => void;
  $nextTick: () => Promise<void>;
}

const airport = (displayName: string, country: string): Place => ({
  displayName,
  formattedAddress: country,
  location: { latitude: 1, longitude: 2 },
  country,
});

const naritaToTaoyuan: FlightLeg = {
  departure: airport('Narita Airport', 'JP'),
  destination: airport('Taoyuan Airport', 'TW'),
  airline: 'Scoot',
  flightNumber: 'TR 867',
  distance: 2186,
  durationMinutes: 240,
};

const taoyuanToChangi: FlightLeg = {
  departure: airport('Taoyuan Airport', 'TW'),
  destination: airport('Changi Airport', 'SG'),
  airline: 'Scoot',
  flightNumber: 'TR 867',
  aircraftType: 'Boeing 787-9',
  distance: 3226,
  durationMinutes: 280,
};

const legsResponse = (data: FlightLeg[]) => ({
  code: 200,
  status: 'Success',
  message: 'ok',
  data,
});

vi.mock('@tanstack/vue-query', () => ({
  useQuery: vi.fn(),
  useMutation: vi.fn(),
  useQueryClient: vi.fn(),
}));

vi.mock('primevue/usetoast', () => ({
  useToast: vi.fn(),
}));

// Mock services
vi.mock('@/services/location-service', () => ({
  LocationService: {
    searchPlaces: vi.fn(),
  },
}));

vi.mock('@/services/travel-record-service', () => ({
  TravelRecordService: {
    createTravelRecord: vi.fn(),
    lookupFlightLegs: vi.fn(),
  },
}));

describe('CreateTravelRecordsDialog', () => {
  let wrapper: VueWrapper;
  let dialogStore: ReturnType<typeof useDialogStore>;

  beforeEach(() => {
    setupQueryMocks();
    vi.clearAllMocks();

    const pinia = createTestingPinia({
      createSpy: vi.fn,
      stubActions: false,
    });

    dialogStore = useDialogStore();
    dialogStore.setDialogState('createTravelRecords', true);

    // Before mounting: the component calls useToast() during setup, so a mock installed
    // afterwards would leave it holding the previous test's toast.
    vi.mocked(useToast).mockReturnValue({
      add: vi.fn(),
      remove: vi.fn(),
      removeGroup: vi.fn(),
      removeAllGroups: vi.fn(),
    });

    wrapper = mount(CreateTravelRecordsDialog, {
      global: {
        plugins: [pinia, PrimeVue],
        stubs: {
          Dialog: {
            template:
              '<div class="p-dialog" v-if="visible"><slot name="header"></slot><slot></slot></div>',
            props: ['visible'],
          },
          AutoComplete,
        },
      },
    });
  });

  it('renders dialog when createTravelRecordsDialogState is true', () => {
    expect(wrapper.find('[data-test-id="show-travel-records-dialog"]').exists()).toBe(true);
    expect(wrapper.find('.text-lg.font-semibold').text()).toBe('New travel records');
  });

  it('hides dialog when createTravelRecordsDialogState is false', async () => {
    dialogStore.setDialogState('createTravelRecords', false);
    await wrapper.vm.$nextTick();
    expect(wrapper.find('[data-test-id="show-travel-records-dialog"]').exists()).toBe(false);
  });

  it('displays validation error when travel date is empty', async () => {
    await wrapper.find('form').trigger('submit.prevent');
    await flushPromises();
    expect(wrapper.find('.p-error').text()).toContain('Travel date is required');
  });

  it('displays validation error when departure is empty', async () => {
    await wrapper.find('form').trigger('submit.prevent');
    await flushPromises();
    expect(wrapper.findAll('.p-error')[1].text()).toContain('Departure is required');
  });

  it('displays validation error when destination is empty', async () => {
    await wrapper.find('form').trigger('submit.prevent');
    await flushPromises();
    expect(wrapper.findAll('.p-error')[2].text()).toContain('Destination is required');
  });

  it('calls searchPlaces when typing in departure autocomplete', async () => {
    const mockPlaces = [
      {
        displayName: 'New York',
        formattedAddress: 'NY, USA',
        location: { latitude: 40.7128, longitude: -74.006 },
      },
    ];

    vi.mocked(LocationService.searchPlaces).mockResolvedValueOnce({
      code: 200,
      status: 'success',
      data: mockPlaces,
    });

    const autoComplete = wrapper.findAllComponents(AutoComplete)[0];
    autoComplete.vm.$emit('complete', { query: 'New York' });
    await flushPromises();

    expect(LocationService.searchPlaces).toHaveBeenCalledWith('New York');
  });

  it('calls searchPlaces when typing in destination autocomplete', async () => {
    const mockPlaces = [
      {
        displayName: 'London',
        formattedAddress: 'UK',
        location: { latitude: 51.5, longitude: -0.12 },
      },
      {
        displayName: 'Los Angeles',
        formattedAddress: 'CA, USA',
        location: { latitude: 34.05, longitude: -118.24 },
      },
    ];
    vi.mocked(LocationService.searchPlaces).mockResolvedValue({
      code: 200,
      status: 'success',
      data: mockPlaces,
    });

    const autoComplete = wrapper.findAllComponents(AutoComplete)[0];
    autoComplete.vm.$emit('complete', { query: 'Lon' });
    await flushPromises();

    expect(LocationService.searchPlaces).toHaveBeenCalledWith('Lon');
  });

  it('resets form and closes dialog on cancel', async () => {
    expect(dialogStore.dialogStates.createTravelRecords).toBe(true);
    (wrapper.vm as unknown as TravelRecordsVm).travelDate = new Date('2023-10-01');
    (wrapper.vm as unknown as TravelRecordsVm).selectedDeparture = {
      displayName: 'New York',
      formattedAddress: 'NY, USA',
      location: { latitude: 40.71, longitude: -74.01 },
    };
    (wrapper.vm as unknown as TravelRecordsVm).selectedDestination = {
      displayName: 'London',
      formattedAddress: 'UK',
      location: { latitude: 51.5, longitude: -0.12 },
    };
    (wrapper.vm as unknown as TravelRecordsVm).flightNumber = 'NH106';
    await wrapper.vm.$nextTick();

    // Click cancel
    await wrapper.find('[data-test-id="cancel-button"]').trigger('click');
    await wrapper.vm.$nextTick();

    expect(dialogStore.dialogStates.createTravelRecords).toBe(false);
    expect((wrapper.vm as unknown as TravelRecordsVm).travelDate).toBe('');
    expect((wrapper.vm as unknown as TravelRecordsVm).selectedDeparture).toBe(null);
    expect((wrapper.vm as unknown as TravelRecordsVm).selectedDestination).toBe(null);
    expect((wrapper.vm as unknown as TravelRecordsVm).flightNumber).toBe('');
  });

  // Flight number functionality tests

  it('renders flight number input field', () => {
    const flightInput = wrapper.findComponent(InputText);
    expect(flightInput.exists()).toBe(true);
    expect(wrapper.find('label[for="flight-number"]').text()).toBe('Flight number');
  });

  it('shows departure and destination fields when no flight number is entered', () => {
    expect(wrapper.findAllComponents(AutoComplete).length).toBe(2);
    expect(wrapper.find('label[for="departure"]').exists()).toBe(true);
    expect(wrapper.find('label[for="destination"]').exists()).toBe(true);
  });

  it('hides departure and destination fields when flight number is entered', async () => {
    (wrapper.vm as unknown as TravelRecordsVm).flightNumber = 'NH106';
    await wrapper.vm.$nextTick();

    expect(wrapper.findAllComponents(AutoComplete).length).toBe(0);
    expect(wrapper.find('label[for="departure"]').exists()).toBe(false);
    expect(wrapper.find('label[for="destination"]').exists()).toBe(false);
  });

  it('hides transport type selector when flight number is entered', async () => {
    // Transport type select should be visible initially
    expect(wrapper.find('.p-select').exists()).toBe(true);

    (wrapper.vm as unknown as TravelRecordsVm).flightNumber = 'NH106';
    await wrapper.vm.$nextTick();

    // Transport type select should be hidden
    expect(wrapper.find('.p-select').exists()).toBe(false);
  });

  it('shows warning message when flight number is entered', async () => {
    // No warning initially
    expect(wrapper.find('.text-yellow-600').exists()).toBe(false);

    (wrapper.vm as unknown as TravelRecordsVm).flightNumber = 'NH106';
    await wrapper.vm.$nextTick();

    const warning = wrapper.find('.text-yellow-600');
    expect(warning.exists()).toBe(true);
    expect(warning.text()).toContain(
      'Departure and destination will be auto-populated from flight data.',
    );
  });

  it('does not require departure and destination when flight number is entered', async () => {
    (wrapper.vm as unknown as TravelRecordsVm).flightNumber = 'NH106';
    (wrapper.vm as unknown as TravelRecordsVm).travelDate = new Date('2025-01-15');
    await wrapper.vm.$nextTick();

    await wrapper.find('form').trigger('submit.prevent');
    await flushPromises();

    // Should not show departure/destination validation errors
    const errors = wrapper.findAll('.p-error');
    const errorTexts = errors.map((e) => e.text());
    expect(errorTexts).not.toContain('Departure is required');
    expect(errorTexts).not.toContain('Destination is required');
  });

  describe('flight lookup', () => {
    const vm = () => wrapper.vm as unknown as TravelRecordsVm;

    const enterFlight = async (flightNumber: string, date: Date) => {
      vm().travelDate = date;
      vm().flightNumber = flightNumber;
      await wrapper.vm.$nextTick();
      await flushPromises();
    };

    beforeEach(() => {
      vi.mocked(TravelRecordService.createTravelRecord).mockResolvedValue({
        code: 200,
        status: 'Success',
        message: 'ok',
      });
    });

    it('looks the flight up by the picked local calendar date, not the UTC date', async () => {
      vi.mocked(TravelRecordService.lookupFlightLegs).mockResolvedValueOnce(
        legsResponse([taoyuanToChangi]),
      );
      // Local midnight on 9 Oct. East of UTC, toISOString() would give 2026-10-08.
      await enterFlight('VN786', new Date(2026, 9, 9));

      // Call the mutation directly since Vuelidate dynamic rules don't re-evaluate in test env
      vm().lookupLegs();
      await flushPromises();

      expect(TravelRecordService.lookupFlightLegs).toHaveBeenCalledWith('VN786', '2026-10-09');
      expect(TravelRecordService.createTravelRecord).toHaveBeenCalledWith(
        expect.objectContaining({ travelDate: '2026-10-09' }),
      );
    });

    it('saves a single-leg flight straight away with the leg data', async () => {
      vi.mocked(TravelRecordService.lookupFlightLegs).mockResolvedValueOnce(
        legsResponse([taoyuanToChangi]),
      );
      await enterFlight('TR 867', new Date(2026, 10, 7));

      vm().lookupLegs();
      await flushPromises();

      expect(TravelRecordService.createTravelRecord).toHaveBeenCalledTimes(1);
      const callArgs = vi.mocked(TravelRecordService.createTravelRecord).mock.calls[0]?.[0];
      expect(callArgs).toEqual(
        expect.objectContaining({
          transportType: 'flight',
          departure: taoyuanToChangi.departure,
          destination: taoyuanToChangi.destination,
          airline: 'Scoot',
          flightNumber: 'TR 867',
          aircraftType: 'Boeing 787-9',
          durationMinutes: 280,
        }),
      );
      expect(callArgs).not.toHaveProperty('id');
    });

    it('asks which leg was flown when the flight has several, and saves the chosen one', async () => {
      vi.mocked(TravelRecordService.lookupFlightLegs).mockResolvedValueOnce(
        legsResponse([naritaToTaoyuan, taoyuanToChangi]),
      );
      await enterFlight('TR867', new Date(2026, 10, 7));

      vm().lookupLegs();
      await flushPromises();

      // Nothing is saved until a leg is chosen
      expect(TravelRecordService.createTravelRecord).not.toHaveBeenCalled();
      expect(vm().flightLegs).toHaveLength(2);
      expect(wrapper.find('label[for="flight-leg"]').text()).toBe('Flight leg');
      // The combobox takes its accessible name from that label
      const legCombobox = wrapper.find('#flight-leg');
      expect(legCombobox.attributes('role')).toBe('combobox');
      expect(legCombobox.attributes('aria-labelledby')).toBe('flight-leg-label');
      expect(wrapper.find('[data-test-id="flight-leg-hint"]').text()).toContain('2 legs');

      vm().selectedLeg = taoyuanToChangi;
      await wrapper.vm.$nextTick();
      vm().createRecord();
      await flushPromises();

      expect(TravelRecordService.createTravelRecord).toHaveBeenCalledWith(
        expect.objectContaining({
          departure: expect.objectContaining({ country: 'TW' }),
          destination: expect.objectContaining({ country: 'SG' }),
        }),
      );
    });

    it('clears the looked-up legs when the date changes', async () => {
      vi.mocked(TravelRecordService.lookupFlightLegs).mockResolvedValueOnce(
        legsResponse([naritaToTaoyuan, taoyuanToChangi]),
      );
      await enterFlight('TR867', new Date(2026, 10, 7));
      vm().lookupLegs();
      await flushPromises();
      vm().selectedLeg = taoyuanToChangi;
      await wrapper.vm.$nextTick();

      vm().travelDate = new Date(2026, 10, 8);
      await wrapper.vm.$nextTick();

      expect(vm().flightLegs).toHaveLength(0);
      expect(vm().selectedLeg).toBeNull();
      expect(wrapper.find('label[for="flight-leg"]').exists()).toBe(false);
    });

    it('warns and saves nothing when the flight does not operate that day', async () => {
      vi.mocked(TravelRecordService.lookupFlightLegs).mockResolvedValueOnce({
        code: 404,
        status: 'Not Found',
        message: 'No flight data found for the given flight number and date',
      });
      await enterFlight('XX999', new Date(2026, 10, 7));

      vm().lookupLegs();
      await flushPromises();

      expect(TravelRecordService.createTravelRecord).not.toHaveBeenCalled();
      expect(vi.mocked(useToast)().add).toHaveBeenCalledWith(
        expect.objectContaining({ severity: 'warn', summary: 'Flight not found' }),
      );
    });

    it('discards a lookup result when the date changed while it was in flight', async () => {
      let resolveLookup: (value: ReturnType<typeof legsResponse>) => void = () => {};
      vi.mocked(TravelRecordService.lookupFlightLegs).mockReturnValueOnce(
        new Promise((resolve) => {
          resolveLookup = resolve;
        }),
      );
      await enterFlight('TR867', new Date(2026, 10, 7));

      vm().lookupLegs();
      await flushPromises();
      // The user moves the date on before the 7 Nov response arrives
      vm().travelDate = new Date(2026, 10, 8);
      await wrapper.vm.$nextTick();
      resolveLookup(legsResponse([taoyuanToChangi]));
      await flushPromises();

      expect(TravelRecordService.createTravelRecord).not.toHaveBeenCalled();
      expect(vm().selectedLeg).toBeNull();
    });

    it('locks the inputs and Cancel while the lookup runs', async () => {
      let resolveLookup: (value: ReturnType<typeof legsResponse>) => void = () => {};
      vi.mocked(TravelRecordService.lookupFlightLegs).mockReturnValueOnce(
        new Promise((resolve) => {
          resolveLookup = resolve;
        }),
      );
      await enterFlight('TR867', new Date(2026, 10, 7));

      vm().lookupLegs();
      await flushPromises();

      expect(wrapper.find('#flight-number').attributes('disabled')).toBeDefined();
      expect(wrapper.find('input[name="travel-date"]').attributes('disabled')).toBeDefined();
      expect(wrapper.find('[data-test-id="cancel-button"]').attributes('disabled')).toBeDefined();

      resolveLookup(legsResponse([naritaToTaoyuan, taoyuanToChangi]));
      await flushPromises();

      expect(wrapper.find('#flight-number').attributes('disabled')).toBeUndefined();
    });

    it('sends the provider distance with the leg', async () => {
      vi.mocked(TravelRecordService.lookupFlightLegs).mockResolvedValueOnce(
        legsResponse([taoyuanToChangi]),
      );
      await enterFlight('TR867', new Date(2026, 10, 7));

      vm().lookupLegs();
      await flushPromises();

      expect(TravelRecordService.createTravelRecord).toHaveBeenCalledWith(
        expect.objectContaining({ distance: 3226 }),
      );
    });

    it('refuses to save in flight mode without a leg', async () => {
      await enterFlight('TR867', new Date(2026, 10, 7));

      vm().createRecord();
      await flushPromises();

      expect(TravelRecordService.createTravelRecord).not.toHaveBeenCalled();
    });
  });

  it('calls createTravelRecord with manual data when no flight number', async () => {
    vi.mocked(TravelRecordService.createTravelRecord).mockResolvedValueOnce({
      code: 200,
      status: 'Success',
      message: 'ok',
    });

    (wrapper.vm as unknown as TravelRecordsVm).travelDate = new Date('2025-01-15T00:00:00.000Z');
    (wrapper.vm as unknown as TravelRecordsVm).selectedDeparture = {
      displayName: 'Tokyo',
      formattedAddress: 'Tokyo, Japan',
      location: { latitude: 35.67, longitude: 139.65 },
    };
    (wrapper.vm as unknown as TravelRecordsVm).selectedDestination = {
      displayName: 'London',
      formattedAddress: 'London, UK',
      location: { latitude: 51.5, longitude: -0.12 },
    };
    await wrapper.vm.$nextTick();

    await wrapper.find('form').trigger('submit.prevent');
    await flushPromises();

    expect(TravelRecordService.createTravelRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        departure: expect.objectContaining({ displayName: 'Tokyo' }),
        destination: expect.objectContaining({ displayName: 'London' }),
        transportType: 'flight',
      }),
    );

    const callArgs = vi.mocked(TravelRecordService.createTravelRecord).mock.calls[0]?.[0];
    expect(callArgs).not.toHaveProperty('id');
  });
});
