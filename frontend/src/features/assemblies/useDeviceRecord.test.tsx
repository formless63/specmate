import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { PermissionsProvider } from '../../lib/permissions';
import { emptyAssembly, useDeviceRecord, type DeviceRecordProps } from './useDeviceRecord';
import type { Assembly } from './api';
const child = '00000000-0000-4000-8000-000000000001';
const declarations = (display_ref = 'Board A'): Assembly => ({ ...emptyAssembly(), occurrences: [{ local_id: 'board-a', revision_id: child, display_ref, placement: { status: 'unknown' } }] });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const response = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });
function server() {
  let assembly = declarations(); let state = 'draft-v4'; let denied = false; let held: Promise<void> | null = null; let release = () => {}; let lose = false; let conflict = false; let creates = 0;
  const calls: string[] = []; const posts: { operation: string; payload: { assembly?: Assembly }; expected_state?: string; idempotency_key: string }[] = []; const replay = new Map<string, unknown>();
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => { calls.push(url);
    if (url.includes('/access/workspace')) return response({ workspace_id: 'workspace' });
    if (url.includes('/record?')) {
      const query = new URL(url, 'http://localhost').searchParams; const number = Number(query.get('revision_number') ?? '2');
      if (number === 150) return response({ error: { message: 'The requested exact revision is unavailable.' } }, 404);
      return response({ definition_id: 'device', workspace_id: 'workspace', name: 'Synthetic device', kind: 'assembly', selected: query.get('working') === 'true' ? { kind: 'draft', draft_id: 'd1', state, content: { assembly } } : { kind: 'revision', revision_id: `r${number}`, number, snapshot_id: `snapshot-r${number}`, sha256: 'a'.repeat(64), content: { assembly: declarations('Historical A') } } });
    }
    if (url.includes('/workspace/library/')) return response({ record_id: 'device', kind: 'assembly', family: 'definition', label: 'Synthetic device', latest_revision: 2, latest_revision_id: 'r2', used_in: [] });
    if (url.includes('/catalog/definitions/')) return response({ definition_id: 'device', name: 'Synthetic device', kind: 'assembly', drafts: [{ draft_id: 'd1', state }], revisions: url.includes('offset=50') ? [{ revision_id: 'r75', number: 75 }] : [{ revision_id: 'r1', number: 1 }, { revision_id: 'r2', number: 2 }] });
    if (url.includes('/assemblies/drafts/')) return response({ definition_id: 'device', draft_id: 'd1', state, content: { assembly } });
    if (url.includes('/catalog/revision-labels')) return response({ labels: [{ revision_id: child, readable: !denied }], source_labels: [] });
    if (url.includes('/revisions/') && url.endsWith('/snapshot')) return response({ content: { assembly: declarations('Historical A') } });
    if (url.includes('/revisions/')) { const id = url.split('/').at(-1); return response({ revision_id: id, definition_id: 'device', number: id === 'r75' ? 75 : id === 'r1' ? 1 : 2, snapshot_id: `snapshot-${id}`, sha256: 'a'.repeat(64) }); }
    if (url.includes('/shared-scenes/captured-snapshots/')) return response({ snapshot_id: 'captured', sha256: 'b'.repeat(64), root: { definition_id: 'device', snapshot_sha256: 'b'.repeat(64), kind: 'assembly' }, basis: { kind: 'captured_draft', draft_id: 'd1', draft_version: 4, snapshot_id: 'captured', snapshot_sha256: 'b'.repeat(64) }, nodes: [], geometry: [], relationships: [] });
    if (url.endsWith('/operations')) { const body = JSON.parse(String(init?.body)); posts.push(body); if (held) await held; if (replay.has(body.idempotency_key)) return response({ result: replay.get(body.idempotency_key) }); if (conflict) return response({ error: { message: 'Device editing token conflicts.' } }, 409);
      let result: unknown; if (body.operation === 'assembly.snapshot') result = { snapshot_id: 'captured', sha256: 'b'.repeat(64) };
      else if (body.operation === 'assembly.freeze') { state = 'draft-v6'; result = { revision_id: 'r3', number: 3, snapshot_id: 'captured', draft: { definition_id: 'device', draft_id: 'd1', state, content: { assembly } } }; }
      else { if (body.operation === 'assembly.create') creates += 1; assembly = body.payload.assembly; state = 'draft-v5'; result = { definition_id: 'device', draft_id: 'd1', state, content: { assembly } }; }
      replay.set(body.idempotency_key, result); if (lose) { lose = false; throw new Error('Committed response lost'); } return response({ result }); }
    return response({});
  }));
  return { calls, posts, get creates() { return creates; }, deny: (value: boolean) => { denied = value; }, remoteRemovesChild: () => { assembly = emptyAssembly(); state = 'draft-v9'; }, conflict: () => { conflict = true; }, lose: () => { lose = true; }, hold: () => { held = new Promise(resolve => { release = resolve; }); }, release: () => { held = null; release(); } };
}
let current!: ReturnType<typeof useDeviceRecord>;
function Harness(props: DeviceRecordProps) { current = useDeviceRecord(props); return <>{current.unavailable ? <p>Withdrawn</p> : current.checking ? <p>Checking</p> : <pre>{JSON.stringify(current.assembly)}</pre>}{current.error && <p>{current.error}</p>}<button onClick={() => void current.save()}>Save</button><button onClick={() => void current.capture()}>Capture</button><button onClick={() => void current.freeze()}>Freeze</button><button onClick={() => void current.refresh()}>Refresh</button></>; }
function setup(patch: Partial<DeviceRecordProps> = {}, grants = ['workspace.read', 'item.create', 'design.edit', 'design.freeze']) { const callbacks = { onCreated: vi.fn(), onSelect: vi.fn() }; const defaults: DeviceRecordProps = { active: true, principalKey: 'principal', workspaceId: 'workspace', definitionId: 'device', revisionNumber: null, draftRequested: true, ...callbacks, ...patch }; const cache = new QueryClient({ defaultOptions: { queries: { retry: false } } }); const tree = (values: Partial<DeviceRecordProps> = {}) => <PermissionsProvider permissions={grants}><QueryClientProvider client={cache}><Harness {...defaults} {...values} /></QueryClientProvider></PermissionsProvider>; return { ...render(tree()), tree, callbacks }; }
const ready = () => waitFor(() => { expect(current.checking).toBe(false); expect(current.unavailable).toBe(false); });
const saved = async () => { await waitFor(() => expect(current.current?.state).toBe('draft-v4')); await ready(); };
test('exact r75 uses its own snapshot beyond the first history page and unavailable r150 never falls forward', async () => { const api = server(); const view = setup({ revisionNumber: 75, draftRequested: false }); await screen.findByText(/Historical A/); expect(current.sceneBasis).toBe('snapshot-r75'); expect(api.calls.some(url => url.includes('revision_number=75'))).toBe(true); expect(api.calls.some(url => url.endsWith('/revisions/r2'))).toBe(false); view.rerender(view.tree({ revisionNumber: 150 })); await screen.findByText('Withdrawn'); expect(screen.queryByText(/Historical A/)).toBeNull(); });
test('only explicit saved-state Capture creates a captured scene basis, and working edits invalidate it without another write', async () => { const api = server(); setup(); await saved(); expect(current.sceneBasis).toBeNull(); expect(api.posts).toHaveLength(0); fireEvent.click(screen.getByText('Capture')); await waitFor(() => expect(current.inspectionBasis).toBe('captured')); expect(current.sceneBasis).toBeNull(); expect(api.posts[0]).toMatchObject({ operation: 'assembly.snapshot', expected_state: 'draft-v4' }); act(() => current.change(declarations('Working later A'))); await ready(); expect(current.sceneBasis).toBeNull(); fireEvent.click(screen.getByText('Capture')); fireEvent.click(screen.getByText('Freeze')); expect(api.posts).toHaveLength(1); expect(current.assembly?.occurrences[0]?.display_ref).toBe('Working later A'); });
test('a held capture never labels later working edits as captured geometry', async () => { const api = server(); setup(); await saved(); api.hold(); fireEvent.click(screen.getByText('Capture')); await waitFor(() => expect(api.posts).toHaveLength(1)); act(() => current.change(declarations('After capture click'))); await act(async () => api.release()); await ready(); expect(current.dirty).toBe(true); expect(current.sceneBasis).toBeNull(); expect(current.assembly?.occurrences[0]?.display_ref).toBe('After capture click'); });
test('original retained child pins remain freshly authorized after a competing server draft removes them', async () => { const api = server(); setup(); await saved(); act(() => current.change(declarations('Private local A'))); await ready(); api.remoteRemovesChild(); api.deny(true); fireEvent(window, new Event('focus')); await screen.findByText('Withdrawn'); expect(screen.queryByText(/Private local A/)).toBeNull(); fireEvent.click(screen.getByText('Save')); expect(api.posts).toHaveLength(0); api.deny(false); fireEvent.click(screen.getByText('Refresh')); await screen.findByText(/Private local A/); await ready(); expect(current.current?.state).toBe('draft-v4'); api.conflict(); fireEvent.click(screen.getByText('Save')); await screen.findByText('Device editing token conflicts.'); expect(api.posts[0]?.expected_state).toBe('draft-v4'); });
test('lost create response retries one stable creation intent', async () => { const api = server(); const view = setup({ definitionId: null, initial: { name: 'Synthetic device create', assembly: emptyAssembly() } }); await ready(); api.lose(); fireEvent.click(screen.getByText('Save')); await screen.findByText('Committed response lost'); fireEvent.click(screen.getByText('Save')); await waitFor(() => expect(view.callbacks.onCreated).toHaveBeenCalledWith('device', true)); expect(api.creates).toBe(1); expect(api.posts[0]?.idempotency_key).toBe(api.posts[1]?.idempotency_key); });
test.each(['unmount', 'principal', 'workspace'] as const)('held creation cannot call an old onCreated after %s changes', async mode => { const api = server(); const view = setup({ definitionId: null, initial: { name: 'Synthetic held device', assembly: emptyAssembly() } }); await ready(); api.hold(); fireEvent.click(screen.getByText('Save')); await waitFor(() => expect(api.posts).toHaveLength(1)); if (mode === 'unmount') view.unmount(); else view.rerender(view.tree(mode === 'principal' ? { principalKey: 'another' } : { workspaceId: 'another' })); await act(async () => api.release()); expect(view.callbacks.onCreated).not.toHaveBeenCalled(); });
test('inactive and viewer direct methods cannot save capture or freeze', async () => { const api = server(); const view = setup({}, ['workspace.read']); await saved(); fireEvent.click(screen.getByText('Save')); fireEvent.click(screen.getByText('Capture')); fireEvent.click(screen.getByText('Freeze')); expect(api.posts).toHaveLength(0); view.rerender(view.tree({ active: false })); fireEvent.click(screen.getByText('Capture')); expect(api.posts).toHaveLength(0); });

