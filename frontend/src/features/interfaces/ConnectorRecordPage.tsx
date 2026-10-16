import { useState } from 'react';
import { Alert, Button, Group, MantineThemeProvider, Select, Stack, Table, Text, TextInput } from '@mantine/core';
import { DefinitionPickerScope } from '../../components/library/DefinitionSelect';
import { RecordPage, type RecordState } from '../../components/record';
import { InspectionScope, PermissionsProvider, usePermission } from '../../lib/permissions';
import { newestFirst, revisionOptionLabel } from '../../lib/revision-labels';
import type { LibraryRecord, Project } from '../workspace/api';
import { PinoutWorkbench } from '../pinout-editor/PinoutWorkbench';
import { BodyFace } from './BodyFace';
import { BodyEditor, PinoutEditor } from './InterfacePanel';
import { PortEditor } from './PortEditor';
import { AssemblyEditor } from '../end-assemblies/EndAssemblyEditor';
import { StackDiagram, StackView } from '../end-assemblies/StackEditor';
import { ConnectorRelations } from './ConnectorRelations';
import { StockRecordDetails } from '../wire-stock/StockRecordSections';
import { blankConnector, useConnectorSession, type ConnectorSessionProps } from './useConnectorSession';
import type { ConnectorKind, ConnectorValue, Relation } from './connector-api';
import type { Inspection, Pinout, Port } from './api';
import type { EndAssembly } from '../end-assemblies/api';
import './connector-record.css';

