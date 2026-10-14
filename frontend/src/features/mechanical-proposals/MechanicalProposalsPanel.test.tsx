import { MantineProvider } from '@mantine/core';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { PermissionsProvider } from '../../lib/permissions';
import { SourceError } from '../sources/api';
import * as api from './api';
import { MechanicalProposalsPanel } from './MechanicalProposalsPanel';

vi.mock('./api', async original => ({
  ...(await original<typeof import('./api')>()),
  listBoards: vi.fn(), boardInputs: vi.fn(), listDrafts: vi.fn(), readDraft: vi.fn(), readRetained: vi.fn(), createDraft: vi.fn(), updateDraft: vi.fn(), retainDraft: vi.fn(), decideRetained: vi.fn(), listDraftTargets: vi.fn(),
}));

const pad = '00000000-0000-0000-0000-0000000000a1';
const empty: api.Parameters = {
  shell: { board_clearance_mm: null, wall_mm: null, corner_radius_mm: null, interior_height_mm: null, board_thickness_mm: null },
  boss: { outer_diameter_mm: null, pilot_diameter_mm: null, height_mm: null, lid_clearance_diameter_mm: null },
  mounts: [], connectors: [], vents: [], cable_guides: [],
};
const proposal = (status: api.Proposal['status'] = 'incomplete'): api.Proposal => ({
  generator: 'parametric-planar-v1', units: 'mm', frame: 'native', status,
  features: [{ feature_id: 'enclosure_outline', kind: 'enclosure_outline', status: 'incomplete', unresolved: ['shell.wall_mm'], geometry: { board_envelope: { x0: 10, y0: 10, x1: 60, y1: 40 }, cavity: null, outer: null }, parameters_used: {}, checks: [], notes: ['Envelope is the axis-aligned bounding rectangle of the native outline.'] },
    { feature_id: `boss:${pad}`, kind: 'mount_candidate', status: 'incomplete', unresolved: ['mounts'], geometry: { center: [13, 13], drill_mm: [3.2, 3.2], decision: 'unreviewed' }, parameters_used: {}, checks: [], notes: [] }],
  unresolved: [{ feature_id: 'enclosure_outline', code: 'unknown_input', parameter: 'shell.wall_mm', message: 'Wall thickness is unknown.' },
    { feature_id: `boss:${pad}`, code: 'unreviewed_mount_candidate', parameter: 'mounts', message: 'Non-plated hole is a candidate only; choose whether it is a mount.' }],
  facts_used: [], checks_summary: { pass: 0, fail: 0, not_evaluated: 0 },
  remaining_physical_checks: ['No collision, clearance, printability or manufacturability analysis has run.'], limitations: [],
  qualification: { physical: false, fit: 'not_evaluated', clearance: 'not_evaluated', printability: 'not_evaluated', manufacturing: 'not_evaluated' },
  board: { interpretation_id: 'board-1', interpretation_sha256: 'a'.repeat(64), source_revision_id: 'rev', source_sha256: 'b'.repeat(64), adapter: 'kicad-intake-v1', tool_version: '10.0.6' },
});
const draft = (over: Partial<api.Draft> = {}): api.Draft => ({ draft_id: 'draft-1', workspace_id: 'project-1', interpretation_id: 'board-1', name: 'Case', parameters: empty, version: 1, state: 'proposal-v1', proposal: proposal(), revisions: [], updated_at: '2026-01-01T00:00:00Z', ...over });
const inputs: api.BoardInputs = { interpretation_id: 'board-1', sha256: 'a'.repeat(64), units: 'mm', frame: 'KiCad absolute: x right, y down', outline_polygons: 1, cutouts: 0,
  holes: [{ pad_id: pad, position: [13, 13], drill: [3.2, 3.2], mounting_status: 'candidate-not-reviewed' }],
  components: [{ component_id: 'comp-1', reference: 'J1', value: 'Header', footprint: 'Header', position: [59, 25], side: 'front' }] };

