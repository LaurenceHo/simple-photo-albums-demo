import ManageGpsTracks from '@/components/dialog/ManageGpsTracks.vue';
import PrimeVue from 'primevue/config';
import { mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { nextTick, type Ref } from 'vue';

const storeState = vi.hoisted(() => ({
  legend: null as unknown as Ref<unknown[]>,
  dialogStates: null as unknown as Ref<Record<string, boolean>>,
  uploadTrack: vi.fn(),
  deleteTrack: vi.fn(),
  setDialogState: vi.fn(),
}));

vi.mock('@/stores', async () => {
  const { ref } = await import('vue');
  storeState.legend = ref<unknown[]>([]);
  storeState.dialogStates = ref<Record<string, boolean>>({ manageGpsTracks: true });

  return {
    useGpsTrackStore: () => ({
      legend: storeState.legend,
      uploadTrack: storeState.uploadTrack,
      deleteTrack: storeState.deleteTrack,
    }),
    useDialogStore: () => ({
      dialogStates: storeState.dialogStates,
      setDialogState: storeState.setDialogState,
    }),
  };
});

vi.mock('pinia', async (importOriginal) => {
  const original = await importOriginal<typeof import('pinia')>();
  return { ...original, storeToRefs: (store: Record<string, unknown>) => store };
});

const track = (trackId: string, label: string, distanceKm?: number) => ({
  trackId,
  colour: '#0072B2',
  label,
  distanceKm,
  isLoading: false,
  isError: false,
  visible: true,
});

/** A File whose `.text()` resolves, which jsdom's File does not implement. */
const gpxFile = (name: string, contents = '<gpx/>', size = 100) =>
  ({
    name,
    size,
    text: () => Promise.resolve(contents),
  }) as unknown as File;

const mountDialog = () =>
  mount(ManageGpsTracks, {
    global: {
      plugins: [PrimeVue],
      stubs: {
        // Honours `visible` and renders the header slot. A stub that ignored `visible`
        // would render the delete-confirmation dialog at all times, so the test asserting
        // that deletion asks first would pass without the confirmation existing.
        Dialog: {
          props: ['visible'],
          template:
            '<div v-if="visible"><slot name="header" /><slot /><slot name="footer" /></div>',
        },
      },
    },
  });

/** Drive the hidden file input's change handler with a chosen set of files. */
const pickFiles = async (wrapper: ReturnType<typeof mountDialog>, files: File[]) => {
  const input = wrapper.find('#gpx-input');
  Object.defineProperty(input.element, 'files', { value: files, configurable: true });
  await input.trigger('change');
  await nextTick();
  await nextTick();
};

describe('ManageGpsTracks', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.clearAllMocks();
    storeState.legend.value = [];
    storeState.dialogStates.value = { manageGpsTracks: true };
    storeState.uploadTrack.mockResolvedValue({ code: 200, status: 'Success' });
    storeState.deleteTrack.mockResolvedValue({ code: 200, status: 'Success' });
  });

  describe('the track list', () => {
    it('shows an empty message when the album has no tracks', () => {
      const wrapper = mountDialog();

      expect(wrapper.find('[data-test-id="no-tracks-message"]').exists()).toBe(true);
    });

    it('renders one row per track with its label and distance', () => {
      storeState.legend.value = [track('day-1', 'Day One', 8.4), track('day-2', 'day-2')];

      const wrapper = mountDialog();
      const rows = wrapper.findAll('[data-test-id="track-row"]');

      expect(rows).toHaveLength(2);
      expect(rows[0]?.text()).toContain('Day One');
      expect(rows[0]?.text()).toContain('8.4 km');
    });

    it('gives every row a delete button — the only way to remove a track', () => {
      storeState.legend.value = [track('day-1', 'Day One', 8.4)];

      const wrapper = mountDialog();

      expect(wrapper.findAll('[data-test-id="delete-track-button"]')).toHaveLength(1);
    });
  });

  describe('deleting', () => {
    beforeEach(() => {
      storeState.legend.value = [track('day-1', 'Day One', 8.4)];
    });

    it('asks for confirmation before destroying an upload that has no undo', async () => {
      const wrapper = mountDialog();

      await wrapper.find('[data-test-id="delete-track-button"]').trigger('click');

      expect(storeState.deleteTrack).not.toHaveBeenCalled();
      expect(wrapper.text()).toContain('Delete "Day One"?');
    });

    it('deletes once confirmed', async () => {
      const wrapper = mountDialog();

      await wrapper.find('[data-test-id="delete-track-button"]').trigger('click');
      await wrapper.find('[data-test-id="confirm-delete-track-button"]').trigger('click');
      await nextTick();

      expect(storeState.deleteTrack).toHaveBeenCalledWith('day-1');
    });

    it('surfaces the server message when the delete fails', async () => {
      storeState.deleteTrack.mockResolvedValue({ code: 500, message: 'Failed to delete' });
      const wrapper = mountDialog();

      await wrapper.find('[data-test-id="delete-track-button"]').trigger('click');
      await wrapper.find('[data-test-id="confirm-delete-track-button"]').trigger('click');
      await nextTick();
      await nextTick();

      expect(wrapper.find('[data-test-id="track-error"]').text()).toContain('Failed to delete');
    });
  });

  describe('uploading', () => {
    it('derives the trackId from the filename stem, sanitised', async () => {
      const wrapper = mountDialog();

      await pickFiles(wrapper, [gpxFile('2026-04-12 Day (1).gpx')]);

      expect(storeState.uploadTrack).toHaveBeenCalledWith('2026-04-12 Day _1_', '<gpx/>');
    });

    it('uploads several files, reporting each outcome independently', async () => {
      (storeState.uploadTrack as Mock)
        .mockResolvedValueOnce({ code: 200 })
        .mockResolvedValueOnce({ code: 400, message: 'The GPX file contains no track points' });

      const wrapper = mountDialog();
      await pickFiles(wrapper, [gpxFile('day-1.gpx'), gpxFile('day-2.gpx')]);

      const statuses = wrapper.findAll('[data-test-id="upload-status"]');
      expect(statuses).toHaveLength(2);
      expect(statuses[0]?.text()).toContain('Done');
      // One failure must not abandon the rest: the second was still attempted.
      expect(statuses[1]?.text()).toContain('Failed');
      expect(storeState.uploadTrack).toHaveBeenCalledTimes(2);
    });

    it('surfaces the server message, which names the parse failure or the cap', async () => {
      storeState.uploadTrack.mockResolvedValue({
        code: 409,
        message: 'This album already has the maximum of 20 GPS tracks.',
      });

      const wrapper = mountDialog();
      await pickFiles(wrapper, [gpxFile('day-21.gpx')]);

      expect(wrapper.find('[data-test-id="track-error"]').text()).toContain('maximum of 20');
    });

    it('rejects a non-gpx file before making any request', async () => {
      const wrapper = mountDialog();

      await pickFiles(wrapper, [gpxFile('holiday.jpg')]);

      expect(storeState.uploadTrack).not.toHaveBeenCalled();
      expect(wrapper.find('[data-test-id="track-error"]').text()).toContain('Only .gpx');
    });

    // The cap is set by the parser's memory cost, not by the photo upload limit it used to
    // copy - see `MAX_GPX_LENGTH` on the server for the measurements behind the number.
    it('rejects a file over the size cap before making any request', async () => {
      const wrapper = mountDialog();

      await pickFiles(wrapper, [gpxFile('huge.gpx', '<gpx/>', 3 * 1024 * 1024)]);

      expect(storeState.uploadTrack).not.toHaveBeenCalled();
      expect(wrapper.find('[data-test-id="track-error"]').text()).toContain('larger than 2MB');
    });

    it('accepts a file just under the cap', async () => {
      const wrapper = mountDialog();

      await pickFiles(wrapper, [gpxFile('big.gpx', '<gpx/>', 2 * 1024 * 1024 - 1)]);

      // Guards the cap from being tightened into rejecting everything.
      expect(storeState.uploadTrack).toHaveBeenCalled();
    });
  });
});
