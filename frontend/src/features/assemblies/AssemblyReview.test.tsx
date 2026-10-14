import { PermissionsProvider } from "../../lib/permissions";
import { MantineProvider } from '@mantine/core';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { StrictMode } from 'react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { AssemblyPanel } from './AssemblyPanel';
import type { Assembly } from './api';

beforeEach(() => { vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} }); Element.prototype.scrollIntoView = vi.fn(); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
function fixture(strict = false) {
  const assembly: Assembly = { occurrences: [{ local_id: 'board', revision_id: 'board-rev', display_ref: 'A1', placement: { status: 'known', translation: [1, 2, 3], rotation_xyzw: [0, 0, 1, 0] } }], relationships: [] };
  const state = { assembly, denyRetained: false, delayDraft: false, pendingDraft: null as null | ((value: Response) => void), deny: false, version: 'draft-v1', calls: [] as any[], pending: null as null | ((value: Response) => void), delaySave: false, loseFreeze: false, delayChoices: false, pendingChoices: null as null | ((value: Response) => void) };
  const outcomes = new Map<string, unknown>();
  const snapshot = { snapshot_id: 'snapshot', sha256: 'hash', occurrences: [], relationships: [] };
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const draftId = url.includes('draft-b') ? 'draft-b' : 'draft-a';
    const draft = { definition_id: 'assembly', draft_id: draftId, state: state.version, content: { assembly: state.assembly } };
    if (init?.method === 'POST') {
      const envelope = JSON.parse(String(init.body));
      if (envelope.operation === 'assembly.placement_inputs') {
        if (state.delayChoices) return new Promise<Response>(resolve => { state.pendingChoices = resolve; });
        return state.deny ? reply({ error: { message: 'Referenced model access denied' } }, 404) : reply({ result: { ...draft, state: state.version, occurrences: [{ path: ['board'], display_ref: 'A1', name: 'Source-derived private label', kind: 'board', revision_id: 'board-rev', snapshot_sha256: 'private-model-hash', placement: assembly.occurrences[0]!.placement }], relationships: [] } });
      }
      state.calls.push(envelope);
      if (state.delaySave) return new Promise<Response>(resolve => { state.pending = resolve; });
      if (outcomes.has(envelope.idempotency_key)) return reply(outcomes.get(envelope.idempotency_key));
      if (envelope.expected_state !== state.version) return reply({ error: { message: 'Original state conflicts' } }, 409);
      if (envelope.operation === 'assembly.freeze') {
        state.version = `draft-v${Number(state.version.slice(7)) + 1}`;
        const result = { result: { ...snapshot, draft: { ...draft, state: state.version } } };
        outcomes.set(envelope.idempotency_key, result);
        if (state.loseFreeze) { state.loseFreeze = false; throw new Error('Freeze response unavailable'); }
        return reply(result);
      }
      return reply({ result: { ...draft, ...snapshot } });
    }
    if (url.includes('catalog/definitions/')) return state.deny ? reply({ error: { message: 'Referenced model access denied' } }, 404) : reply({ definition_id: 'assembly', drafts: [{ draft_id: 'draft-a', state: state.version }, { draft_id: 'draft-b', state: state.version }], revisions: [] });
    if (url.includes('assemblies/drafts/')) {
      if (state.delayDraft) return new Promise<Response>(resolve => { state.pendingDraft = resolve; });
      return state.deny ? reply({ error: { message: 'Referenced model access denied' } }, 404) : reply(draft);
    }
    if (url.includes('revisions/board-rev')) return state.denyRetained ? reply({ error: { message: 'Original child source denied' } }, 404) : reply({ revision_id: 'board-rev' });
    if (url.includes('/snapshots/')) return reply(snapshot);
    return reply([{ definition_id: 'assembly', name: 'Own assembly', kind: 'assembly' }]);
  }));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const panel = <MantineProvider env="test"><QueryClientProvider client={client}><PermissionsProvider permissions={['design.edit', 'design.freeze']}><AssemblyPanel projectId="own-project" /></PermissionsProvider></QueryClientProvider></MantineProvider>;
  render(strict ? <StrictMode>{panel}</StrictMode> : panel);
  return state;
}
async function choose(label: string, value: string) {
  fireEvent.click(await screen.findByRole('combobox', { name: label }));
  fireEvent.click(await screen.findByRole('option', { name: value }));
}
async function open() {
  await screen.findByRole('combobox', { name: 'Assembly definition' });
  await choose('Assembly definition', 'Own assembly');
  await choose('Assembly draft', 'draft-a · draft-v1');
  await screen.findByLabelText('board X (mm)');
  await screen.findByText('private-model-hash');
}

