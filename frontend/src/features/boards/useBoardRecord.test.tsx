import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { PermissionsProvider } from '../../lib/permissions';
import { emptyBoard, type Board } from './api';
import { useBoardRecord } from './useBoardRecord';
const sourceId = '00000000-0000-4000-8000-000000000001';
const permissions = ['workspace.read', 'item.create', 'design.edit', 'design.freeze'];
const board = (label = 'Saved pad'): Board => ({ ...emptyBoard(), terminals: [{ terminal_id: 'pad-stable', label, group: null, kind: 'solder_pad', side: 'top', native_pad_ids: [], note: null }] });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const reply = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
function server() {
  let state = 'draft-v4'; let content = board(); let newest = 2; let denyWorking = false; let conflict = false; let loseResponse = false;
  let held: Promise<void> | null = null; let release = () => {};
  const posts: { operation: string; payload: { interface: Board; name?: string }; expected_state?: string; idempotency_key: string }[] = []; const calls: string[] = []; const replay = new Map<string, unknown>(); let creates = 0;
  vi.stubGlobal('fetch', vi.fn(async (path: string, init?: RequestInit) => {
    calls.push(path);
    if (path.includes('/access/workspace')) return reply({ workspace_id: 'workspace' });
    if (path.includes('/workspace/library/')) return reply({ record_id: 'b1', family: 'definition', kind: 'board', label: 'Synthetic board', latest_revision: newest, latest_revision_id: `r${newest}`, referenceable: true, used_in: [], used_in_total: 0 });
    if (path.includes('/catalog/definitions/')) return reply({ definition_id: 'b1', name: 'Synthetic board', kind: 'board', drafts: [{ draft_id: 'd1', state }], revisions: path.includes('offset=50') ? [{ revision_id: 'r75', number: 75 }] : [{ revision_id: 'r1', number: 1 }, { revision_id: 'r2', number: 2 }] });
    if (path.includes('/interfaces/drafts/')) return reply({ definition_id: 'b1', draft_id: 'd1', state, content: { interface: content } });
    if (path.includes('/interfaces/revisions/')) return reply({ revision_id: path.split('/').at(-1), interface: board(path.endsWith('r75') ? 'Historical75' : 'Frozen pad'), board: {} });
    if (path.includes('/catalog/revision-labels')) return reply({ labels: [{ revision_id: sourceId, readable: !denyWorking }], source_labels: [] });
    if (path.endsWith('/operations')) {
      const request = JSON.parse(String(init?.body)); posts.push(request); if (held) await held;
      if (replay.has(request.idempotency_key)) return reply({ result: replay.get(request.idempotency_key), replayed: true });
      if (conflict) return reply({ error: { message: 'Original editing token conflicts.' } }, 409);
      let result: unknown;
      if (request.operation === 'interface.freeze') { newest = 3; state = 'draft-v6'; result = { revision_id: 'r3', number: 3, draft: { state } }; }
      else { if (request.operation === 'interface.create') creates += 1; content = request.payload.interface; state = 'draft-v5'; result = { definition_id: 'b1', draft_id: 'd1', state, content: { interface: content } }; }
      replay.set(request.idempotency_key, result);
      if (loseResponse) { loseResponse = false; throw new Error('Connection lost after commit'); }
      return reply({ result });
    }
    return reply({});
  }));
  return { posts, calls, get creates() { return creates; }, workingDenied: (value: boolean) => { denyWorking = value; }, remoteChange: () => { state = 'draft-v9'; content = board('Remote pad'); }, conflict: () => { conflict = true; }, lose: () => { loseResponse = true; }, hold: () => { held = new Promise(resolve => { release = resolve; }); }, release: () => { held = null; release(); } };
}
type Props = Parameters<typeof useBoardRecord>[0];
let current!: ReturnType<typeof useBoardRecord>;
function Harness(props: Props) { current = useBoardRecord(props); return <><button onClick={() => void current.save()}>Call save</button><button onClick={() => void current.freeze()}>Call freeze</button><button onClick={current.refresh}>Refresh</button>{current.unavailable ? <p>Withdrawn</p> : current.checking ? <p>Checking</p> : <pre>{JSON.stringify(current.content)}</pre>}{current.error && <p>{current.error}</p>}</>; }
function setup(patch: Partial<Props> = {}, grants = permissions) {
  const callbacks = { onCreated: vi.fn(), onSelect: vi.fn() };
  const defaults: Props = { active: true, principalKey: 'principal', workspaceId: 'workspace', definitionId: 'b1', kind: 'board', revisionNumber: null, draftRequested: true, ...callbacks, ...patch };
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const tree = (values: Partial<Props> = {}, nextGrants = grants) => <PermissionsProvider permissions={nextGrants}><QueryClientProvider client={client}><Harness {...defaults} {...values} /></QueryClientProvider></PermissionsProvider>;
  return { ...render(tree()), callbacks, tree };
}
const ready = () => waitFor(() => { expect(current.checking).toBe(false); expect(current.unavailable).toBe(false); });

