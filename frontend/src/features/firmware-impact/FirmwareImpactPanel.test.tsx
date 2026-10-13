import { MantineProvider } from '@mantine/core';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { Evaluation } from '../firmware/api';
import { operation } from '../firmware-occurrences/api';
import { read } from '../identity/api';
import { FirmwareImpactPanel } from './FirmwareImpactPanel';
import { compareImpact, type ImpactInputs, type ImpactResult } from './api';

vi.mock('./api', () => ({ compareImpact: vi.fn() }));
vi.mock('../identity/api', () => ({ read: vi.fn() }));
vi.mock('../firmware-occurrences/api', () => ({ operation: vi.fn() }));
const inputs: ImpactInputs = {
  firmware_revision_id: 'firmware-one', firmware_snapshot_sha256: 'exact-firmware-hash', occurrence: null,
  sources: [{ local_id: 'app', source_revision_id: 'source-one', source_manifest_sha256: 'manifest-one', files: [{ path: 'src/main.c', sha256: 'file-hash', rights: 'MIT', role: 'application' }] }],
  configuration: [], toolchain: { family: 'other', name: 'Declared compiler', version: null, framework: null, board_id: null },
  target: { population_revision_id: 'population-one', option_id: 'default', component_id: 'native-mcu', declared_part: null }, pins: [],
};
const evaluation: Evaluation = {
  sources: [], target: { population_revision_id: 'population-one', population_name: 'Synthetic board', population_number: 1, population_snapshot_sha256: 'population-hash',
    option_id: 'default', option_name: 'Default', interpretation_id: 'native-one', interpretation_sha256: 'native-hash', board_source_revision_id: 'board-source', component: null, declared_part: null, pads: [] },
  findings: [], counts: { valid: 0, invalid: 0, unknown: 0, not_evaluated: 0 }, readiness: 'declared', toolchain_support: 'declared_not_verified', compilation: 'not_performed', flashing: 'not_performed', device_operation: 'not_observed',
};
const result: ImpactResult = {
  comparison_sha256: 'comparison-hash', review_required: true,
  baseline: { reference: { firmware_revision_id: 'firmware-one' }, inputs, evaluation },
  candidate: { reference: { firmware_revision_id: 'firmware-two' }, inputs: { ...inputs, firmware_revision_id: 'firmware-two' }, evaluation },
  findings: [{ key: 'pins.LED', status: 'changed', baseline: { pad_id: 'pad-one' }, candidate: { pad_id: 'pad-two' }, reason: 'Review the exact changed native pad.' },
    { key: 'mcu_pin_capability', status: 'unknown', baseline: null, candidate: null, reason: 'MCU capability is not evaluated.' }],
  observations_total: 1, observation_offset: 0, observations_truncated: false, observations_has_more: false,
  observations: [{ subject: { subject_id: 'original-subject', project_id: 'project-one', state: 'facts-v2', target: { kind: 'physical_unit', unit_id: 'unit-one' }, physical_unit_serial: 'SYNTH-UNIT' },
    assertion: { assertion_id: 'assertion-one', subject_id: 'original-subject', sequence: 1, recorded_at: '2026-01-01T00:00:00Z', canonical_value: { kind: 'boolean', value: true }, relation_to_design_state: 'attached_evidence', evidence_status: 'declared',
      fact: { property: 'device_test', status: 'known', purpose: 'general', role: 'actual', value: { kind: 'boolean', value: true }, conditions: [], basis: 'Synthetic result', provenance: { method: 'measurement', evidence: [{ kind: 'citation', citation: 'Synthetic result' }] } } },
    applicability: 'review_required', reason: 'This result belongs to the actual physical unit; never transfer it.', review_keys: ['pins.LED'], historical_result_preserved: true, candidate_result: null }],
};
beforeEach(() => {
  vi.mocked(read).mockImplementation(async path => {
    if (path.includes('/firmware')) return { firmware: [{ definition_id: 'fw-definition', name: 'Synthetic firmware', draft_id: null, revisions: [{ revision_id: 'firmware-one', number: 1 }, { revision_id: 'firmware-two', number: 2 }] }] };
    if (path.includes('/definitions') && !path.startsWith('catalog')) return [{ definition_id: 'assembly-one', name: 'Synthetic repeated controller', kind: 'assembly' }];
    if (path.startsWith('catalog/')) return { revisions: [{ revision_id: 'assembly-revision', number: 3 }], drafts: [] };
    if (path.startsWith('revisions/')) return { snapshot_id: 'assembly-snapshot' };
    if (path.startsWith('facts/subjects/')) return { ...result.observations[0]!.subject, assertions: [result.observations[0]!.assertion], assessments: {}, offset: 0, limit: 50, has_more: false };
    return [result.observations[0]!.subject];
  });
  vi.mocked(compareImpact).mockResolvedValue(result);
  vi.mocked(operation).mockResolvedValue({ snapshot_id: 'assembly-snapshot', occurrences: [{ path: ['left', 'board'], kind: 'pcb_population', firmware_revision_id: 'firmware-one', display_ref: 'A1' }], adoptions: [] });
});
afterEach(() => { cleanup(); vi.resetAllMocks(); });
function panel(projectId = 'project-one') { return <MantineProvider env="test"><FirmwareImpactPanel projectId={projectId} /></MantineProvider>; }
async function select() {
  fireEvent.click(screen.getByRole('button', { name: 'Show firmware impact' }));
  await screen.findAllByRole('option', { name: 'Synthetic firmware · revision 1' });
  fireEvent.change(screen.getByLabelText('Baseline firmware revision'), { target: { value: 'firmware-one' } });
  fireEvent.change(screen.getByLabelText('Candidate firmware revision'), { target: { value: 'firmware-two' } });
}

