import { MantineProvider } from '@mantine/core';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { StrictMode } from 'react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { MechanicalSourcesPanel } from './MechanicalSourcesPanel';
import { PermissionsProvider } from '../../lib/permissions';
import type { MechanicalRead, MechanicalSource, TargetChoice } from './api';

const source: MechanicalSource = {
  item_role: 'enclosure', sources: [{ local_id: 'native', source_revision_id: 'source-rev', source_manifest_sha256: 'a'.repeat(64),
    files: [{ path: 'body.step', sha256: 'b'.repeat(64), rights: 'MIT', role: 'native', format: 'step' }] }],
  targets: [{ local_id: 'hardware', role: 'hardware', revision_id: 'hardware-rev', snapshot_sha256: 'c'.repeat(64), board: null, native_component_id: null, basis: 'Explicit revision input' }],
  models: [], limitations: ['Tolerance unknown'],
};
const target: TargetChoice = { revision_id: 'hardware-rev', snapshot_sha256: 'c'.repeat(64), name: 'Synthetic hardware', number: 1,
  kind: 'hardware', board: null, components: [], models: [], models_truncated: false };
function read(extra: Partial<MechanicalRead> = {}): MechanicalRead {
  return { definition_id: 'definition', name: 'Synthetic enclosure', draft_id: 'draft', state: 'draft-v1', revision_id: null, revision_number: null, snapshot_sha256: null,
    content: { mechanical_source: structuredClone(source) }, evaluation: {
      sources: [{ ...source.sources[0]!, name: 'Synthetic native sources', number: 1, role: 'derivative', derived_from: 'original-rev', ancestry: ['original-rev'] }],
      targets: [{ ...source.targets[0]!, name: 'Synthetic hardware', number: 1, kind: 'hardware', component: null, board_geometry: null }],
      models: [], findings: [{ code: 'model_geometry', status: 'unknown', local_id: null, message: 'Missing model geometry supplies no clearance evidence.' }],
      readiness: 'declared_with_unknowns', limitations: ['Tolerance unknown'], native_execution: 'none', geometry_validation: 'not_performed', clearance: 'not_evaluated', fit: 'not_evaluated', manufacturability: 'not_evaluated', physical_qualification: false,
    }, ...extra };
}
function reply(body: unknown, status = 200) { return new Response(JSON.stringify(body), { status }); }
beforeEach(() => { vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} }); Element.prototype.scrollIntoView = vi.fn(); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
function setup(options: { permissions?: string[]; strict?: boolean; draft?: MechanicalRead; operations?: Response[]; lost?: () => void; target?: TargetChoice; summary?: TargetChoice } = {}) {
  const bodies: any[] = [];
  let denied = false;
  const mock = vi.fn(async (url: string, init?: RequestInit) => {
    if (denied && url.includes('/sources/revisions/')) return reply({ error: { message: 'Source access unavailable' } }, 404);
    if (url.endsWith('/records')) return reply({ records: [{ definition_id: 'definition', name: 'Synthetic enclosure', drafts: [{ draft_id: 'draft' }], revisions: [{ revision_id: 'frozen', number: 1 }] }], next_after: null });
    if (url.endsWith('/mechanical-sources/workspaces/project/targets')) return reply({ targets: [options.summary ?? options.target ?? target], next_after: null });
    if (url.endsWith('/sources/workspaces/project/revisions')) return reply({ revisions: [{ revision_id: 'source-rev', name: 'Synthetic native sources', role: 'derivative', number: 1 }], next_after: null });
    if (url.endsWith('/sources/revisions/source-rev')) return reply({ revision_id: 'source-rev', name: 'Synthetic native sources', role: 'derivative', number: 1,
      manifest_sha256: 'a'.repeat(64), manifest: { ancestry: ['original-rev'], files: [{ path: 'body.step', sha256: 'b'.repeat(64), rights: 'MIT' }] } });
    if (url.endsWith('/mechanical-sources/targets/hardware-rev')) return reply(options.target ?? target);
    if (url.endsWith('/mechanical-sources/drafts/draft')) return reply(options.draft ?? read());
    if (url.endsWith('/mechanical-sources/revisions/frozen')) return reply(read({ draft_id: null, state: null, revision_id: 'frozen', revision_number: 1, snapshot_sha256: 'd'.repeat(64) }));
    if (url.endsWith('/operations')) { bodies.push(JSON.parse(String(init?.body))); return options.operations?.shift() ?? reply({ result: { draft_id: 'draft', revision_id: 'frozen' } }); }
    throw new Error(`Unexpected route ${url}`);
  });
  vi.stubGlobal('fetch', mock);
  const props = { workspaceId: 'project', onAccessLost: options.lost };
  const permissions = options.permissions ?? ['workspace.read', 'item.create', 'design.edit', 'design.freeze'];
  const view = render(<MantineProvider><PermissionsProvider permissions={permissions}>{options.strict ? <StrictMode><MechanicalSourcesPanel {...props} /></StrictMode> : <MechanicalSourcesPanel {...props} />}</PermissionsProvider></MantineProvider>);
  return { ...view, bodies, mock, deny: (value: boolean) => { denied = value; } };
}
async function refresh() { fireEvent.click(screen.getByRole('button', { name: 'Refresh mechanical sources' })); await screen.findByText('Synthetic enclosure'); }
async function openDraft() { await refresh(); fireEvent.click(screen.getByRole('button', { name: 'Open draft' })); await screen.findByRole('button', { name: 'Edit mechanical draft' }); }

