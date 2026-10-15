import { grants } from "../../test/grants";
import { PermissionsProvider } from "../../lib/permissions";
import { MantineProvider } from '@mantine/core';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { PrintingPanel } from './PrintingPanel';
import * as api from './api';

vi.mock('./api', async original => {
  const actual = await original<typeof import('./api')>();
  return { ...actual, listParameters: vi.fn(), listProfiles: vi.fn(), listPreparations: vi.fn(), listMechanical: vi.fn(),
    listProfileRevisions: vi.fn(), listPreparationRevisions: vi.fn(), readProfile: vi.fn(), readPreparation: vi.fn(),
    readMechanicalRevision: vi.fn(), sliceOptions: vi.fn(), sliceRead: vi.fn(), requestSlice: vi.fn(), saveProfile: vi.fn(), listOrcaPresets: vi.fn(), freezeRecord: vi.fn() };
});
vi.mock('../sources/api', async original => ({ ...await original<typeof import('../sources/api')>(), registerBlob: vi.fn(), command: vi.fn() }));
import * as sources from '../sources/api';

const base = { workspace_id: 'ws', state: 'draft-v1', base_revision_id: 'rev-prep', revision_id: null, revision_number: null, snapshot_sha256: null };
const status = { printable: 'not_evaluated', printer_submission: 'not_available', physical_qualification: false } as const;
const preparation: api.PreparationRecord = { ...base, definition_id: 'def-prep', draft_id: 'draft-prep', name: 'FDM PETG', content: {} };
const read: api.PreparationRead = {
  ...preparation, ...status,
  part_identity: { mechanical_definition_id: 'part-def', name: 'Synthetic bracket', item_role: 'part', revision_number: 1,
    model: { path: 'bracket.stl', sha256: 'f'.repeat(64), rights: 'CC-BY-4.0', format: 'mesh', source_revision_id: 'src' } },
  parameters: [
    { role: 'material', key: 'nozzle_temperature_c', label: 'Nozzle temperature', unit: '°C', type: 'number', slicer_setting: 'temperature', required_for_slicing: true,
      status: 'declared', value: 240, basis: 'documented', source: { kind: 'citation', citation: 'Synthetic datasheet table 2' }, note: null,
      profile_name: 'PETG material', profile_revision_id: 'rev-mat', profile_revision_number: 1 },
    { role: 'material', key: 'filament_density_g_cm3', label: 'Filament density', unit: 'g/cm³', type: 'number', slicer_setting: 'filament_density', required_for_slicing: false,
      status: 'unknown', value: null, basis: 'unknown', source: null, note: null, profile_name: 'PETG material', profile_revision_id: 'rev-mat', profile_revision_number: 1 },
  ],
  slicing: { tool_id: 'prusaslicer-2.5.0', blockers: [], requires_frozen_revision: false, tool_default_settings: ['material.filament_density_g_cm3'] },
};
const slice: api.SliceRead = {
  ...status, preparation_revision_id: 'rev-prep', build_id: 'build-a', recipe_id: 'print-slice-prusaslicer-v1-abc', image: 'specmate-slicer-check@sha256:aaa', report_sha256: 'r',
  inputs: { tool: { id: 'prusaslicer-2.5.0', name: 'PrusaSlicer', package: 'prusa-slicer', package_version: '2.5.0+dfsg-4' },
    profiles: { printer: { revision_id: 'rev-printer', snapshot_sha256: 'a' }, process: { revision_id: 'rev-process', snapshot_sha256: 'b' }, material: { revision_id: 'rev-mat', snapshot_sha256: 'c' } },
    part: { path: 'bracket.stl', sha256: 'f', rights: 'CC-BY-4.0' }, declared: [], tool_defaults: [], config: {} },
  report: { estimates: { print_time_s: { value: 3723, status: 'slicer_estimate' }, filament_length_mm: { value: 1234.5, status: 'slicer_estimate' }, filament_mass_g: { value: null, status: 'unknown' } },
    printable: 'not_evaluated', printer_submission: 'not_performed', physical_qualification: false },
  outputs: [{ output_id: 'out-a', path: 'slice.gcode', sha256: 'x', size: 120, rights: 'CC-BY-4.0', media_type: 'text/x.gcode' }],
};

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  vi.mocked(api.listParameters).mockResolvedValue([]);
  vi.mocked(api.listProfiles).mockResolvedValue([]);
  vi.mocked(api.listOrcaPresets).mockResolvedValue([]);
  vi.mocked(api.listPreparations).mockResolvedValue([preparation]);
  vi.mocked(api.listMechanical).mockResolvedValue({ records: [] });
  vi.mocked(api.listPreparationRevisions).mockResolvedValue([{ revision_id: 'rev-prep', number: 1, sha256: 'h', frozen_at: '2026-10-14T00:00:00Z' }]);
  vi.mocked(api.readPreparation).mockResolvedValue(read);
  vi.mocked(api.readMechanicalRevision).mockResolvedValue({ definition_id: 'part-def', name: 'Synthetic bracket', revision_id: 'm', snapshot_sha256: 's', content: { mechanical_source: { sources: [] } } });
  vi.mocked(api.sliceOptions).mockResolvedValue({ ...status, preparation_revision_id: 'rev-prep', recipe_id: 'print-slice-prusaslicer-v1-abc', available_recipe_id: 'print-slice-prusaslicer-v1-abc',
    unavailable_reason: null, tool: slice.inputs.tool, proposed_recipe: null, builds: [{ build_id: 'build-a', state: 'succeeded', failure: null, exit_code: 0 }] });
  vi.mocked(api.sliceRead).mockResolvedValue(slice);
  vi.mocked(api.requestSlice).mockResolvedValue({ build_id: 'build-b' });
});
afterEach(() => { cleanup(); vi.resetAllMocks(); vi.unstubAllGlobals(); });

