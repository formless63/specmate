import { grants } from "../../test/grants";
import { PermissionsProvider } from "../../lib/permissions";
import { StrictMode } from 'react';
import { MantineProvider } from '@mantine/core';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { RevisionDetail } from '../sources/api';
import type { Authority, Candidate, Projection } from './api';
import { PropertyAuthorityPanel } from './PropertyAuthority';

const SQUARE: [number, number][] = [[0, 0], [50, 0], [50, 30], [0, 30]];
const known = { status: 'known' as const, outline_polygons: 1, cutouts: 0, vertices: 4, bbox_mm: [0, 0, 50, 30] as [number, number, number, number], net_area_mm2: 1500 };
const projection: Projection = {
  projection_id: 'projection-1', version: 2, interpretation_id: 'interp-1', attempt_id: 'attempt-1', build_id: 'build-1', output_id: 'output-1',
  adapter: 'kicad-intake-v1', tool_version: '10.0.6', native_format_version: 20260206, source_revision_id: 'rev-1', source_number: 1,
  source_path: 'board.kicad_pcb', source_sha256: 'board-hash-1', report_sha256: 'report-1', status: 'known', value: { outline: [SQUARE], cutouts: [] },
  value_sha256: 'value-1', summary: known, previous_projection_id: null, changes: { kind: 'initial', before: null, after: known },
  basis: 'Initial review', reconciled_by: 'editor', created_at: '2026-10-13T00:00:00Z',
};
const wider: Candidate = {
  interpretation_id: 'interp-2', report_sha256: 'report-2', build_id: 'build-2', source_revision_id: 'rev-2', source_path: 'board.kicad_pcb',
  source_sha256: 'board-hash-2', adapter: 'kicad-intake-v1', tool_version: '10.0.6', status: 'known', value_sha256: 'value-2',
  summary: { ...known, bbox_mm: [0, 0, 60, 30], net_area_mm2: 1800 }, accepted_at: '2026-10-13T00:00:00Z',
};
function authority(overrides: Partial<Authority> = {}): Authority {
  return {
    authority_id: 'authority-1', workspace_id: 'project-a', property: 'pcb.board_outline', extractor: 'kicad-intake-v1', state: 'authority-v2', version: 2,
    basis: 'Edge.Cuts in native board', lineage_root_bundle_id: 'root',
    owner: { bundle_id: 'bundle-1', name: 'Working board', role: 'derivative', path: 'board.kicad_pcb', head_revision_id: 'rev-2', head_number: 2,
      head_manifest_sha256: 'manifest-2', head_file_sha256: 'board-hash-2', head_file_rights: 'synthetic', head_file_present: true, editable: true,
      handoff_url: '/api/v0/sources/revisions/rev-2/handoff' },
    status: 'stale', projection, head_candidates: [wider], head_candidates_agree: true,
    non_owner_evidence: { items: [], truncated: false }, history: [projection],
    owner_changes: [{ version: 1, owner_revision_id: 'rev-1', owner_bundle_id: 'bundle-1', owner_path: 'board.kicad_pcb', basis: 'Edge.Cuts in native board', changed_by: 'editor', created_at: '2026-10-13T00:00:00Z' }],
    editable_copy: 'Specmate holds no editable copy of this property.', physical_qualification: false, ...overrides,
  };
}
const detail: RevisionDetail = {
  revision_id: 'rev-2', name: 'Working board', role: 'derivative', number: 2, manifest_sha256: 'manifest-2', derived_from: 'orig', expansion: null,
  manifest: { ancestry: ['rev-1'], files: [{ path: 'board.kicad_pcb', sha256: 'board-hash-2', bytes: 10, media_type: 'application/octet-stream', rights: 'synthetic' }] },
};
function reply(value: unknown, status = 200) { return new Response(JSON.stringify(value), { status }); }
beforeEach(() => { vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} }); Element.prototype.scrollIntoView = vi.fn(); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function setup(reads: Authority[], commands: Response[] = [], canWrite = true, currentDetail: RevisionDetail | null = detail) {
  const bodies: Record<string, unknown>[] = [];
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith('/property-authorities')) return reply({ authorities: [{ authority_id: 'authority-1', property: 'pcb.board_outline', owner_bundle_name: 'Working board', owner_path: 'board.kicad_pcb', state: 'authority-v2', head_revision_id: 'rev-2', projection_current: false, projection_status: 'known' }] });
    if (url.includes('/property-authorities/authority-1')) { const next = reads.length > 1 ? reads.shift()! : reads[0]!; return next ? reply(next) : reply({ error: { message: 'Property authority not found.' } }, 404); }
    if (url.endsWith('/operations')) { bodies.push(JSON.parse(String(init?.body))); return commands.shift() ?? reply({ result: { authority_id: 'authority-1' } }); }
    throw new Error(`Unexpected route ${url}`);
  });
  vi.stubGlobal('fetch', fetchMock);
  const onOpenRevision = vi.fn();
  const onAuthorityFailure = vi.fn();
  const view = render(<MantineProvider><PermissionsProvider permissions={grants({ register: canWrite })}><PropertyAuthorityPanel workspaceId="project-a" detail={currentDetail} onOpenRevision={onOpenRevision} onAuthorityFailure={onAuthorityFailure} /></PermissionsProvider></MantineProvider>);
  return { bodies, fetchMock, onOpenRevision, onAuthorityFailure, view };
}
async function openAuthority() {
  fireEvent.click(screen.getByRole('button', { name: 'Show property authorities' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Review board.kicad_pcb outline authority' }));
  await screen.findByText('Board outline authority');
}

test('nothing is requested until the reviewer opens property authority', () => {
  const { fetchMock } = setup([authority()]);
  expect(fetchMock).not.toHaveBeenCalled();
});

test('stale projection shows exact provenance and edits route to the owning source', async () => {
  const { onOpenRevision } = setup([authority()]);
  await openAuthority();
  expect(screen.getByText(/owning source changed after the last reconciliation/)).toBeTruthy();
  expect(screen.getByText(/no editable copy/)).toBeTruthy();
  expect(screen.getByText(/Source SHA-256 board-hash-1 · report SHA-256 report-1/)).toBeTruthy();
  expect(screen.getByText(/Interpretation interp-1 · build build-1 · kicad-intake-v1 · KiCad 10.0.6/)).toBeTruthy();
  expect(screen.getByRole('img', { name: 'Reconciled projection outline' })).toBeTruthy();
  expect(screen.getByRole('link', { name: 'Download owner editing handoff' }).getAttribute('href')).toBe('/api/v0/sources/revisions/rev-2/handoff');
  fireEvent.click(screen.getByRole('button', { name: 'Edit outline through owning source' }));
  expect(onOpenRevision).toHaveBeenCalledWith('rev-2');
});

test('reconciliation is deliberate, pins the interpretation and uses the state token', async () => {
  const { bodies } = setup([authority(), authority({ status: 'current', state: 'authority-v3' })]);
  await openAuthority();
  const action = screen.getByRole('button', { name: 'Reconcile projection to interpretation interp-2' }) as HTMLButtonElement;
  expect(action.disabled).toBe(true);
  fireEvent.change(screen.getByLabelText('Basis'), { target: { value: 'Reviewed widened Edge.Cuts' } });
  fireEvent.click(action);
  await screen.findByText('authority-v3');
  expect(bodies[0]).toMatchObject({ operation: 'source_property.reconcile', expected_state: 'authority-v2', payload: { authority_id: 'authority-1', interpretation_id: 'interp-2', basis: 'Reviewed widened Edge.Cuts' } });
  expect(bodies[0]).toHaveProperty('idempotency_key');
});

test('conflict keeps the basis and rereads current state without retrying', async () => {
  const { bodies } = setup([authority(), authority({ state: 'authority-v3' })], [reply({ error: { message: 'The property authority changed since it was reviewed.' } }, 409)]);
  await openAuthority();
  fireEvent.change(screen.getByLabelText('Basis'), { target: { value: 'My review' } });
  fireEvent.click(screen.getByRole('button', { name: 'Reconcile projection to interpretation interp-2' }));
  expect(await screen.findByText('The property authority changed since it was reviewed.')).toBeTruthy();
  await screen.findByText('authority-v3');
  expect((screen.getByLabelText('Basis') as HTMLTextAreaElement).value).toBe('My review');
  expect(bodies).toHaveLength(1);
});

test('disagreeing extractions are shown, preserved and never offered for selection', async () => {
  const other = { ...wider, interpretation_id: 'interp-3', value_sha256: 'value-3' };
  const fork = { ...wider, interpretation_id: 'interp-fork', bundle_name: 'Competing fork', differs_from_projection: true };
  setup([authority({ status: 'conflicting', head_candidates: [wider, other], head_candidates_agree: false, non_owner_evidence: { items: [fork], truncated: false } })]);
  await openAuthority();
  expect(screen.getByText(/disagree. They are preserved below/)).toBeTruthy();
  expect(screen.queryByRole('button', { name: /Reconcile projection/ })).toBeNull();
  expect(screen.getByText('Competing fork')).toBeTruthy();
  expect(screen.getByText('Differs from projection')).toBeTruthy();
});

test('unknown coverage and read-only original owner are explicit', async () => {
  const unknown: Projection = { ...projection, status: 'unknown', value: { outline: null, cutouts: null, reason: ['outline unresolved'] }, summary: { status: 'unknown', reason: ['outline unresolved'] } };
  setup([authority({ status: 'current', projection: unknown, owner: { ...authority().owner, role: 'original', editable: false } })], [], false, null);
  await openAuthority();
  expect(screen.getByText('Unknown: outline unresolved')).toBeTruthy();
  expect(screen.queryByRole('img')).toBeNull();
  expect(screen.getByText(/preserved read-only/)).toBeTruthy();
  expect(screen.queryByLabelText('Basis')).toBeNull();
  expect(screen.queryByRole('button', { name: /Edit outline/ })).toBeNull();
});

test('designating an owner names the inspected exact revision and board file', async () => {
  const { bodies } = setup([authority()]);
  fireEvent.click(screen.getByRole('button', { name: 'Show property authorities' }));
  fireEvent.change(await screen.findByLabelText('Basis'), { target: { value: 'Edge.Cuts maintained natively' } });
  fireEvent.click(screen.getByRole('button', { name: 'Designate board outline owner' }));
  await waitFor(() => expect(bodies).toHaveLength(1));
  expect(bodies[0]).toMatchObject({ operation: 'source_property.declare', payload: { owner_revision_id: 'rev-2', path: 'board.kicad_pcb', property: 'pcb.board_outline', basis: 'Edge.Cuts maintained natively' } });
});

test('authority loss clears retained authority data', async () => {
  const reads: Authority[] = [authority()];
  const { onAuthorityFailure, fetchMock } = setup(reads);
  await openAuthority();
  fetchMock.mockImplementation(async () => reply({ error: { message: 'Property authority not found.' } }, 404));
  fireEvent.click(screen.getByRole('button', { name: 'Refresh property authorities' }));
  await waitFor(() => expect(onAuthorityFailure).toHaveBeenCalled());
  expect(screen.queryByText('Board outline authority')).toBeNull();
  expect(screen.queryByText(/board-hash-1/)).toBeNull();
});


test('detached read denial must not gate replacement Sources workspace', async () => {
  const { fetchMock, onAuthorityFailure } = setup([authority()]);
  fireEvent.click(screen.getByRole('button', { name: 'Show property authorities' }));
  await screen.findByRole('button', { name: 'Review board.kicad_pcb outline authority' });
  let finish!: (value: Response) => void;
  fetchMock.mockImplementation(() => new Promise<Response>(resolve => { finish = resolve; }));
  fireEvent.click(screen.getByRole('button', { name: 'Review board.kicad_pcb outline authority' }));
  cleanup();
  await act(async () => finish(reply({ error: { message: 'No longer authorized' } }, 404)));
  expect(onAuthorityFailure).not.toHaveBeenCalled();
});


test('detached mutation completion does not launch reads or notify a recovered parent', async () => {
  const { fetchMock, onAuthorityFailure } = setup([authority()]);
  await openAuthority();
  let finish!: (value: Response) => void;
  fetchMock.mockImplementation((url: string) => {
    if (url.endsWith('/operations')) return new Promise<Response>(resolve => { finish = resolve; });
    return Promise.resolve(reply({ error: { message: 'No longer authorized' } }, 404));
  });
  fireEvent.change(screen.getByLabelText('Basis'), { target: { value: 'Review before replacement' } });
  fireEvent.click(screen.getByRole('button', { name: 'Reconcile projection to interpretation interp-2' }));
  const before = fetchMock.mock.calls.length;
  cleanup();
  await act(async () => finish(reply({ result: { authority_id: 'authority-1' } })));
  expect(fetchMock.mock.calls.length).toBe(before);
  expect(onAuthorityFailure).not.toHaveBeenCalled();
});

test('source replacement fences mutation success and preserves the new review basis', async () => {
  const { fetchMock, onAuthorityFailure, onOpenRevision, view } = setup([authority()]);
  await openAuthority();
  let finish!: (value: Response) => void;
  fetchMock.mockImplementation(() => new Promise<Response>(resolve => { finish = resolve; }));
  fireEvent.change(screen.getByLabelText('Basis'), { target: { value: 'Old context' } });
  fireEvent.click(screen.getByRole('button', { name: 'Reconcile projection to interpretation interp-2' }));
  view.rerender(<MantineProvider><PermissionsProvider permissions={grants({ register: true })}><PropertyAuthorityPanel workspaceId="project-a" detail={{ ...detail, revision_id: 'replacement' }} onOpenRevision={onOpenRevision} onAuthorityFailure={onAuthorityFailure} /></PermissionsProvider></MantineProvider>);
  fireEvent.change(screen.getByLabelText('Basis'), { target: { value: 'New context review' } });
  const before = fetchMock.mock.calls.length;
  await act(async () => finish(reply({ result: { authority_id: 'authority-1' } })));
  expect(fetchMock.mock.calls.length).toBe(before);
  expect((screen.getByLabelText('Basis') as HTMLTextAreaElement).value).toBe('New context review');
});

test('same-source later history selection does not suppress an earlier relevant denial', async () => {
  const { fetchMock, onAuthorityFailure } = setup([authority()]);
  await openAuthority();
  let finish!: (value: Response) => void;
  fetchMock.mockImplementationOnce(() => new Promise<Response>(resolve => { finish = resolve; }));
  fireEvent.click(screen.getByRole('button', { name: 'Review board.kicad_pcb outline authority' }));
  fireEvent.click(screen.getByRole('button', { name: 'Review board.kicad_pcb outline authority' }));
  await screen.findByText('Board outline authority');
  await act(async () => finish(reply({ error: { message: 'Source access lost' } }, 404)));
  expect(onAuthorityFailure).toHaveBeenCalledTimes(1);
  expect(screen.queryByText('Board outline authority')).toBeNull();
});

test('StrictMode setup remains active for successful reads', async () => {
  const { view, onOpenRevision, onAuthorityFailure } = setup([authority()]);
  view.unmount();
  render(<StrictMode><MantineProvider><PermissionsProvider permissions={grants({ register: true })}><PropertyAuthorityPanel workspaceId="project-a" detail={detail} onOpenRevision={onOpenRevision} onAuthorityFailure={onAuthorityFailure} /></PermissionsProvider></MantineProvider></StrictMode>);
  await openAuthority();
  expect(screen.getByText('Board outline authority')).toBeTruthy();
});
