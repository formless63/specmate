import { MantineProvider } from '@mantine/core';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { CableTestIntentPanel, DraftEditor, PlanEditor, PlanInspector } from './CableTestIntentPanel';
import { initialPlan, type Draft, type TestPlan } from './api';

beforeEach(() => vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} }));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
function wrap(children: React.ReactNode) {
  return <MantineProvider><QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })}>{children}</QueryClientProvider></MantineProvider>;
}
const terminal = (endpoint_id: string, contact_id: string) => ({ endpoint_id, kind: 'contact' as const, contact_id, element_path: null });
const plan = (): TestPlan => ({ ...initialPlan(), root_revision_id: 'cable-r1', cable_revision_id: 'cable-r1' });
const target = { root_revision_id: 'cable-r1', root_snapshot_id: 'snapshot-1', root_sha256: 'root-hash', cable_revision_id: 'cable-r1', cable_sha256: 'cable-hash', occurrence_path: [], endpoints: [{ local_id: 'a', label: 'END-A' }, { local_id: 'b', label: null }], terminals: [{ terminal: terminal('a', '1'), label: 'CONTACT-A', physical_role: 'contact' }, { terminal: terminal('b', '2'), label: 'CONTACT-B', physical_role: 'contact' }] };
const response = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });
async function select(label: string, option: string) {
  const field = await screen.findByRole('combobox', { name: label });
  fireEvent.focus(field); fireEvent.keyDown(field, { key: 'ArrowDown' });
  fireEvent.click(await within(screen.getByRole('listbox', { name: label, hidden: true })).findByText(option));
}
function Harness({ onValue }: { onValue?: (v: TestPlan) => void }) {
  const [value, setValue] = useState(plan);
  return <PlanEditor value={value} onChange={v => { setValue(v); onValue?.(v); }} />;
}

test('authored terminal pairs preserve unknown intent and exact identifiers; labels do not identify copper', async () => {
  const values: TestPlan[] = [];
  const commands: object[] = [];
  vi.stubGlobal('fetch', vi.fn(async (_url: string, options: RequestInit) => { commands.push(JSON.parse(String(options.body))); return response({ result: target }); }));
  render(wrap(<Harness onValue={v => values.push(v)} />));
  await screen.findByLabelText('Pair stable ID');
  fireEvent.change(screen.getByLabelText('Pair stable ID'), { target: { value: 'expected' } });
  await select('First test terminal', 'a · contact · 1 · CONTACT-A');
  await select('Second test terminal', 'b · contact · 2 · CONTACT-B');
  fireEvent.change(screen.getByLabelText('Pair declaration basis'), { target: { value: 'Independent declaration' } });
  fireEvent.click(screen.getByRole('button', { name: 'Add expected pair' }));
  expect(values.at(-1)?.pairs[0]).toMatchObject({ first: terminal('a', '1'), second: terminal('b', '2'), intent: 'unknown', basis: 'Independent declaration', evidence: { status: 'unknown' } });
  fireEvent.change(screen.getByLabelText('Label stable ID'), { target: { value: 'marker' } });
  fireEvent.change(screen.getByLabelText('Label text'), { target: { value: 'Printed identity' } });
  fireEvent.change(screen.getByLabelText('Label declaration basis'), { target: { value: 'Declared text' } });
  fireEvent.click(screen.getByRole('button', { name: 'Add cable label' }));
  expect(values.at(-1)?.labels[0]).toMatchObject({ local_id: 'marker', text: 'Printed identity', evidence: { status: 'unknown' } });
  expect(commands[0]).toMatchObject({ operation: 'cable_test_plan.inspect_target', payload: { root_revision_id: 'cable-r1', cable_revision_id: 'cable-r1', occurrence_path: [] } });
  expect(commands[0]).not.toHaveProperty('idempotency_key');
}, 10_000);