const panel = (permissions: string[]) => <MantineProvider env="test" theme={{ respectReducedMotion: true }}>
  <PermissionsProvider permissions={permissions}><PrintingPanel workspaceId="ws" projectId={null} /></PermissionsProvider></MantineProvider>;

async function openPreparation() {
  fireEvent.click(await screen.findByRole('combobox', { name: 'Saved preparation' }));
  fireEvent.click(await screen.findByRole('option', { name: 'FDM PETG' }));
  await screen.findByText(/Synthetic bracket r1/);
}

test('preparation shows part identity, parameter provenance and unknowns without printable claims', async () => {
  render(panel(grants()));
  await openPreparation();
  const table = screen.getByRole('table', { name: 'Effective parameters' });
  expect(within(table).getByText('240 °C')).toBeTruthy();
  expect(within(table).getByText(/Synthetic datasheet table 2/)).toBeTruthy();
  expect(within(table).getByText('Filament density unknown')).toBeTruthy();
  expect(within(table).queryByText('0')).toBeNull();
  expect(screen.getByText(/Left to slicer defaults \(not declared\): material.filament_density_g_cm3/)).toBeTruthy();
  expect(screen.getByText('printable').nextSibling?.textContent).toBe('not evaluated');
  expect(screen.getByText('Saving preparations is unavailable', { exact: false })).toBeTruthy();
});

test('slice evidence names the exact tool and keeps unknown estimates unknown; viewers cannot request', async () => {
  render(panel(grants()));
  await openPreparation();
  fireEvent.click(screen.getByRole('combobox', { name: 'Frozen revision' }));
  fireEvent.click(await screen.findByRole('option', { name: 'r1' }));
  expect((await screen.findByRole('button', { name: 'Request slice' }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: 'Inspect slice build-a' }));
  await screen.findByText('Registered slice evidence');
  expect(screen.getByText(/Generated by PrusaSlicer 2.5.0\+dfsg-4/)).toBeTruthy();
  expect(screen.getByText('Filament mass unknown')).toBeTruthy();
  expect(screen.getByText('3723 s (slicer estimate)')).toBeTruthy();
  expect(screen.getByRole('link', { name: 'slice.gcode' }).getAttribute('href')).toContain('/slices/build-a/outputs/out-a');
});

test('build.execute holders request the exact approved recipe', async () => {
  render(panel(grants({ execute: true })));
  await openPreparation();
  fireEvent.click(screen.getByRole('combobox', { name: 'Frozen revision' }));
  fireEvent.click(await screen.findByRole('option', { name: 'r1' }));
  const button = await screen.findByRole('button', { name: 'Request slice' });
  await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(button);
  await waitFor(() => expect(api.requestSlice).toHaveBeenCalledWith('rev-prep', 'print-slice-prusaslicer-v1-abc'));
});

