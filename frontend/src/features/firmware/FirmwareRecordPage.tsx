import { Alert, Button, Group, Modal, Stack, Text, TextInput } from '@mantine/core';
import { useEffect, useRef, useState } from 'react';
import { RecordPage, type RecordState } from '../../components/record';
import { usePermission } from '../../lib/permissions';
import { randomUUID } from '../../lib/random-id';
import { authorizeSecondary, secondaryPins } from '../assemblies/secondary-authority';
import { FirmwareBuildPanel } from '../firmware-builds/FirmwareBuildPanel';
import { canonical, readRecord } from '../parts/api';
import { command, request, SourceError } from '../sources/api';
import { requestJson } from '../workspace/api';
import type { Firmware, FirmwareRead } from './api';
import { blankFirmware, FirmwareEvaluation, FirmwareFields, FirmwareInspection } from './FirmwareFields';

export type FirmwareRecordProps = { active: boolean; principalKey: string; workspaceId: string; definitionId: string | null; revisionNumber: number | null; working: boolean; embedded?: boolean; onBack: () => void; onSelect: (number: number | null, working: boolean) => void; onCreated: (id: string, open: boolean) => void };
const pins = (value: Firmware) => JSON.stringify(secondaryPins({ firmware: value }));
/** Typed firmware commands retain independent CAS and never borrow a Device's identity. */
export function FirmwareRecordPage(props: FirmwareRecordProps) { return <FirmwareSession key={`${props.principalKey}:${props.workspaceId}:${props.definitionId ?? 'new'}`} {...props} />; }
function FirmwareSession(props: FirmwareRecordProps) {
  const [current, setCurrent] = useState<FirmwareRead | null>(null), [base, setBase] = useState<FirmwareRead | null>(null), [form, setForm] = useState<Firmware>(blankFirmware), [name, setName] = useState('');
  const [confirmed, setConfirmed] = useState(''), [error, setError] = useState(''), [notice, setNotice] = useState(''), [busy, setBusy] = useState(false), [versions, setVersions] = useState(false), [explicitDraft, setExplicitDraft] = useState(''), [draftId, setDraftId] = useState<string | null>(null);
  const generation = useRef(0), alive = useRef(true), undo = useRef<Firmware[]>([]), intent = useRef<{ signature: string; key: string } | null>(null);
  const editing = !props.definitionId || props.working, dirty = !base || canonical(form) !== canonical(base.content.firmware);
  const selection = JSON.stringify([props.definitionId, props.revisionNumber, props.working, draftId, props.active]), signature = pins(form), key = `${selection}:${signature}`;
  const latest = useRef({ props, form, base, selection, signature }); latest.current = { props, form, base, selection, signature };
  const create = usePermission('item.create'), edit = usePermission(props.definitionId ? 'design.edit' : 'item.create'), freezeGate = usePermission('design.freeze');
  const ready = props.active && confirmed === key;
  useEffect(() => { alive.current = true; return () => { alive.current = false; generation.current++; }; }, []);
  function commandKey(operation: string, payload: unknown, state?: string | null) { const signature = canonical([operation, payload, state]); if (intent.current?.signature !== signature) intent.current = { signature, key: randomUUID() }; return intent.current.key; }
  async function refresh(discard = false) {
    const token = ++generation.current, snapshot = latest.current, valid = () => alive.current && token === generation.current && latest.current.selection === snapshot.selection;
    setConfirmed(''); setError(''); setBusy(false);
    if (!snapshot.props.active) return;
    try {
      let selected: FirmwareRead | null = null;
      if (snapshot.props.definitionId) {
        const record = await readRecord(snapshot.props.definitionId, snapshot.props.revisionNumber, snapshot.props.working, draftId);
        if (record.workspace_id !== snapshot.props.workspaceId || record.definition_id !== snapshot.props.definitionId || record.kind !== 'firmware') throw new Error('This record is not firmware in the current workspace.');
        selected = await request<FirmwareRead>(record.selected.kind === 'draft' ? `pcb/firmware-drafts/${record.selected.draft_id}` : `pcb/firmware-revisions/${record.selected.revision_id}`);
        if (selected.definition_id !== record.definition_id || (record.selected.kind === 'revision' && selected.revision_id !== record.selected.revision_id) || (record.selected.kind === 'draft' && selected.draft_id !== record.selected.draft_id)) throw new Error('The selected firmware state is unavailable.');
      } else {
        const workspace = await requestJson<{ workspace_id: string }>('/api/v0/access/workspace', { cache: 'no-store' });
        if (workspace.workspace_id !== snapshot.props.workspaceId) throw new Error('Workspace unavailable.');
      }
      const saved = selected?.draft_id ? selected : null, next = saved && (!snapshot.base || discard) ? saved.content.firmware : snapshot.form;
      await authorizeSecondary({ firmware: next });
      if (!valid()) return;
      if (latest.current.signature !== snapshot.signature && !(saved && (!snapshot.base || discard))) { void refresh(); return; }
      setCurrent(selected);
      if (saved && (!snapshot.base || discard)) { setBase(saved); setForm(structuredClone(next)); undo.current = []; }
      else if (saved && saved.state !== snapshot.base?.state) setNotice('A newer saved draft exists. Your local edits and original save token remain retained.');
      setConfirmed(`${snapshot.selection}:${pins(next)}`);
    } catch (reason) { if (valid()) setError(reason instanceof Error ? reason.message : 'Firmware unavailable.'); }
  }
  useEffect(() => { void refresh(); const focus = () => { void refresh(); }; if (props.active) window.addEventListener('focus', focus); return () => { generation.current++; window.removeEventListener('focus', focus); }; }, [selection, signature]);
  function change(next: Firmware) { if (!ready || !editing || busy || !edit.allowed) return; undo.current.push(form); setForm(next); }
  async function save() {
    if (!ready || !editing || busy || !edit.allowed) return;
    const token = generation.current, snapshot = latest.current, valid = () => alive.current && generation.current === token && latest.current.selection === snapshot.selection;
    const operation = base?.draft_id ? 'firmware.update' : 'firmware.create';
    const payload = base?.draft_id ? { draft_id: base.draft_id, firmware: form } : { workspace_id: props.workspaceId, name: name.trim(), firmware: form };
    setBusy(true); setError('');
    try {
      const result = await command<{ draft_id: string }>(operation, payload, { expectedState: base?.state ?? undefined, idempotencyKey: commandKey(operation, payload, base?.state) });
      if (!valid()) return;
      const saved = await request<FirmwareRead>(`pcb/firmware-drafts/${result.draft_id}`);
      if (!valid()) return;
      setBase(saved); setCurrent(saved); setForm(structuredClone(saved.content.firmware)); undo.current = []; intent.current = null; setNotice('Firmware draft saved.');
      if (!props.definitionId) props.onCreated(saved.definition_id, latest.current.props.active);
    } catch (reason) { if (valid()) { setError(reason instanceof Error ? reason.message : 'Save failed.'); if (reason instanceof SourceError && [401, 403, 404].includes(reason.status)) void refresh(); } }
    finally { if (valid()) setBusy(false); }
  }
  async function freeze() {
    if (!ready || !base?.draft_id || dirty || busy || !freezeGate.allowed || current?.evaluation.readiness === 'blocked') return;
    const token = generation.current, selected = selection; setBusy(true); setError('');
    try {
      const payload = { draft_id: base.draft_id }, result = await command<{ revision_id: string }>('firmware.freeze', payload, { expectedState: base.state ?? undefined, idempotencyKey: commandKey('firmware.freeze', payload, base.state) });
      if (!alive.current || generation.current !== token || latest.current.selection !== selected) return;
      const [frozen, saved] = await Promise.all([request<FirmwareRead>(`pcb/firmware-revisions/${result.revision_id}`), request<FirmwareRead>(`pcb/firmware-drafts/${base.draft_id}`)]);
      if (!alive.current || generation.current !== token || latest.current.selection !== selected) return;
      setBase(saved); intent.current = null; props.onSelect(frozen.revision_number, false);
    } catch (reason) { if (alive.current && generation.current === token) { setError(reason instanceof Error ? reason.message : 'Freeze failed.'); void refresh(); } }
    finally { if (alive.current && generation.current === token) setBusy(false); }
  }
  const state: RecordState = !editing && current?.revision_id ? { kind: 'revision', id: current.revision_id, number: current.revision_number! } : base?.draft_id ? { kind: 'draft', id: base.draft_id, version: Number(base.state?.match(/\d+/)?.[0] ?? 0), dirty } : { kind: 'new' };
  const saveable = !!form.sources.length && !!form.toolchain.name.trim() && !!form.target.component_id && !!form.target.option_id && (!!props.definitionId || !!name.trim());
  return <Stack><Group><Button variant="quiet" onClick={props.onBack}>Back to firmware</Button><Button variant="quiet" onClick={() => void refresh()}>Refresh firmware access</Button>{props.definitionId && <Button variant="quiet" onClick={() => setVersions(true)}>Versions</Button>}</Group>
    {error && <Alert color="red">{error}</Alert>}{!ready && <Text role="status">Firmware is hidden until current access is confirmed. Local edits remain retained.</Text>}
    {!ready && props.active && editing && <Group>{undo.current.length > 0 && <Button disabled={busy} onClick={() => setForm(undo.current.pop()!)}>Undo last local edit</Button>}{base && <Button disabled={busy} onClick={() => void refresh(true)}>Reload saved firmware (discard local edits)</Button>}</Group>}
    {!ready && props.active && props.definitionId && <details><summary>Advanced: choose an explicit working draft</summary><TextInput label="Explicit firmware draft ID" value={explicitDraft} onChange={event => setExplicitDraft(event.currentTarget.value)} /><Button disabled={!explicitDraft.trim()} onClick={() => { setDraftId(explicitDraft.trim()); props.onSelect(null, true); }}>Open chosen firmware draft</Button></details>}
    <div hidden={!ready} inert={!ready || undefined}><RecordPage layout={props.embedded ? 'section' : 'workbench'} active={ready} identity={{ id: props.definitionId ?? undefined, name: current?.name ?? (name || 'New firmware'), kind: 'firmware' }} state={state}
      actions={editing ? <><Button disabled={!ready || busy || !edit.allowed || !undo.current.length} variant="quiet" onClick={() => setForm(undo.current.pop()!)}>Undo</Button><Button {...edit.props} disabled={!ready || busy || !edit.allowed || !saveable} onClick={() => void save()}>Save firmware draft</Button><Button {...freezeGate.props} disabled={!ready || busy || !base || dirty || !freezeGate.allowed || current?.evaluation.readiness === 'blocked'} onClick={() => void freeze()}>Freeze firmware declarations</Button></> : edit.allowed && <Button onClick={() => props.onSelect(null, true)}>Continue draft</Button>}
      notice={<>{notice && <Text>{notice}</Text>}{!props.definitionId && <TextInput label="Firmware name" value={name} disabled={busy || !create.allowed} onChange={event => setName(event.currentTarget.value)} />}</>}
      views={[{ id: 'declaration', label: 'Declaration', content: <><div hidden={!editing} inert={!editing || undefined}><FirmwareFields value={form} onChange={change} active={ready && editing} editable={ready && editing && !busy && edit.allowed} workspaceId={props.workspaceId} principalKey={props.principalKey} onAccessLost={() => void refresh()} /></div>{!editing && current && <FirmwareInspection read={current} />}</> }]} view="declaration" onView={() => {}}
      inspector={[{ id: 'review', label: 'Declaration review', content: () => current ? editing ? <FirmwareEvaluation read={current} /> : <Text>The declaration view shows the exact frozen inputs and findings. Toolchain support, compilation and device operation are separate evidence.</Text> : <Text>Save the declaration to review its exact target and pin findings.</Text> }, { id: 'build', label: 'Builds', content: () => current?.revision_id ? <FirmwareBuildPanel active={ready} firmware_revision_id={current.revision_id} /> : <Text>Freeze a firmware declaration before reviewing a compiler build.</Text> }]} /></div>
    <Modal opened={ready && versions} onClose={() => setVersions(false)} title="Firmware versions"><Stack>{current?.revision_number && <Button disabled={current.revision_number <= 1} onClick={() => { setVersions(false); props.onSelect(current.revision_number! - 1, false); }}>Previous exact revision</Button>}<Button onClick={() => { setVersions(false); props.onSelect(null, false); }}>Latest frozen revision</Button><Button onClick={() => { setVersions(false); props.onSelect(null, true); }}>Working draft</Button><details><summary>Advanced: explicit working draft</summary><TextInput label="Explicit firmware draft ID" value={explicitDraft} onChange={event => setExplicitDraft(event.currentTarget.value)} /><Button disabled={!explicitDraft.trim()} onClick={() => { setDraftId(explicitDraft.trim()); setVersions(false); props.onSelect(null, true); }}>Open chosen firmware draft</Button></details></Stack></Modal>
  </Stack>;
}