test('target denial removes source-derived choices and recovers unsaved authoring fields', async () => {
  let denied = false;
  vi.stubGlobal('fetch', vi.fn(async () => denied ? response({ error: { message: 'Target unavailable' } }, 404) : response({ result: target })));
  render(wrap(<Harness />));
  fireEvent.change(await screen.findByLabelText('Pair stable ID'), { target: { value: 'unsaved-pair' } });
  fireEvent.change(screen.getByLabelText('Pair declaration basis'), { target: { value: 'Unsaved rationale' } });
  denied = true;
  fireEvent.click(screen.getByRole('button', { name: 'Refresh exact target access' }));
  await screen.findByText('Target unavailable');
  expect(screen.queryByRole('combobox', { name: 'First test terminal' })).toBeNull();
  expect(screen.queryByText(/root-hash/)).toBeNull();
  denied = false;
  fireEvent.click(screen.getByRole('button', { name: 'Refresh exact target access' }));
  expect((await screen.findByLabelText('Pair stable ID') as HTMLInputElement).value).toBe('unsaved-pair');
  expect((screen.getByLabelText('Pair declaration basis') as HTMLInputElement).value).toBe('Unsaved rationale');
});

test('draft refetch preserves independent original CAS baseline and unsaved label', async () => {
  const commands: { operation: string; expected_state: string; payload: { test_plan: TestPlan } }[] = [];
  const d: Draft = { definition_id: 'def', draft_id: 'draft', state: 'draft-v1', content: { test_plan: plan() } };
  vi.stubGlobal('fetch', vi.fn(async (_url: string, options: RequestInit) => {
    const cmd = JSON.parse(String(options.body));
    if (cmd.operation === 'cable_test_plan.inspect_target') return response({ result: target });
    commands.push(cmd); return response({ result: { ...d, state: 'draft-v3', content: { test_plan: cmd.payload.test_plan } } });
  }));
  const onSaved = vi.fn(async () => {});
  const onFrozen = vi.fn(async () => {});
  const cache = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const element = (draft: Draft, hidden = false) => <MantineProvider><QueryClientProvider client={cache}><DraftEditor draft={draft} hidden={hidden} onError={() => {}} onSaved={onSaved} onFrozen={onFrozen} /></QueryClientProvider></MantineProvider>;
  const rendered = render(element(d));
  fireEvent.change(await screen.findByLabelText('Label stable ID'), { target: { value: 'new-label' } });
  fireEvent.change(screen.getByLabelText('Label text'), { target: { value: 'Unsaved label' } });
  fireEvent.change(screen.getByLabelText('Label declaration basis'), { target: { value: 'Explicit label intent' } });
  rendered.rerender(element({ ...d, state: 'draft-v2' }, true));
  rendered.rerender(element({ ...d, state: 'draft-v2' }));
  expect((await screen.findByLabelText('Label text') as HTMLInputElement).value).toBe('Unsaved label');
  fireEvent.click(screen.getByRole('button', { name: 'Add cable label' }));
  fireEvent.click(screen.getByRole('button', { name: 'Save test-plan draft' }));
  await waitFor(() => expect(onSaved).toHaveBeenCalled());
  expect(commands[0]).toMatchObject({ operation: 'cable_test_plan.update', expected_state: 'draft-v1', payload: { test_plan: { labels: [{ text: 'Unsaved label' }] } } });
});

test('same frozen revision refresh clears retained intent, evidence and package link on denial', async () => {
  let denied = false;
  const inspected = { revision_id: 'plan-r1', sha256: 'plan-hash', test_plan: { ...plan(), pairs: [{ local_id: 'pair', first: terminal('a', '1'), second: terminal('b', '2'), intent: 'isolation', basis: 'Private expectation' }], labels: [] }, root_snapshot_id: 'scope-snapshot', root_sha256: 'scope-hash', cable_sha256: 'cable-hash', evidence: [{ kind: 'pair', local_id: 'pair', evidence: { status: 'registered_file', source_path: 'design/test.txt', sha256: 'source-hash', rights: 'declared-license' } }], physical_test: 'not_performed', physical_continuity: 'not_evaluated', physical_qualification: 'not_evaluated' };
  vi.stubGlobal('fetch', vi.fn(async () => denied ? response({ error: { message: 'Plan unavailable' } }, 404) : response(inspected)));
  render(wrap(<PlanInspector revisionId="plan-r1" />));
  await screen.findByText('Private expectation');
  expect(screen.getByRole('link', { name: 'Download portable expectation package' }).getAttribute('href')).toBe('/api/v0/cable-test-intent/revisions/plan-r1/package');
  denied = true;
  fireEvent.click(screen.getByRole('button', { name: 'Refresh frozen test-plan access' }));
  await screen.findByText('Plan unavailable');
  expect(screen.queryByText('Private expectation')).toBeNull();
  expect(screen.queryByText(/source-hash/)).toBeNull();
  expect(screen.queryByRole('link')).toBeNull();
  denied = false;
  fireEvent.click(screen.getByRole('button', { name: 'Refresh frozen test-plan access' }));
  await screen.findByText('Private expectation');
});