test('loads on demand, displays retained ancestry and explicit unknown geometry', async () => {
  const { mock } = setup(); expect(mock).not.toHaveBeenCalled(); await openDraft();
  expect(screen.getByText(/Original\/derivative ancestry: original-rev/)).toBeTruthy();
  expect(screen.getByText(/Missing model geometry supplies no clearance evidence/)).toBeTruthy();
  expect(screen.getByText(/Geometry validation: not performed/)).toBeTruthy();
  expect(screen.getByText(/rights MIT · native\/step/)).toBeTruthy();
});

test('create pins exact preserved file bytes and rights through the shared operation', async () => {
  const { bodies } = setup(); await refresh(); fireEvent.click(screen.getByRole('button', { name: 'New mechanical source' }));
  fireEvent.change(screen.getByLabelText('Mechanical source name'), { target: { value: 'New reusable enclosure' } });
  fireEvent.change(screen.getByLabelText('Exact accessible source revision ID'), { target: { value: 'source-rev' } });
  fireEvent.click(screen.getByRole('button', { name: 'Add exact source' })); await screen.findAllByText('source-rev', { selector: 'code' });
  fireEvent.change(screen.getByLabelText('Exact accessible target revision ID'), { target: { value: 'hardware-rev' } });
  fireEvent.click(screen.getByRole('button', { name: 'Add exact target' })); await screen.findAllByText(/target1/);
  fireEvent.click(screen.getByRole('button', { name: 'Save mechanical draft' }));
  await screen.findByRole('button', { name: 'Edit mechanical draft' });
  expect(bodies[0]).toMatchObject({ operation: 'mechanical_source.create', payload: { workspace_id: 'project', name: 'New reusable enclosure',
    mechanical_source: { sources: [{ source_revision_id: 'source-rev', source_manifest_sha256: 'a'.repeat(64), files: [{ path: 'body.step', sha256: 'b'.repeat(64), rights: 'MIT' }] }],
      targets: [{ revision_id: 'hardware-rev', snapshot_sha256: 'c'.repeat(64), native_component_id: null }] } } });
});

