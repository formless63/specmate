import { Alert, Button, Group, MantineThemeProvider, Modal, Select, Stack, Text, TextInput } from '@mantine/core';
import { useState, type ReactNode } from 'react';
import { DefinitionPickerScope } from '../../components/library/DefinitionSelect';
import { RecordPage, type RecordSection, type RecordState } from '../../components/record';
import { ExactPins } from '../../lib/IdentityLabel';
import { InspectionScope, usePermission, type PermissionName } from '../../lib/permissions';
import type { Content } from '../parts/api';
import { usePartSession, type SessionProps } from '../parts/usePartSession';

export type SecondaryContext = {
  inspectorTab?: string; refreshAccess: () => void; content: Content; workingContent: Content; change: (content: Content) => void; editable: boolean; editing: boolean; active: boolean;
  selected: ReturnType<typeof usePartSession>['selected']; record: ReturnType<typeof usePartSession>['record'];
};
export type SecondaryRecordProps = SessionProps & {
  createPermission?: PermissionName;
  canSave?: boolean | ((context: SecondaryContext) => boolean); canFreeze?: boolean | ((context: SecondaryContext) => boolean);
  title: string; collectionLabel: string; viewLabel?: string; onBack: () => void;
  renderContent: (context: SecondaryContext) => ReactNode;
  renderInspection?: (context: SecondaryContext) => ReactNode;
  inspector?: (context: SecondaryContext) => RecordSection[];
};
/** Selected-state frame. Domain callbacks authorize saved pins and the retained local buffer. */
export function SecondaryRecordPage(props: SecondaryRecordProps) {
  return <SecondaryRecordSession key={`${props.principalKey}:${props.workspaceId}`} {...props} />;
}
function SecondaryRecordSession(props: SecondaryRecordProps) {
  const session = usePartSession(props), edit = usePermission(props.definitionId ? 'design.edit' : props.createPermission ?? 'item.create'), freeze = usePermission('design.freeze');
  const [versions, setVersions] = useState(false), [discard, setDiscard] = useState(false), [draftId, setDraftId] = useState(''), [inspectorTab, setInspectorTab] = useState('');
  const selected = session.selected, revision = selected?.kind === 'revision' ? selected : null;
  const context: SecondaryContext = { refreshAccess: () => { void session.refresh(); }, content: session.content ?? session.buffer, workingContent: session.buffer, change: session.change, editing: session.editing, editable: session.ready && session.editing && edit.allowed && !session.busy, active: session.ready, selected, record: session.record };
  const extraInspector = props.inspector?.(context) ?? [];
  const inspector = extraInspector.some(section => section.id === inspectorTab) || inspectorTab === 'identity' ? inspectorTab : extraInspector[0]?.id ?? 'identity';
  context.inspectorTab = inspector;
  const canSave = typeof props.canSave === 'function' ? props.canSave(context) : props.canSave !== false;
  const canFreeze = typeof props.canFreeze === 'function' ? props.canFreeze(context) : props.canFreeze !== false;
  const state: RecordState = revision ? { kind: 'revision', id: revision.revision_id, number: revision.number } : session.base ? { kind: 'draft', id: session.base.draft_id, version: Number(session.base.state.replace('draft-v', '')) || 1, dirty: session.dirty } : { kind: 'new' };
  const select = (number: number | null, working: boolean) => { props.onSelect(number, working); setVersions(false); };
  return <MantineThemeProvider theme={{ components: { Select: Select.extend({ defaultProps: { comboboxProps: { withinPortal: false } } }) } }}><DefinitionPickerScope.Provider value={{ key: `${props.principalKey}:${props.workspaceId}`, active: session.ready }}><Stack>
    <Group><Button variant="quiet" onClick={props.onBack}>Back to {props.collectionLabel}</Button><Button variant="quiet" onClick={() => void session.refresh()}>Refresh access</Button>{props.definitionId && <Button variant="quiet" onClick={() => setVersions(true)}>Versions</Button>}</Group>
    {session.error && <Alert color="red">{session.error}</Alert>}
    {!session.ready && <Text role="status">Record contents are hidden until current access is confirmed. Local edits remain retained.</Text>}
    {!session.ready && props.active && session.editing && <Group>{session.canUndo && <Button variant="quiet" disabled={session.busy} onClick={session.undoEdit}>Undo last local edit</Button>}{session.base && <Button variant="quiet" disabled={session.busy} onClick={() => void session.refresh(true)}>Reload saved draft (discard local edits)</Button>}</Group>}
    {!session.ready && session.errorStatus === 422 && session.error === 'Choose an explicit working draft.' && <details><summary>Advanced: choose a working draft</summary><TextInput label="Explicit working draft ID" value={draftId} onChange={e => setDraftId(e.currentTarget.value)} /><Button disabled={!draftId.trim()} onClick={() => session.chooseDraft(draftId.trim())}>Open chosen draft</Button></details>}
    <div hidden={!session.ready} inert={!session.ready || undefined}><RecordPage active={session.ready} identity={{ id: props.definitionId ?? undefined, name: session.record?.name ?? (session.name || `New ${props.title.toLowerCase()}`), kind: session.record?.kind ?? props.initial.kind }} state={state}
      actions={session.editing ? <><Button variant="quiet" disabled={!context.editable || !session.canUndo} onClick={session.undoEdit}>Undo</Button>{session.base && <Button variant="quiet" disabled={session.busy} onClick={() => setDiscard(true)}>Revert local edits</Button>}<Button {...edit.props} disabled={!context.editable || !session.name.trim() || !canSave} loading={session.busy} onClick={() => void session.save()}>Save draft</Button><Button {...freeze.props} disabled={!freeze.allowed || !session.ready || session.busy || !session.base || session.dirty || !canFreeze} onClick={() => void session.freeze()}>Freeze saved draft</Button></> : edit.allowed && <Button onClick={() => props.onSelect(null, true)}>Continue draft</Button>}
      notice={<Stack gap={4}>{session.notice && <Text role="status">{session.notice}</Text>}{!props.definitionId && <TextInput label={`${props.title} name`} maxLength={200} disabled={session.busy || !edit.allowed} value={session.name} onChange={e => session.setName(e.currentTarget.value)} />}</Stack>}
      views={[{ id: 'content', label: props.viewLabel ?? 'Declarations', content: <><div hidden={!session.editing} inert={!session.editing || undefined}><InspectionScope permission={props.definitionId ? 'design.edit' : props.createPermission ?? 'item.create'}><fieldset disabled={!context.editable} style={{ border: 0, padding: 0, minWidth: 0 }}>{props.renderContent({ ...context, content: session.buffer, editing: true, selected: session.base, active: context.active && session.editing })}</fieldset></InspectionScope></div>{!session.editing && session.ready && <div>{(props.renderInspection ?? props.renderContent)({ ...context, editing: false, editable: false })}</div>}</> }]} view="content" onView={() => {}} inspectorTab={inspector} onInspectorTab={setInspectorTab}
      inspector={[...extraInspector, { id: 'identity', label: 'Exact identity', content: () => <Stack><Text>{revision ? `Frozen r${revision.number}; retained engineering state.` : 'Working draft; changes remain local until Save.'}</Text><ExactPins pins={[{ label: 'Definition ID', value: props.definitionId }, { label: 'Revision ID', value: revision?.revision_id }, { label: 'Snapshot ID', value: revision?.snapshot_id }, { label: 'SHA-256', value: revision?.sha256 }, { label: 'Draft ID', value: session.base?.draft_id }, { label: 'Save token', value: session.base?.state }]} /></Stack> }]} /></div>
    <Modal opened={session.ready && versions} onClose={() => setVersions(false)} title={`${props.title} versions`}><Stack>{revision && <><Text>Frozen r{revision.number}</Text><Button disabled={revision.number <= 1} onClick={() => select(revision.number - 1, false)}>Previous exact revision</Button></>}<Button onClick={() => select(null, false)}>Latest frozen revision</Button><Button onClick={() => select(null, true)}>Working draft</Button><details><summary>Advanced: explicit working draft</summary><TextInput label="Explicit working draft ID" value={draftId} onChange={e => setDraftId(e.currentTarget.value)} /><Button disabled={!draftId.trim()} onClick={() => { if (!session.dirty || window.confirm('Replace retained local edits with the chosen working draft?')) { session.chooseDraft(draftId.trim()); select(null, true); } }}>Open chosen draft</Button></details></Stack></Modal>
    <Modal opened={session.ready && discard} onClose={() => setDiscard(false)} title="Discard local edits?"><Text>The saved working draft will replace this buffer.</Text><Button onClick={() => { setDiscard(false); void session.refresh(true); }}>Reload saved draft</Button></Modal>
  </Stack></DefinitionPickerScope.Provider></MantineThemeProvider>;
}