test('an exact historical revision beyond page one never becomes newest, including when unavailable', async () => {
  const api = server(); const view = setup({ revisionNumber: 75, draftRequested: false });
  await screen.findByText(/Historical75/); expect(current.revision?.revision_id).toBe('r75');
  expect(api.calls.some(path => path.includes('offset=50'))).toBe(true); expect(api.calls.some(path => path.endsWith('/interfaces/revisions/r2'))).toBe(false);
  view.rerender(view.tree({ revisionNumber: 150 })); await screen.findByText('Withdrawn');
  expect(screen.queryByText(/Historical75/)).toBeNull(); expect(api.calls.some(path => path.endsWith('/interfaces/revisions/r2'))).toBe(false);
});
test('dirty new references are freshly fenced on focus and recover without adopting remote CAS or content', async () => {
  const api = server(); setup(); await ready(); await waitFor(() => expect(current.current?.state).toBe('draft-v4'));
  act(() => current.change({ interface: { ...board('Working pad'), carried_connectors: [{ local_id: 'body', body_revision_id: sourceId, correspondence: [], review: 'unreviewed', basis: null }] } }));
  await screen.findByText(/Working pad/); await ready(); api.remoteChange(); api.workingDenied(true);
  fireEvent(window, new Event('focus')); await screen.findByText('Withdrawn'); expect(screen.queryByText(/Working pad/)).toBeNull();
  fireEvent.click(screen.getByText('Call save')); expect(api.posts).toHaveLength(0);
  api.workingDenied(false); fireEvent.click(screen.getByText('Refresh')); await screen.findByText(/Working pad/); await ready();
  expect(current.current?.state).toBe('draft-v4'); expect(current.dirty).toBe(true); expect(current.content?.interface?.carried_connectors[0]?.body_revision_id).toBe(sourceId);
  api.conflict(); fireEvent.click(screen.getByText('Call save')); await screen.findByText('Original editing token conflicts.');
  expect(api.posts[0]?.expected_state).toBe('draft-v4'); expect(current.content?.interface?.terminals[0]?.label).toBe('Working pad');
});
test('retry after a lost create response reuses one reviewed intent key and one committed definition', async () => {
  const api = server(); const view = setup({ definitionId: null, initial: { name: 'Synthetic create', board: board() } }); await ready(); api.lose();
  fireEvent.click(screen.getByText('Call save')); await screen.findByText('Connection lost after commit');
  fireEvent.click(screen.getByText('Call save')); await waitFor(() => expect(view.callbacks.onCreated).toHaveBeenCalledWith('b1', true));
  expect(api.posts).toHaveLength(2); expect(api.posts[0]?.idempotency_key).toBe(api.posts[1]?.idempotency_key); expect(api.creates).toBe(1);
});
test.each(['unmount', 'principal', 'workspace'] as const)('held create cannot call the old creation callback after %s changes', async mode => {
  const api = server(); const view = setup({ definitionId: null, initial: { name: 'Synthetic create', board: board() } }); await ready(); api.hold(); fireEvent.click(screen.getByText('Call save')); await waitFor(() => expect(api.posts).toHaveLength(1));
  if (mode === 'unmount') view.unmount(); else view.rerender(view.tree(mode === 'principal' ? { principalKey: 'another-principal' } : { workspaceId: 'another-workspace' }));
  await act(async () => api.release()); expect(view.callbacks.onCreated).not.toHaveBeenCalled();
});
test('held save preserves later local edits while advancing only the saved draft token', async () => {
  const api = server(); setup(); await ready(); await waitFor(() => expect(current.current?.state).toBe('draft-v4')); act(() => current.change({ interface: board('Submitted pad') })); api.hold(); fireEvent.click(screen.getByText('Call save')); await waitFor(() => expect(api.posts).toHaveLength(1));
  act(() => current.change({ interface: board('Later pad') })); await act(async () => api.release());
  await waitFor(() => expect(current.current?.state).toBe('draft-v5')); expect(current.content?.interface?.terminals[0]?.label).toBe('Later pad'); expect(current.dirty).toBe(true);
});
test('held freeze never selects the frozen revision over newer working edits', async () => {
  const api = server(); const view = setup(); await ready(); await waitFor(() => expect(current.current?.state).toBe('draft-v4')); api.hold(); fireEvent.click(screen.getByText('Call freeze')); await waitFor(() => expect(api.posts).toHaveLength(1)); act(() => current.change({ interface: board('After freeze click') })); await act(async () => api.release());
  await waitFor(() => expect(current.current?.state).toBe('draft-v6')); expect(view.callbacks.onSelect).not.toHaveBeenCalled(); expect(current.dirty).toBe(true); expect(current.content?.interface?.terminals[0]?.label).toBe('After freeze click');
});
test('direct method calls remain inert for inactive or read-only controllers', async () => {
  const api = server(); const view = setup({}, ['workspace.read']); await ready(); await waitFor(() => expect(current.current).not.toBeNull()); fireEvent.click(screen.getByText('Call save')); fireEvent.click(screen.getByText('Call freeze')); expect(api.posts).toHaveLength(0);
  view.rerender(view.tree({ active: false }, permissions)); fireEvent.click(screen.getByText('Call save')); fireEvent.click(screen.getByText('Call freeze')); expect(api.posts).toHaveLength(0);
});