test('changing projects clears newly authored scope and label intent', async () => {
  vi.stubGlobal('fetch', vi.fn(async (_url: string, options?: RequestInit) => options?.method === 'POST' ? response({ result: target }) : response([])));
  const cache = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const element = (projectId: string) => <MantineProvider><QueryClientProvider client={cache}><CableTestIntentPanel projectId={projectId} /></QueryClientProvider></MantineProvider>;
  const view = render(element('one'));
  fireEvent.change(await screen.findByLabelText('Test-plan name'), { target: { value: 'Private draft' } });
  fireEvent.change(screen.getByLabelText('Exact cable revision ID'), { target: { value: 'cable-r1' } });
  fireEvent.change(screen.getByLabelText('Exact scope root revision ID'), { target: { value: 'cable-r1' } });
  await act(async () => { view.rerender(element('two')); });
  await waitFor(() => expect((screen.getByLabelText('Test-plan name') as HTMLInputElement).value).toBe(''));
  expect((screen.getByLabelText('Exact cable revision ID') as HTMLInputElement).value).toBe('');
});

test('pending save disables conflicting authoring and advances token only after acceptance', async () => {
  const d: Draft = { definition_id: 'def', draft_id: 'draft', state: 'draft-v1', content: { test_plan: plan() } };
  let accept!: (r: Response) => void;
  vi.stubGlobal('fetch', vi.fn(async (_url: string, options: RequestInit) => {
    const cmd = JSON.parse(String(options.body));
    if (cmd.operation === 'cable_test_plan.inspect_target') return response({ result: target });
    return new Promise<Response>(resolve => { accept = resolve; });
  }));
  render(wrap(<DraftEditor draft={d} onError={() => {}} onSaved={async () => {}} onFrozen={async () => {}} />));
  await screen.findByLabelText('Pair stable ID');
  fireEvent.click(screen.getByRole('button', { name: 'Save test-plan draft' }));
  await waitFor(() => expect((screen.getByLabelText('Pair stable ID') as HTMLInputElement).disabled).toBe(true));
  expect((screen.getByRole('button', { name: 'Freeze saved test plan' }) as HTMLButtonElement).disabled).toBe(true);
  await act(async () => accept(response({ result: { ...d, state: 'draft-v2' } })));
  await screen.findByText('draft-v2');
  expect((screen.getByLabelText('Pair stable ID') as HTMLInputElement).disabled).toBe(false);
});