test('stale updates preserve edited declarations and the original CAS state', async () => {
  const { bodies } = setup({ operations: [reply({ error: { message: 'Draft changed' } }, 409)] }); await openDraft();
  fireEvent.click(screen.getByRole('button', { name: 'Edit mechanical draft' }));
  fireEvent.change(screen.getByLabelText('Mechanical limitations, one per line'), { target: { value: 'User unsaved limitation' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save mechanical draft' })); await screen.findByText('Draft changed');
  expect((screen.getByLabelText('Mechanical limitations, one per line') as HTMLTextAreaElement).value).toBe('User unsaved limitation');
  expect(bodies[0]).toMatchObject({ operation: 'mechanical_source.update', expected_state: 'draft-v1', payload: { mechanical_source: { limitations: ['User unsaved limitation'] } } });
});

test('denial hides provenance and unsaved state, restoration rechecks and retains original CAS', async () => {
  const lost = vi.fn(); const { deny, bodies } = setup({ lost }); await openDraft();
  fireEvent.click(screen.getByRole('button', { name: 'Edit mechanical draft' }));
  fireEvent.change(screen.getByLabelText('Mechanical limitations, one per line'), { target: { value: 'Retained unsaved limitation' } });
  deny(true); fireEvent.click(screen.getByRole('button', { name: 'Refresh mechanical sources' })); await screen.findByText(/Declarations are hidden/);
  expect(screen.queryByText('Synthetic native sources revision 1 (derivative)')).toBeNull();
  expect(screen.queryByLabelText('Mechanical limitations, one per line')).toBeNull(); expect(lost).toHaveBeenCalledOnce();
  deny(false); await refresh();
  expect((screen.getByLabelText('Mechanical limitations, one per line') as HTMLTextAreaElement).value).toBe('Retained unsaved limitation');
  fireEvent.click(screen.getByRole('button', { name: 'Save mechanical draft' })); await screen.findByRole('button', { name: 'Edit mechanical draft' });
  expect(bodies[0].expected_state).toBe('draft-v1');
});

test('response loss retries the identical reviewed request with the same idempotency key', async () => {
  const { bodies } = setup({ operations: [reply({ error: { message: 'Response unavailable' } }, 503)] }); await openDraft();
  fireEvent.click(screen.getByRole('button', { name: 'Edit mechanical draft' }));
  fireEvent.click(screen.getByRole('button', { name: 'Save mechanical draft' })); await screen.findByText('Response unavailable');
  fireEvent.click(screen.getByRole('button', { name: 'Save mechanical draft' })); await screen.findByRole('button', { name: 'Edit mechanical draft' });
  expect(bodies[0].idempotency_key).toBe(bodies[1].idempotency_key); expect(bodies[0].payload).toEqual(bodies[1].payload);
});

test('frozen history and read-only membership offer no authoring controls', async () => {
  setup({ permissions: ['workspace.read'] }); await refresh(); fireEvent.click(screen.getByRole('button', { name: 'Revision 1' }));
  await screen.findByRole('heading', { name: 'Synthetic enclosure revision 1' });
  expect(screen.queryByRole('button', { name: 'New mechanical source' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Edit mechanical draft' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Freeze mechanical declarations' })).toBeNull();
});

test('strict mode refresh works and a late read cannot reopen a cancelled selection', async () => {
  const { mock } = setup({ strict: true }); await refresh();
  let resolve!: (value: Response) => void;
  mock.mockImplementationOnce(() => new Promise<Response>(accept => { resolve = accept; }));
  fireEvent.click(screen.getByRole('button', { name: 'Open draft' }));
  fireEvent.click(screen.getByRole('button', { name: 'New mechanical source' }));
  await act(async () => resolve(reply(read())));
  expect(screen.queryByRole('button', { name: 'Edit mechanical draft' })).toBeNull();
  expect(screen.getByLabelText('Mechanical source name')).toBeTruthy();
});

test('freezing sends the current token and opens immutable revision history', async () => {
  const { bodies } = setup(); await openDraft();
  fireEvent.click(screen.getByRole('button', { name: 'Freeze mechanical declarations' }));
  await screen.findByRole('heading', { name: 'Synthetic enclosure revision 1' });
  expect(bodies[0]).toMatchObject({ operation: 'mechanical_source.freeze', expected_state: 'draft-v1', payload: { draft_id: 'draft' } });
});

test('a selected model pins its represented revision and source, preserving unknown quality', async () => {
  const model = { representation_id: 'model-representation', label: 'Declared model', revision_id: 'hardware-rev', snapshot_sha256: 'c'.repeat(64),
    source_revision_id: 'source-rev', source_manifest_sha256: 'a'.repeat(64), path: 'body.step', sha256: 'b'.repeat(64), rights: 'MIT' };
  const { bodies } = setup({ target: { ...target, models: [model] } }); await openDraft();
  fireEvent.click(screen.getByRole('button', { name: 'Edit mechanical draft' }));
  fireEvent.click(screen.getByLabelText('Model owning revision', { selector: 'input' }));
  fireEvent.click(screen.getByRole('option', { name: 'Synthetic hardware revision 1', hidden: true }));
  await screen.findByRole('button', { name: 'Pin model Declared model' });
  fireEvent.click(screen.getByLabelText('Model applies to target', { selector: 'input' }));
  fireEvent.click(screen.getAllByRole('option', { name: 'hardware', hidden: true }).at(-1)!);
  fireEvent.click(screen.getByRole('button', { name: 'Pin model Declared model' }));
  await screen.findByText(/model1 · representation model-representation/);
  expect((screen.getByLabelText('Model accuracy for model1') as HTMLInputElement).value).toBe('');
  fireEvent.click(screen.getByRole('button', { name: 'Save mechanical draft' })); await screen.findByRole('button', { name: 'Edit mechanical draft' });
  expect(bodies[0].payload.mechanical_source.models[0]).toMatchObject({ representation_id: 'model-representation', revision_id: 'hardware-rev',
    snapshot_sha256: 'c'.repeat(64), source_local_id: 'native', path: 'body.step', target_local_id: 'hardware', units: null, frame: null, accuracy: null });
  expect(bodies[0].payload.mechanical_source.sources[0].files[0].role).toBe('model');
});

test('adding a summarized board immediately restores exact option and component choices', async () => {
  const board: TargetChoice = { ...target, kind: 'pcb_population', board: {
    interpretation_id: 'interpretation', interpretation_sha256: 'e'.repeat(64), source_revision_id: 'board-source',
    source_manifest_sha256: 'f'.repeat(64), options: [{ local_id: 'fit', name: 'Chosen population' }],
  }, components: [{ id: 'component', reference: 'U1', value: 'Synthetic controller' }] };
  setup({ target: board, summary: target }); await refresh();
  fireEvent.click(screen.getByRole('button', { name: 'New mechanical source' }));
  fireEvent.change(screen.getByLabelText('Exact accessible target revision ID'), { target: { value: 'hardware-rev' } });
  fireEvent.click(screen.getByRole('button', { name: 'Add exact target' }));
  await screen.findByLabelText('Board option for target1', { selector: 'input' });
  fireEvent.click(screen.getByLabelText('Board option for target1', { selector: 'input' }));
  fireEvent.click(await screen.findByRole('option', { name: 'Chosen population', hidden: true }));
  fireEvent.click(screen.getByLabelText('Target role for target1', { selector: 'input' }));
  fireEvent.click(screen.getByRole('option', { name: 'component', hidden: true }));
  fireEvent.click(screen.getByLabelText('Native component for target1', { selector: 'input' }));
  expect(await screen.findByRole('option', { name: 'U1: Synthetic controller', hidden: true })).toBeTruthy();
});

test('an exact path pins only its file from a larger source bundle', async () => {
  const { mock, bodies } = setup(); await refresh();
  fireEvent.click(screen.getByRole('button', { name: 'New mechanical source' }));
  fireEvent.change(screen.getByLabelText('Mechanical source name'), { target: { value: 'Exact source file' } });
  fireEvent.change(screen.getByLabelText('Exact source file path (optional)'), { target: { value: 'body.step' } });
  fireEvent.change(screen.getByLabelText('Exact accessible source revision ID'), { target: { value: 'source-rev' } });
  mock.mockImplementationOnce(async () => reply({ revision_id: 'source-rev', manifest_sha256: 'a'.repeat(64), manifest: {
    files: [{ path: 'body.step', sha256: 'b'.repeat(64), rights: 'MIT' }, ...Array.from({ length: 201 }, (_, i) => ({ path: `sibling${i}.step`, sha256: 'd'.repeat(64), rights: 'unknown' }))],
  } }));
  fireEvent.click(screen.getByRole('button', { name: 'Add exact source' }));
  await screen.findAllByText('source-rev', { selector: 'code' });
  fireEvent.click(screen.getByRole('button', { name: 'Save mechanical draft' }));
  await screen.findByRole('button', { name: 'Edit mechanical draft' });
  expect(bodies[0].payload.mechanical_source.sources[0].files).toEqual([{ path: 'body.step', sha256: 'b'.repeat(64), rights: 'MIT', role: 'supporting', format: 'other' }]);
});

async function choice(label: string, value: string) {
  fireEvent.click(screen.getByLabelText(label, { selector: 'input' }));
  fireEvent.click(within(screen.getByRole('listbox', { name: label, hidden: true })).getByRole('option', { name: value, hidden: true }));
}

test('scoped uncertainty sends explicit zero tolerance and full envelope bounds; stale retry retains CAS and exact key', async () => {
  const { bodies } = setup({ operations: [reply({ error: { message: 'Uncertainty conflict' } }, 409), reply({ error: { message: 'Uncertainty conflict' } }, 409)] });
  await openDraft(); fireEvent.click(screen.getByRole('button', { name: 'Edit mechanical draft' }));
  fireEvent.click(screen.getByRole('button', { name: 'Add material assumption' }));
  await choice('Status for materials material1', 'declared');
  fireEvent.change(screen.getByLabelText('Basis for materials material1'), { target: { value: 'Original hypothetical material basis' } });
  fireEvent.change(screen.getByLabelText('Material specification for material1'), { target: { value: 'Synthetic polymer' } });
  fireEvent.click(screen.getByRole('button', { name: 'Add tolerance assumption' }));
  await choice('Scope for tolerances tolerance1', 'hardware');
  await choice('Status for tolerances tolerance1', 'declared');
  fireEvent.change(screen.getByLabelText('Basis for tolerances tolerance1'), { target: { value: 'Hypothetical width deviation' } });
  fireEvent.change(screen.getByLabelText('Dimension or stable feature for tolerance1'), { target: { value: 'opening width' } });
  fireEvent.change(screen.getByLabelText('Lower deviation (mm) for tolerance1'), { target: { value: '0' } });
  fireEvent.change(screen.getByLabelText('Upper deviation (mm) for tolerance1'), { target: { value: '0.25' } });
  fireEvent.click(screen.getByRole('button', { name: 'Add connector envelope scope' }));
  await choice('Status for connector_envelopes envelope1', 'declared');
  await choice('Connector usage for envelope1', 'mated');
  fireEvent.change(screen.getByLabelText('Basis for connector_envelopes envelope1'), { target: { value: 'Hypothetical mated state; no other coverage' } });
  fireEvent.change(screen.getByLabelText('Envelope frame for envelope1'), { target: { value: 'declared_local' } });
  for (const [bound, values] of [['minimum', [-1, 0, 1]], ['maximum', [2, 3, 4]]] as const) {
    for (let i = 0; i < 3; i++) fireEvent.change(screen.getByLabelText(`${bound} ${['X', 'Y', 'Z'][i]} (mm) for envelope1`), { target: { value: String(values[i]) } });
  }
  fireEvent.click(screen.getByRole('button', { name: 'Save mechanical draft' })); await screen.findByText('Uncertainty conflict');
  expect(bodies[0].expected_state).toBe('draft-v1');
  expect(bodies[0].payload.mechanical_source.uncertainty).toMatchObject({
    materials: [{ target_local_id: null, status: 'declared', specification: 'Synthetic polymer', behavior: null, basis: 'Original hypothetical material basis' }],
    tolerances: [{ target_local_id: 'hardware', dimension: 'opening width', status: 'declared', units: 'mm', lower_deviation: 0, upper_deviation: 0.25 }],
    connector_envelopes: [{ target_local_id: 'hardware', usage: 'mated', minimum: [-1, 0, 1], maximum: [2, 3, 4], units: 'mm', frame: 'declared_local' }],
  });
  expect(screen.getByText(/Clearance, fit and manufacturability: not evaluated/)).toBeTruthy();
  expect((screen.getByLabelText('Lower deviation (mm) for tolerance1') as HTMLInputElement).value).toBe('0');
  fireEvent.click(screen.getByRole('button', { name: 'Save mechanical draft' }));
  await vi.waitFor(() => expect(bodies).toHaveLength(2));
  expect(bodies[1].payload).toEqual(bodies[0].payload); expect(bodies[1].idempotency_key).toBe(bodies[0].idempotency_key);
});

test('unknown and justified not applicable scopes invent no bounds; source denial hides and restores retained uncertainty', async () => {
  const { bodies, deny } = setup({ operations: [reply({ error: { message: 'Retained uncertainty' } }, 409)] });
  await openDraft(); fireEvent.click(screen.getByRole('button', { name: 'Edit mechanical draft' }));
  fireEvent.click(screen.getByRole('button', { name: 'Add tolerance assumption' }));
  fireEvent.click(screen.getByRole('button', { name: 'Add connector envelope scope' }));
  await choice('Status for connector_envelopes envelope1', 'not_applicable');
  fireEvent.change(screen.getByLabelText('Basis for connector_envelopes envelope1'), { target: { value: 'No body-envelope usage in this declared scope' } });
  expect(screen.queryByLabelText('minimum X (mm) for envelope1')).toBeNull();
  expect(screen.queryByLabelText('Lower deviation (mm) for tolerance1')).toBeNull();
  deny(true); fireEvent.click(screen.getByRole('button', { name: 'Refresh mechanical sources' })); await screen.findByText(/Declarations are hidden/);
  expect(screen.queryByLabelText('Basis for connector_envelopes envelope1')).toBeNull();
  deny(false); await refresh();
  expect((screen.getByLabelText('Basis for connector_envelopes envelope1') as HTMLTextAreaElement).value).toBe('No body-envelope usage in this declared scope');
  fireEvent.click(screen.getByRole('button', { name: 'Save mechanical draft' })); await screen.findByText('Retained uncertainty');
  const u = bodies[0].payload.mechanical_source.uncertainty;
  expect(u.tolerances[0]).toMatchObject({ status: 'unknown', lower_deviation: null, upper_deviation: null });
  expect(u.connector_envelopes[0]).toMatchObject({ status: 'not_applicable', minimum: null, maximum: null, frame: null });
  expect(bodies[0].expected_state).toBe('draft-v1');
});

test('read-only assessment shows exact declared scopes and missing prerequisites without manufacturing or fit approval', async () => {
  const detail = read();
  detail.evaluation.uncertainty_assessment = {
    kind: 'declared_prerequisites', coverage: 'explicit_scopes_only', readiness: 'missing_declared_inputs',
    assumptions: { materials: [{ local_id: 'polymer', target_local_id: null, status: 'declared', specification: 'Original hypothetical polymer', behavior: null, basis: 'Original experiment assumption' }],
      processes: [], tolerances: [{ local_id: 'width', target_local_id: 'hardware', model_local_id: null, dimension: 'opening width', units: 'mm', status: 'declared', lower_deviation: 0, upper_deviation: 0, basis: 'Declared synthetic zero' }], connector_envelopes: [] },
    geometry: [], prerequisites: [{ code: 'connector_scope', status: 'unknown', scope: { target_local_id: 'hardware', model_local_id: null }, assumption_local_id: null, message: 'Connector relevance and mating scope are unassessed; no coverage is inferred.' }],
    missing_prerequisites: [], fit: 'not_evaluated', clearance: 'not_evaluated', manufacturability: 'not_evaluated', physical_qualification: false,
  };
  setup({ permissions: ['workspace.read'], draft: detail }); await refresh();
  fireEvent.click(screen.getByRole('button', { name: 'Open draft' }));
  await screen.findByRole('heading', { name: 'Geometry and process prerequisites' });
  expect(screen.getByText(/Material polymer · mechanical item · declared · Original hypothetical polymer · behavior unknown/)).toBeTruthy();
  expect(screen.getByText(/deviation 0 to 0 mm · basis Declared synthetic zero/)).toBeTruthy();
  expect(screen.getByText(/hardware · Connector relevance and mating scope are unassessed/)).toBeTruthy();
  expect(screen.getByText(/Native geometry is not validated; fit, clearance and manufacturability are not evaluated/)).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Edit mechanical draft' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Freeze mechanical declarations' })).toBeNull();
});