test('focus cannot upgrade capture CAS past the displayed staged editor baseline', async () => {
  const state = fixture(); await open();
  fireEvent.change(screen.getByLabelText('board X (mm)'), { target: { value: '77' } });
  state.version = 'draft-v2'; fireEvent(window, new Event('focus'));
  await screen.findByText(/A newer assembly draft is available/);
  fireEvent.click(screen.getByRole('button', { name: 'Freeze assembly revision' }));
  await waitFor(() => expect(state.calls).toHaveLength(1));
  expect(state.calls[0].expected_state).toBe('draft-v1');
  await screen.findByText('Original state conflicts');
  expect((screen.getByLabelText('board X (mm)') as HTMLInputElement).value).toBe('77');
});

test('source denial hides every result but preserves own manual fields and original CAS until explicit fresh restoration', async () => {
  const state = fixture(true); await open();
  fireEvent.change(screen.getByLabelText('board X (mm)'), { target: { value: '77' } });
  state.deny = true; fireEvent(window, new Event('focus'));
  await screen.findAllByText('Referenced model access denied');
  await waitFor(() => expect(screen.queryByLabelText('board X (mm)')).toBeNull());
  expect(screen.queryByText('private-model-hash')).toBeNull();
  expect(screen.queryByText('Source-derived private label')).toBeNull();
  state.deny = false; state.version = 'draft-v2';
  fireEvent.click(screen.getByRole('button', { name: 'Refresh authorized assemblies' }));
  const input = await screen.findByLabelText('board X (mm)');
  expect((input as HTMLInputElement).value).toBe('77');
  fireEvent.click(screen.getByRole('button', { name: 'Save board' }));
  await waitFor(() => expect(state.calls).toHaveLength(1));
  expect(state.calls[0].expected_state).toBe('draft-v1');
  await screen.findByText('Original state conflicts');
});

