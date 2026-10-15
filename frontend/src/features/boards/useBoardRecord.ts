import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError, requestJson, type LibraryRecord } from '../workspace/api';
import { usePermission } from '../../lib/permissions';
import { randomUUID } from '../../lib/random-id';
import { associationTargets } from '../pcb/api';
import type { Identity } from '../identity/api';
import { command, PcbRequestError, type Population, type PopulationReview } from '../pcb/api';
import { emptyBoard, type Board, type BoardInspection } from './api';

export type BoardContent = { interface?: Board; pcb_population?: Population };
export type RecordDraft = { definition_id: string; draft_id: string; state: string; content: BoardContent; review?: PopulationReview };
type Revision = { revision_id: string; number: number };
type Frozen = { content: BoardContent; inspection?: BoardInspection; review?: PopulationReview };
type Props = {
  active: boolean; principalKey: string; workspaceId: string; definitionId: string | null;
  kind: 'board' | 'pcb_population'; revisionNumber: number | null; draftRequested: boolean;
  initial?: { name: string; board: Board }; onCreated: (id: string, open: boolean) => void;
  onSelect: (number: number | null, draft?: boolean) => void;
};
const clone = <T,>(value: T): T => structuredClone(value);
type LocalPins = { revisions: string[]; sources: string[]; models: string[] };
function pins(content: BoardContent): LocalPins {
  const board = content.interface; const population = content.pcb_population;
  const revisions = [...(board?.carried_connectors.map(row => row.body_revision_id) ?? []), ...(board?.derived_from ? [board.derived_from.population_revision_id] : []), ...(population?.associations.flatMap(row => row.target_revision_id ? [row.target_revision_id] : []) ?? [])];
  const sources = [...(population ? [population.source_revision_id] : []), ...(population?.associations.flatMap(row => row.evidence?.kind === 'source_file' ? [row.evidence.source_revision_id] : []) ?? [])];
  return { revisions: [...new Set(revisions)].sort(), sources: [...new Set(sources)].sort(), models: [...new Set(population?.associations.flatMap(row => row.representation_id ? [row.representation_id] : []) ?? [])].sort() };
}
const denied = (error: unknown) => (error instanceof ApiError || error instanceof PcbRequestError) && [401, 403, 404].includes(error.status);