test('authorized named frozen choices produce exact review and preserve actual unit result', async () => {
  render(panel()); await select(); fireEvent.click(screen.getByRole('button', { name: 'Compare firmware impact' }));
  await screen.findByText('Exact change assessment');
  expect(compareImpact).toHaveBeenCalledWith({ project_id: 'project-one', baseline: { firmware_revision_id: 'firmware-one' }, candidate: { firmware_revision_id: 'firmware-two' }, assertion_ids: [], observation_offset: 0 });
  expect(screen.getByText(/Physical unit SYNTH-UNIT/)).toBeTruthy();
  expect(screen.getByText(/original subject original-subject/)).toBeTruthy();
  expect(screen.getByText(/Hardware compatibility: not evaluated/)).toBeTruthy();
  expect(screen.getByText(/no candidate result is created/)).toBeTruthy();
  expect(screen.getByText('changed')).toBeTruthy(); expect(screen.getByText('unknown')).toBeTruthy();
});

test('focus denial clears retained evidence and private selectors; explicit refresh restores choices', async () => {
  render(panel()); await select(); fireEvent.click(screen.getByRole('button', { name: 'Compare firmware impact' }));
  await screen.findByText('Exact change assessment');
  vi.mocked(read).mockRejectedValueOnce(new Error('Current source access denied'));
  fireEvent(window, new Event('focus'));
  expect(screen.queryByText('Exact change assessment')).toBeNull();
  expect(screen.queryByText(/SYNTH-UNIT/)).toBeNull();
  await screen.findByText('Current source access denied');
  expect(screen.queryAllByRole('option', { name: 'Synthetic firmware · revision 1' })).toHaveLength(0);
  fireEvent.click(screen.getByRole('button', { name: 'Refresh authorized impact inputs' }));
  await screen.findAllByRole('option', { name: 'Synthetic firmware · revision 1' });
});

test('late comparison cannot reopen evidence after newer denied authority refresh', async () => {
  let finish!: (value: ImpactResult) => void;
  vi.mocked(compareImpact).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  render(panel()); await select(); fireEvent.click(screen.getByRole('button', { name: 'Compare firmware impact' }));
  vi.mocked(read).mockRejectedValueOnce(new Error('Latest authority denied'));
  fireEvent(window, new Event('focus')); await screen.findByText('Latest authority denied');
  await act(async () => finish(result));
  expect(screen.queryByText('Exact change assessment')).toBeNull(); expect(screen.queryByText(/SYNTH-UNIT/)).toBeNull();
});

test('late failure cannot clear newer successful comparison after selection changed', async () => {
  let fail!: (reason: Error) => void;
  vi.mocked(compareImpact).mockImplementationOnce(() => new Promise((_resolve, reject) => { fail = reject; }));
  render(panel()); await select(); fireEvent.click(screen.getByRole('button', { name: 'Compare firmware impact' }));
  fireEvent.change(screen.getByLabelText('Candidate firmware revision'), { target: { value: 'firmware-one' } });
  fireEvent.click(screen.getByRole('button', { name: 'Compare firmware impact' }));
  await screen.findByText('Exact change assessment'); await act(async () => fail(new Error('Obsolete failure')));
  expect(screen.queryByText('Obsolete failure')).toBeNull(); expect(screen.getByText('Exact change assessment')).toBeTruthy();
});