test('captured preview rejects a fabricated frozen root identity and withdraws its retained geometry', async () => {
  server(); const original = globalThis.fetch; let altered = false;
  vi.stubGlobal('fetch', vi.fn(async (input: string, init?: RequestInit) => {
    const result = await original(input, init);
    if (altered && input.includes('/shared-scenes/captured-snapshots/')) { const body = await result.json(); body.root.revision_id = 'fabricated'; return response(body); }
    return result;
  }));
  setup(); await saved(); fireEvent.click(screen.getByText('Capture')); await waitFor(() => expect(current.inspectionBasis).toBe('captured'));
  altered = true; fireEvent(window, new Event('focus')); await screen.findByText('Withdrawn'); expect(current.inspectionBasis).toBeNull();
  expect(current.current?.state).toBe('draft-v4');
});

test('an unrelated denied later draft never participates in an old exact device read', async () => {
  const api = server(); const original = globalThis.fetch;
  vi.stubGlobal('fetch', vi.fn(async (input: string, init?: RequestInit) => input.includes('/catalog/definitions/device?') || input.includes('/assemblies/drafts/') || input.includes('/workspace/library/') ? response({ error: { message: 'Unrelated current draft denied' } }, 403) : original(input, init)));
  setup({ revisionNumber: 75, draftRequested: false }); await screen.findByText(/Historical A/); await ready();
  expect(current.sceneBasis).toBe('snapshot-r75'); expect(api.calls.some(url => url.includes('/assemblies/drafts/'))).toBe(false); expect(current.identity.isPending).toBe(true);
});

