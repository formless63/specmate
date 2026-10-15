import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { useConnectorSession, type ConnectorSessionProps } from './useConnectorSession';
import { initialInterface, type Body } from './api';
const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
function server() {
  const calls: string[] = [], posts: Record<string, unknown>[] = [];
  let deny = false, invalid = false, multiple = false, version = 4, held: Promise<void> | null = null, release: (() => void) | null = null;
  vi.stubGlobal('fetch', vi.fn(async (path: string, init?: RequestInit) => {
    calls.push(path);
    if (deny) return reply({ error: { message: 'Authority denied' } }, 403);
    if (path.includes('/workspace/library/')) return reply({ record_id: 'body', label: 'Synthetic body', kind: 'connector_body', latest_revision: 77, latest_revision_id: 'r77' });
    if (path.includes('/catalog/definitions/')) return reply({ definition_id: 'body', drafts: multiple ? [{ draft_id: 'd2', state: 'draft-v1' }, { draft_id: 'd1', state: 'draft-v4' }] : [{ draft_id: 'd1' }], revisions: path.includes('offset=50') ? [{ number: 77, revision_id: 'r77' }] : [{ number: 1, revision_id: 'r1' }] });
    if (path.includes('/interfaces/drafts/')) return reply({ definition_id: 'body', draft_id: path.endsWith('d2') ? 'd2' : 'd1', state: `draft-v${version}`, content: { interface: initialInterface('connector_body') } });
    if (path.includes('/interfaces/revisions/')) return reply({ definition_id: 'body', revision_id: path.endsWith('r77') ? 'r77' : 'r1', interface: { ...initialInterface('connector_body'), family: path.endsWith('r77') ? 'exact 77' : 'exact 1' } });
    if (path.endsWith('/operations')) {
      const command = JSON.parse(String(init?.body)); posts.push(command); if (held) await held;
      if (command.expected_state !== `draft-v${version}`) return reply({ error: { message: 'Draft changed' } }, 409);
      if (invalid) return reply({ error: { message: 'Invalid local contacts' } }, 422);
      version += 1;
      const draft = { draft_id: 'd1', state: `draft-v${version}`, content: { interface: command.payload.interface ?? initialInterface('connector_body') } };
      return reply({ result: command.operation === 'interface.freeze' ? { number: 78, draft } : draft });
    }
    throw new Error(`Unexpected read ${path}`);
  }));
  return { calls, posts, multiple: () => { multiple = true; }, deny: (value: boolean) => { deny = value; }, invalid: (value: boolean) => { invalid = value; }, advance: () => { version = 9; }, hold: () => { held = new Promise<void>(resolve => { release = resolve; }); return () => release?.(); } };
}
function mount(changes: Partial<ConnectorSessionProps> = {}) {
  const props: ConnectorSessionProps = { definitionId: 'body', revisionNumber: null, draftRequested: true, active: true, workspaceId: 'w1', principalKey: 'owner', onSelect: vi.fn(), onCreated: vi.fn(), ...changes };
  const hook = renderHook(next => useConnectorSession(next), { initialProps: props }); return { ...hook, props };
}
test('reads only one exact beyond-first-page revision, no collection content or workspace definitions', async () => {
  const api = server(); const { result } = mount({ revisionNumber: 77, draftRequested: false });
  await waitFor(() => expect(result.current.ready).toBe(true));
  expect((result.current.frozen?.interface as Body).family).toBe('exact 77');
  expect(api.calls.filter(path => path.includes('/catalog/definitions/'))).toEqual(['/api/v0/catalog/definitions/body?offset=50']);
  expect(api.calls.some(path => path.includes('/workspace/definitions') || path.includes('/drafts/'))).toBe(false);
});
test('cached draft denial/recovery preserves buffer and original CAS, then save/freeze/save consumes returned tokens', async () => {
  const api = server(); const { result } = mount(); await waitFor(() => expect(result.current.ready).toBe(true));
  act(() => result.current.change({ ...result.current.buffer as Body, family: 'Unsaved family' }));
  api.deny(true); await act(() => result.current.refresh()); expect(result.current.ready).toBe(false);
  api.deny(false); api.advance(); await act(() => result.current.refresh()); expect(result.current.ready).toBe(true);
  expect((result.current.buffer as Body).family).toBe('Unsaved family'); expect(result.current.base?.state).toBe('draft-v4');
  await act(() => result.current.save()); expect(api.posts[0]?.expected_state).toBe('draft-v4'); expect(result.current.error).toBe('Draft changed'); expect(result.current.ready).toBe(true);
  await act(() => result.current.refresh(true)); act(() => result.current.change({ ...result.current.buffer as Body, family: 'After deliberate reload' }));
  await act(() => result.current.save()); expect(api.posts[1]?.expected_state).toBe('draft-v9');
  await act(() => result.current.freeze()); expect(api.posts[2]?.expected_state).toBe('draft-v10');
  act(() => result.current.change({ ...result.current.buffer as Body, family: 'After freeze' })); await act(() => result.current.save()); expect(api.posts[3]?.expected_state).toBe('draft-v11');
});
test('validation failure keeps invalid local draft editable and retains the save token', async () => {
  const api = server(); const { result } = mount(); await waitFor(() => expect(result.current.ready).toBe(true));
  act(() => result.current.change({ ...result.current.buffer as Body, family: 'First' })); api.invalid(true); await act(() => result.current.save());
  expect(result.current.error).toBe('Invalid local contacts'); expect(result.current.ready).toBe(true);
  act(() => result.current.change({ ...result.current.buffer as Body, family: 'Corrected locally' })); expect((result.current.buffer as Body).family).toBe('Corrected locally'); expect(result.current.base?.state).toBe('draft-v4');
});
test('held save is ignored after a same-ID principal boundary and cannot select another context', async () => {
  const api = server(); const { result, rerender, props } = mount(); await waitFor(() => expect(result.current.ready).toBe(true));
  const release = api.hold(); let pending: Promise<void>;
  act(() => { pending = result.current.save(); });
  rerender({ ...props, principalKey: 'viewer' }); await act(async () => { release(); await pending; });
  expect(props.onCreated).not.toHaveBeenCalled(); expect(props.onSelect).not.toHaveBeenCalled(); expect(result.current.base?.state).toBe('draft-v4');
});

test('multiple editable drafts require an explicit exact choice instead of catalog order', async () => {
  const api = server(); api.multiple(); const { result } = mount();
  await waitFor(() => expect(result.current.needsDraftChoice).toBe(true)); expect(result.current.ready).toBe(false); expect(api.calls.some(path => path.includes('/interfaces/drafts/'))).toBe(false);
  act(() => result.current.chooseDraft('d1')); await waitFor(() => expect(result.current.ready).toBe(true)); expect(api.calls.filter(path => path.includes('/interfaces/drafts/'))).toEqual(['/api/v0/interfaces/drafts/d1']);
});
