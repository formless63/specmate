import { MantineProvider } from '@mantine/core';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { AssemblyInspector, AssemblyPanel } from './AssemblyPanel';
import type { Assembly } from './api';

beforeEach(() => vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} }));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
function fixture() {
  const assembly: Assembly = { occurrences: [{ local_id: 'board', revision_id: 'exact-board', display_ref: 'A1', placement: { status: 'known', translation: [1, 2, 3], rotation_xyzw: [0, 0, 1, 0] } }], relationships: [] };
  const state = { version: 'draft-v1', deny: false, lose: false, assembly, calls: [] as { operation: string; expected_state?: string; idempotency_key?: string; payload: { assembly: Assembly } }[] };
  const outcomes = new Map<string, unknown>();
  vi.stubGlobal('fetch', vi.fn(async (url: string, options?: RequestInit) => {
    const draft = { definition_id: 'assembly', draft_id: 'draft', state: state.version, content: { assembly: state.assembly } };
    let body: unknown;
    if (options?.method === 'POST') {
      const cmd = JSON.parse(String(options.body));
      if (cmd.operation === 'assembly.placement_inputs') body = { result: { draft_id: 'draft', state: state.version, occurrences: [{ path: ['board'], revision_id: 'exact-board', snapshot_sha256: 'board-hash', name: 'Synthetic board', kind: 'board', display_ref: 'A1', placement: assembly.occurrences[0]?.placement }], relationships: [] } };
      else {
        state.calls.push(cmd);
        if (outcomes.has(cmd.idempotency_key)) body = outcomes.get(cmd.idempotency_key);
        else {
          if (cmd.expected_state !== state.version) return new Response(JSON.stringify({ error: { message: 'Assembly draft changed' } }), { status: 409 });
          state.assembly = cmd.payload.assembly; state.version = `draft-v${Number(state.version.slice(7)) + 1}`;
          body = { result: { ...draft, state: state.version, content: { assembly: state.assembly } } }; outcomes.set(cmd.idempotency_key, body);
          if (state.lose) { state.lose = false; throw new Error('Save response unavailable'); }
        }
      }
    } else if (url.includes('assemblies/drafts/')) {
      if (state.deny) return new Response(JSON.stringify({ error: { message: 'Current model source unavailable' } }), { status: 404 });
      body = draft;
    } else if (url.includes('catalog/definitions/')) body = { definition_id: 'assembly', name: 'Mounting workshop', drafts: [{ draft_id: 'draft', state: state.version }], revisions: [] };
    else body = [{ definition_id: 'assembly', name: 'Mounting workshop', kind: 'assembly' }];
    return new Response(JSON.stringify(body), { status: 200 });
  }));
  return state;
}
function panel(permissions = ['design.edit', 'design.freeze']) {
  return <MantineProvider env="test"><QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><AssemblyPanel projectId="project" permissions={permissions} /></QueryClientProvider></MantineProvider>;
}
async function choose(label: string, value: string) {
  const input = screen.getByRole('combobox', { name: label }); fireEvent.click(input); fireEvent.keyDown(input, { key: 'ArrowDown' });
  fireEvent.click(await screen.findByText(value, { exact: true }));
}
async function open() { await screen.findByRole('combobox', { name: 'Assembly definition' }); await choose('Assembly definition', 'Mounting workshop'); await screen.findByRole('combobox', { name: 'Assembly draft' }); await choose('Assembly draft', 'draft · draft-v1'); await screen.findByLabelText('board X (mm)'); }

test('focus refresh preserves staged quaternion/translation and original CAS token', async () => {
  const state = fixture(); render(panel()); await open();
  fireEvent.change(screen.getByLabelText('board X (mm)'), { target: { value: '25' } });
  state.version = 'draft-v2'; fireEvent(window, new Event('focus'));
  await screen.findByText(/A newer assembly draft is available/);
  expect((screen.getByLabelText('board X (mm)') as HTMLInputElement).value).toBe('25');
  fireEvent.click(screen.getByRole('button', { name: 'Save board' }));
  await waitFor(() => expect(state.calls).toHaveLength(1));
  expect(state.calls[0]?.expected_state).toBe('draft-v1');
  expect(state.calls[0]?.payload.assembly.occurrences[0]?.placement?.rotation_xyzw).toEqual([0, 0, 1, 0]);
});

