import { useEffect, useRef, useState } from 'react';
import { randomUUID } from '../../lib/random-id';
import { ApiError } from '../workspace/api';
import { authorizeReferences, canonical, command, PART_KINDS, readRecord, referenceSignature, type Content, type Draft, type PartRecord } from './api';

export type SessionProps = {
  allowedKinds?: readonly string[]; active: boolean; principalKey: string; workspaceId: string; definitionId: string | null; revisionNumber: number | null; draftRequested: boolean;
  initial: { kind: string; content: Content; name?: string }; onCreated: (id: string, open: boolean) => void; onSelect: (number: number | null, working: boolean) => void; onAccessLost?: () => void;
};
export function usePartSession(props: SessionProps) {
  const { active, principalKey, workspaceId, definitionId, revisionNumber, draftRequested, initial } = props;
  const [record, setRecord] = useState<PartRecord | null>(null), [base, setBase] = useState<Draft | null>(null);
  const [buffer, setBuffer] = useState<Content>(() => structuredClone(initial.content)), [name, setName] = useState(initial.name ?? '');
  const [draftId, setDraftId] = useState<string | null>(null), [error, setError] = useState(''), [notice, setNotice] = useState(''), [busy, setBusy] = useState(false), [confirmed, setConfirmed] = useState('');
  const undo = useRef<Content[]>([]), alive = useRef(false), epoch = useRef(0), reads = useRef(0), edits = useRef(0), keys = useRef(new Map<string, string>());
  const editing = !definitionId || revisionNumber === null && (draftRequested || record?.selected.kind === 'draft');
  const dirty = !base || canonical(base.content) !== canonical(buffer);
  const signature = `${principalKey}:${workspaceId}:${definitionId ?? 'new'}:${revisionNumber ?? 'latest'}:${draftRequested}:${draftId ?? ''}:${active}:${editing ? referenceSignature(buffer) : ''}`;
  const latest = useRef({ props, base, buffer, editing, signature }); latest.current = { props, base, buffer, editing, signature };
  const safe = (token: number) => alive.current && token === epoch.current;
  function fail(failure: unknown, withdraw = true) {
    if (withdraw) setConfirmed('');
    setError(failure instanceof Error ? failure.message : 'The selected record is unavailable.');
    if (failure instanceof ApiError && [401, 403, 404].includes(failure.status)) props.onAccessLost?.();
  }
  useEffect(() => { alive.current = true; epoch.current += 1; return () => { alive.current = false; epoch.current += 1; reads.current += 1; }; }, [principalKey, workspaceId]);
  async function refresh(discard = false) {
    const snapshot = latest.current, token = epoch.current, serial = ++reads.current;
    setConfirmed(''); setError('');
    try {
      const current = definitionId ? await readRecord(definitionId, revisionNumber, draftRequested, draftId) : null;
      if (current && (!(props.allowedKinds ?? PART_KINDS).includes(current.kind) || current.definition_id !== definitionId || current.workspace_id !== workspaceId)) throw new ApiError(404, 'The selected record is unavailable.');
      const saved = current?.selected.kind === 'draft' ? current.selected : null;
      const next = saved && (!snapshot.base || discard) ? saved.content : snapshot.buffer;
      if (!current || saved) await authorizeReferences(next);
      if (!safe(token) || serial !== reads.current) return;
      if (current) { setRecord(current); setName(current.name); }
      if (saved && (!snapshot.base || discard)) { setBase(saved); setBuffer(structuredClone(next)); undo.current = []; }
      else if (saved && saved.state !== snapshot.base?.state) setNotice('A newer saved draft exists. Your local buffer and original save token remain retained.');
      setConfirmed(`${principalKey}:${workspaceId}:${definitionId ?? 'new'}:${revisionNumber ?? 'latest'}:${draftRequested}:${draftId ?? ''}:${active}:${(!definitionId || saved) ? referenceSignature(next) : ''}`);
    } catch (failure) { if (safe(token) && serial === reads.current) fail(failure); }
  }
  const refreshRef = useRef(refresh); refreshRef.current = refresh;
  useEffect(() => {
    if (!active) { setConfirmed(''); reads.current += 1; return; }
    void refreshRef.current();
    const focus = () => { void refreshRef.current(); }; window.addEventListener('focus', focus);
    return () => { reads.current += 1; window.removeEventListener('focus', focus); };
  }, [signature]);
  const ready = active && confirmed === signature;
  const change = (content: Content) => { if (!busy && ready && editing && canonical(content) !== canonical(buffer)) { undo.current.push(structuredClone(buffer)); edits.current += 1; setBuffer(content); } };
  const undoEdit = () => { const previous = undo.current.at(-1); if (previous && ready && !busy && editing) { undo.current.pop(); edits.current += 1; setBuffer(previous); } };
  const intentKey = (operation: string, payload: unknown, state?: string) => { const fingerprint = canonical([operation, payload, state]); let key = keys.current.get(fingerprint); if (!key) { key = randomUUID(); keys.current.set(fingerprint, key); } return key; };
  async function save() {
    if (!ready || busy || !editing || !name.trim() || definitionId && !base) return;
    const token = epoch.current, selected = signature, submitted = edits.current;
    const operation = base ? 'draft.update' : 'definition.create';
    const payload = base ? { draft_id: base.draft_id, changes: buffer } : { workspace_id: workspaceId, kind: initial.kind, name: name.trim(), content: buffer };
    setBusy(true); setError('');
    try {
      const saved = await command<Draft & { definition_id?: string }>(operation, payload, base?.state, intentKey(operation, payload, base?.state));
      if (!safe(token)) return;
      setBase({ ...saved, kind: 'draft' }); if (submitted === edits.current) { setBuffer(structuredClone(saved.content)); undo.current = []; }
      setNotice('Saved working draft.');
      if (!definitionId && saved.definition_id) props.onCreated(saved.definition_id, latest.current.props.active && latest.current.signature === selected);
    } catch (failure) { if (safe(token)) fail(failure, failure instanceof ApiError && [401, 403, 404].includes(failure.status)); }
    finally { if (safe(token)) setBusy(false); }
  }
  async function freeze() {
    if (!ready || busy || !base || dirty || !editing) return;
    const token = epoch.current, selected = signature, payload = { draft_id: base.draft_id };
    setBusy(true); setError('');
    try {
      const frozen = await command<{ number: number; draft: Draft }>('draft.freeze', payload, base.state, intentKey('draft.freeze', payload, base.state));
      if (!safe(token)) return; setBase({ ...frozen.draft, kind: 'draft' }); setNotice(`Frozen r${frozen.number}.`);
      if (latest.current.props.active && latest.current.signature === selected) props.onSelect(frozen.number, false);
    } catch (failure) { if (safe(token)) fail(failure, failure instanceof ApiError && [401, 403, 404].includes(failure.status)); }
    finally { if (safe(token)) setBusy(false); }
  }
  return { record, base, buffer, name, setName, editing, dirty, busy, ready, error, notice, change, undoEdit, canUndo: undo.current.length > 0, refresh, save, freeze,
    chooseDraft: (id: string) => { setBase(null); setDraftId(id); }, selected: editing ? base : record?.selected, content: editing ? buffer : record?.selected.content };
}
