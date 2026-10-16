import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { blankPart, partValue, type Content, type Draft, type PartRecord } from './api';
import { usePartSession, type SessionProps } from './usePartSession';
const reply = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
const saved = (state = 'draft-v4', value = 'Saved value'): Draft => ({ kind: 'draft', draft_id: 'draft', state, base_revision_id: 'r1', content: { ...blankPart(), legacy: { preserved: ['authored'] }, part: { ...partValue(blankPart())!, value } } });
const frozen = (number: number): PartRecord => ({ definition_id: 'part', workspace_id: 'workspace', name: 'Synthetic part', kind: 'part', selected: { kind: 'revision', revision_id: `r${number}`, number, snapshot_id: `s${number}`, sha256: String(number).repeat(64), content: { ...blankPart(), part: { ...partValue(blankPart())!, value: `Frozen ${number}` } } } });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
function server() {
  const calls: string[] = [], commands: { operation: string; payload: Record<string, unknown>; expected_state: string; idempotency_key: string }[] = [];
  let denied = false, stale = false, state = 'draft-v4';
  vi.stubGlobal('fetch', vi.fn(async (input: string, init?: RequestInit) => {
    const path = String(input); calls.push(path);
    if (denied) return reply({ error: { message: 'Current source denied' } }, 403);
    if (path === '/api/v0/operations') {
      const body = JSON.parse(String(init?.body)); commands.push(body);
      if (stale) return reply({ error: { message: 'Draft changed since expected state.' } }, 409);
      if (body.operation === 'draft.update') return reply({ result: { ...saved('draft-v5'), content: Object.fromEntries(Object.entries(body.payload.changes as Content).reverse()) } });
      if (body.operation === 'definition.create') return reply({ result: { ...saved('draft-v1'), definition_id: 'created', content: body.payload.content } });
      return reply({ result: { number: 3, draft: saved('draft-v6') } });
    }
    if (path.includes('revision-labels')) { const params = new URL(path, 'http://synthetic').searchParams; return reply({ labels: params.getAll('revision_ids').map(revision_id => ({ revision_id, readable: true })) }); }
    const params = new URL(path, 'http://synthetic').searchParams;
    const number = params.get('revision_number');
    if (number === '999') return reply({ error: { message: 'The requested exact revision is unavailable.' } }, 404);
    return reply(params.has('working') || params.has('draft_id') ? { definition_id: 'part', workspace_id: 'workspace', name: 'Synthetic part', kind: 'part', selected: saved(state) } : frozen(Number(number ?? 2)));
  }));
  return { calls, commands, deny: (value: boolean) => { denied = value; }, stale: () => { stale = true; }, updateState: () => { state = 'draft-v8'; } };
}
function mount(changes: Partial<SessionProps> = {}) {
  const props: SessionProps = { active: true, principalKey: 'owner', workspaceId: 'workspace', definitionId: 'part', revisionNumber: 1, draftRequested: false, initial: { kind: 'part', content: blankPart() }, onCreated: vi.fn(), onSelect: vi.fn(), ...changes };
  return { props, ...renderHook((next: SessionProps) => usePartSession(next), { initialProps: props }) };
}
test('reads the requested exact state without histories; unknown rN never falls forward', async () => {
  const api = server(), { result, rerender, props } = mount(); await waitFor(() => expect(result.current.ready).toBe(true));
  expect(partValue(result.current.content!)?.value).toBe('Frozen 1'); expect(api.calls).toEqual(['/api/v0/catalog/definitions/part/record?revision_number=1']);
  rerender({ ...props, revisionNumber: 999 }); expect(result.current.ready).toBe(false);
  await waitFor(() => expect(result.current.error).toContain('requested exact revision'));
  expect(result.current.ready).toBe(false); expect(api.calls.some(path => path.includes('revision_number=2'))).toBe(false);
});
test('exact back/forward inspection preserves the separate working buffer and original CAS token', async () => {
  server(); const { result, props, rerender } = mount({ revisionNumber: null, draftRequested: true }); await waitFor(() => expect(result.current.ready).toBe(true));
  act(() => result.current.change({ ...result.current.buffer, part: { ...partValue(result.current.buffer)!, value: 'Local retained value' } }));
  rerender({ ...props, active: false }); rerender({ ...props, revisionNumber: 1, draftRequested: false }); await waitFor(() => expect(result.current.ready).toBe(true)); expect(partValue(result.current.content!)?.value).toBe('Frozen 1');
  rerender({ ...props, revisionNumber: 2, draftRequested: false }); await waitFor(() => expect(result.current.ready).toBe(true)); expect(partValue(result.current.content!)?.value).toBe('Frozen 2');
  rerender(props); await waitFor(() => expect(result.current.ready).toBe(true)); expect(partValue(result.current.buffer)?.value).toBe('Local retained value'); expect(result.current.base?.state).toBe('draft-v4'); expect(result.current.dirty).toBe(true);
});
test('current authority denial hides retained state; recovery keeps unsaved content and stale CAS', async () => {
  const api = server(), { result } = mount({ revisionNumber: null, draftRequested: true }); await waitFor(() => expect(result.current.ready).toBe(true));
  act(() => result.current.change({ ...result.current.buffer, part: { ...partValue(result.current.buffer)!, value: 'Private local edit' } }));
  api.deny(true); await act(async () => result.current.refresh()); expect(result.current.ready).toBe(false); expect(result.current.error).toBe('Current source denied');
  api.deny(false); api.updateState(); await act(async () => result.current.refresh()); expect(result.current.ready).toBe(true); expect(partValue(result.current.buffer)?.value).toBe('Private local edit'); expect(result.current.base?.state).toBe('draft-v4'); expect(result.current.notice).toContain('newer saved draft');
});
test('save normalizes reordered object keys without a phantom edit or undo; legacy fields persist', async () => {
  const api = server(), { result } = mount({ revisionNumber: null, draftRequested: true }); await waitFor(() => expect(result.current.ready).toBe(true));
  act(() => result.current.change({ ...result.current.buffer, part: { ...partValue(result.current.buffer)!, value: 'Edited value' } }));
  await act(async () => result.current.save()); expect(result.current.dirty).toBe(false); expect(result.current.canUndo).toBe(false);
  expect(api.commands[0]!.payload.changes).toMatchObject({ legacy: { preserved: ['authored'] }, part: { value: 'Edited value' } }); expect(api.commands[0]!.expected_state).toBe('draft-v4');
});
test('stale save never overwrites/reloads the buffer and retry keeps the same reviewed intent key', async () => {
  const api = server(), { result } = mount({ revisionNumber: null, draftRequested: true }); await waitFor(() => expect(result.current.ready).toBe(true));
  act(() => result.current.change({ ...result.current.buffer, part: { ...partValue(result.current.buffer)!, value: 'CAS buffer' } })); api.stale();
  await act(async () => result.current.save()); await act(async () => result.current.save()); expect(result.current.ready).toBe(true); expect(result.current.dirty).toBe(true); expect(partValue(result.current.buffer)?.value).toBe('CAS buffer'); expect(result.current.base?.state).toBe('draft-v4');
  expect(api.commands).toHaveLength(2); expect(api.commands[0]!.idempotency_key).toBe(api.commands[1]!.idempotency_key);
});
test('held historical read cannot replace a later exact target', async () => {
  let release!: (value: Response) => void;
  vi.stubGlobal('fetch', vi.fn((path: string) => path.includes('revision_number=1') ? new Promise<Response>(resolve => { release = resolve; }) : Promise.resolve(reply(frozen(2)))));
  const { result, props, rerender } = mount(); rerender({ ...props, revisionNumber: 2 }); await waitFor(() => expect(result.current.ready).toBe(true));
  await act(async () => release(reply(frozen(1)))); expect(partValue(result.current.content!)?.value).toBe('Frozen 2');
});
test('new buffers are local until save and inactive completion cannot open a different page', async () => {
  let release!: (value: Response) => void;
  const calls: string[] = []; vi.stubGlobal('fetch', vi.fn((path: string) => { calls.push(path); return new Promise<Response>(resolve => { release = resolve; }); }));
  const { result, props, rerender } = mount({ definitionId: null, revisionNumber: null }); await waitFor(() => expect(result.current.ready).toBe(true)); expect(calls).toEqual([]);
  act(() => result.current.setName('Synthetic new part')); let saving!: Promise<void>; act(() => { saving = result.current.save(); }); rerender({ ...props, active: false });
  await act(async () => { release(reply({ result: { ...saved('draft-v1'), definition_id: 'created' } })); await saving; }); expect(props.onCreated).toHaveBeenCalledWith('created', false);
});