test('response-loss retry preserves reviewed exact payload, old token and key', async () => {
  const state = fixture(); state.lose = true; render(panel()); await open();
  fireEvent.change(screen.getByLabelText('board X (mm)'), { target: { value: '40' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save board' })); await screen.findByText('Save response unavailable');
  fireEvent.click(screen.getByRole('button', { name: 'Save board' }));
  await waitFor(() => expect(state.calls).toHaveLength(2));
  expect(state.calls[0]?.payload).toEqual(state.calls[1]?.payload);
  expect(state.calls[0]?.idempotency_key).toBe(state.calls[1]?.idempotency_key);
  expect(state.calls[1]?.expected_state).toBe('draft-v1');
});

test('current source denial discards unsaved placements and retained mounting choices', async () => {
  const state = fixture(); render(panel()); await open();
  fireEvent.change(screen.getByLabelText('board X (mm)'), { target: { value: '999' } });
  state.deny = true; fireEvent(window, new Event('focus'));
  await screen.findByText('Current model source unavailable');
  expect(screen.queryByLabelText('board X (mm)')).toBeNull();
  expect(screen.queryByText('Canonical mounting declarations')).toBeNull();
  expect(screen.queryByRole('button', { name: 'Freeze assembly revision' })).toBeNull();
});

test('read-only users inspect draft declarations without mutation or transform controls', async () => {
  fixture(); render(panel([])); await screen.findByRole('combobox', { name: 'Assembly definition' }); await choose('Assembly definition', 'Mounting workshop'); await screen.findByRole('combobox', { name: 'Assembly draft' }); await choose('Assembly draft', 'draft · draft-v1');
  await screen.findByText('Read-only assembly draft draft · draft-v1');
  expect(screen.queryByRole('button', { name: 'Create assembly draft' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Freeze assembly revision' })).toBeNull();
  expect(screen.queryByLabelText('Known placement for board')).toBeNull();
});

test('denied frozen refresh cannot retain private canonical placement or mounting details', async () => {
  let denied = false;
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(denied ? { error: { message: 'Frozen source access denied' } } : { snapshot_id: 'snapshot', sha256: 'hash', occurrences: [{ address: { snapshot_id: 'snapshot', path: ['board'] }, name: 'Private board', display_ref: 'A1', revision_id: 'private-revision', snapshot_sha256: 'private-hash', placement: { status: 'known', translation: [50, 0, 0], rotation_xyzw: [0, 0, 1, 0] }, assignments: {} }], relationships: [] }), { status: denied ? 404 : 200 })));
  render(<MantineProvider env="test"><QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><AssemblyInspector snapshotId="snapshot" /></QueryClientProvider></MantineProvider>);
  fireEvent.click(await screen.findByRole('button', { name: 'board · A1' }));
  expect(screen.getByText('Canonical rotation quaternion (X, Y, Z, W): 0, 0, 1, 0')).toBeTruthy();
  denied = true; fireEvent.click(screen.getByRole('button', { name: 'Refresh canonical assembly inspection' }));
  await screen.findByText('Frozen source access denied');
  expect(screen.queryByText('Exact revision: private-revision')).toBeNull();
  expect(screen.queryByText('Canonical placement: 50, 0, 0 mm')).toBeNull();
});

test('saving one occurrence preserves an independently staged sibling transform', async () => {
  const state = fixture(); const original = state.assembly.occurrences[0]!;
  state.assembly = { ...state.assembly, occurrences: [{ ...original, local_id: 'left' }, { ...original, local_id: 'right' }] };
  render(panel()); await screen.findByRole('combobox', { name: 'Assembly definition' }); await choose('Assembly definition', 'Mounting workshop'); await screen.findByRole('combobox', { name: 'Assembly draft' }); await choose('Assembly draft', 'draft · draft-v1'); await screen.findByLabelText('right X (mm)');
  fireEvent.change(screen.getByLabelText('right X (mm)'), { target: { value: '90' } });
  fireEvent.change(screen.getByLabelText('left X (mm)'), { target: { value: '10' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save left' }));
  await waitFor(() => expect(state.version).toBe('draft-v2'));
  expect((screen.getByLabelText('right X (mm)') as HTMLInputElement).value).toBe('90');
  expect(state.assembly.occurrences[1]?.placement?.translation?.[0]).toBe(1);
  await waitFor(() => expect((screen.getByRole('button', { name: 'Save right' }) as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(screen.getByRole('button', { name: 'Save right' }));
  await waitFor(() => expect(state.calls).toHaveLength(2));
  expect(state.calls[1]?.expected_state).toBe('draft-v2');
  expect(state.calls[1]?.payload.assembly.occurrences[0]?.placement?.translation?.[0]).toBe(10);
  expect(state.calls[1]?.payload.assembly.occurrences[1]?.placement?.translation?.[0]).toBe(90);
});