const view = (permissions?: string[], workspaceId = 'project-1') => render(<MantineProvider env="test"><PermissionsProvider permissions={permissions}><MechanicalProposalsPanel workspaceId={workspaceId} principalKey="actor-1" /></PermissionsProvider></MantineProvider>);

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  Element.prototype.scrollIntoView = vi.fn();
  vi.mocked(api.listBoards).mockResolvedValue({ boards: [{ interpretation_id: 'board-1', sha256: 'a'.repeat(64), board_path: 'board.kicad_pcb', source_revision_id: 'rev', outline: 'closed-line-polygons', hole_candidates: 1, components: 1 }] });
  vi.mocked(api.listDrafts).mockResolvedValue({ truncated: false, drafts: [{ draft_id: 'draft-1', name: 'Case', interpretation_id: 'board-1', version: 1, state: 'proposal-v1', updated_at: 'now', revision_count: 0 }] });
  vi.mocked(api.readDraft).mockResolvedValue(draft());
  vi.mocked(api.boardInputs).mockResolvedValue(inputs);
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.resetAllMocks(); });

async function open() { fireEvent.click(await screen.findByRole('button', { name: 'Open proposal Case' })); await screen.findByText('Unresolved inputs (2)'); }

test('opening a draft shows unknowns as unresolved, never defaulted, and candidate holes undecided', async () => {
  view(['workspace.read', 'item.create', 'design.edit']); await open();
  expect(screen.getByText('Wall thickness is unknown.')).toBeTruthy();
  expect(screen.getByText(/Incomplete: unresolved inputs remain/)).toBeTruthy();
  expect(screen.getByText(/not evaluated\. Board interpretation/)).toBeTruthy();
  expect((screen.getByLabelText(/Wall thickness/) as HTMLInputElement).value).toBe('');
  expect((screen.getAllByLabelText(/Hole at \(13, 13\)/).find(el => el.tagName === 'INPUT') as HTMLInputElement).value).toBe('Not decided (candidate only)');
  expect(screen.getByRole('img', { name: /Plan view/ })).toBeTruthy();
});

test('saving sends only parsed declarations under the draft CAS state with a stable key, then clears dirty state', async () => {
  const saved = draft({ version: 2, state: 'proposal-v2', parameters: { ...empty, shell: { ...empty.shell, wall_mm: 2, board_clearance_mm: 0 } } });
  vi.mocked(api.updateDraft).mockResolvedValue(saved);
  view(['workspace.read', 'item.create', 'design.edit']); await open();
  fireEvent.change(screen.getByLabelText(/Wall thickness/), { target: { value: '2' } });
  fireEvent.change(screen.getByLabelText(/Board clearance/), { target: { value: '0' } });
  expect(screen.getByText('Unsaved edits')).toBeTruthy();
  expect((screen.getByRole('button', { name: 'Retain proposal record' }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: 'Save declarations' }));
  await waitFor(() => expect(api.updateDraft).toHaveBeenCalledTimes(1));
  const [id, parameters, state, key] = vi.mocked(api.updateDraft).mock.calls[0]!;
  expect(id).toBe('draft-1'); expect(state).toBe('proposal-v1'); expect(typeof key).toBe('string');
  expect(parameters.shell).toEqual({ board_clearance_mm: 0, wall_mm: 2, corner_radius_mm: null, interior_height_mm: null, board_thickness_mm: null });
  expect(parameters.mounts).toEqual([]);
  await waitFor(() => expect(screen.queryByText('Unsaved edits')).toBeNull());
});

