import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { usePermission } from '../../lib/permissions';
import { randomUUID } from '../../lib/random-id';
import { ApiError, requestJson, type LibraryRecord } from '../workspace/api';
import { SourceError } from '../sources/api';
import type { Identity } from '../identity/api';
import { authorizeWorkingPins, exactUuid } from '../boards/working-authority';
import type { CapturedScenePreview } from '../shared-scene/api';
import { command, type Assembly, type Draft } from './api';

type Revision = { revision_id: string; number: number };
export type DevicePin = Revision & { definition_id: string; snapshot_id: string; sha256: string };
type Frozen = { pin: DevicePin; assembly: Assembly };
type Capture = { snapshot_id: string; sha256?: string; draft?: Draft; revision_id?: string; number?: number };
export type DeviceRecordProps = { active: boolean; principalKey: string; workspaceId: string; definitionId: string | null; revisionNumber: number | null; draftRequested: boolean; initial?: { name: string; assembly: Assembly }; onCreated: (id: string, open: boolean) => void; onSelect: (number: number | null, draft?: boolean) => void };
export const emptyAssembly = (): Assembly => ({ schema_version: '0.1', occurrences: [], relationships: [], assignments: [] });
export function devicePins(value: Assembly, base?: string | null) {
  return [...new Set([...(base ? [base] : []), ...value.occurrences.flatMap(row => [row.revision_id, ...(row.assignments?.firmware_revision_id ? [row.assignments.firmware_revision_id] : [])]), ...(value.assignments ?? []).flatMap(row => row.assignments.firmware_revision_id ? [row.assignments.firmware_revision_id] : []), ...value.relationships.flatMap(row => Object.values(row).flatMap(ref => ref && typeof ref === 'object' && 'kind' in ref && ref.kind === 'revision' && 'revision_id' in ref ? [String(ref.revision_id)] : []))])].sort();
}
const denied = (error: unknown) => (error instanceof ApiError || error instanceof SourceError) && [401, 403, 404].includes(error.status);
/** One working declaration/CAS and one explicitly selected immutable scene basis. */
export function useDeviceRecord(props: DeviceRecordProps) {
  const { active, principalKey, workspaceId, definitionId, revisionNumber, draftRequested, initial } = props;
  const cache = useQueryClient(); const edit = usePermission(definitionId ? 'design.edit' : 'item.create'); const freezeGate = usePermission('design.freeze');
  const base = ['device-record', principalKey, workspaceId, definitionId];
  const [name, setName] = useState(initial?.name ?? ''); const [assembly, setAssembly] = useState<Assembly>(() => structuredClone(initial?.assembly ?? emptyAssembly()));
  const [current, setCurrent] = useState<Draft | null>(null); const [dirty, setDirty] = useState(!definitionId); const [draftChoice, setDraftChoice] = useState<string | null>(null);
  const [capture, setCapture] = useState<{ snapshotId: string; state: string; sha256: string } | null>(null);
  const [busy, setBusy] = useState(false); const [blocked, setBlocked] = useState(false); const [error, setError] = useState(''); const [message, setMessage] = useState('');
  const [history, setHistory] = useState(false); const [details, setDetails] = useState(false); const [offset, setOffset] = useState(0); const [editorEpoch, setEditorEpoch] = useState(0);
  const lifetime = useRef(0); const alive = useRef(false); const inFlight = useRef(false); const edits = useRef(0); const intents = useRef(new Map<string, string>());
  const selection = `${active}:${definitionId}:${revisionNumber}:${draftRequested}:${draftChoice}`; const latestSelection = useRef(selection); latestSelection.current = selection;
  useEffect(() => { alive.current = true; lifetime.current += 1; inFlight.current = false; intents.current.clear(); setCurrent(null); setName(initial?.name ?? ''); setAssembly(structuredClone(initial?.assembly ?? emptyAssembly())); setDirty(!definitionId); setDraftChoice(null); setCapture(null); setBusy(false); setBlocked(false); setError(''); setMessage(''); return () => { alive.current = false; lifetime.current += 1; }; }, [principalKey, workspaceId]);
  type SelectedRecord = { definition_id: string; workspace_id: string; name: string; kind: string; selected: ({ kind: 'revision'; revision_id: string; number: number; snapshot_id: string; sha256: string } | { kind: 'draft'; draft_id: string; state: string; base_revision_id?: string | null }) & { content: { assembly?: Assembly } } };
  const selected = useQuery({ queryKey: [...base, 'selected', revisionNumber, draftRequested, draftChoice], enabled: active && !!definitionId, retry: false, queryFn: async ({ signal }) => {
    const params = new URLSearchParams({ include_content: 'true' });
    if (revisionNumber !== null) params.set('revision_number', String(revisionNumber));
    else if (draftRequested) { params.set('working', 'true'); if (draftChoice) params.set('draft_id', draftChoice); }
    const result = await requestJson<SelectedRecord>(`/api/v0/catalog/definitions/${definitionId}/record?${params}`, { signal });
    if (result.definition_id !== definitionId || result.workspace_id !== workspaceId || result.kind !== 'assembly' || !result.selected.content.assembly || revisionNumber !== null && (result.selected.kind !== 'revision' || result.selected.number !== revisionNumber)) throw new Error('The exact selected device state is unavailable. No alternate snapshot was substituted.');
    return result;
  } });
  const editing = !definitionId || revisionNumber === null && (draftRequested || selected.data?.selected.kind === 'draft');
  const metadata = useQuery({ queryKey: [...base, 'metadata'], enabled: active && !!definitionId && details, retry: false, queryFn: ({ signal }) => requestJson<LibraryRecord>(`/api/v0/workspace/library/${definitionId}`, { signal }) });
  // Broad identity/history reads are optional. A different draft cannot withdraw a valid old revision.
  const identity = useQuery({ queryKey: [...base, 'identity', 0], enabled: active && !!definitionId && editing, retry: false, queryFn: ({ signal }) => requestJson<Identity>(`/api/v0/catalog/definitions/${definitionId}?offset=0&limit=50`, { signal }) });
  const selectedValue = selected.data?.selected;
  const revision: Revision | null = selectedValue?.kind === 'revision' ? { revision_id: selectedValue.revision_id, number: selectedValue.number } : null;
  const frozen = { ...selected, data: selectedValue?.kind === 'revision' && selectedValue.content.assembly ? { pin: { definition_id: definitionId!, revision_id: selectedValue.revision_id, number: selectedValue.number, snapshot_id: selectedValue.snapshot_id, sha256: selectedValue.sha256 }, assembly: selectedValue.content.assembly } as Frozen : undefined };
  const draftId = draftChoice ?? current?.draft_id ?? (selectedValue?.kind === 'draft' ? selectedValue.draft_id : null) ?? (identity.data?.drafts.length === 1 ? identity.data.drafts[0]!.draft_id : null);
  const needsDraftChoice = !!definitionId && editing && identity.isSuccess && !draftId;
  const draft = useQuery({ queryKey: [...base, 'draft', draftId], enabled: active && !!draftId && editing && !identity.isError, retry: false, queryFn: async ({ signal }) => {
    const result = await requestJson<Draft>(`/api/v0/assemblies/drafts/${draftId}`, { signal }); if (result.definition_id !== definitionId || !result.content.assembly) throw new Error('The selected draft is not this device.'); return result;
  } });
  const workingPins = devicePins(assembly, current?.base_revision_id);
  const working = useQuery({ queryKey: [...base, 'working-authority', workingPins], enabled: active && editing, retry: false, refetchOnWindowFocus: 'always', queryFn: async ({ signal }) => {
    if (!definitionId) { const access = await requestJson<{ workspace_id: string }>(`/api/v0/access/workspace?workspace_id=${workspaceId}`, { signal }); if (access.workspace_id !== workspaceId) throw new ApiError(403, 'Workspace unavailable.'); }
    if (workingPins.some(id => !exactUuid(id))) throw new Error('A working device pin is incomplete.'); await authorizeWorkingPins({ revisions: workingPins, sources: [] }, workspaceId, signal); return true;
  } });
  const captureWanted = editing && !!capture && !dirty && capture.state === current?.state;
  const captured = useQuery({ queryKey: [...base, 'captured-authority', capture?.snapshotId], enabled: active && captureWanted, retry: false, queryFn: async ({ signal }) => {
    const preview = await requestJson<CapturedScenePreview>(`/api/v0/shared-scenes/captured-snapshots/${capture!.snapshotId}/preview`, { signal });
    if (preview.snapshot_id !== capture!.snapshotId || preview.sha256 !== capture!.sha256 || preview.root.definition_id !== definitionId || preview.root.kind !== 'assembly' || preview.root.snapshot_sha256 !== capture!.sha256 || 'revision_id' in preview.root || preview.basis.kind !== 'captured_draft' || preview.basis.snapshot_id !== capture!.snapshotId || preview.basis.snapshot_sha256 !== capture!.sha256 || preview.basis.draft_id !== current?.draft_id || `draft-v${preview.basis.draft_version}` !== capture!.state) throw new Error('Captured scene basis does not match the selected saved device state.');
    return preview;
  } });
  const revisions = useQuery({ queryKey: [...base, 'identity', offset], enabled: active && history && !!definitionId, retry: false, queryFn: ({ signal }) => requestJson<Identity>(`/api/v0/catalog/definitions/${definitionId}?offset=${offset}&limit=50`, { signal }) });
  useEffect(() => { if (draft.isSuccess && draft.data && current?.draft_id !== draft.data.draft_id) { setCurrent(draft.data); setAssembly(structuredClone(draft.data.content.assembly)); setDirty(false); } }, [draft.data, draft.isSuccess]);
  const choosingDraft = editing && !draftId && identity.isSuccess && identity.data.drafts.length > 1;
  const checking = !!definitionId && (!choosingDraft && (selected.isPending || selected.isFetching) || editing && (identity.isPending || identity.isFetching || !!draftId && (draft.isPending || draft.isFetching))) || editing && (working.isPending || working.isFetching) || captureWanted && captured.isFetching;
  const unavailable = blocked || !choosingDraft && selected.isError || editing && (identity.isError || draft.isError || working.isError) || captureWanted && captured.isError;
  const enabled = useRef({ active, checking, unavailable, edit: edit.allowed, freeze: freezeGate.allowed }); enabled.current = { active, checking, unavailable, edit: edit.allowed, freeze: freezeGate.allowed };
  useEffect(() => { if (!active) return; const refresh = () => { if (definitionId) { void selected.refetch(); if (editing) { void identity.refetch(); if (draftId) void draft.refetch(); } } if (editing) void working.refetch(); if (capture && !dirty) void captured.refetch(); }; const visible = () => { if (document.visibilityState !== 'hidden') refresh(); }; window.addEventListener('focus', visible); document.addEventListener('visibilitychange', visible); return () => { window.removeEventListener('focus', visible); document.removeEventListener('visibilitychange', visible); }; }, [active, definitionId, draftId, editing, capture?.snapshotId, dirty, selected.refetch, identity.refetch, draft.refetch, working.refetch, captured.refetch]);
  const change = (value: Assembly) => { if (!enabled.current.active || !enabled.current.edit || enabled.current.checking || enabled.current.unavailable || !editing) return; edits.current += 1; setAssembly(value); setDirty(true); };
  const markStaged = () => { if (enabled.current.active && enabled.current.edit && !enabled.current.checking && !enabled.current.unavailable && editing) { edits.current += 1; setDirty(true); } };
  function keyFor(operation: string, payload: object, state?: string) { const fingerprint = JSON.stringify([operation, payload, state]); const key = intents.current.get(fingerprint) ?? randomUUID(); intents.current.set(fingerprint, key); if (intents.current.size > 8) intents.current.delete(intents.current.keys().next().value!); return key; }
  async function run<T>(operation: string, payload: object, state: string | undefined, permission: boolean, apply: (result: T, unchanged: boolean, sameSelection: boolean) => void | Promise<void>) {
    if (!alive.current || !enabled.current.active || !permission || enabled.current.checking || enabled.current.unavailable || inFlight.current) return;
    const token = lifetime.current; const submitted = edits.current; const chosen = selection; inFlight.current = true; setBusy(true); setError(''); setMessage('');
    try { const result = await command<T>(operation, payload, state, keyFor(operation, payload, state)); if (alive.current && token === lifetime.current) await apply(result, submitted === edits.current, chosen === latestSelection.current); }
    catch (failure) { if (alive.current && token === lifetime.current) { setError(failure instanceof Error ? failure.message : String(failure)); if (denied(failure)) setBlocked(true); } }
    finally { if (alive.current && token === lifetime.current) { inFlight.current = false; setBusy(false); } }
  }
  async function save() {
    if (!editing || !definitionId && !name.trim() || definitionId && !current) return;
    await run<Draft>(definitionId ? 'assembly.update' : 'assembly.create', { ...(current ? { draft_id: current.draft_id } : { name: name.trim(), workspace_id: workspaceId }), assembly }, current?.state, enabled.current.edit, async (result, unchanged, sameSelection) => {
      if (!result.content.assembly) throw new Error('Save returned no typed assembly.'); setCurrent(result); if (unchanged) { setAssembly(structuredClone(result.content.assembly)); setDirty(false); } cache.setQueryData(['device-record', principalKey, workspaceId, result.definition_id, 'draft', result.draft_id], result); setMessage('Saved device draft.');
      if (!definitionId) props.onCreated(result.definition_id, sameSelection); await cache.invalidateQueries({ queryKey: ['workspace', 'library'] }); await cache.invalidateQueries({ queryKey: ['workspace', 'designs'] });
    });
  }
  async function captureSaved(freeze: boolean) {
    if (!editing || !current || dirty) return;
    await run<Capture>(freeze ? 'assembly.freeze' : 'assembly.snapshot', { draft_id: current.draft_id }, current.state, freeze ? enabled.current.freeze : enabled.current.edit, async (result, unchanged, sameSelection) => {
      const next = result.draft ?? current; setCurrent(next); cache.setQueryData([...base, 'draft', next.draft_id], next); if (unchanged && !freeze) { if (!result.sha256) throw new Error('Capture returned no immutable snapshot hash.'); setCapture({ snapshotId: result.snapshot_id, state: next.state, sha256: result.sha256 }); }
      setMessage(freeze ? 'Frozen exact device revision.' : 'Captured saved device state.'); await cache.invalidateQueries({ queryKey: [...base, 'selected'] }); await cache.invalidateQueries({ queryKey: [...base, 'metadata'] }); await cache.invalidateQueries({ queryKey: [...base, 'identity'] }); if (freeze && result.number && unchanged && sameSelection) props.onSelect(result.number);
    });
  }
  async function refresh() {
    if (!alive.current || !active) return; const token = lifetime.current;
    try { if (definitionId) { await selected.refetch({ throwOnError: true }); if (editing) { await identity.refetch({ throwOnError: true }); if (draftId) await draft.refetch({ throwOnError: true }); } } if (editing) await working.refetch({ throwOnError: true }); if (capture && !dirty) await captured.refetch({ throwOnError: true }); if (alive.current && token === lifetime.current) setBlocked(false); }
    catch (failure) { if (alive.current && token === lifetime.current) setError(failure instanceof Error ? failure.message : String(failure)); }
  }
  async function reload() { if (!active || !editing || !draftId || inFlight.current) return; const token = lifetime.current; const result = await draft.refetch(); if (alive.current && token === lifetime.current && result.isSuccess) { setCurrent(result.data); setAssembly(structuredClone(result.data.content.assembly)); setDirty(false); setCapture(null); setEditorEpoch(value => value + 1); } }
  const sceneBasis = !editing ? frozen.data?.pin.snapshot_id ?? null : null;
  const inspectionBasis = captureWanted && captured.isSuccess && !captured.isFetching && !captured.isError ? capture.snapshotId : null;
  return { editing, revision, frozen, draft, current, assembly: editing ? assembly : frozen.data?.assembly ?? null, dirty, busy, checking, unavailable, needsDraftChoice, draftId, identity, metadata, record: metadata.data, name: name || selected.data?.name || metadata.data?.label || identity.data?.name || 'New device', enteredName: name, setName: (value: string) => { if (enabled.current.active && enabled.current.edit && !enabled.current.checking && !enabled.current.unavailable && !busy && !definitionId) setName(value); }, change, markStaged, save, capture: () => captureSaved(false), freeze: () => captureSaved(true), refresh, reload, sceneBasis, inspectionBasis, captured, captureBasis: capture, editorEpoch, error, message, history, setHistory, setDetails, revisions, offset, setOffset,
    chooseDraft: (id: string | null) => { if (!busy && !dirty && active) { setDraftChoice(id); setCurrent(null); setCapture(null); setEditorEpoch(value => value + 1); } }, failAuthority: (failure: unknown) => { if (denied(failure)) setBlocked(true); } };
}