export type ConnectorRecordProps = ConnectorSessionProps & {
  projects: Project[]; onBack: () => void; onOpen: (relation: Relation) => void;
  onNew: (kind: ConnectorKind, value: ConnectorValue, name?: string) => void;
  onOpenInProject: (projectId: string, record: LibraryRecord) => void;
};
/** Privacy changes replace the entire retained session, including held operation callbacks. */
export function ConnectorRecordPage(props: ConnectorRecordProps) {
  return <ConnectorRecordSession key={`${props.principalKey}:${props.workspaceId}:${props.definitionId ?? 'new'}`} {...props} />;
}
function ConnectorRecordSession(props: ConnectorRecordProps) {
  const session = useConnectorSession(props);
  const [view, setView] = useState('body'), [history, setHistory] = useState(false);
  const create = usePermission('item.create'), edit = usePermission(props.definitionId ? 'design.edit' : 'item.create'), freeze = usePermission('design.freeze');
  const permitted = session.editing && edit.allowed;
  const mode = !props.definitionId ? 'create' : session.editing ? 'draft' : 'frozen';
  const [everReady, setEverReady] = useState(false);
  if (session.ready && !everReady) setEverReady(true);
  const value = session.editing ? session.buffer : session.frozen?.interface;
  const revisionId = session.editing ? null : session.frozen?.revision_id ?? null;
  const state: RecordState = !props.definitionId ? { kind: 'new' } : session.editing ? { kind: 'draft', id: session.base?.draft_id ?? '', version: Number(session.base?.state.replace('draft-v', '')) || 1, dirty: session.dirty } : { kind: 'revision', id: revisionId ?? '', number: session.number ?? 0 };
  const change = (next: ConnectorValue) => { if (permitted) session.change(next); };
  const newPort = (id: string, label: string) => props.onNew('port', { ...blankConnector('port') as Port, pinout_revision_id: id }, `${label} device port`);
  const newStack = (pinout: string, body: string, label: string) => props.onNew('end_assembly', { ...blankConnector('end_assembly') as EndAssembly, stack: { layers: [{ kind: 'connector', layer_id: 'connector', body_revision_id: body, pinout_revision_id: pinout }], joins: [] } }, `${label} end stack`);
  let editor = null;
  if (value?.kind === 'connector_body') editor = <BodyEditor value={value} onChange={change} face={false} />;
  if (value?.kind === 'pinout') editor = <PinoutEditor value={value} onChange={change} mode={mode} definitionId={props.definitionId} workbench={false} />;
  if (value?.kind === 'end_assembly') editor = <AssemblyEditor value={value} onChange={change} />;
  const draw = value?.kind === 'connector_body' ? <><BodyFace body={value} /><Table.ScrollContainer minWidth={360}><Table aria-label="Physical contacts"><Table.Thead><Table.Tr><Table.Th>Contact</Table.Th><Table.Th>Label</Table.Th><Table.Th>Physical role</Table.Th></Table.Tr></Table.Thead><Table.Tbody>{value.contacts.map(contact => <Table.Tr key={contact.contact_id}><Table.Td>{contact.contact_id}</Table.Td><Table.Td>{contact.label || 'Unknown'}</Table.Td><Table.Td>{contact.physical_role}</Table.Td></Table.Tr>)}</Table.Tbody></Table></Table.ScrollContainer><Text size="sm">Family {value.family ?? 'unknown'} · mating role {value.mating_role}. Mating and electrical compatibility are not inferred.</Text></>
    : value?.kind === 'pinout' ? <PinoutWorkbench value={value} onChange={permitted && !session.busy ? change : undefined} mode={mode} definitionId={props.definitionId} inspection={session.frozen as Inspection | null} />
    : value?.kind === 'port' ? <PermissionsProvider permissions={permitted ? undefined : []}><InspectionScope permission="design.edit"><fieldset disabled={session.busy} style={{ border: 0, padding: 0, minWidth: 0 }}><PortEditor value={value} onChange={change} mode={mode} /></fieldset></InspectionScope></PermissionsProvider>
    : value?.kind === 'end_assembly' ? <><StackDiagram label="Saved end stack" layers={value.stack.layers.map(layer => ({ kind: layer.kind, name: layer.layer_id }))} />{session.frozen?.end_stack && <StackView resolved={session.frozen.end_stack} label="Saved end stack" />}<Text>{value.description || 'Description unknown'}</Text><Text size="sm">Continuity is not evaluated.</Text></> : null;
  const views = [{ id: 'body', label: value?.kind === 'pinout' ? 'Pinout' : value?.kind === 'port' ? 'Device port' : value?.kind === 'end_assembly' ? 'End stack' : 'Body', content: <div className="connector-record-drawing">{draw}</div> }];
  if (value?.kind === 'connector_body') for (const [kind, label] of [['pinout', 'Pinouts'], ['port', 'Device ports'], ['end_assembly', 'Saved end stacks']] as const) views.push({ id: kind, label, content: revisionId ? <Stack>{kind === 'pinout' && create.allowed && <Button onClick={() => props.onNew('pinout', { ...blankConnector('pinout') as Pinout, body_revision_id: revisionId }, `${session.name} pinout`)}>New pinout variant from body r{session.number}</Button>}<ConnectorRelations key={`${revisionId}:${kind}`} active={props.active && session.ready && view === kind} bodyRevisionId={revisionId} kind={kind} onOpen={props.onOpen} onAccessLost={() => { void session.refresh(); }} onNewPort={row => newPort(row.revision_id, row.name)} onNewStack={row => newStack(row.revision_id, row.body_revision_ids[0] ?? '', row.name)} /></Stack> : <Text>Freeze the body to create and browse exact related records.</Text> });
  return <MantineThemeProvider theme={{ components: { Select: Select.extend({ defaultProps: { comboboxProps: { withinPortal: false } } }) } }}><DefinitionPickerScope.Provider value={{ key: `${props.principalKey}:${props.workspaceId}`, active: props.active && session.ready }}>
    {session.needsDraftChoice && <Stack><Alert title="Choose a connector draft">Several editable drafts exist. Choose an exact draft; their catalog order does not identify the newest.</Alert><Select label="Connector draft" value={null} onChange={id => id && session.chooseDraft(id)} data={session.draftChoices.map(draft => ({ value: draft.draft_id, label: `${draft.state} · ${draft.draft_id}` }))} /><Group><Button variant="quiet" disabled={session.draftOffset === 0} onClick={() => { void session.loadDraftChoices(Math.max(0, session.draftOffset - 50)); }}>Previous connector drafts</Button><Button variant="quiet" disabled={session.draftChoices.length < 50} onClick={() => { void session.loadDraftChoices(session.draftOffset + 50); }}>More connector drafts</Button><Button variant="quiet" onClick={props.onBack}>Back to list</Button></Group></Stack>}
    {!session.ready && !session.needsDraftChoice && <Stack><Alert color={session.error ? 'red' : 'blue'} title={session.error ? 'Connector unavailable' : 'Confirming connector access'}>{session.error || 'Checking the selected state and its exact references.'}</Alert><Group><Button variant="quiet" onClick={props.onBack}>Back to list</Button><Button onClick={() => { void session.refresh(); }}>Retry connector access</Button></Group></Stack>}
    {everReady && value && <div hidden={!session.ready} inert={!session.ready || undefined}><RecordPage active={props.active && session.ready} identity={{ id: props.definitionId ?? undefined, name: session.name || `New ${value.kind.replaceAll('_', ' ')}`, kind: value.kind }} state={state}
      view={views.some(item => item.id === view) ? view : 'body'} onView={setView} views={views}
      actions={<Group gap="xs"><Button variant="quiet" onClick={props.onBack}>Back to list</Button><Button variant="quiet" onClick={() => { void session.refresh(); }}>Refresh record</Button>{props.definitionId && <Button variant="quiet" onClick={() => setHistory(!history)}>Connector versions</Button>}{create.allowed && <Button variant="quiet" onClick={() => props.onNew(value.kind, structuredClone(value), `${session.name} copy`)}>Duplicate connector</Button>}{session.editing && <><Button disabled={!permitted || session.busy || !session.name.trim() || !session.ready} loading={session.busy} title={edit.reason} onClick={() => { void session.save(); }}>Save connector</Button><Button variant="quiet" disabled={session.busy || !session.base} onClick={() => { void session.refresh(true); }}>Reload saved draft (discard local changes)</Button><Button disabled={!freeze.allowed || session.busy || session.dirty || !session.base || !session.ready} title={freeze.reason} onClick={() => { void session.freeze(); }}>Freeze saved connector</Button></>}{value.kind === 'pinout' && revisionId && create.allowed && <><Button variant="quiet" onClick={() => newPort(revisionId, session.name)}>New device port</Button><Button variant="quiet" onClick={() => newStack(revisionId, value.body_revision_id, session.name)}>New saved end stack</Button></>}</Group>}
      notice={<>{session.error && <Alert color="red">{session.error}</Alert>}{session.notice && <Text role="status">{session.notice}</Text>}</>}
      revisions={history && <Stack><Text>Exact revision choices never advance an existing pin.</Text><Select label="Connector revision" value={session.editing ? null : String(session.number)} data={newestFirst(session.identity?.revisions ?? []).map(row => ({ value: String(row.number), label: revisionOptionLabel(session.name, row.number) }))} onChange={number => number && props.onSelect(Number(number), false)} /><Group><Button variant="quiet" disabled={session.historyOffset === 0} onClick={() => { void session.loadHistory(Math.max(0, session.historyOffset - 50)); }}>Earlier connector revisions</Button><Button variant="quiet" disabled={(session.identity?.revisions.length ?? 0) < 50} onClick={() => { void session.loadHistory(session.historyOffset + 50); }}>Later connector revisions</Button><Button variant="quiet" onClick={() => props.onSelect(null, true)}>Edit current connector draft</Button></Group></Stack>}
      inspector={[{ id: 'part', label: 'Part', content: () => <PermissionsProvider permissions={permitted ? undefined : []}><InspectionScope permission="design.edit"><fieldset disabled={session.busy} style={{ border: 0, padding: 0, minWidth: 0 }}><Stack>{!props.definitionId && <TextInput label="Connector name" value={session.name} onChange={event => { if (permitted && !session.busy) session.setName(event.currentTarget.value); }} />}{editor}{value.kind === 'port' && <Text>Device conditions and per-contact requirements are edited beside the port drawing.</Text>}</Stack></fieldset></InspectionScope></PermissionsProvider> },
        { id: 'details', label: 'Details', content: () => session.record ? <StockRecordDetails toolLabel="Connector" active={props.active && session.ready} principalKey={props.principalKey} workspaceId={props.workspaceId} record={session.record} revisionId={revisionId} revisionNumber={session.number} projects={props.projects} onOpenInProject={props.onOpenInProject} /> : <Text>Save a definition to attach sources, evidence and project references.</Text> }]} /></div>}
  </DefinitionPickerScope.Provider></MantineThemeProvider>;
}