test('a stale save keeps unsaved edits and offers an explicit reload', async () => {
  vi.mocked(api.updateDraft).mockRejectedValue(new SourceError(409, 'Proposal draft changed since it was read; nothing was saved.'));
  view(['workspace.read', 'item.create', 'design.edit']); await open();
  fireEvent.change(screen.getByLabelText(/Wall thickness/), { target: { value: '3' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save declarations' }));
  await screen.findByText(/Your unsaved edits are kept/);
  expect((screen.getByLabelText(/Wall thickness/) as HTMLInputElement).value).toBe('3');
  expect(api.readDraft).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole('button', { name: /Load latest/ }));
  await waitFor(() => expect(api.readDraft).toHaveBeenCalledTimes(2));
  await waitFor(() => expect((screen.getByLabelText(/Wall thickness/) as HTMLInputElement).value).toBe(''));
});

test('read-only members cannot create, edit, save or retain, with a visible reason', async () => {
  view(['workspace.read']); await open();
  expect(screen.getByRole('note').textContent).toMatch(/Read-only access/);
  for (const name of ['Create proposal draft', 'Save declarations', 'Retain proposal record']) expect((screen.getByRole('button', { name }) as HTMLButtonElement).disabled).toBe(true);
  const wall = screen.getByLabelText(/Wall thickness/) as HTMLInputElement;
  expect(wall.readOnly).toBe(true);
  expect(wall.disabled).toBe(false);
});

test('losing access clears the draft, board identities and proposal', async () => {
  view(['workspace.read', 'item.create', 'design.edit']); await open();
  vi.mocked(api.updateDraft).mockRejectedValue(new SourceError(404, 'Proposal draft not found.'));
  fireEvent.change(screen.getByLabelText(/Wall thickness/), { target: { value: '3' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save declarations' }));
  await screen.findByText(/Access to this project or its board source changed/);
  expect(screen.queryByText('Wall thickness is unknown.')).toBeNull();
  expect(screen.queryByLabelText(/Wall thickness/)).toBeNull();
});

test('retaining reads the exact retained record and labels it as a record, not a fit', async () => {
  const doc = proposal();
  vi.mocked(api.retainDraft).mockResolvedValue({ revision_id: 'rev-1', draft_id: 'draft-1', workspace_id: 'project-1', number: 1, interpretation_id: 'board-1', interpretation_sha256: 'a'.repeat(64), generator: 'g', draft_version: 1, status: 'incomplete', sha256: 'c'.repeat(64), created_at: 'now' });
  vi.mocked(api.readRetained).mockResolvedValue({ revision_id: 'rev-1', draft_id: 'draft-1', workspace_id: 'project-1', number: 1, interpretation_id: 'board-1', interpretation_sha256: 'a'.repeat(64), generator: 'g', draft_version: 1, status: 'incomplete', sha256: 'c'.repeat(64), created_at: 'now', document: { draft_id: 'draft-1', draft_name: 'Case', draft_version: 1, parameters: empty, proposal: doc } });
  view(['workspace.read', 'item.create', 'design.edit']); await open();
  fireEvent.click(screen.getByRole('button', { name: 'Retain proposal record' }));
  await screen.findByText('Retained record 1');
  expect(api.retainDraft).toHaveBeenCalledWith('draft-1', 'proposal-v1', expect.any(String));
  expect(screen.getByText(/SHA-256 c{64}/)).toBeTruthy();
});

const retainedRecord = (extra: Partial<api.Retained> = {}): api.Retained => ({ revision_id: 'rev-1', draft_id: 'draft-1', workspace_id: 'project-1', number: 1, interpretation_id: 'board-1', interpretation_sha256: 'a'.repeat(64), generator: 'g', draft_version: 1, status: 'incomplete', sha256: 'c'.repeat(64), created_at: 'now', decision_state: 'decision-v0', current_decision: null, decisions: [], document: { draft_id: 'draft-1', draft_name: 'Case', draft_version: 1, parameters: empty, proposal: proposal() }, ...extra });
const summary = { revision_id: 'rev-1', number: 1, sha256: 'c'.repeat(64), status: 'incomplete' as const };
async function inspect() {
  vi.mocked(api.readDraft).mockResolvedValue(draft({ revisions: [summary] }));
  view(['workspace.read', 'item.create', 'design.edit']); await open();
  fireEvent.click(screen.getByRole('button', { name: 'Inspect retained record 1' }));
  await screen.findByText('Review decision');
}

test('a decision needs a reason, is sent under the decision state, and the history is re-read', async () => {
  vi.mocked(api.readRetained).mockResolvedValueOnce(retainedRecord());
  await inspect();
  const record = screen.getByRole('button', { name: 'Record decision' }) as HTMLButtonElement;
  expect(record.disabled).toBe(true);
  fireEvent.click(screen.getByText('Reject'));
  fireEvent.change(screen.getByLabelText(/Reason/), { target: { value: 'Wrong board.' } });
  expect(record.disabled).toBe(false);
  const decision: api.Decision = { decision_id: 'd1', revision_id: 'rev-1', version: 1, decision: 'rejected', reason: 'Wrong board.', link_mode: null, definition_id: null, draft_id: null, decided_by_id: 1, created_at: 'now' };
  vi.mocked(api.decideRetained).mockResolvedValue({ revision_id: 'rev-1', decision_state: 'decision-v1', current_decision: decision, decisions: [decision], recorded: decision });
  vi.mocked(api.readRetained).mockResolvedValueOnce(retainedRecord({ decision_state: 'decision-v1', current_decision: decision, decisions: [decision] }));
  fireEvent.click(record);
  await waitFor(() => expect(api.decideRetained).toHaveBeenCalledWith('rev-1', { decision: 'rejected', reason: 'Wrong board.' }, 'decision-v0', expect.any(String)));
  await screen.findByText('Wrong board.');
});

test('accepting requires a target and a stale decision keeps the typed reason', async () => {
  vi.mocked(api.readRetained).mockResolvedValueOnce(retainedRecord());
  await inspect();
  fireEvent.click(screen.getByText('Accept'));
  fireEvent.change(screen.getByLabelText(/Reason/), { target: { value: 'Looks right.' } });
  const record = screen.getByRole('button', { name: 'Record decision' }) as HTMLButtonElement;
  expect(record.disabled).toBe(true);
  fireEvent.change(screen.getByLabelText('New draft name'), { target: { value: 'Housing' } });
  expect(record.disabled).toBe(false);
  vi.mocked(api.decideRetained).mockRejectedValue(new SourceError(409, 'Review decisions changed'));
  fireEvent.click(record);
  await screen.findByText(/nothing was recorded/);
  expect((screen.getByLabelText(/Reason/) as HTMLTextAreaElement).value).toBe('Looks right.');
  expect(api.decideRetained).toHaveBeenCalledWith('rev-1', { decision: 'accepted', reason: 'Looks right.', draftName: 'Housing' }, 'decision-v0', expect.any(String));
});

test('read-only members see decisions but cannot record one', async () => {
  vi.mocked(api.readDraft).mockResolvedValue(draft({ revisions: [summary] }));
  vi.mocked(api.readRetained).mockResolvedValueOnce(retainedRecord());
  view(['workspace.read']); await open();
  fireEvent.click(screen.getByRole('button', { name: 'Inspect retained record 1' }));
  await screen.findByText('Review decision');
  expect((screen.getByRole('button', { name: 'Record decision' }) as HTMLButtonElement).disabled).toBe(true);
  // The decision form renders as inspection: the reason stays readable but cannot be edited.
  await waitFor(() => expect((screen.getByLabelText(/Reason/) as HTMLTextAreaElement).readOnly).toBe(true));
  expect(screen.getAllByText(/Read-only access: requires/).length).toBeGreaterThan(0);
  // The decision choice is plain text, not an operable control.
  expect(screen.queryByRole('radio', { name: 'Accept' })).toBeNull();
  expect(screen.queryByText('Accept')).toBeNull();
});

test('linking offers a picker over workspace drafts and sends the chosen draft id', async () => {
  vi.mocked(api.readRetained).mockResolvedValueOnce(retainedRecord());
  vi.mocked(api.listDraftTargets).mockResolvedValue({ drafts: [{ draft_id: 'dr-9', definition_id: 'def-9', name: 'Target housing', kind: 'note' }] });
  await inspect();
  fireEvent.click(screen.getByText('Accept'));
  fireEvent.change(screen.getByLabelText(/Reason/), { target: { value: 'Fits intent.' } });
  fireEvent.click(screen.getByText('Link existing draft'));
  await waitFor(() => expect(api.listDraftTargets).toHaveBeenCalledWith('project-1', expect.anything()));
  fireEvent.click((await screen.findAllByLabelText('Existing design draft')).find(el => el.tagName === 'INPUT')!);
  fireEvent.click(await screen.findByText(/Target housing/));
  vi.mocked(api.decideRetained).mockRejectedValue(new SourceError(409, 'x'));
  fireEvent.click(screen.getByRole('button', { name: 'Record decision' }));
  await waitFor(() => expect(api.decideRetained).toHaveBeenCalledWith('rev-1', { decision: 'accepted', reason: 'Fits intent.', linkDraftId: 'dr-9' }, 'decision-v0', expect.any(String)));
});
