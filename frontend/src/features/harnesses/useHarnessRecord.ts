import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { usePermission } from '../../lib/permissions';
import { randomUUID } from '../../lib/random-id';
import { authorizeConnectorReferences } from '../interfaces/connector-api';
import type { Identity } from '../identity/api';
import { ApiError, requestJson, runOperation, type LibraryRecord } from '../workspace/api';
import { initialHarness, type Harness, type Draft } from './api';
export type HarnessRecordProps = { active: boolean; principalKey: string; workspaceId: string; definitionId: string | null; revisionNumber: number | null; draftRequested: boolean; onCreated: (id: string, open: boolean) => void; onSelect: (number: number | null, draft?: boolean) => void };
type Pin = { revision_id: string; number: number; snapshot_id: string; sha256: string };
type Selected = { definition_id: string; workspace_id: string; name: string; kind: string; selected: (Pin & { kind: 'revision'; content: { harness: Harness } }) | ({ kind: 'draft'; draft_id: string; state: string; base_revision_id?: string | null; content: { harness: Harness } }) };
export const deniedHarness = (failure: unknown) => !!failure && typeof failure === 'object' && 'status' in failure && [401, 403, 404].includes(Number(failure.status));
export function harnessReferences(value: unknown): string[] {
  const found = new Set<string>();
  function visit(item: unknown) { if (item && typeof item === 'object') for (const [key, field] of Object.entries(item)) { if (key.endsWith('_revision_id') && typeof field === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(field)) found.add(field); else if (typeof field === 'object') visit(field); } }
  visit(value); return [...found].sort();
}
/** A retained working buffer never substitutes for an exact frozen selection. */
export function useHarnessRecord(props: HarnessRecordProps) {
  const { active, principalKey, workspaceId, definitionId, revisionNumber, draftRequested } = props;
  const cache = useQueryClient(), edit = usePermission(definitionId ? 'design.edit' : 'item.create'), freezeGate = usePermission('design.freeze');
  const key = ['harness-record', principalKey, workspaceId, definitionId];
  const [value, setValue] = useState(initialHarness), [name, setName] = useState(''), [current, setCurrent] = useState<Draft | null>(null), [dirty, setDirty] = useState(!definitionId), [busy, setBusy] = useState(false), [blocked, setBlocked] = useState(false), [error, setError] = useState(''), [message, setMessage] = useState('');
  const [choice, setChoice] = useState<string | null>(null), [history, setHistory] = useState(false), [details, setDetails] = useState(false), [offset, setOffset] = useState(0), [editorEpoch, setEditorEpoch] = useState(0);
  const alive = useRef(false), lifetime = useRef(0), changes = useRef(0), inFlight = useRef(false), intents = useRef(new Map<string, string>());
  const target = JSON.stringify([active, definitionId, revisionNumber, draftRequested, choice]); const latest = useRef(target); latest.current = target;
  useEffect(() => { alive.current = true; lifetime.current += 1; inFlight.current = false; intents.current.clear(); setValue(initialHarness()); setName(''); setCurrent(null); setDirty(!definitionId); setChoice(null); setBusy(false); setBlocked(false); setError(''); setMessage(''); return () => { alive.current = false; lifetime.current += 1; }; }, [principalKey, workspaceId]);
  const selected = useQuery({ queryKey: [...key, 'selected', revisionNumber, draftRequested, choice], enabled: active && !!definitionId, retry: false, queryFn: async ({ signal }) => {
    const query = new URLSearchParams({ include_content: 'true' }); if (revisionNumber !== null) query.set('revision_number', String(revisionNumber)); else if (draftRequested) { query.set('working', 'true'); if (choice) query.set('draft_id', choice); }
    const result = await requestJson<Selected>(`/api/v0/catalog/definitions/${definitionId}/record?${query}`, { signal, cache: 'no-store' });
    if (result.definition_id !== definitionId || result.workspace_id !== workspaceId || result.kind !== 'harness' || !result.selected.content.harness || revisionNumber !== null && (result.selected.kind !== 'revision' || result.selected.number !== revisionNumber)) throw new Error('The selected exact harness state is unavailable. No alternate revision was substituted.'); return result;
  } });
  const state = selected.data?.selected, editing = !definitionId || revisionNumber === null && (draftRequested || state?.kind === 'draft');
  const needsChoice = editing && selected.isError && selected.error instanceof ApiError && selected.error.status === 422 && selected.error.message.includes('explicit working draft');
  const identity = useQuery({ queryKey: [...key, 'history', offset], enabled: active && !!definitionId && (history || needsChoice), retry: false, queryFn: ({ signal }) => requestJson<Identity>(`/api/v0/catalog/definitions/${definitionId}?offset=${offset}&limit=50`, { signal }) });
  const metadata = useQuery({ queryKey: [...key, 'metadata'], enabled: active && details && !!definitionId, retry: false, queryFn: ({ signal }) => requestJson<LibraryRecord>(`/api/v0/workspace/library/${definitionId}`, { signal }) });
  const pins = harnessReferences({ value, base_revision_id: current?.base_revision_id });
  const working = useQuery({ queryKey: [...key, 'working', pins], enabled: active && editing, retry: false, refetchOnWindowFocus: 'always', queryFn: async ({ signal }) => {
    if (!definitionId) { const access = await requestJson<{ workspace_id: string }>('/api/v0/access/workspace', { signal, cache: 'no-store' }); if (access.workspace_id !== workspaceId) throw new ApiError(404, 'Workspace unavailable.'); }
    await authorizeConnectorReferences({ value, base_revision_id: current?.base_revision_id }); return true;
  } });
  useEffect(() => { if (editing && state?.kind === 'draft' && !(dirty && current?.draft_id === state.draft_id)) { setCurrent({ definition_id: definitionId!, draft_id: state.draft_id, state: state.state, base_revision_id: state.base_revision_id, content: state.content }); setValue(structuredClone(state.content.harness)); setDirty(false); } }, [selected.data]);
  const checking = !!definitionId && !needsChoice && (selected.isPending || selected.isFetching) || editing && (working.isPending || working.isFetching);
  const unavailable = blocked || !needsChoice && selected.isError || editing && working.isError;
  const enabled = useRef({ active, checking, unavailable, edit: edit.allowed, freeze: freezeGate.allowed }); enabled.current = { active, checking, unavailable, edit: edit.allowed, freeze: freezeGate.allowed };
  async function refresh() {
    if (!active || !alive.current) return; const generation = lifetime.current;
    try { if (definitionId) await selected.refetch({ throwOnError: true }); if (editing) await working.refetch({ throwOnError: true }); if (alive.current && generation === lifetime.current) setBlocked(false); }
    catch (failure) { if (alive.current && generation === lifetime.current) setError(failure instanceof Error ? failure.message : String(failure)); }
  }
  useEffect(() => { if (!active) return; const focus = () => { if (document.visibilityState !== 'hidden') { if (definitionId) void selected.refetch(); if (editing) void working.refetch(); } }; window.addEventListener('focus', focus); document.addEventListener('visibilitychange', focus); return () => { window.removeEventListener('focus', focus); document.removeEventListener('visibilitychange', focus); }; }, [active, definitionId, editing, selected.refetch, working.refetch]);
  function change(next: Harness) { if (!enabled.current.active || !enabled.current.edit || enabled.current.checking || enabled.current.unavailable || !editing) return; changes.current += 1; setValue(next); setDirty(true); }
  async function command<T>(operation: string, payload: object, expected: string | undefined, permission: boolean, apply: (result: T, unchanged: boolean, sameTarget: boolean) => void | Promise<void>) {
    if (!alive.current || !enabled.current.active || !permission || enabled.current.checking || enabled.current.unavailable || inFlight.current) return;
    const generation = lifetime.current, submitted = changes.current, selection = target; const fingerprint = JSON.stringify([operation, payload, expected]); let intent = intents.current.get(fingerprint); if (!intent) { intent = randomUUID(); intents.current.set(fingerprint, intent); } inFlight.current = true; setBusy(true); setError(''); setMessage('');
    try { const response = await runOperation<T>(operation, payload, { expectedState: expected, idempotencyKey: intent }); if (alive.current && generation === lifetime.current) await apply(response.result, submitted === changes.current, selection === latest.current); }
    catch (failure) { if (alive.current && generation === lifetime.current) { setError(failure instanceof Error ? failure.message : String(failure)); if (deniedHarness(failure)) setBlocked(true); } }
    finally { if (alive.current && generation === lifetime.current) { inFlight.current = false; setBusy(false); } }
  }
  async function save() {
    if (!editing || !definitionId && !name.trim() || definitionId && !current) return;
    await command<Draft>(definitionId ? 'harness.update' : 'harness.create', { ...(current ? { draft_id: current.draft_id } : { workspace_id: workspaceId, name: name.trim() }), harness: value }, current?.state, enabled.current.edit, async (result, unchanged, sameTarget) => {
      if (!result.content.harness) throw new Error('Saved harness content is unavailable.'); setCurrent(result); if (unchanged) { setValue(structuredClone(result.content.harness)); setDirty(false); } setMessage('Saved harness draft.'); if (!definitionId) props.onCreated(result.definition_id, sameTarget); await cache.invalidateQueries({ queryKey: ['workspace', 'designs'] }); await cache.invalidateQueries({ queryKey: ['workspace', 'library'] });
    });
  }
  async function freeze() {
    if (!editing || dirty || !current) return;
    await command<{ revision_id: string; number: number; draft?: Draft }>('harness.freeze', { draft_id: current.draft_id }, current.state, enabled.current.freeze, async (result, unchanged, sameTarget) => { if (result.draft) setCurrent(result.draft); await cache.invalidateQueries({ queryKey: [...key, 'selected'] }); setMessage('Frozen exact harness revision.'); if (unchanged && sameTarget) props.onSelect(result.number); });
  }
  async function reload() { if (!active || !editing || !definitionId || inFlight.current) return; const generation = lifetime.current; const result = await selected.refetch(); if (alive.current && generation === lifetime.current && result.isSuccess && result.data.selected.kind === 'draft') { const draft = result.data.selected; setCurrent({ definition_id: definitionId, draft_id: draft.draft_id, state: draft.state, base_revision_id: draft.base_revision_id, content: draft.content }); setValue(structuredClone(draft.content.harness)); setDirty(false); setEditorEpoch(old => old + 1); } }
  return { editing, current, workingValue: value, value: editing ? value : state?.kind === 'revision' ? state.content.harness : null, pin: state?.kind === 'revision' ? state : null, name: name || selected.data?.name || 'New harness', enteredName: name, setName: (next: string) => { if (enabled.current.active && enabled.current.edit && !enabled.current.checking && !enabled.current.unavailable && !definitionId && !busy) setName(next); }, dirty, busy, checking, unavailable, needsChoice, error, message, change, save, freeze, reload, refresh, identity, metadata, history, setHistory, setDetails, offset, setOffset, editorEpoch,
    chooseDraft: (id: string | null) => { if (active && !dirty && !busy) { setChoice(id); setCurrent(null); setEditorEpoch(old => old + 1); } }, failAuthority: (failure: unknown) => { if (deniedHarness(failure)) setBlocked(true); } };
}