test('late denial from an abandoned save cannot clear a newly authorized revisit of the same draft', async () => {
  const state = fixture(); await open(); state.delaySave = true;
  fireEvent.change(screen.getByLabelText('board X (mm)'), { target: { value: '12' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save board' }));
  await waitFor(() => expect(state.pending).toBeTruthy());
  await choose('Assembly draft', 'draft-b · draft-v1');
  await screen.findByLabelText('board X (mm)');
  await choose('Assembly draft', 'draft-a · draft-v1');
  await screen.findByLabelText('board X (mm)');
  await act(async () => { state.pending!(reply({ error: { message: 'Earlier source denial' } }, 404)); });
  await waitFor(() => expect(screen.getByLabelText('board X (mm)')).toBeTruthy());
  expect(screen.queryByText('Earlier source denial')).toBeNull();
});


test('a lost freeze response retries the same operation and advances only its accepted baseline', async () => {
  const state = fixture(); await open(); state.loseFreeze = true;
  fireEvent.change(screen.getByLabelText('board X (mm)'), { target: { value: '77' } });
  fireEvent.click(screen.getByRole('button', { name: 'Freeze assembly revision' }));
  await screen.findByText('Freeze response unavailable');
  expect(state.version).toBe('draft-v2');
  fireEvent.click(screen.getByRole('button', { name: 'Freeze assembly revision' }));
  await screen.findByText('Draft draft-a · draft-v2');
  expect(state.calls[1].idempotency_key).toBe(state.calls[0].idempotency_key);
  expect(state.calls[1].expected_state).toBe(state.calls[0].expected_state);
  expect(state.calls[1].payload).toEqual(state.calls[0].payload);
  expect((screen.getByLabelText('board X (mm)') as HTMLInputElement).value).toBe('77');
  fireEvent.click(screen.getByRole('button', { name: 'Save board' }));
  await waitFor(() => expect(state.calls).toHaveLength(3));
  expect(state.calls[2].expected_state).toBe('draft-v2');
  expect(state.calls[2].payload.assembly.occurrences[0].placement.translation).toEqual([77, 2, 3]);
  state.version = 'draft-v4';
  await choose('Assembly draft', 'draft-b · draft-v2');
  await screen.findByText('Draft draft-b · draft-v4');
  await choose('Assembly draft', 'draft-a · draft-v2');
  await screen.findByText('Draft draft-a · draft-v4');
  expect((screen.getByLabelText('board X (mm)') as HTMLInputElement).value).toBe('1');
});

test('late private mounting results cannot reveal denied input and fresh restoration retains own mounting intent', async () => {
  const state = fixture(); await open();
  fireEvent.change(screen.getByLabelText('Mounted contextual occurrence'), { target: { value: '["board"]' } });
  fireEvent.change(screen.getByLabelText('Supporting contextual occurrence'), { target: { value: '[]' } });
  fireEvent.change(screen.getByLabelText('Mounting declaration local ID'), { target: { value: 'own-mount' } });
  fireEvent.change(screen.getByLabelText('Mounted unverified stable feature ID (optional)'), { target: { value: 'own-hole' } });
  state.delayChoices = true;
  fireEvent.click(screen.getByRole('button', { name: 'Refresh mounting choices' }));
  await waitFor(() => expect(state.pendingChoices).toBeTruthy());
  state.deny = true; fireEvent(window, new Event('focus'));
  await screen.findAllByText('Referenced model access denied');
  await act(async () => { state.pendingChoices!(reply({ result: { draft_id: 'draft-a', state: 'draft-v1', occurrences: [{ path: ['board'], display_ref: 'Late private label', name: 'Late private name', kind: 'board', revision_id: 'board-rev', snapshot_sha256: 'late-private-hash', placement: { status: 'unknown' } }] } })); });
  expect(screen.queryByLabelText('Mounting declaration local ID')).toBeNull();
  expect(screen.queryByText('late-private-hash')).toBeNull();
  expect(screen.queryByText(/Late private label/)).toBeNull();
  state.delayChoices = false; state.deny = false;
  fireEvent.click(screen.getByRole('button', { name: 'Refresh authorized assemblies' }));
  await screen.findByText('private-model-hash');
  expect((screen.getByLabelText('Mounting declaration local ID') as HTMLInputElement).value).toBe('own-mount');
  expect((screen.getByLabelText('Mounted unverified stable feature ID (optional)') as HTMLInputElement).value).toBe('own-hole');
  fireEvent.click(screen.getByRole('button', { name: 'Add mounting declaration' }));
  await waitFor(() => expect(state.calls).toHaveLength(1));
  expect(state.calls[0].expected_state).toBe('draft-v1');
  expect(state.calls[0].payload.assembly.relationships).toEqual([{ kind: 'mounting', local_id: 'own-mount', mounted: { kind: 'occurrence', path: ['board'], feature_id: 'own-hole' }, support: { kind: 'occurrence', path: [], feature_id: null } }]);
});


test('a cached draft revisit waits for fresh scope and cannot expose revoked original input', async () => {
  const state = fixture(); await open();
  await choose('Assembly draft', 'draft-b · draft-v1');
  await screen.findByText('Draft draft-b · draft-v1');
  state.delayDraft = true;
  await choose('Assembly draft', 'draft-a · draft-v1');
  await waitFor(() => expect(state.pendingDraft).toBeTruthy());
  expect(screen.queryByLabelText('board X (mm)')).toBeNull();
  expect(screen.queryByText('private-model-hash')).toBeNull();
  await act(async () => { state.pendingDraft!(reply({ error: { message: 'Revoked cached draft' } }, 404)); });
  await screen.findByText('Revoked cached draft');
  expect(screen.queryByLabelText('board X (mm)')).toBeNull();
});

test('restoring a newer draft still authorizes the retained original revision pins before revealing staged input', async () => {
  const state = fixture(); await open();
  fireEvent.change(screen.getByLabelText('board X (mm)'), { target: { value: '77' } });
  state.deny = true; fireEvent(window, new Event('focus'));
  await screen.findAllByText('Referenced model access denied');
  state.deny = false; state.version = 'draft-v2'; state.denyRetained = true;
  fireEvent.click(screen.getByRole('button', { name: 'Refresh authorized assemblies' }));
  await screen.findByText('Original child source denied');
  expect(screen.queryByLabelText('board X (mm)')).toBeNull();
  expect(screen.queryByText('private-model-hash')).toBeNull();
  state.denyRetained = false;
  fireEvent.click(screen.getByRole('button', { name: 'Refresh authorized assemblies' }));
  expect((await screen.findByLabelText('board X (mm)') as HTMLInputElement).value).toBe('77');
});


test('focus rechecks original editor pins even when a competing current draft removed them', async () => {
  const state = fixture(); await open();
  fireEvent.change(screen.getByLabelText('board X (mm)'), { target: { value: '77' } });
  state.assembly = { occurrences: [], relationships: [] }; state.version = 'draft-v2'; state.denyRetained = true;
  fireEvent(window, new Event('focus'));
  await screen.findByText('Original child source denied');
  expect(screen.queryByLabelText('board X (mm)')).toBeNull();
  expect(screen.queryByText('private-model-hash')).toBeNull();
  state.denyRetained = false;
  fireEvent.click(screen.getByRole('button', { name: 'Refresh authorized assemblies' }));
  expect((await screen.findByLabelText('board X (mm)') as HTMLInputElement).value).toBe('77');
  fireEvent.click(screen.getByRole('button', { name: 'Save board' }));
  await waitFor(() => expect(state.calls).toHaveLength(1));
  expect(state.calls[0].expected_state).toBe('draft-v1');
});