test('domain references authorize both saved and retained buffers and fence a changed local pin before disclosure', async () => {
  server(); let denied = false;
  const authorizeContent = vi.fn(async (content: Content) => { if (content.domain_pin === 'private' && denied) throw new Error('Retained domain pin denied'); });
  const { result, props, rerender } = mount({ revisionNumber: null, draftRequested: true, authorizeContent });
  await waitFor(() => expect(result.current.ready).toBe(true));
  act(() => result.current.change({ ...result.current.buffer, domain_pin: 'private' }));
  expect(result.current.ready).toBe(false);
  await waitFor(() => expect(result.current.ready).toBe(true));
  denied = true; rerender({ ...props, active: false }); rerender(props);
  await waitFor(() => expect(result.current.error).toBe('Retained domain pin denied'));
  expect(result.current.ready).toBe(false); expect(result.current.buffer.domain_pin).toBe('private');
  denied = false; await act(async () => result.current.refresh());
  expect(result.current.ready).toBe(true); expect(result.current.base?.state).toBe('draft-v4'); expect(result.current.buffer.domain_pin).toBe('private');
  expect(authorizeContent.mock.calls.some(([content]) => content.domain_pin === undefined)).toBe(true);
  expect(authorizeContent.mock.calls.some(([content]) => content.domain_pin === 'private')).toBe(true);
});

test('an explicit domain freeze uses the shared original CAS and returned revision navigation', async () => {
  const api = server(), { result, props } = mount({ revisionNumber: null, draftRequested: true, freezeOperation: 'interface.freeze' });
  await waitFor(() => expect(result.current.ready).toBe(true));
  await act(async () => result.current.freeze());
  expect(api.commands).toHaveLength(1);
  expect(api.commands[0]).toMatchObject({ operation: 'interface.freeze', payload: { draft_id: 'draft' }, expected_state: 'draft-v4' });
  expect(props.onSelect).toHaveBeenCalledWith(3, false);
  expect(result.current.base?.state).toBe('draft-v6');
});