test('a pending create from a replaced project cannot reopen a draft after switching away and back', async () => {
  let accept!: (r: Response) => void;
  vi.stubGlobal('fetch', vi.fn(async (_url: string, options?: RequestInit) => {
    if (options?.method !== 'POST') return response([]);
    const cmd = JSON.parse(String(options.body));
    if (cmd.operation === 'cable_test_plan.inspect_target') return response({ result: target });
    return new Promise<Response>(resolve => { accept = resolve; });
  }));
  const cache = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const element = (projectId: string) => <MantineProvider><QueryClientProvider client={cache}><CableTestIntentPanel projectId={projectId} /></QueryClientProvider></MantineProvider>;
  const view = render(element('one'));
  fireEvent.change(await screen.findByLabelText('Test-plan name'), { target: { value: 'Original project plan' } });
  fireEvent.change(screen.getByLabelText('Exact cable revision ID'), { target: { value: 'cable-r1' } });
  fireEvent.change(screen.getByLabelText('Exact scope root revision ID'), { target: { value: 'cable-r1' } });
  await waitFor(() => expect((screen.getByRole('button', { name: 'Create test-plan draft' }) as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(screen.getByRole('button', { name: 'Create test-plan draft' }));
  await waitFor(() => expect(accept).toBeDefined());
  await act(async () => view.rerender(element('two')));
  await act(async () => view.rerender(element('one')));
  await act(async () => accept(response({ result: { definition_id: 'stale-definition', draft_id: 'stale-draft', state: 'draft-v1', content: { test_plan: plan() } } })));
  expect(screen.queryByText('Edit test-plan draft')).toBeNull();
  expect((screen.getByLabelText('Test-plan name') as HTMLInputElement).value).toBe('');
});

test('a detached target denial still hides same-editor retained expectations until an explicit refresh', async () => {
  let rejectOld!: (r: Response) => void;
  let oldCalls = 0;
  vi.stubGlobal('fetch', vi.fn(async (_url: string, options: RequestInit) => {
    const cmd = JSON.parse(String(options.body));
    if (cmd.payload.root_revision_id === 'cable-r1') {
      oldCalls += 1;
      if (oldCalls === 2) return new Promise<Response>(resolve => { rejectOld = resolve; });
    }
    return response({ result: target });
  }));
  render(wrap(<Harness />));
  fireEvent.change(await screen.findByLabelText('Pair stable ID'), { target: { value: 'retained-unsaved' } });
  fireEvent.click(screen.getByRole('button', { name: 'Refresh exact target access' }));
  await waitFor(() => expect(rejectOld).toBeDefined());
  fireEvent.change(screen.getByLabelText('Exact scope root revision ID'), { target: { value: 'replacement-root' } });
  await screen.findByLabelText('Pair stable ID');
  await act(async () => rejectOld(response({ error: { message: 'Previous scope revoked' } }, 404)));
  await screen.findByText('Target access must be explicitly rechecked before retained expectations can be shown.');
  expect(screen.queryByRole('combobox', { name: 'First test terminal' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Refresh exact target access' }));
  expect((await screen.findByLabelText('Pair stable ID') as HTMLInputElement).value).toBe('retained-unsaved');
});

test('detached frozen-plan denial hides the same plan after a newer refresh succeeds', async () => {
  let rejectOld!: (r: Response) => void;
  let calls = 0;
  const inspection = { revision_id: 'same-plan', sha256: 'private-plan-hash', root_sha256: 'root', root_snapshot_id: 'snapshot', cable_sha256: 'cable', test_plan: plan(), evidence: [], physical_test: 'not_performed', physical_continuity: 'not_evaluated', physical_qualification: 'not_evaluated' };
  vi.stubGlobal('fetch', vi.fn(async () => {
    calls += 1;
    if (calls === 2) return new Promise<Response>(resolve => { rejectOld = resolve; });
    return response(inspection);
  }));
  const cache = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const element = (refresh: number) => <MantineProvider><QueryClientProvider client={cache}><PlanInspector revisionId="same-plan" refresh={refresh} /></QueryClientProvider></MantineProvider>;
  const view = render(element(0));
  await screen.findByText(/private-plan-hash/);
  fireEvent.click(screen.getByRole('button', { name: 'Refresh frozen test-plan access' }));
  await waitFor(() => expect(rejectOld).toBeDefined());
  await act(async () => view.rerender(element(1)));
  await screen.findByText(/private-plan-hash/);
  await act(async () => rejectOld(response({ error: { message: 'Frozen authority revoked' } }, 404)));
  await screen.findByText('Frozen test-plan access must be explicitly rechecked.');
  expect(screen.queryByText(/private-plan-hash/)).toBeNull();
  expect(screen.queryByRole('link')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Refresh frozen test-plan access' }));
  await screen.findByText(/private-plan-hash/);
});