test('project change discards comparison and outstanding result', async () => {
  let finish!: (value: ImpactResult) => void;
  vi.mocked(compareImpact).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const view = render(panel()); await select(); fireEvent.click(screen.getByRole('button', { name: 'Compare firmware impact' }));
  view.rerender(panel('project-two')); await act(async () => finish(result));
  expect(screen.queryByText('Exact change assessment')).toBeNull();
  expect(screen.getByRole('button', { name: 'Show firmware impact' })).toBeTruthy();
});

test('context selection preserves exact frozen snapshot and occurrence path', async () => {
  render(panel()); await select();
  fireEvent.change(screen.getByLabelText('Baseline assembly context (optional)'), { target: { value: 'assembly-one' } });
  const frozen = await screen.findByLabelText('Baseline frozen assembly revision');
  fireEvent.change(frozen, { target: { value: 'assembly-revision' } });
  const occurrence = await screen.findByLabelText('Baseline exact board occurrence');
  fireEvent.change(occurrence, { target: { value: '["left","board"]' } });
  fireEvent.click(screen.getByRole('button', { name: 'Compare firmware impact' }));
  await waitFor(() => expect(compareImpact).toHaveBeenCalledWith(expect.objectContaining({ baseline: { firmware_revision_id: 'firmware-one', assembly_snapshot_id: 'assembly-snapshot', path: ['left', 'board'] } })));
});

test('deliberate additional assertions display readable subject and predicate', async () => {
  render(panel()); await select(); fireEvent.click(screen.getByRole('button', { name: 'Choose additional historical observations' }));
  await screen.findByRole('option', { name: 'Physical unit SYNTH-UNIT' });
  fireEvent.change(screen.getByLabelText('Historical observation subject'), { target: { value: 'original-subject' } });
  fireEvent.click(await screen.findByRole('checkbox', { name: 'device_test · known · True · measurement' }));
  fireEvent.click(screen.getByRole('button', { name: 'Compare firmware impact' }));
  await waitFor(() => expect(compareImpact).toHaveBeenCalledWith(expect.objectContaining({ assertion_ids: ['assertion-one'] })));
});

test('comparison denial discards named selections and historical evidence before recovery', async () => {
  render(panel()); await select(); fireEvent.click(screen.getByRole('button', { name: 'Compare firmware impact' }));
  await screen.findByText('Exact change assessment');
  vi.mocked(compareImpact).mockRejectedValueOnce(new Error('Current dependent source denied'));
  fireEvent.click(screen.getByRole('button', { name: 'Compare firmware impact' }));
  await screen.findByText('Current dependent source denied');
  expect(screen.queryByText(/SYNTH-UNIT/)).toBeNull();
  expect(screen.queryAllByRole('option', { name: 'Synthetic firmware · revision 1' })).toHaveLength(0);
  expect((screen.getByRole('button', { name: 'Compare firmware impact' }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: 'Refresh authorized impact inputs' }));
  await screen.findAllByRole('option', { name: 'Synthetic firmware · revision 1' });
});

test('observation paging requests a fresh comparison and declares partial scope', async () => {
  vi.mocked(compareImpact).mockResolvedValueOnce({ ...result, observations_total: 101, observations_truncated: true, observations_has_more: true });
  render(panel()); await select(); fireEvent.click(screen.getByRole('button', { name: 'Compare firmware impact' }));
  await screen.findByText(/This page shows up to 100 assertions from position 1/);
  fireEvent.click(screen.getByRole('button', { name: 'Next impact observations' }));
  await waitFor(() => expect(compareImpact).toHaveBeenLastCalledWith(expect.objectContaining({ observation_offset: 100 })));
});

test('denied contextual read hides its retained input labels and comparison', async () => {
  render(panel()); await select(); fireEvent.click(screen.getByRole('button', { name: 'Compare firmware impact' }));
  await screen.findByText('Exact change assessment');
  fireEvent.change(screen.getByLabelText('Baseline assembly context (optional)'), { target: { value: 'assembly-one' } });
  const frozen = await screen.findByLabelText('Baseline frozen assembly revision');
  vi.mocked(operation).mockRejectedValueOnce(new Error('Current assembly parent denied'));
  fireEvent.change(frozen, { target: { value: 'assembly-revision' } });
  await screen.findByText('Current assembly parent denied');
  expect(screen.queryByText('Exact change assessment')).toBeNull();
  expect(screen.queryByLabelText('Baseline frozen assembly revision')).toBeNull();
});
