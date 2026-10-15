import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError } from '../workspace/api';
import { command, PcbRequestError } from '../pcb/api';
import { randomUUID } from '../../lib/random-id';
import { usePermission, type PermissionName } from '../../lib/permissions';
import { authorizeWorkingPins, exactUuid, uniquePins, type WorkingPins } from './working-authority';

export type ContextDraft<T> = { definition_id: string; draft_id: string; state: string; value: T; raw?: unknown };
export type ContextAdapter<T, F> = {
  kind: string; create: string; update: string; freeze: string; createPermission?: PermissionName;
  initial: () => T; pins: (value: T) => WorkingPins; complete: (value: T) => boolean;
  readDraft: (id: string, signal?: AbortSignal) => Promise<ContextDraft<T>>;
  readFrozen: (id: string, signal?: AbortSignal) => Promise<F>;
  fromOperation: (result: unknown) => ContextDraft<T>;
  payload: (value: T) => object;
};
const isDenied = (failure: unknown) => (failure instanceof ApiError || failure instanceof PcbRequestError) && [401, 403, 404].includes(failure.status);
/** A contextual subrecord owns its buffer/CAS independently of the primary board state. */
export function useContextRecord<T, F>({ adapter, active, principalKey, workspaceId, scopeKey }: { adapter: ContextAdapter<T, F>; active: boolean; principalKey: string; workspaceId: string; scopeKey: string }) {
  const cache = useQueryClient(); const edit = usePermission('design.edit'); const create = usePermission(adapter.createPermission ?? 'item.create'); const freezeGate = usePermission('design.freeze');
  const [value, setValue] = useState<T>(adapter.initial); const [name, setName] = useState(''); const [current, setCurrent] = useState<ContextDraft<T> | null>(null);
  const [dirty, setDirty] = useState(true); const [frozenId, setFrozen] = useState<string | null>(null); const [busy, setBusy] = useState(false); const [blocked, setBlocked] = useState(false); const [error, setError] = useState('');
  const edits = useRef(0); const epoch = useRef(0); const mounted = useRef(false); const inFlight = useRef(false); const intents = useRef(new Map<string, string>());
  const gate = current ? edit : create;
  useEffect(() => { mounted.current = true; epoch.current += 1; inFlight.current = false; intents.current.clear(); setCurrent(null); setValue(adapter.initial()); setName(''); setDirty(true); setFrozen(null); setBlocked(false); setError(''); setBusy(false); return () => { mounted.current = false; epoch.current += 1; }; }, [principalKey, workspaceId, scopeKey]);
  const pins = uniquePins(adapter.pins(value)); const incomplete = !adapter.complete(value) || [...pins.revisions, ...pins.sources].some(id => !exactUuid(id));
  const authority = useQuery({ queryKey: ['context-record-authority', principalKey, workspaceId, scopeKey, adapter.kind, current?.draft_id, JSON.stringify(pins)], enabled: active && !incomplete, retry: false, refetchOnWindowFocus: 'always', queryFn: async ({ signal }) => {
    if (current) await adapter.readDraft(current.draft_id, signal);
    await authorizeWorkingPins(pins, workspaceId, signal); return true;
  } });
  const saved = useQuery({ queryKey: ['context-record-saved', principalKey, scopeKey, adapter.kind, current?.draft_id], enabled: active && !!current, retry: false, queryFn: ({ signal }) => adapter.readDraft(current!.draft_id, signal) });
  const frozen = useQuery({ queryKey: ['context-record-frozen', principalKey, scopeKey, adapter.kind, frozenId], enabled: active && !!frozenId, retry: false, queryFn: ({ signal }) => adapter.readFrozen(frozenId!, signal) });
  useEffect(() => { if (!active) return; const refresh = () => { if (!incomplete) void authority.refetch(); if (current) void saved.refetch(); if (frozenId) void frozen.refetch(); }; window.addEventListener('focus', refresh); return () => window.removeEventListener('focus', refresh); }, [active, incomplete, current?.draft_id, frozenId, authority.refetch, saved.refetch, frozen.refetch]);
  const checking = !incomplete && (authority.isPending || authority.isFetching) || !!current && (saved.isPending || saved.isFetching) || !!frozenId && (frozen.isPending || frozen.isFetching);
  const unavailable = blocked || authority.isError || saved.isError || frozen.isError;
  const enabled = useRef({ active, checking, unavailable, incomplete, allowed: gate.allowed, canFreeze: freezeGate.allowed, canCreate: create.allowed }); enabled.current = { active, checking, unavailable, incomplete, allowed: gate.allowed, canFreeze: freezeGate.allowed, canCreate: create.allowed };
  const intentKey = (operation: string, payload: object, state?: string) => { const fingerprint = JSON.stringify([operation, payload, state]); const key = intents.current.get(fingerprint) ?? randomUUID(); intents.current.set(fingerprint, key); if (intents.current.size > 8) intents.current.delete(intents.current.keys().next().value!); return key; };
  const change = (next: T) => { if (!enabled.current.active || !enabled.current.allowed || enabled.current.unavailable || enabled.current.checking || inFlight.current) return; edits.current += 1; setValue(next); setDirty(true); };
  async function perform<R>(operation: string, payload: object, state: string | undefined, apply: (result: R) => void, permission: boolean) {
    if (!mounted.current || !enabled.current.active || !permission || enabled.current.unavailable || enabled.current.checking || inFlight.current) return;
    const token = epoch.current; inFlight.current = true; setBusy(true); setError('');
    try { const result = await command<R>(operation, payload, undefined, state, intentKey(operation, payload, state)); if (mounted.current && token === epoch.current) apply(result); }
    catch (failure) { if (mounted.current && token === epoch.current) { setError(failure instanceof Error ? failure.message : String(failure)); if (isDenied(failure)) setBlocked(true); } }
    finally { if (mounted.current && token === epoch.current) { inFlight.current = false; setBusy(false); } }
  }
  const save = async () => {
    if (incomplete || !current && !name.trim()) return; const submitted = edits.current; const operation = current ? adapter.update : adapter.create;
    await perform<unknown>(operation, { ...(current ? { draft_id: current.draft_id } : { name: name.trim(), workspace_id: workspaceId }), ...adapter.payload(value) }, current?.state, result => {
      const draft = adapter.fromOperation(result); setCurrent(draft); if (submitted === edits.current) { setValue(structuredClone(draft.value)); setDirty(false); }
      cache.setQueryData(['context-record-saved', principalKey, scopeKey, adapter.kind, draft.draft_id], draft);
      void cache.invalidateQueries({ queryKey: ['workspace', 'library'] });
    }, enabled.current.allowed);
  };
  const freeze = async () => {
    if (!current || dirty || incomplete) return;
    await perform<{ revision_id: string; draft: { state: string } }>(adapter.freeze, { draft_id: current.draft_id }, current.state, result => { setCurrent({ ...current, state: result.draft.state }); setFrozen(result.revision_id); }, enabled.current.canFreeze);
  };
  const load = async (id: string, label: string) => {
    if (!mounted.current || !enabled.current.active || inFlight.current) return; const token = epoch.current; inFlight.current = true; setBusy(true); setError('');
    try { const draft = await adapter.readDraft(id); if (mounted.current && token === epoch.current) { setCurrent(draft); setValue(structuredClone(draft.value)); setName(label); setDirty(false); setFrozen(null); setBlocked(false); } }
    catch (failure) { if (mounted.current && token === epoch.current) { setError(failure instanceof Error ? failure.message : String(failure)); if (isDenied(failure)) setBlocked(true); } }
    finally { if (mounted.current && token === epoch.current) { inFlight.current = false; setBusy(false); } }
  };
  const refresh = async () => { if (!active || !mounted.current) return; const token = epoch.current; try { if (!incomplete) await authority.refetch({ throwOnError: true }); if (current) await saved.refetch({ throwOnError: true }); if (frozenId) await frozen.refetch({ throwOnError: true }); if (mounted.current && token === epoch.current) setBlocked(false); } catch (failure) { if (mounted.current && token === epoch.current) setError(failure instanceof Error ? failure.message : String(failure)); } };
  return { value, change, name, setName: (next: string) => { if (active && gate.allowed && !busy && !current && !unavailable && !checking) setName(next); }, current, dirty, busy, incomplete, checking, unavailable, error, gate, freezeGate,
    save, freeze, load, refresh, saved, frozen, frozenId, failAuthority: (failure: unknown) => { if (isDenied(failure)) setBlocked(true); }, inspect: (id: string) => { if (active && !busy) setFrozen(id); }, newRecord: () => { if (enabled.current.active && !inFlight.current && enabled.current.canCreate) { epoch.current += 1; edits.current += 1; setCurrent(null); setValue(adapter.initial()); setName(''); setDirty(true); setFrozen(null); setBlocked(false); setError(''); } } };
}
