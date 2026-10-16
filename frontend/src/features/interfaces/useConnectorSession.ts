import { useEffect, useRef, useState } from 'react';
import { randomUUID } from '../../lib/random-id';
import { ApiError, requestJson, type LibraryRecord } from '../workspace/api';
import { authorizeConnectorReferences, connectorCommand, connectorKind, readConnectorDraft, readConnectorIdentity, readConnectorRevision, type ConnectorDraft, type ConnectorInspection, type ConnectorKind, type ConnectorValue } from './connector-api';
import { initialInterface } from './api';
import type { Identity } from '../identity/api';

const revisionPageOffset = (number: number) => Math.floor((number - 1) / 50) * 50;

export function blankConnector(kind: ConnectorKind): ConnectorValue {
  return kind === 'end_assembly' ? { kind, description: null, stack: { layers: [], joins: [] }, review: 'unreviewed', review_basis: null } : initialInterface(kind) as ConnectorValue;
}
export function connectorReferences(value: unknown): string {
  const refs: string[] = [];
  function visit(item: unknown) { if (item && typeof item === 'object') for (const [key, field] of Object.entries(item)) { if (key.endsWith('_revision_id') && typeof field === 'string') refs.push(`${key}:${field}`); else visit(field); } }
  visit(value); return refs.sort().join('|');
}
export type ConnectorSessionProps = {
  definitionId: string | null; revisionNumber: number | null; draftRequested: boolean; active: boolean; workspaceId: string; principalKey: string;
  initial?: { kind: ConnectorKind; value?: ConnectorValue; name?: string }; onAccessLost?: () => void;
  onFrozen?: (value: { definition_id: string; revision_id: string; number: number; kind: ConnectorKind; name: string }) => void;
  onSelect: (number: number | null, draft: boolean) => void; onCreated: (id: string, open: boolean) => void;
};
export function useConnectorSession(props: ConnectorSessionProps) {
  const { definitionId, revisionNumber, draftRequested, active, workspaceId, principalKey, initial } = props;
  const [record, setRecord] = useState<LibraryRecord | null>(null), [identity, setIdentity] = useState<Identity | null>(null);
  const [base, setBase] = useState<ConnectorDraft | null>(null), [buffer, setBuffer] = useState<ConnectorValue>(() => structuredClone(initial?.value ?? blankConnector(initial?.kind ?? 'connector_body')));
  const [frozen, setFrozen] = useState<ConnectorInspection | null>(null), [number, setNumber] = useState<number | null>(revisionNumber);
  const [name, setName] = useState(initial?.name ?? ''), [dirty, setDirty] = useState(false), [busy, setBusy] = useState(false);
  const [draftChoices, setDraftChoices] = useState<Identity['drafts']>([]), [needsDraftChoice, setNeedsDraftChoice] = useState(false), [draftOffset, setDraftOffset] = useState(0), [chosenDraftId, setChosenDraftId] = useState<string | null>(null);
  const [historyOffset, setHistoryOffset] = useState(0);
  const [blocked, setBlocked] = useState(false);
  const [confirmed, setConfirmed] = useState(''), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const alive = useRef(false), context = useRef(0), reads = useRef(0), edits = useRef(0), keys = useRef(new Map<string, string>());
  const editing = !definitionId || revisionNumber === null && (draftRequested || record?.latest_revision === null);
  const signature = `${principalKey}:${workspaceId}:${definitionId ?? 'new'}:${revisionNumber ?? 'latest'}:${editing ? `draft:${connectorReferences(buffer)}` : 'frozen'}:${active}:${chosenDraftId ?? ''}`;
  const latest = useRef({ props, base, buffer, dirty, editing, signature }); latest.current = { props, base, buffer, dirty, editing, signature };
  const safe = (epoch: number) => alive.current && epoch === context.current;
  const withdraw = (failure: unknown, fence = true) => { if (fence) { setConfirmed(''); setBlocked(true); setNeedsDraftChoice(false); } setError(failure instanceof Error ? failure.message : 'Connector access is unavailable.'); if (failure instanceof ApiError && [401, 403, 404].includes(failure.status)) props.onAccessLost?.(); };
  useEffect(() => { alive.current = true; context.current += 1; return () => { alive.current = false; context.current += 1; reads.current += 1; }; }, [workspaceId, principalKey]);
  async function refresh(discard = false) {
    const snapshot = latest.current, epoch = context.current, read = ++reads.current;
    setConfirmed(''); setNeedsDraftChoice(false); setError('');
    try {
      let nextValue = snapshot.buffer;
      if (definitionId) {
        const metadata = await requestJson<LibraryRecord>(`/api/v0/workspace/library/${definitionId}`, { cache: 'no-store' });
        if (!connectorKind(metadata.kind)) throw new ApiError(404, 'This record is not a connector, pinout, device port or saved end stack.');
        const chosen = revisionNumber ?? metadata.latest_revision;
        const page = await readConnectorIdentity(definitionId, chosen ? revisionPageOffset(chosen) : 0);
        const edit = revisionNumber === null && (draftRequested || chosen === null);
        let readDraft: ConnectorDraft | null = null, inspected: ConnectorInspection | null = null;
        if (edit) {
          const currentPage = chosen && revisionPageOffset(chosen) !== 0 ? await readConnectorIdentity(definitionId) : page;
          const id = snapshot.base?.draft_id ?? chosenDraftId ?? (currentPage.drafts.length === 1 ? currentPage.drafts[0]!.draft_id : null);
          if (!id && currentPage.drafts.length > 1) {
            if (!safe(epoch) || read !== reads.current) return;
            setRecord(metadata); setIdentity(page); setDraftChoices(currentPage.drafts); setDraftOffset(0); setNeedsDraftChoice(true); setBlocked(false); return;
          }
          if (!id) throw new ApiError(404, 'No editable draft is available for this record.');
          readDraft = await readConnectorDraft(id);
          if (readDraft.definition_id !== definitionId || readDraft.content.interface.kind !== metadata.kind) throw new ApiError(404, 'The selected draft is unavailable.');
          nextValue = !snapshot.base || discard ? readDraft.content.interface : snapshot.buffer;
          await authorizeConnectorReferences(nextValue);
        } else {
          const revision = page.revisions.find(item => item.number === chosen);
          if (!revision) throw new ApiError(404, 'The requested exact revision is unavailable.');
          inspected = await readConnectorRevision(revision.revision_id);
          if (inspected.definition_id !== definitionId || inspected.interface.kind !== metadata.kind) throw new ApiError(404, 'The requested exact revision is unavailable.');
        }
        if (!safe(epoch) || read !== reads.current) return;
        setNeedsDraftChoice(false); setRecord(metadata); setIdentity(page); setHistoryOffset(chosen ? revisionPageOffset(chosen) : 0); setNumber(chosen); setFrozen(inspected);
        if (readDraft && (!snapshot.base || discard)) { setBase(readDraft); setBuffer(structuredClone(nextValue)); setDirty(false); }
        else if (readDraft && readDraft.state !== snapshot.base?.state) setNotice('A newer saved draft exists. Local edits and their original save token remain retained; reload the saved draft to discard them.');
        setName(metadata.label);
        setConfirmed(`${principalKey}:${workspaceId}:${definitionId}:${revisionNumber ?? 'latest'}:${edit ? `draft:${connectorReferences(nextValue)}` : 'frozen'}:${active}:${chosenDraftId ?? ''}`);
      } else {
        await authorizeConnectorReferences(nextValue);
        if (!safe(epoch) || read !== reads.current) return;
        setConfirmed(snapshot.signature);
      }
      if (safe(epoch) && read === reads.current) setBlocked(false);
    } catch (failure) { if (safe(epoch) && read === reads.current) withdraw(failure); }
  }
  async function loadHistory(offset: number) {
    if (!definitionId || !latest.current.props.active) return;
    const epoch = context.current;
    try { const page = await readConnectorIdentity(definitionId, offset); if (safe(epoch) && latest.current.props.active) { setIdentity(page); setHistoryOffset(offset); } }
    catch (failure) { if (safe(epoch)) withdraw(failure); }
  }
  async function loadDraftChoices(offset: number) {
    if (!definitionId || !latest.current.props.active) return;
    const epoch = context.current;
    try { const page = await readConnectorIdentity(definitionId, offset); if (safe(epoch) && latest.current.props.active) { setDraftChoices(page.drafts); setDraftOffset(offset); } }
    catch (failure) { if (safe(epoch)) { setNeedsDraftChoice(false); withdraw(failure); } }
  }
  const refreshRef = useRef(refresh); refreshRef.current = refresh;
  useEffect(() => {
    if (!active) { setConfirmed(''); reads.current += 1; return; }
    void refreshRef.current();
    const focus = () => { void refreshRef.current(); };
    window.addEventListener('focus', focus);
    return () => { reads.current += 1; window.removeEventListener('focus', focus); };
  }, [signature]);
  const ready = active && confirmed === signature && !blocked;
  const change = (value: ConnectorValue) => { if (!busy && ready && editing) { edits.current += 1; setBuffer(value); setDirty(true); } };
  const key = (operation: string, payload: unknown, state?: string) => { const intent = JSON.stringify([operation, payload, state]); let id = keys.current.get(intent); if (!id) { id = randomUUID(); keys.current.set(intent, id); } return id; };
  async function save() {
    if (!ready || busy || !editing || !name.trim() || definitionId && !base) return;
    const epoch = context.current, selected = latest.current.signature, sent = edits.current;
    const operation = base ? 'interface.update' : 'interface.create';
    const payload = base ? { draft_id: base.draft_id, interface: buffer } : { workspace_id: workspaceId, name: name.trim(), interface: buffer };
    setBusy(true); setError('');
    try {
      const result = await connectorCommand<ConnectorDraft>(operation, payload, base?.state, key(operation, payload, base?.state));
      if (!safe(epoch)) return;
      setBase(previous => ({ ...previous, ...result }));
      if (sent === edits.current) { setBuffer(structuredClone(result.content.interface)); setDirty(false); }
      setNotice('Saved connector draft.');
      if (!definitionId && result.definition_id) props.onCreated(result.definition_id, active && latest.current.signature === selected);
    } catch (failure) { if (safe(epoch)) withdraw(failure, failure instanceof ApiError && [401, 403, 404].includes(failure.status)); }
    finally { if (safe(epoch)) setBusy(false); }
  }
  async function freeze() {
    if (!ready || busy || !base || dirty || !editing) return;
    const epoch = context.current, selected = latest.current.signature;
    setBusy(true); setError('');
    const payload = { draft_id: base.draft_id };
    try {
      const result = await connectorCommand<{ revision_id: string; number: number; draft: ConnectorDraft }>('interface.freeze', payload, base.state, key('interface.freeze', payload, base.state));
      if (!safe(epoch)) return;
      setBase(previous => ({ ...previous!, ...result.draft })); setNotice(`Frozen r${result.number}.`);
      if (active && latest.current.signature === selected) {
        const id = definitionId ?? base.definition_id;
        if (id && result.revision_id) props.onFrozen?.({ definition_id: id, revision_id: result.revision_id, number: result.number, kind: buffer.kind, name });
        props.onSelect(result.number, false);
      }
    } catch (failure) { if (safe(epoch)) withdraw(failure, failure instanceof ApiError && [401, 403, 404].includes(failure.status)); }
    finally { if (safe(epoch)) setBusy(false); }
  }
  return { record, identity, base, buffer, frozen, number, name, setName, dirty, busy, ready, error, notice, editing, change, refresh, save, freeze, historyOffset, loadHistory, needsDraftChoice, draftChoices, draftOffset, loadDraftChoices, chooseDraft: setChosenDraftId };
}
