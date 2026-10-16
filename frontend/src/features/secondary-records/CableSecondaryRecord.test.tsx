import { MantineProvider } from '@mantine/core';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory } from '@tanstack/react-router';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { PermissionsProvider } from '../../lib/permissions';
import { record as libraryRecord, reply, workspaceServer } from '../../test/workspaceServer';
import { initialPlan, type TestPlan } from '../cable-test-intent/api';
import { emptyIntent } from '../intents/api';
import { NavigationProvider, useNavigation } from '../navigation';
import { ProbeProvider } from '../probe';
import type { Content } from '../parts/api';
import { App } from '../../App';
import { CableSecondaryRecord } from './CableSecondaryRecord';

type Kind = 'cable_intent' | 'cable_test_plan';
const plan = (): TestPlan => ({ ...initialPlan(), root_revision_id: 'root-r1', cable_revision_id: 'cable-r1', occurrence_path: ['child'], labels: [{ local_id: 'saved', text: 'Saved label', basis: 'Authored', evidence: { status: 'unknown' } }] });
const intent = () => ({ ...emptyIntent(), from_revision_id: 'from-r1', to_revision_id: 'to-r1', description: 'Saved requirements' });
const end = { kind: 'port', rows: [{ contact_id: '1', number: '1', label: '1', physical_role: 'contact', status: 'declared', signal: null }], role: 'unknown', body_revision_id: 'body-r1', pinout_revision_id: 'pinout-r1', device_label: 'Synthetic device', variant_label: 'Variant', selected_conditions: {} };
const target = { root_revision_id: 'root-r1', root_snapshot_id: 'root-snapshot', root_sha256: 'root-hash', cable_revision_id: 'cable-r1', cable_sha256: 'cable-hash', occurrence_path: ['child'], endpoints: [{ local_id: 'a', label: 'End A' }], terminals: [] };
beforeEach(() => { vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} }); Element.prototype.scrollIntoView = vi.fn(); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
function server(kind: Kind) {
  let denied = false, domainDenied = false, conflict = false, multiple = false, wrongKind = false, state = 'draft-v1', hold = false;
  let release: ((response: Response) => void) | null = null;
  let content: Content = kind === 'cable_intent' ? { interface: intent() } : { test_plan: plan() };
  const reads: string[] = [], writes: { operation: string; expected_state: string; payload: { changes: Content }; idempotency_key: string }[] = [];
  const draft = () => ({ kind: 'draft', draft_id: 'working', definition_id: 'secondary', state, base_revision_id: 'secondary-r1', content });
  vi.stubGlobal('fetch', vi.fn(async (path: string, options?: RequestInit) => {
    if (path.includes('/catalog/revision-labels?')) return reply({ labels: [], source_labels: [] });
    if (path.includes('/record?')) {
      reads.push(path); if (denied) return reply({ error: { message: 'Record access withdrawn' } }, 403);
      const params = new URL(path, 'http://test').searchParams;
      if (params.get('revision_number') === '999') return reply({ error: { message: 'Requested exact revision unavailable' } }, 404);
      const working = params.has('working') || params.has('draft_id');
      if (working && multiple && !params.has('draft_id')) return reply({ error: { message: 'Choose an explicit working draft.' } }, 422);
      return reply({ definition_id: 'secondary', workspace_id: 'w1', kind: wrongKind ? 'part' : kind, name: 'Synthetic secondary', selected: working ? draft() : { kind: 'revision', revision_id: `secondary-r${params.get('revision_number') ?? '75'}`, number: Number(params.get('revision_number') ?? 75), snapshot_id: 'snapshot', sha256: 'hash', content } });
    }
    if (path.endsWith('/operations')) {
      const command = JSON.parse(String(options?.body));
      if (command.operation === 'cable_test_plan.inspect_target') return domainDenied ? reply({ error: { message: 'Current target source denied' } }, 403) : reply({ result: target });
      writes.push(command);
      if (hold) return new Promise<Response>(resolve => { release = resolve; });
      if (conflict) return reply({ error: { message: 'Original draft token conflicts' } }, 409);
      if (command.operation === 'draft.update') { content = command.payload.changes; state = 'draft-v2'; return reply({ result: draft() }); }
      state = 'draft-v3'; return reply({ result: { number: 76, revision_id: 'secondary-r76', draft: draft() } });
    }
    if (path.includes('/end')) return reply(end);
    if (path.includes('/interfaces/revisions/')) return reply({ revision_id: 'secondary-r75', interface: intent(), intent: { from: { name: 'From', revision_number: 1, kind: 'port' }, to: { name: 'To', revision_number: 1, kind: 'port' }, check: { reason: 'Not evaluated' } } });
    if (path.includes('/cable-test-intent/revisions/')) return reply({ revision_id: 'secondary-r75', sha256: 'plan-hash', root_sha256: 'root-hash', root_snapshot_id: 'root-snapshot', cable_sha256: 'cable-hash', test_plan: plan(), evidence: [], physical_test: 'not_performed', physical_continuity: 'not_evaluated', physical_qualification: 'not_evaluated' });
    return reply({});
  }));
  return { reads, writes, wrongKind: () => { wrongKind = true; }, deny: (value: boolean) => { denied = value; }, domainDeny: (value: boolean) => { domainDenied = value; }, conflict: (value: boolean) => { conflict = value; }, multiple: () => { multiple = true; }, questions: () => { content = { interface: { ...intent(), rows: [{ row_id: 'q', requirement: 'required', from_contact_id: '1', to_contact_ids: [], signal_ref: null, pairing: 'declared', return_policy: 'unknown', conductor: { kind: 'unknown', impedance_ohm: null, basis: null }, required_parts: [], question: { kind: 'name_and_type_only', text: 'Choose the declared destination', options: [{ contact_id: '1', label: 'Use declared contact 1' }] }, basis: null }] } }; }, advance: () => { state = 'draft-v9'; }, hold: () => { hold = true; }, held: () => release, release: () => release?.(reply({ result: draft() })) };
}
function mount(kind: Kind, revision = '@75', permissions = ['workspace.read', 'design.edit', 'design.freeze', 'item.create']) {
  const exact = revision.startsWith('@') ? revision : '';
  const params = new URLSearchParams(kind === 'cable_test_plan' ? { tool: 'cable-test-intent' } : {}); if (revision.startsWith('?')) params.set('status', 'draft');
  const path = `${kind === 'cable_intent' ? '/designs/recipes' : '/designs'}/secondary${exact}/~/occurrence${params.size ? `?${params}` : ''}`;
  const history = createMemoryHistory({ initialEntries: [path] }), cache = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  function Routed({ active, principalKey }: { active: boolean; principalKey: string }) {
    const nav = useNavigation()!;
    return <ProbeProvider probe={nav.location.probe} onProbe={probe => nav.navigate({ probe })}><CableSecondaryRecord kind={kind} active={active} workspaceId="w1" principalKey={principalKey} record={libraryRecord('secondary', 'Synthetic secondary', { kind, latest_revision: 75 })} /></ProbeProvider>;
  }
  const tree = (active = true, principalKey = 'owner') => <MantineProvider env="test"><QueryClientProvider client={cache}><PermissionsProvider permissions={permissions}><NavigationProvider history={history}><Routed active={active} principalKey={principalKey} /></NavigationProvider></PermissionsProvider></QueryClientProvider></MantineProvider>;
  const view = render(tree()); return { history, rerender: (active = true, principalKey = 'owner') => view.rerender(tree(active, principalKey)) };
}
async function saveDraft() { const button = await screen.findByRole('button', { name: 'Save draft' }); await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false)); fireEvent.click(button); }
test.each(['cable_intent', 'cable_test_plan'] as const)('%s exact secondary record opens its own older revision and preserves occurrence path on draft navigation', async kind => {
  const api = server(kind), { history } = mount(kind);
  await screen.findByRole('button', { name: 'Continue draft' });
  expect(api.reads[0]).toContain('/catalog/definitions/secondary/record?revision_number=75');
  expect(screen.queryByRole('combobox', { name: /definition|Frozen revision|Test-plan draft/ })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Continue draft' }));
  await screen.findByRole('button', { name: 'Save draft' });
  expect(history.location.pathname).toContain('/~/occurrence'); expect(history.location.search).toContain('status=draft');
  expect(api.reads.some(path => path.includes('working=true'))).toBe(true); expect(api.writes).toHaveLength(0);
});
test('partial test-plan authoring and saved-buffer edits survive hide, source denial and newer-state recovery with original CAS', async () => {
  const api = server('cable_test_plan'), view = mount('cable_test_plan', '?status=draft');
  fireEvent.change(await screen.findByLabelText('Pair stable ID'), { target: { value: 'Private partial pair' } });
  fireEvent.change(screen.getByLabelText('Label stable ID'), { target: { value: 'new-label' } });
  fireEvent.change(screen.getByLabelText('Label text'), { target: { value: 'Private added label' } });
  fireEvent.change(screen.getByLabelText('Label declaration basis'), { target: { value: 'Human declaration' } });
  fireEvent.click(screen.getByRole('button', { name: 'Add cable label' }));
  await screen.findByText('Private added label'); view.rerender(false); api.domainDeny(true); view.rerender();
  await screen.findByText('Current target source denied'); expect(screen.queryByDisplayValue('Private partial pair')).toBeNull(); expect(screen.queryByText('Private added label')).toBeNull();
  api.domainDeny(false); api.advance(); fireEvent.click(screen.getByRole('button', { name: 'Refresh access' }));
  expect((await screen.findByLabelText('Pair stable ID') as HTMLInputElement).value).toBe('Private partial pair'); await screen.findByText('Private added label');
  api.conflict(true); await saveDraft(); await screen.findByText('Original draft token conflicts');
  expect(api.writes[0]).toMatchObject({ operation: 'draft.update', expected_state: 'draft-v1', payload: { changes: { test_plan: { labels: [expect.anything(), { local_id: 'new-label', text: 'Private added label' }] } } } });
  expect((screen.getByLabelText('Pair stable ID') as HTMLInputElement).value).toBe('Private partial pair');
});
test('save then domain freeze uses returned token and exact plan revision without substituting its cable', async () => {
  const api = server('cable_test_plan'), { history } = mount('cable_test_plan', '?status=draft');
  fireEvent.change(await screen.findByLabelText('Label stable ID'), { target: { value: 'new' } }); fireEvent.change(screen.getByLabelText('Label text'), { target: { value: 'New label' } });
  fireEvent.change(screen.getByLabelText('Label declaration basis'), { target: { value: 'Human basis' } }); fireEvent.click(screen.getByRole('button', { name: 'Add cable label' }));
  await saveDraft(); await waitFor(() => expect((screen.getByRole('button', { name: 'Freeze saved draft' }) as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(screen.getByRole('button', { name: 'Freeze saved draft' })); await waitFor(() => expect(history.location.pathname).toContain('secondary@76/~/occurrence'));
  expect(api.writes.map(row => [row.operation, row.expected_state])).toEqual([['draft.update', 'draft-v1'], ['cable_test_plan.freeze', 'draft-v2']]);
});
test('multiple drafts require explicit choice; an unavailable exact revision never falls forward', async () => {
  const api = server('cable_test_plan'); api.multiple(); mount('cable_test_plan', '?status=draft');
  await screen.findAllByText('Choose an explicit working draft.'); expect(screen.queryByLabelText('Pair stable ID')).toBeNull();
  fireEvent.change(screen.getByLabelText('Explicit working draft ID'), { target: { value: 'working' } }); fireEvent.click(screen.getByRole('button', { name: 'Open chosen draft' }));
  await screen.findByLabelText('Pair stable ID'); expect(api.reads.at(-1)).toContain('draft_id=working');
});
test('viewer exact plan has a package link and no enabled edit action', async () => {
  const api = server('cable_test_plan'); mount('cable_test_plan', '@75', ['workspace.read']);
  expect(await screen.findByRole('link', { name: 'Download portable expectation package' })).toBeTruthy();
  const edit = screen.queryByRole('button', { name: 'Continue draft' }); expect(!edit || (edit as HTMLButtonElement).disabled).toBe(true);
  expect(screen.queryByRole('button', { name: 'Save draft' })).toBeNull(); expect(api.writes).toHaveLength(0);
});
test('a held save cannot populate or navigate a replacement principal', async () => {
  const api = server('cable_test_plan'), view = mount('cable_test_plan', '?status=draft');
  fireEvent.change(await screen.findByLabelText('Label stable ID'), { target: { value: 'new' } }); fireEvent.change(screen.getByLabelText('Label text'), { target: { value: 'Private held label' } }); fireEvent.change(screen.getByLabelText('Label declaration basis'), { target: { value: 'Human basis' } }); fireEvent.click(screen.getByRole('button', { name: 'Add cable label' }));
  api.hold(); await saveDraft(); await waitFor(() => expect(api.held()).not.toBeNull());
  expect((screen.getByLabelText('Label text') as HTMLInputElement).disabled).toBe(true);
  view.rerender(true, 'replacement'); await screen.findByLabelText('Pair stable ID'); await act(async () => api.release());
  expect(screen.queryByText('Private held label')).toBeNull(); expect(view.history.location.pathname).not.toContain('@76');
});

test('Recipe questions and local answers gate domain Freeze until the reviewed draft is saved', async () => {
  const api = server('cable_intent'); api.questions(); mount('cable_intent', '?status=draft');
  const frozen = await screen.findByRole('button', { name: 'Freeze saved draft' }); expect((frozen as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(await screen.findByRole('button', { name: 'Use declared contact 1' }));
  const save = await screen.findByRole('button', { name: 'Save draft' }); await waitFor(() => expect((save as HTMLButtonElement).disabled).toBe(false));
  expect((screen.getByRole('button', { name: 'Freeze saved draft' }) as HTMLButtonElement).disabled).toBe(true);
  await saveDraft(); await waitFor(() => expect((screen.getByRole('button', { name: 'Freeze saved draft' }) as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(screen.getByRole('button', { name: 'Freeze saved draft' }));
  await waitFor(() => expect(api.writes).toHaveLength(2));
  expect(api.writes[0]).toMatchObject({ operation: 'draft.update', expected_state: 'draft-v1', payload: { changes: { interface: { rows: [{ question: null, to_contact_ids: ['1'], pairing: 'answered' }] } } } });
  expect(api.writes[1]).toMatchObject({ operation: 'interface.freeze', expected_state: 'draft-v2' });
});
test.each(['cable_intent', 'cable_test_plan'] as const)('%s unavailable exact revision never substitutes latest frozen or draft', async kind => {
  const api = server(kind); mount(kind, '@999'); await screen.findByText('Requested exact revision unavailable');
  expect(api.reads.every(path => path.includes('revision_number=999'))).toBe(true);
  expect(screen.queryByRole('button', { name: 'Continue draft' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Save draft' })).toBeNull(); expect(api.writes).toHaveLength(0);
});
test('exact Back/Forward inspection retains incomplete working form input independently of the frozen plan', async () => {
  server('cable_test_plan'); const view = mount('cable_test_plan', '?status=draft');
  fireEvent.change(await screen.findByRole('textbox', { name: 'Pair stable ID' }), { target: { value: 'Partial unsaved pair' } });
  await act(async () => view.history.push('/designs/secondary@74/~/occurrence?tool=cable-test-intent'));
  await screen.findByRole('button', { name: 'Continue draft' }); expect(screen.queryByRole('textbox', { name: 'Pair stable ID' })).toBeNull();
  await act(async () => view.history.back());
  expect((await screen.findByRole('textbox', { name: 'Pair stable ID' }) as HTMLInputElement).value).toBe('Partial unsaved pair');
  await act(async () => view.history.forward()); await screen.findByRole('button', { name: 'Continue draft' });
  expect(view.history.location.pathname).toContain('secondary@74/~/occurrence');
});

test.each(['cable_intent', 'cable_test_plan'] as const)('App routes %s exact IDs to the compact host once, retaining the older revision and path', async kind => {
  const api = server(kind), domain = globalThis.fetch;
  workspaceServer({ projects: [] }, path => {
    if (path === '/api/v0/workspace/library/secondary') return reply(libraryRecord('secondary', 'Synthetic secondary', { kind, latest_revision: 80 }));
    return undefined;
  });
  const workspace = globalThis.fetch;
  vi.stubGlobal('fetch', (path: string, init?: RequestInit) => path.includes('/record?') || path.includes('/revision-labels?') || path.includes('/interfaces/revisions/') || path.includes('/cable-test-intent/revisions/') || path === '/api/v0/operations' && JSON.parse(String(init?.body)).operation === 'cable_test_plan.inspect_target' ? domain(path, init) : workspace(path, init));
  window.history.replaceState(null, '', kind === 'cable_intent' ? '/designs/recipes/secondary@75/~/occurrence' : '/designs/secondary@75/~/occurrence?tool=cable-test-intent');
  render(<MantineProvider env="test"><QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><App /></QueryClientProvider></MantineProvider>);
  await screen.findByRole('heading', { name: 'Synthetic secondary' });
  expect(screen.getAllByRole('heading', { name: 'Synthetic secondary' })).toHaveLength(1);
  expect(screen.queryByRole('region', { name: 'Selection' })).toBeNull();
  expect(window.location.pathname).toContain('@75/~/occurrence');
  expect(api.reads.some(path => path.includes('revision_number=75'))).toBe(true);
  expect(api.reads.some(path => path.includes('revision_number=80'))).toBe(false);
  expect(api.writes).toHaveLength(0);
});

test('a changed returned kind withdraws retained secondary content instead of using an initial fallback', async () => {
  const api = server('cable_test_plan'); mount('cable_test_plan', '?status=draft');
  fireEvent.change(await screen.findByRole('textbox', { name: 'Pair stable ID' }), { target: { value: 'Retained partial' } });
  api.wrongKind(); fireEvent.click(screen.getByRole('button', { name: 'Refresh access' }));
  await screen.findByText('The selected record is unavailable.');
  expect(screen.queryByRole('textbox', { name: 'Pair stable ID' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Save draft' })).toBeNull(); expect(api.writes).toHaveLength(0);
});

test.each([
  ['cable_intent', '/designs/recipes?status=new', 'Recipe name'],
  ['cable_test_plan', '/designs?tool=cable-test-intent&status=new', 'Test plan name'],
] as const)('App opens deliberate New %s as a local form without engineering writes', async (_kind, path, label) => {
  const api = workspaceServer({ projects: [] }); window.history.replaceState(null, '', path);
  render(<MantineProvider env="test"><QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><App /></QueryClientProvider></MantineProvider>);
  const name = await screen.findByRole('textbox', { name: label }); fireEvent.change(name, { target: { value: 'Prepared local secondary' } });
  expect(window.location.search).toContain('status=new');
  expect((screen.getByRole('button', { name: 'Save draft' }) as HTMLButtonElement).disabled).toBe(true);
  expect(api.state.operations.filter(row => !['library.home', 'library.previews'].includes(row.operation))).toHaveLength(0);
});
