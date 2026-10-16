import { Alert, Button, Group, MantineThemeProvider, Menu, Select, Stack, Text, TextInput } from '@mantine/core';
import { useMediaQuery } from '@mantine/hooks';
import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { DefinitionPickerScope } from '../../components/library/DefinitionSelect';
import { RecordPage, RecordSections, type RecordState } from '../../components/record';
import { RootDocuments } from '../../components/editor/Documents';
import { usePermission } from '../../lib/permissions';
import { ContextSelectionProvider, useContextSelection } from '../context-selection/ContextSelectionProvider';
import { TreeView, BoardView, CableView, InspectorView, SchematicView, BomView } from '../context-selection/views';
import { useNavigation } from '../navigation';
import { useProbe } from '../probe';
import type { Address, GeometryScene } from '../shared-scene/api';
import { StockRecordDetails } from '../wire-stock/StockRecordSections';
import type { LibraryRecord, Project } from '../workspace/api';
import { useDeviceRecord, type DeviceRecordProps } from './useDeviceRecord';
import { OccurrenceControls, RelationshipControls, WorkingFirmware, WorkingTree } from './DeviceWorking';
import type { Assembly } from './api';
import './device-record.css';
const Viewport = lazy(() => import('../shared-scene/SceneViewport'));
const DeviceSections = lazy(() => import('./DeviceSections').then(module => ({ default: module.DeviceSections })));
type Props = DeviceRecordProps & { projects: Project[]; onBack: () => void; onOpenInProject: (id: string, record: LibraryRecord) => void };
export function DeviceRecordPage(props: Props) {
  const record = useDeviceRecord(props);
  const readable = !record.checking && !record.unavailable && !record.needsDraftChoice && !!record.assembly;
  const retained = useRef<{ assembly: Assembly; name: string; pin: NonNullable<typeof record.frozen.data>['pin'] | null; metadata: LibraryRecord | null } | null>(null);
  if (readable) retained.current = { assembly: record.assembly!, name: record.name, pin: record.editing ? null : record.frozen.data?.pin ?? null, metadata: record.record ?? null };
  const content = retained.current;
  const pin = !record.editing ? content?.pin : null;
  return <ContextSelectionProvider recordKey={props.definitionId ?? "new-device"} scope={{ principal_key: props.principalKey, project_id: props.workspaceId, snapshot_id: pin?.snapshot_id ?? 'working-device' }} active={props.active && readable && !!pin} authorityPending={!readable} revision={pin?.number ?? null} expectedRoot={pin ? { definitionId: pin.definition_id, revisionId: pin.revision_id, sha256: pin.sha256 } : undefined}>
    <DeviceSurface {...props} record={record} content={content} rootReadable={readable} />
  </ContextSelectionProvider>;
}
function DeviceSurface(props: Props & { record: ReturnType<typeof useDeviceRecord>; content: { assembly: Assembly; name: string; pin: NonNullable<ReturnType<typeof useDeviceRecord>['frozen']['data']>['pin'] | null; metadata: LibraryRecord | null } | null; rootReadable: boolean }) {
  const compact = useMediaQuery("(max-width: 48em)");
  const { record, content, active, principalKey, workspaceId, definitionId, onBack, onSelect } = props;
  const context = useContextSelection(), navigation = useNavigation(), probe = useProbe();
  const edit = usePermission(definitionId ? 'design.edit' : 'item.create'), freeze = usePermission('design.freeze');
  const [ownView, setOwnView] = useState('scene'), [ownTab, setOwnTab] = useState('occurrence');
  const view = active && ['scene', 'tree', 'documents'].includes(navigation?.location.filters?.view ?? '') ? navigation!.location.filters!.view! : ownView;
  const tab = active ? navigation?.location.filters?.section ?? ownTab : ownTab;
  const chooseTab = (value: string) => { setOwnTab(value); if (active) navigation?.navigate({ filters: { ...navigation.location.filters, section: value } }, { replace: true }); };
  useEffect(() => { record.setDetails(active && tab === 'more'); }, [active, tab, record.setDetails]);
  const [selected, setSelected] = useState<string | null>(null), [capturedSelection, setCapturedSelection] = useState<Address | null>(null), [staged, setStaged] = useState(new Set<string>());
  useEffect(() => { setStaged(new Set()); }, [record.editorEpoch]);
  const assembly = content?.assembly;
  const frozen = !record.editing && !!content?.pin;
  const unavailable = record.unavailable || frozen && context.state.status === 'unavailable';
  const readable = props.rootReadable && (!frozen || context.state.status === 'ready');
  const frameActive = active && readable;
  const editable = frameActive && record.editing && edit.allowed && !record.busy;
  const choose = (id: string | null) => { setSelected(id); setCapturedSelection(null); chooseTab('occurrence'); if (definitionId && id && active) probe?.setProbe({ object: definitionId, rev: null, path: [id] }); };
  const selectedWorking = selected ?? (probe?.probe?.object === definitionId && probe.probe.path.length === 1 ? probe.probe.path[0]! : null);
  const geometry = frozen ? context.state.scene : record.inspectionBasis ? record.captured.data : null;
  const paths = [...new Map([...(assembly?.occurrences.map(row => ({ path: [row.local_id], label: row.display_ref || row.local_id })) ?? []), ...(geometry?.nodes.map(row => ({ path: row.address.path, label: `${row.address.path.join(' / ')} · ${row.display_ref || row.name}` })) ?? [])].map(row => [JSON.stringify(row.path), row])).values()];
  const state: RecordState = !definitionId ? { kind: 'new' } : record.editing ? { kind: 'draft', id: record.current?.draft_id ?? record.draftId ?? '', version: Number(record.current?.state.replace('draft-v', '')) || 1, dirty: record.dirty } : { kind: 'revision', id: record.revision?.revision_id ?? '', number: record.revision?.number ?? 0 };
  const refresh = () => { void record.refresh(); if (frozen) void context.refresh(); };
  const selectScene = (address: Address) => { if (frozen) context.controller.selectOccurrence(address); else { setCapturedSelection(address); chooseTab('occurrence'); if (address.path.length === 1) setSelected(address.path[0]!); if (definitionId && active) probe?.setProbe({ object: definitionId, rev: null, path: [...address.path, ...(address.feature_id ? ['#' + address.feature_id] : [])] }); } };
  const capturedFromProbe = !frozen && geometry && probe?.probe?.object === definitionId ? geometry.nodes.find(node => JSON.stringify(node.address.path) === JSON.stringify(probe.probe!.path))?.address ?? null : null;
  const sceneSelected = frozen && context.state.selection?.kind === 'occurrence' ? context.state.selection.address : capturedFromProbe ?? capturedSelection;
  const rows = record.identity.data?.drafts ?? [];
  const draftChoice = <Select size="xs" label="Editable device draft" value={record.draftId} disabled={record.busy || record.dirty && !!record.current} data={rows.map(row => ({ value: row.draft_id, label: `${row.state} · ${row.draft_id.slice(0, 8)}` }))} onChange={record.chooseDraft} />;
  return <MantineThemeProvider theme={{ components: { Select: Select.extend({ defaultProps: { comboboxProps: { withinPortal: false } } }) } }}><DefinitionPickerScope.Provider value={{ key: `${principalKey}:${workspaceId}`, active: frameActive }}><div hidden={!active} inert={!active}>
    {!readable && <Stack gap="xs"><Group><Button size="xs" variant="quiet" onClick={onBack}>Back to Designs</Button><Button size="xs" variant="quiet" onClick={refresh}>Refresh device</Button></Group>{unavailable ? <Alert color="red" title="Device state unavailable">Selected drawings and facts are hidden. Local buffers and original editing tokens remain available for authorized recovery.</Alert> : record.needsDraftChoice ? <><Text>Choose an editable draft explicitly. Catalog order is not chronological.</Text>{draftChoice}</> : <Text role="status">Checking current exact device state and source access…</Text>}</Stack>}
    <div hidden={!readable} inert={!readable}>
      <RecordPage active={frameActive} identity={{ id: definitionId ?? undefined, name: content?.name ?? record.name, kind: 'device' }} state={state}
        actions={<>{!(compact && record.editing) && <><Button size="xs" variant="quiet" onClick={onBack}>Back to Designs</Button><Button size="xs" variant="quiet" onClick={refresh}>Refresh device</Button></>}{!record.editing && edit.allowed && <Button size="xs" onClick={() => onSelect(null, true)}>Continue draft</Button>}{record.editing && <><Button size="xs" loading={record.busy} disabled={!editable || staged.size > 0 || !definitionId && !record.enteredName.trim()} {...edit.props} onClick={() => void record.save()}>Save device</Button><Button size="xs" variant="quiet" disabled={!editable || !record.current || record.dirty || staged.size > 0} onClick={() => void record.capture()}>Capture saved assembly</Button>{compact ? <Menu withinPortal={false} position="bottom-end"><Menu.Target><Button size="xs" variant="quiet">Device actions</Button></Menu.Target><Menu.Dropdown><Menu.Item onClick={onBack}>Back to Designs</Menu.Item><Menu.Item onClick={refresh}>Refresh device</Menu.Item><Menu.Item disabled={!frameActive || record.busy || !record.current || record.dirty || staged.size > 0 || !freeze.allowed} title={freeze.reason} onClick={() => void record.freeze()}>Freeze saved device</Menu.Item>{record.current && <Menu.Item disabled={record.busy} onClick={() => { void record.reload(); }}>Reload saved draft (discard local edits)</Menu.Item>}</Menu.Dropdown></Menu> : <><Button size="xs" variant="quiet" disabled={!frameActive || record.busy || !record.current || record.dirty || staged.size > 0 || !freeze.allowed} {...freeze.props} onClick={() => void record.freeze()}>Freeze saved device</Button>{record.current && <Button size="xs" variant="quiet" disabled={record.busy} onClick={() => { void record.reload(); }}>Reload saved draft (discard local edits)</Button>}</>}</>}</>}

        notice={<>{record.error && <Alert color="red">{record.error}</Alert>}{record.message && <Text size="xs" role="status">{record.message}</Text>}{staged.size > 0 && <Text size="sm">Apply or discard the selected occurrence fields before saving or capturing.</Text>}{record.dirty && record.current && record.draft.data?.state !== record.current.state && <Alert color="yellow">The saved draft changed. Your working declaration and original editing token are retained.</Alert>}</>}
        revisions={<Group gap="xs"><Button size="xs" variant="quiet" onClick={() => record.setHistory(value => !value)}>Revisions</Button>{record.revision && <Button size="xs" variant="quiet" onClick={() => onSelect(record.revision!.number)}>r{record.revision.number}</Button>}{definitionId && <Button size="xs" variant="quiet" onClick={() => onSelect(null, true)}>Draft</Button>}{record.history && <><Button size="xs" variant="quiet" disabled={!record.offset} onClick={() => record.setOffset(value => Math.max(0, value - 50))}>Earlier page</Button>{record.revisions.data?.revisions.map(row => <Button size="xs" variant="quiet" key={row.revision_id} onClick={() => onSelect(row.number)}>r{row.number}</Button>)}<Button size="xs" variant="quiet" disabled={Math.max(record.revisions.data?.drafts.length ?? 0, record.revisions.data?.revisions.length ?? 0) < 50} onClick={() => record.setOffset(value => value + 50)}>Later page</Button>{record.editing && draftChoice}</>}</Group>}
        view={view} onView={value => { setOwnView(value); if (active) navigation?.navigate({ filters: { ...navigation.location.filters, view: value } }, { replace: true }); }}
        views={[
          { id: 'scene', label: 'Scene', content: <DeviceScene geometry={geometry} active={frameActive && view === 'scene'} selected={sceneSelected} onSelect={selectScene} captured={!frozen} dirty={record.dirty} /> },
          { id: 'tree', label: 'Tree', content: frozen && context.state.scene ? <TreeView /> : geometry ? <CapturedTree scene={geometry} selected={sceneSelected} onSelect={selectScene} /> : assembly ? <WorkingTree assembly={assembly} selected={selectedWorking} onSelect={choose} /> : null },
          { id: 'documents', label: 'Documents', content: content?.pin && frozen && definitionId ? <RootDocuments name={content.name} snapshot={{ definitionId, revisionId: content.pin.revision_id, draftId: null }} principalKey={principalKey} workspaceId={workspaceId} active={frameActive && view === 'documents'} authorizeWorking={async () => { throw new Error('Device documents require the selected frozen revision.'); }} /> : <Text size="sm">Exact device documents require a frozen revision. A captured draft scene does not establish a document or BOM qualification basis.</Text> },
        ]}
        inspectorTab={tab} onInspectorTab={chooseTab} inspector={[
          { id: 'occurrence', label: 'Occurrence', content: () => <Stack gap="xs">{!definitionId && <TextInput size="xs" label="Device name" value={record.enteredName} disabled={!editable} onChange={event => record.setName(event.currentTarget.value)} />}{frozen && context.state.scene ? <InspectorView /> : sceneSelected && geometry && sceneSelected.path.length > 1 ? <><CapturedOccurrence scene={geometry} selected={sceneSelected} /><Button size="xs" variant="quiet" onClick={() => choose(sceneSelected.path[0]!)}>Inspect containing working occurrence</Button></> : assembly ? <OccurrenceControls newRecord={!definitionId} assembly={assembly} selected={selectedWorking} onSelect={choose} editable={editable} onChange={record.change} staged={staged} epoch={record.editorEpoch} onStaged={id => { setStaged(prior => new Set([...prior, id])); record.markStaged(); }} onApplied={id => setStaged(prior => new Set([...prior].filter(value => value !== id)))} /> : null}</Stack> },
          { id: 'relationships', label: 'Relationships', content: () => assembly ? <RelationshipControls assembly={assembly} editable={editable} onChange={record.change} paths={paths} /> : null },
          ...(['interfaces', 'options', 'enclosure', 'drawings'] as const).map(section => ({ id: section, label: { interfaces: 'Interfaces', options: 'Options', enclosure: 'Enclosure', drawings: 'Drawings' }[section], content: () => <Suspense fallback={<Text>Loading {section}…</Text>}><DeviceSections section={section} active={frameActive && tab === section} principalKey={principalKey} workspaceId={workspaceId} definitionId={definitionId} revisionId={frozen ? content?.pin?.revision_id ?? null : null} snapshotId={frozen ? content?.pin?.snapshot_id ?? null : null} /></Suspense> })),
          { id: 'firmware', label: 'Firmware', content: () => <Stack gap="xs">{assembly && <WorkingFirmware assembly={assembly} editable={editable} paths={paths} onChange={record.change} />}<Suspense fallback={<Text>Loading firmware context…</Text>}><DeviceSections section="firmware" active={frameActive && tab === 'firmware'} principalKey={principalKey} workspaceId={workspaceId} definitionId={definitionId} revisionId={frozen ? content?.pin?.revision_id ?? null : null} snapshotId={frozen ? content?.pin?.snapshot_id ?? null : null} draftId={record.current?.draft_id ?? null} draftDirty={record.dirty} /></Suspense></Stack> },
          ...(frozen && context.state.scene ? [{ id: 'context', label: 'Context', content: () => <RecordSections sections={[{ id: 'board', label: 'Selected native board context', content: () => <BoardView /> }, { id: 'cable', label: 'Selected cable context', content: () => <CableView /> }, { id: 'schematic', label: 'Selected schematic context', content: () => <SchematicView /> }, { id: 'bom', label: 'Exact frozen BOM context', content: () => <BomView /> }]} /> }] : []),
          { id: 'more', label: 'More', content: () => <Stack gap="xs">{content?.metadata && <StockRecordDetails toolLabel="Device" active={frameActive && tab === 'more'} principalKey={principalKey} workspaceId={workspaceId} record={content.metadata} revisionId={frozen ? content.pin?.revision_id ?? null : null} revisionNumber={frozen ? content.pin?.number ?? null : null} projects={props.projects} onOpenInProject={props.onOpenInProject} />}<RecordSections sections={[{ id: 'content', label: 'Advanced · selected declaration', content: () => <pre>{JSON.stringify(assembly, null, 2)}</pre> }]} /></Stack> },
        ]} />
    </div>
  </div></DefinitionPickerScope.Provider></MantineThemeProvider>;
}
function DeviceScene({ geometry, active, selected, onSelect, captured, dirty }: { geometry: GeometryScene | null | undefined; active: boolean; selected: Address | null; onSelect: (value: Address) => void; captured: boolean; dirty: boolean }) {
  const retained = useRef<GeometryScene | null>(null); if (geometry) retained.current = geometry;
  const [arrangement, setArrangement] = useState<'canonical' | 'inspection'>('canonical');
  const surface = retained.current;
  return <Stack gap="xs">{!geometry && <div className="device-empty"><Text>{dirty ? 'Working declaration changed.' : 'No saved scene captured.'}</Text><Text size="sm">Save the declaration, then choose Capture saved assembly. The preview uses that immutable capture and its exact child revisions; it never auto-saves or freezes.</Text></div>}
    <div hidden={!geometry} inert={!geometry}>{surface && <><Group gap="xs"><Select size="xs" label="Scene arrangement" value={arrangement} allowDeselect={false} data={[{ value: 'canonical', label: 'Declared placement' }, { value: 'inspection', label: 'Local inspection' }]} onChange={value => setArrangement(value as typeof arrangement)} />{captured && <Text size="xs">Captured draft preview · no frozen root revision.</Text>}</Group><Suspense fallback={<Text>Loading shared scene…</Text>}><Viewport compactControls scene={surface} active={active && !!geometry} arrangement={arrangement} selected={selected?.snapshot_id === surface.snapshot_id ? selected : null} onSelect={onSelect} onRestoreCanonical={() => setArrangement('canonical')} /></Suspense></>}</div>
  </Stack>;
}

