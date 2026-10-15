import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { PermissionsProvider } from '../../lib/permissions';
import { ApiError } from '../workspace/api';
import { useContextRecord, type ContextAdapter, type ContextDraft } from './useContextRecord';
const pin = '00000000-0000-4000-8000-000000000001';
type Value = { source: string; note: string };
type Frozen = { revision_id: string };
const grants = ['workspace.read', 'item.create', 'design.edit', 'design.freeze'];
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const reply = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
function server() {
  let denied = false; let state = 'original-v4'; let held: Promise<void> | null = null; let release = () => {}; let readsHeld: Promise<void> | null = null; let releaseRead = () => {}; let lose = false; let creates = 0;
  const posts: { operation: string; expected_state?: string; idempotency_key: string; payload: { value: Value } }[] = []; const reads: string[] = []; const replay = new Map<string, unknown>();
  const draft = (id = 'd1'): ContextDraft<Value> => ({ definition_id: 'definition', draft_id: id, state, value: { source: pin, note: 'Saved declaration' } });
  const adapter: ContextAdapter<Value, Frozen> = { kind: 'pcb_assertion', create: 'pcb_disagreement.create', update: 'pcb_disagreement.update', freeze: 'pcb_disagreement.freeze', initial: () => ({ source: pin, note: '' }), pins: value => ({ revisions: [], sources: [value.source] }), complete: value => !!value.source, readDraft: async id => { reads.push(id); if (readsHeld) await readsHeld; if (denied) throw new ApiError(403, 'Current source unavailable'); return draft(id); }, readFrozen: async id => ({ revision_id: id }), fromOperation: result => result as ContextDraft<Value>, payload: value => ({ value }) };
  vi.stubGlobal('fetch', vi.fn(async (path: string, init?: RequestInit) => {
    if (path.includes('/catalog/revision-labels')) return reply({ labels: [], source_labels: [{ revision_id: pin, readable: !denied }] });
    if (path.endsWith('/operations')) { const request = JSON.parse(String(init?.body)); posts.push(request); if (held) await held; if (replay.has(request.idempotency_key)) return reply({ result: replay.get(request.idempotency_key) }); if (request.operation.endsWith('.create')) creates += 1; const result = request.operation.endsWith('.freeze') ? { revision_id: 'r1', draft: { state: 'frozen-v6' } } : { ...draft(), state: 'saved-v5', value: request.payload.value }; replay.set(request.idempotency_key, result); if (lose) { lose = false; throw new Error('Lost committed response'); } return reply({ result }); }
    return reply({});
  }));
  return { adapter, posts, reads, get creates() { return creates; }, deny: (value: boolean) => { denied = value; }, remote: () => { state = 'remote-v9'; }, lose: () => { lose = true; }, hold: () => { held = new Promise(resolve => { release = resolve; }); }, release: () => { held = null; release(); }, holdRead: () => { readsHeld = new Promise(resolve => { releaseRead = resolve; }); }, releaseRead: () => { readsHeld = null; releaseRead(); } };
}
let editor!: ReturnType<typeof useContextRecord<Value, Frozen>>;
function Harness(props: Parameters<typeof useContextRecord<Value, Frozen>>[0]) { editor = useContextRecord(props); return <>{editor.checking ? <p>Checking</p> : editor.unavailable ? <p>Withdrawn</p> : <p>{editor.value.note}</p>}{editor.error && <p>{editor.error}</p>}<button onClick={() => void editor.save()}>Save</button><button onClick={() => void editor.freeze()}>Freeze</button><button onClick={() => void editor.refresh()}>Refresh</button></>; }
function setup(adapter: ContextAdapter<Value, Frozen>) { const client = new QueryClient({ defaultOptions: { queries: { retry: false } } }); const tree = (active = true, principalKey = 'principal') => <PermissionsProvider permissions={grants}><QueryClientProvider client={client}><Harness adapter={adapter} active={active} principalKey={principalKey} workspaceId="workspace" scopeKey="fixed-exact-basis" /></QueryClientProvider></PermissionsProvider>; return { ...render(tree()), tree }; }
const ready = () => waitFor(() => { expect(editor.checking).toBe(false); expect(editor.unavailable).toBe(false); });
test('current contextual draft is freshly authorized on resume without rebasing dirty buffer or original CAS', async () => {
  const api = server(); const view = setup(api.adapter); await ready(); await act(async () => editor.load('d1', 'Assertion')); await ready(); act(() => editor.change({ source: pin, note: 'Private unsaved assertion' })); await ready();
  view.rerender(view.tree(false)); api.remote(); api.deny(true); view.rerender(view.tree(true)); await screen.findByText('Withdrawn'); expect(screen.queryByText('Private unsaved assertion')).toBeNull();
  fireEvent.click(screen.getByText('Save')); expect(api.posts).toHaveLength(0); api.deny(false); fireEvent.click(screen.getByText('Refresh')); await screen.findByText('Private unsaved assertion'); await ready(); expect(editor.current?.state).toBe('original-v4');
  fireEvent.click(screen.getByText('Save')); await waitFor(() => expect(api.posts).toHaveLength(1)); expect(api.posts[0]?.expected_state).toBe('original-v4'); expect(api.posts[0]?.payload.value.note).toBe('Private unsaved assertion');
});
test('a held explicit load cannot be relabeled or replaced by a second selection', async () => {
  const api = server(); setup(api.adapter); await ready(); api.holdRead(); let first!: Promise<void>; act(() => { first = editor.load('d1', 'First assertion'); }); await waitFor(() => expect(editor.busy).toBe(true)); await act(async () => editor.load('d2', 'Second assertion')); expect(api.reads).toEqual(['d1']);
  await act(async () => { api.releaseRead(); await first; }); await ready(); expect(editor.current?.draft_id).toBe('d1'); expect(editor.name).toBe('First assertion');
});
test('response-loss retry preserves one contextual creation intent and context changes fence held completion', async () => {
  const api = server(); const view = setup(api.adapter); await ready(); act(() => { editor.setName('Synthetic assertion'); editor.change({ source: pin, note: 'Authored assertion' }); }); await ready(); api.lose(); fireEvent.click(screen.getByText('Save')); await screen.findByText('Lost committed response'); fireEvent.click(screen.getByText('Save')); await waitFor(() => expect(editor.current?.state).toBe('saved-v5')); expect(api.creates).toBe(1); expect(api.posts[0]?.idempotency_key).toBe(api.posts[1]?.idempotency_key);
  act(() => editor.newRecord()); await ready(); act(() => editor.setName('Another assertion')); api.hold(); fireEvent.click(screen.getByText('Save')); await waitFor(() => expect(api.posts).toHaveLength(3)); view.unmount(); await act(async () => api.release());
});
test('loaded saved contextual state freezes using its own CAS without replacing primary board state', async () => {
  const api = server(); setup(api.adapter); await ready(); await act(async () => editor.load('d1', 'Assertion')); await ready(); fireEvent.click(screen.getByText('Freeze')); await waitFor(() => expect(editor.frozenId).toBe('r1')); expect(api.posts[0]?.expected_state).toBe('original-v4'); expect(editor.current?.state).toBe('frozen-v6'); expect(editor.value.note).toBe('Saved declaration');
});