test('OrcaSlicer evidence shows vendor presets, layer count and preset-supplied settings', async () => {
  const orcaTool = { id: 'orcaslicer-2.4.2', name: 'OrcaSlicer', package: 'OrcaSlicer.AppImage', package_version: '2.4.2' };
  vi.mocked(api.readPreparation).mockResolvedValue({ ...read, slicing: { tool_id: 'orcaslicer-2.4.2', blockers: [], requires_frozen_revision: false,
    presets: { printer: { vendor: 'Synthetic', bundle_version: '1.0', name: 'Synthetic machine 0.4' } },
    preset_settings: ['process.layer_height_mm'], not_sent_settings: ['printer.gcode_flavor'] } });
  vi.mocked(api.sliceRead).mockResolvedValue({ ...slice, inputs: { ...slice.inputs, tool: orcaTool },
    report: { ...slice.report, estimates: { ...slice.report.estimates, layer_count: { value: 100, status: 'slicer_estimate' } },
      applied_settings: { printer_settings_id: 'Synthetic machine 0.4', print_settings_id: 'Synthetic process', filament_settings_id: null } } });
  render(panel(grants()));
  await openPreparation();
  expect(screen.getByText(/Taken from the vendor preset \(not declared\): process.layer_height_mm/)).toBeTruthy();
  expect(screen.getByText(/Declared but not sent to this slicer: printer.gcode_flavor/)).toBeTruthy();
  expect(screen.getByText(/printer Synthetic 1.0 \/ Synthetic machine 0.4 · process none/)).toBeTruthy();
  fireEvent.click(screen.getByRole('combobox', { name: 'Frozen revision' }));
  fireEvent.click(await screen.findByRole('option', { name: 'r1' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Inspect slice build-a' }));
  await screen.findByText('Registered slice evidence');
  expect(screen.getByText(/Generated by OrcaSlicer 2.4.2/)).toBeTruthy();
  expect(screen.getByText('100 layers (slicer estimate)')).toBeTruthy();
  expect(screen.getByText('Applied presets: Synthetic machine 0.4 · Synthetic process · unknown')).toBeTruthy();
});

test('a nonterminal slice build is polled until it succeeds, then Inspect enables without reselecting', async () => {
  const options = (state: string) => ({ ...status, preparation_revision_id: 'rev-prep', recipe_id: 'r', available_recipe_id: 'r', unavailable_reason: null, tool: slice.inputs.tool,
    proposed_recipe: null, builds: [{ build_id: 'build-a', state, failure: null, exit_code: null }] });
  vi.mocked(api.sliceOptions).mockResolvedValueOnce(options('waiting_dispatch')).mockResolvedValue(options('succeeded'));
  vi.useFakeTimers({ shouldAdvanceTime: true });
  try {
    render(panel(grants({ execute: true })));
    await openPreparation();
    fireEvent.click(screen.getByRole('combobox', { name: 'Frozen revision' }));
    fireEvent.click(await screen.findByRole('option', { name: 'r1' }));
    const inspect = await screen.findByRole('button', { name: 'Inspect slice build-a' });
    expect((inspect as HTMLButtonElement).disabled).toBe(true);
    await vi.advanceTimersByTimeAsync(3500);
    await waitFor(() => expect((screen.getByRole('button', { name: 'Inspect slice build-a' }) as HTMLButtonElement).disabled).toBe(false));
    const calls = vi.mocked(api.sliceOptions).mock.calls.length;
    await vi.advanceTimersByTimeAsync(10000);
    expect(vi.mocked(api.sliceOptions).mock.calls.length).toBe(calls);
  } finally { vi.useRealTimers(); }
});

test('unavailable slicing explains why and who must act', async () => {
  vi.mocked(api.sliceOptions).mockResolvedValue({ ...status, preparation_revision_id: 'rev-prep', recipe_id: 'r', available_recipe_id: null,
    unavailable_reason: 'No approved recipe matches.', tool: slice.inputs.tool, proposed_recipe: {}, builds: [] });
  render(panel(grants({ execute: true })));
  await openPreparation();
  fireEvent.click(screen.getByRole('combobox', { name: 'Frozen revision' }));
  fireEvent.click(await screen.findByRole('option', { name: 'r1' }));
  await screen.findByText('Slicing is not available');
  expect(screen.getByText('No approved recipe matches.')).toBeTruthy();
  expect(screen.getByText(/operator approves the recipe/)).toBeTruthy();
});

test('one action creates and freezes the printer, process and material profiles for a preset set', async () => {
  const preset = (name: string) => ({ tool: 'orcaslicer-2.4.2' as const, vendor: 'Qidi', bundle_version: '1', name });
  vi.mocked(api.listOrcaPresets).mockResolvedValue([{ key: 'q1', label: 'Qidi Q1 Pro', printer: preset('P'), process: preset('Q'), material: preset('M') }]);
  vi.mocked(api.saveProfile).mockImplementation(async name => ({ ...base, definition_id: name, draft_id: `d-${name}`, name, state: 'draft-v1', content: {} }));
  vi.mocked(api.freezeRecord).mockResolvedValue({ revision_id: 'r', number: 1, draft: { state: 'x' } });
  render(panel(grants({ edit: true, freeze: true, register: true })));
  fireEvent.click(await screen.findByRole('combobox', { name: 'Printer preset set' }));
  fireEvent.click(await screen.findByRole('option', { name: 'Qidi Q1 Pro' }));
  fireEvent.click(screen.getByRole('button', { name: 'Create and freeze the three profiles' }));
  await waitFor(() => expect(api.freezeRecord).toHaveBeenCalledTimes(3));
  expect(vi.mocked(api.saveProfile).mock.calls.map(c => [c[0], c[1].role, c[1].vendor_preset?.name])).toEqual([
    ['Qidi Q1 Pro printer', 'printer', 'P'], ['Qidi Q1 Pro process', 'process', 'Q'], ['Qidi Q1 Pro material', 'material', 'M']]);
});

test('the quick-setup notice names the whole preset set label, including a decimal nozzle size', async () => {
  const preset = (name: string) => ({ tool: 'orcaslicer-2.4.2' as const, vendor: 'Qidi', bundle_version: '1', name });
  vi.mocked(api.listOrcaPresets).mockResolvedValue([{ key: 'q1', label: 'Qidi Q1 Pro, 0.4 mm nozzle, PLA', printer: preset('P'), process: preset('Q'), material: preset('M') }]);
  vi.mocked(api.saveProfile).mockImplementation(async name => ({ ...base, definition_id: name, draft_id: `d-${name}`, name, state: 'draft-v1', content: {} }));
  vi.mocked(api.freezeRecord).mockResolvedValue({ revision_id: 'r', number: 1, draft: { state: 'x' } });
  render(panel(grants({ edit: true, freeze: true, register: true })));
  fireEvent.click(await screen.findByRole('combobox', { name: 'Printer preset set' }));
  fireEvent.click(await screen.findByRole('option', { name: 'Qidi Q1 Pro, 0.4 mm nozzle, PLA' }));
  fireEvent.click(screen.getByRole('button', { name: 'Create and freeze the three profiles' }));
  const notice = await screen.findByRole('status');
  expect(notice.textContent).toContain('Preset set: Qidi Q1 Pro, 0.4 mm nozzle, PLA');
});

test('a model file becomes a frozen mechanical part selected for the new preparation', async () => {
  vi.mocked(sources.registerBlob).mockResolvedValue('a'.repeat(64));
  vi.mocked(sources.command).mockImplementation((async (op: string) => op === 'source.create_original_bundle' ? { revision_id: 'src', manifest_sha256: 'm' }
    : op === 'mechanical_source.create' ? { draft_id: 'md', state: 's1' } : { revision_id: 'mech-1', number: 1 }) as never);
  vi.mocked(api.listMechanical).mockResolvedValue({ records: [{ definition_id: 'p', name: 'cube', revisions: [{ revision_id: 'mech-1', number: 1 }] }] });
  vi.mocked(api.readMechanicalRevision).mockResolvedValue({ definition_id: 'p', name: 'cube', revision_id: 'mech-1', snapshot_sha256: 'snap',
    content: { mechanical_source: { sources: [{ local_id: 'original', files: [{ path: 'cube.stl', role: 'model', format: 'mesh' }] }] } } });
  render(panel(grants({ edit: true, freeze: true, register: true })));
  fireEvent.click(await screen.findByRole('button', { name: 'Start new FDM preparation' }));
  const file = new File(['solid'], 'cube.stl');
  fireEvent.change(await screen.findByLabelText('Model file to upload'), { target: { files: [file] } });
  fireEvent.change(screen.getByLabelText('Declared rights'), { target: { value: 'CC0' } });
  fireEvent.click(screen.getByRole('button', { name: 'Preserve model and freeze part' }));
  await screen.findByText(/froze mechanical part cube r1/);
  expect(vi.mocked(sources.command).mock.calls.map(c => c[0])).toEqual(['source.create_original_bundle', 'mechanical_source.create', 'mechanical_source.freeze']);
  await waitFor(() => expect(api.readMechanicalRevision).toHaveBeenCalledWith('mech-1'));
});