function CapturedTree({ scene, selected, onSelect }: { scene: GeometryScene; selected: Address | null; onSelect: (value: Address) => void }) {
  return <Stack gap="xs" className="device-tree" aria-label="Captured occurrence tree"><Text size="xs">Immutable saved-state capture · exact nested child revisions</Text>{scene.nodes.map(node => <div key={node.node_id} className="device-tree-row"><Button variant={JSON.stringify(selected?.path) === JSON.stringify(node.address.path) ? 'filled' : 'quiet'} aria-pressed={JSON.stringify(selected?.path) === JSON.stringify(node.address.path)} onClick={() => onSelect(node.address)}>{node.address.path.join(' / ')} · {node.display_ref || node.name}</Button><Text size="xs">{node.kind} · placement {node.world_status}</Text></div>)}</Stack>;
}
function CapturedOccurrence({ scene, selected }: { scene: GeometryScene; selected: Address }) {
  const node = scene.nodes.find(row => JSON.stringify(row.address.path) === JSON.stringify(selected.path));
  return node ? <Stack gap="xs"><Text>{node.display_ref || node.name}</Text><Text size="sm">Captured use {node.address.path.join(' / ')}</Text><Text size="xs">Exact child revision {node.revision_id} · {node.kind} · placement {node.world_status}</Text><Text size="sm">Nested declarations belong to their pinned child record. Edit that record deliberately and replace its exact occurrence pin; this capture is immutable.</Text></Stack> : <Text>Select an exact captured use.</Text>;
}