test('lost saved placement replay keeps the reviewed payload and CAS through source withdrawal',async()=>{
 const api=server();setup();await saved();const placement={status:'known' as const,translation:[77,2,3] as [number,number,number],rotation_xyzw:[0,0,1,0] as [number,number,number,number]};act(()=>current.change({...declarations(),occurrences:[{...declarations().occurrences[0]!,placement}]}));await ready();api.lose();fireEvent.click(screen.getByText('Save'));await screen.findByText('Committed response lost');api.deny(true);fireEvent(window,new Event('focus'));await screen.findByText('Withdrawn');api.deny(false);fireEvent.click(screen.getByText('Refresh'));await ready();expect(current.current?.state).toBe('draft-v4');fireEvent.click(screen.getByText('Save'));await waitFor(()=>expect(current.current?.state).toBe('draft-v5'));expect(api.posts[1]).toMatchObject({idempotency_key:api.posts[0]!.idempotency_key,expected_state:'draft-v4',payload:{assembly:{occurrences:[{placement}]}}});
});
test('lost Freeze response retries its original saved baseline and adopts only its own accepted token',async()=>{
 const api=server();setup();await saved();api.lose();fireEvent.click(screen.getByText('Freeze'));await screen.findByText('Committed response lost');api.remoteRemovesChild();fireEvent(window,new Event('focus'));await ready();expect(current.current?.state).toBe('draft-v4');fireEvent.click(screen.getByText('Freeze'));await waitFor(()=>expect(current.current?.state).toBe('draft-v6'));expect(api.posts[1]).toMatchObject({operation:'assembly.freeze',expected_state:'draft-v4',idempotency_key:api.posts[0]!.idempotency_key});
});
test('accepted save from a replaced principal cannot disclose or overwrite the new session',async()=>{
 const api=server();const view=setup();await saved();act(()=>current.change(declarations('Old private edit')));await ready();api.hold();fireEvent.click(screen.getByText('Save'));await waitFor(()=>expect(api.posts).toHaveLength(1));view.rerender(view.tree({principalKey:'replacement'}));await act(async()=>api.release());await ready();expect(current.message).not.toBe('Saved device draft.');
});