/** The selected state owns the diagram and every inspector; refreshing never rebases a dirty buffer. */
export function useBoardRecord({ active, principalKey, workspaceId, definitionId, kind, revisionNumber, draftRequested, initial, onCreated, onSelect }: Props) {
  const cache = useQueryClient();
  const editGate = usePermission(definitionId ? 'design.edit' : 'item.create'); const freezeGate = usePermission('design.freeze');
  const epoch = useRef(0); const mounted = useRef(false); const inFlight = useRef(false);
  const intents = useRef(new Map<string, string>());
  useEffect(() => { mounted.current = true; epoch.current += 1; return () => { mounted.current = false; epoch.current += 1; }; }, [principalKey, workspaceId]);
  const intentKey = (operation: string, payload: object, state?: string) => { const fingerprint = JSON.stringify([principalKey, workspaceId, operation, payload, state]); const key = intents.current.get(fingerprint) ?? randomUUID(); intents.current.set(fingerprint, key); return key; };
  const base = ['board-record', principalKey, definitionId];
  const [current, setCurrent] = useState<RecordDraft | null>(null);
  const [buffer, setBuffer] = useState<BoardContent>(() => ({ interface: clone(initial?.board ?? emptyBoard()) }));
  const [name, setName] = useState(initial?.name ?? '');
  const [dirty, setDirty] = useState(!definitionId);
  const [chosenDraft, setChosenDraft] = useState<string | null>(null);
  const [history, setHistory] = useState(false); const [offset, setOffset] = useState(0);
  const [busy, setBusy] = useState(false); const [blocked, setBlocked] = useState(false);
  const [error, setError] = useState(''); const [message, setMessage] = useState('');
  const edits = useRef(0);
  const selection = `${active}:${definitionId}:${revisionNumber}:${draftRequested}:${chosenDraft}`;
  const latest = useRef(selection); latest.current = selection;
  useEffect(() => { inFlight.current = false; intents.current.clear(); setCurrent(null); setBuffer({ interface: clone(initial?.board ?? emptyBoard()) }); setName(initial?.name ?? ''); setDirty(!definitionId); setChosenDraft(null); setBlocked(false); setBusy(false); setError(''); setMessage(''); }, [principalKey, workspaceId]);
  const metadata = useQuery({ queryKey: [...base, 'metadata'], enabled: active && !!definitionId, retry: false,
    queryFn: ({ signal }) => requestJson<LibraryRecord>(`/api/v0/workspace/library/${definitionId}`, { signal }) });
  const identity = useQuery({ queryKey: [...base, 'identity', 0], enabled: active && !!definitionId && metadata.isSuccess && metadata.data.kind === kind, retry: false,
    queryFn: ({ signal }) => requestJson<Identity>(`/api/v0/catalog/definitions/${definitionId}?offset=0&limit=50`, { signal }) });
  const exact = useQuery({ queryKey: [...base, 'exact', revisionNumber], enabled: active && !!definitionId && revisionNumber !== null && metadata.isSuccess, retry: false,
    queryFn: async ({ signal }) => {
      const page = await requestJson<Identity>(`/api/v0/catalog/definitions/${definitionId}?offset=${Math.floor((revisionNumber! - 1) / 50) * 50}&limit=50`, { signal });
      const found = page.definition_id === definitionId ? page.revisions.find(row => row.number === revisionNumber) : undefined;
      if (!found) throw new Error(`Exact revision r${revisionNumber} is unavailable. No newer revision was substituted.`);
      return found;
    } });
  const revision: Revision | null = revisionNumber !== null ? exact.data ?? null : metadata.data?.latest_revision_id && metadata.data.latest_revision !== null ? { revision_id: metadata.data.latest_revision_id, number: metadata.data.latest_revision } : null;
  const editing = !definitionId || revisionNumber === null && (draftRequested || metadata.isSuccess && !metadata.data.latest_revision_id);
  // Multiple drafts have no implied chronological order in the identity API. Require an explicit choice.
  const draftId = chosenDraft ?? current?.draft_id ?? (identity.data?.drafts.length === 1 ? identity.data.drafts[0]!.draft_id : null);
  const needsDraftChoice = !!definitionId && editing && identity.isSuccess && !draftId;
  const draft = useQuery({ queryKey: [...base, 'draft', draftId], enabled: active && !!draftId && editing && metadata.isSuccess && !identity.isError, retry: false,
    queryFn: async ({ signal }): Promise<RecordDraft> => {
      if (kind === 'board') {
        const result = await requestJson<RecordDraft>(`/api/v0/interfaces/drafts/${draftId}`, { signal });
        if (result.definition_id !== definitionId || result.content.interface?.kind !== 'board') throw new Error('The selected draft is not this board.');
        return result;
      }
      const result = await requestJson<PopulationReview & { definition_id: string; draft_id: string; state: string }>(`/api/v0/pcb/population-drafts/${draftId}/review`, { signal });
      if (result.definition_id !== definitionId) throw new Error('The selected draft is not this population.');
      return { ...result, content: { pcb_population: result.population }, review: result };
    } });
  const frozen = useQuery({ queryKey: [...base, 'revision', revision?.revision_id], enabled: active && !!revision && !editing && !metadata.isError && !exact.isError, retry: false,
    queryFn: async ({ signal }): Promise<Frozen> => {
      if (kind === 'board') {
        const inspection = await requestJson<BoardInspection>(`/api/v0/interfaces/revisions/${revision!.revision_id}`, { signal });
        if (inspection.interface.kind !== 'board') throw new Error('The selected revision is not a declared board.');
        return { content: { interface: inspection.interface }, inspection };
      }
      const review = await requestJson<PopulationReview & { definition_id: string }>(`/api/v0/pcb/population-revisions/${revision!.revision_id}/review`, { signal });
      if (review.definition_id !== definitionId) throw new Error('The selected revision is not this population.');
      return { content: { pcb_population: review.population }, review };
    } });
  const revisions = useQuery({ queryKey: [...base, 'identity', offset], enabled: active && history && !!definitionId, retry: false,
    queryFn: ({ signal }) => requestJson<Identity>(`/api/v0/catalog/definitions/${definitionId}?offset=${offset}&limit=50`, { signal }) });
  useEffect(() => {
    if (!draft.isSuccess || !draft.data || dirty && current?.draft_id === draft.data.draft_id) return;
    setCurrent(draft.data); setBuffer(clone(draft.data.content)); setDirty(false);
  }, [draft.data, draft.isSuccess]);
  const change = (value: BoardContent) => { if (!editing || !enabled.current.edit || !enabled.current.active || enabled.current.unavailable || enabled.current.checking) return; edits.current += 1; setBuffer(value); setDirty(true); };
  const workingPins = pins(buffer);
  const localAuthority = useQuery({ queryKey: [...base, 'working-authority', JSON.stringify(workingPins)], enabled: active && editing, retry: false, refetchOnWindowFocus: 'always',
    queryFn: async ({ signal }) => {
      if (!definitionId) { const access = await requestJson<{ workspace_id: string }>(`/api/v0/access/workspace?workspace_id=${workspaceId}`, { signal }); if (access.workspace_id !== workspaceId) throw new ApiError(403, 'Workspace unavailable.'); }
      // The retained buffer can include pins another session removed from saved content. Reauthorize every working pin, including the original loaded ones.
      for (let at = 0; at < Math.max(workingPins.revisions.length, workingPins.sources.length); at += 50) {
        const revisions = workingPins.revisions.slice(at, at + 50); const sources = workingPins.sources.slice(at, at + 50); const query = new URLSearchParams();
        revisions.forEach(id => query.append('revision_ids', id)); sources.forEach(id => query.append('source_revision_ids', id));
        const result = await requestJson<{ labels: { revision_id: string; readable: boolean }[]; source_labels: { revision_id: string; readable: boolean }[] }>(`/api/v0/catalog/revision-labels?${query}`, { signal });
        if (revisions.some(id => !result.labels.some(row => row.revision_id === id && row.readable)) || sources.some(id => !result.source_labels.some(row => row.revision_id === id && row.readable))) throw new ApiError(403, 'A working reference is unavailable. Local edits and their original editing token are retained.');
      }
      if (workingPins.models.length) { const targets = await associationTargets(workspaceId, signal); if (workingPins.models.some(id => !targets.models.some(row => row.representation_id === id))) throw new ApiError(403, 'A working model reference is unavailable.'); }
      return true;
    } });
  useEffect(() => { if (!active) return; const check = () => { if (editing) void localAuthority.refetch(); if (definitionId) { void metadata.refetch(); if (editing && draftId) void draft.refetch(); else if (revision) void frozen.refetch(); } }; window.addEventListener('focus', check); return () => window.removeEventListener('focus', check); }, [active, editing, definitionId, draftId, revision?.revision_id, localAuthority.refetch]);
  const unavailable = blocked || editing && localAuthority.isError || !!definitionId && (metadata.isError || metadata.data?.kind !== undefined && metadata.data.kind !== kind || identity.isError || revisionNumber !== null && exact.isError || editing && draft.isError || !editing && frozen.isError || history && revisions.isError);
  const checking = editing && (localAuthority.isPending || localAuthority.isFetching) || !!definitionId && (metadata.isPending || metadata.isFetching || identity.isPending || identity.isFetching || revisionNumber !== null && (exact.isPending || exact.isFetching) || editing && !!draftId && (draft.isPending || draft.isFetching) || !editing && !!revision && (frozen.isPending || frozen.isFetching));
  const refresh = () => {
    setBlocked(false); if (definitionId) { void metadata.refetch(); void identity.refetch(); } if (editing) void localAuthority.refetch();
    if (revisionNumber !== null) void exact.refetch(); if (editing && draftId) void draft.refetch();
    if (!editing && revision) void frozen.refetch(); if (history) void revisions.refetch();
  };
  const enabled = useRef({ active, unavailable, checking, edit: editGate.allowed, freeze: freezeGate.allowed }); enabled.current = { active, unavailable, checking, edit: editGate.allowed, freeze: freezeGate.allowed };
  const save = async () => {
    if (!mounted.current || inFlight.current || !enabled.current.active || enabled.current.unavailable || enabled.current.checking || !enabled.current.edit || busy || !editing || !definitionId && !name.trim() || definitionId && !current) return;
    const version = edits.current; const requestEpoch = epoch.current; inFlight.current = true; setBusy(true); setError('');
    try {
      const operation = kind === 'board' ? `interface.${current ? 'update' : 'create'}` : 'pcb.population_update';
      const payload = current
        ? { draft_id: current.draft_id, ...(kind === 'board' ? { interface: buffer.interface } : { population: buffer.pcb_population }) }
        : { name: name.trim(), workspace_id: workspaceId, interface: buffer.interface };
      const result = await command<RecordDraft>(operation, payload, undefined, current?.state, intentKey(operation, payload, current?.state));
      if (!mounted.current || requestEpoch !== epoch.current) return;
      if (result.definition_id !== (definitionId ?? result.definition_id) || kind === 'board' && !result.content.interface || kind === 'pcb_population' && !result.content.pcb_population) throw new Error('The operation returned a different record kind.');
      setCurrent(result); if (version === edits.current) { setBuffer(clone(result.content)); setDirty(false); }
      cache.setQueryData(['board-record', principalKey, result.definition_id, 'draft', result.draft_id], result);
      void cache.invalidateQueries({ queryKey: ['workspace', 'library'] });
      setMessage('Saved draft.'); if (!definitionId) onCreated(result.definition_id, latest.current === selection);
    } catch (failure) { if (mounted.current && requestEpoch === epoch.current) { setError(failure instanceof Error ? failure.message : String(failure)); if (denied(failure)) setBlocked(true); } }
    finally { if (mounted.current && requestEpoch === epoch.current) { inFlight.current = false; setBusy(false); } }
  };
  const freeze = async () => {
    if (!mounted.current || inFlight.current || !enabled.current.active || enabled.current.unavailable || enabled.current.checking || !enabled.current.freeze || busy || dirty || !current) return; const version = edits.current; const requestEpoch = epoch.current; inFlight.current = true; setBusy(true); setError('');
    try {
      const operation = kind === 'board' ? 'interface.freeze' : 'pcb.population_freeze'; const payload = { draft_id: current.draft_id };
      const result = await command<{ revision_id: string; number: number; draft: { state: string } }>(operation, payload, undefined, current.state, intentKey(operation, payload, current.state));
      if (!mounted.current || requestEpoch !== epoch.current) return;
      setCurrent({ ...current, state: result.draft.state });
      await cache.invalidateQueries({ queryKey: [...base, 'metadata'] }); void cache.invalidateQueries({ queryKey: [...base, 'identity'] }); void cache.invalidateQueries({ queryKey: ['workspace', 'library'] });
      if (!mounted.current || requestEpoch !== epoch.current) return;
      if (latest.current === selection && edits.current === version) onSelect(result.number);
      setMessage(`Frozen r${result.number}.`);
    } catch (failure) { if (mounted.current && requestEpoch === epoch.current) { setError(failure instanceof Error ? failure.message : String(failure)); if (denied(failure)) setBlocked(true); } }
    finally { if (mounted.current && requestEpoch === epoch.current) { inFlight.current = false; setBusy(false); } }
  };
  const reload = async () => {
    if (!active || busy || !draftId) return; const requestEpoch = epoch.current;
    const result = await draft.refetch();
    if (mounted.current && requestEpoch === epoch.current && result.isSuccess) { setCurrent(result.data); setBuffer(clone(result.data.content)); setDirty(false); setMessage('Reloaded saved draft; local edits discarded.'); }
  };
  return { metadata, record: metadata.data, identity, revision, editing, draftId, needsDraftChoice, draft, frozen, current,
    content: editing ? buffer : frozen.data?.content, review: editing ? draft.data?.review : frozen.data?.review,
    inspection: frozen.data?.inspection, enteredName: name, name: name || metadata.data?.label || (kind === 'board' ? 'New board' : 'PCB population'),
    setName: (value: string) => { if (enabled.current.active && enabled.current.edit && !busy && !enabled.current.unavailable && !enabled.current.checking) setName(value); }, dirty, busy, error, message, unavailable, checking, change, refresh, save, freeze, reload,
    history, setHistory, offset, setOffset, revisions, failAuthority: (failure: unknown) => { if (denied(failure)) setBlocked(true); }, chooseDraft: (id: string | null) => { if (active && !unavailable && !checking && !busy && !dirty) { setChosenDraft(id); setCurrent(null); } } };
}
