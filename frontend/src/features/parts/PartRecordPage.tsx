import { Alert, Button, Group, MantineThemeProvider, Modal, Select, Stack, Text, TextInput } from '@mantine/core';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { lazy, Suspense, useState } from 'react';
import { DefinitionPickerScope, DefinitionSelect } from '../../components/library/DefinitionSelect';
import { RecordPage, type RecordState } from '../../components/record';
import { RevisionWhereUsed } from '../../components/record/RevisionWhereUsed';
import { ExactPins } from '../../lib/IdentityLabel';
import { InspectionScope, ReadOnlyNote, usePermission } from '../../lib/permissions';
import type { Catalog } from '../identity/api';
import { useNavigation } from '../navigation';
import { AddButton, useReferenceActions, UsedInList } from '../scope/LibraryView';
import { requestJson, type LibraryRecord, type Project } from '../workspace/api';
import { usePartSession, type SessionProps } from './usePartSession';
import { appendLine, KitLines, PartFields } from './PartFields';
import { kitValue, partValue, type Content } from './api';
import { PartAssociations } from './PartAssociations';
import { PartRelations } from './PartRelations';
import { MechanicalFields } from './MechanicalFields';
import { mechanicalModels } from './model-input';
import { PartFacts } from './PartFacts';
import './parts.css';
const PartModel = lazy(() => import('./PartModel').then(module => ({ default: module.PartModel })));

export type PartRecordProps = SessionProps & { collectionLabel?: string; projects: Project[]; onBack: () => void; onDuplicate: (kind: string, content: Content, name: string) => void; onOpenKit: (id: string, revision: number | null, add?: string) => void; onOpenInProject: (project: string, record: LibraryRecord) => void; addRevision?: string };
export function PartRecordPage(props: PartRecordProps) { return <PartRecordSession key={`${props.principalKey}:${props.workspaceId}`} {...props} />; }
function PartRecordSession(props: PartRecordProps) {
  const { active, principalKey, workspaceId, definitionId, onBack, projects } = props;
  const session = usePartSession(props), nav = useNavigation(), cache = useQueryClient();
  const [view, setView] = useState('model'), [inspector, setInspector] = useState('properties'), [versions, setVersions] = useState(false), [draftId, setDraftId] = useState(''), [discard, setDiscard] = useState(false), [adding, setAdding] = useState(false), [kitId, setKitId] = useState<string | null>(null), [acceptedAdd, setAcceptedAdd] = useState<string | null>(null), [offset, setOffset] = useState(0);
  const create = usePermission('item.create'), edit = usePermission(definitionId ? 'design.edit' : 'item.create'), freeze = usePermission('design.freeze'), projectEdit = usePermission('project.edit');
  const actions = useReferenceActions();
  const selected = session.record?.selected, revision = selected?.kind === 'revision' && !session.editing ? selected : null;
  const kind = session.record?.kind ?? props.initial.kind, content = session.content ?? session.buffer, part = partValue(content), kit = kitValue(content);
  const editable = session.ready && session.editing && edit.allowed && !session.busy;
  const catalog = useQuery({ queryKey: ['part-catalog', principalKey, workspaceId, revision?.revision_id, offset], enabled: session.ready && !!revision, retry: false,
    queryFn: ({ signal }) => requestJson<Catalog>(`/api/v0/catalog/revisions/${revision!.revision_id}?offset=${offset}&limit=50`, { signal, cache: 'no-store' }) });
  const visibleCatalog = session.ready && !catalog.isError && !catalog.isFetching ? catalog.data : undefined;
  const metadata = useQuery({ queryKey: ['part-reference-metadata', principalKey, workspaceId, definitionId], enabled: session.ready && !!definitionId && inspector === 'use', retry: false,
    queryFn: ({ signal }) => requestJson<LibraryRecord>(`/api/v0/workspace/library/${definitionId}`, { signal, cache: 'no-store' }) });
  const references = session.ready && !metadata.isError && !metadata.isFetching ? metadata.data : undefined;
  const referenceRecord = references && revision ? { ...references, latest_revision: revision.number, latest_revision_id: revision.revision_id } : references;
  const changeView = (next: string) => { setView(next); if (active) nav?.navigate({ filters: { ...nav.location.filters, view: next } }, { replace: true }); };
  const currentView = active && ['model', 'details', 'parts'].includes(nav?.location.filters?.view ?? '') ? nav!.location.filters!.view! : view;
  const displayName = session.name || (kind === 'kit' ? 'New kit' : 'New part');
  const backLabel = props.collectionLabel ?? (kind === 'kit' ? 'Kits' : 'Parts');
  const state: RecordState = !definitionId ? { kind: 'new' } : revision ? { kind: 'revision', id: revision.revision_id, number: revision.number } : { kind: 'draft', id: session.base?.draft_id ?? '', version: Number(session.base?.state.replace('draft-v', '')) || 1, dirty: session.dirty };
  const rows = visibleCatalog?.representations ?? [];
  const selectedModels = [...new Map([...rows.filter(row => ['model', 'drawing'].includes(row.kind)), ...mechanicalModels(content)].map(row => [row.representation_id, row])).values()];
  const properties = () => kind === 'kit' ? <Text>Catalog grouping · {kit?.lines.length ?? 0} declared lines. Quantities remain unknown until explicitly entered.</Text> : kind === 'mechanical_source' ? <MechanicalFields content={content} editable={editable} active={session.ready && inspector === 'properties'} workspaceId={workspaceId} principalKey={principalKey} change={session.change} /> : <PartFields content={content} editable={editable && kind === 'part'} change={session.change} />;
  const fence = <Stack gap="xs"><Group><Button size="xs" variant="quiet" onClick={onBack}>Back to {backLabel}</Button><Button size="xs" onClick={() => void session.refresh()}>Retry current record access</Button></Group>
    {session.error ? <Alert color="red" title="Record unavailable">{session.error}<Text size="sm">Retained content is hidden until current access is confirmed. Local edits remain in this session.</Text></Alert> : <Text role="status">Reading selected record state…</Text>}
    {props.draftRequested && <><TextInput label="Explicit working draft ID" value={draftId} onChange={event => setDraftId(event.currentTarget.value)} /><Button disabled={!draftId.trim()} onClick={() => { if (!session.dirty || window.confirm('Replace the retained local buffer with this explicitly chosen working draft?')) session.chooseDraft(draftId.trim()); }}>Open chosen draft</Button></>}
  </Stack>;
  const details = <Stack><dl className="part-spec"><div><dt>Category</dt><dd>{part?.category ?? (kind === 'mechanical_source' ? String((content.mechanical_source as { item_role?: string })?.item_role ?? 'Unknown') : 'Unknown')}</dd></div><div><dt>Value</dt><dd>{part?.value ?? (typeof content.value === 'string' ? content.value : 'Unknown')}</dd></div><div><dt>Package</dt><dd>{part?.package ?? (typeof content.package === 'string' ? content.package : 'Unknown')}</dd></div><div><dt>Physical fit</dt><dd>Not evaluated</dd></div></dl>
    {kind === 'mechanical_source' && <Text>Model, target and source declarations are available in Properties. A drawing is not clearance evidence.</Text>}
    {!part && !kit && Object.entries(content).filter(([, value]) => typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean').map(([key, value]) => <Text key={key}>{key}: {String(value)}</Text>)}
  </Stack>;
  return <MantineThemeProvider theme={{ components: { Select: Select.extend({ defaultProps: { comboboxProps: { withinPortal: false } } }) } }}><DefinitionPickerScope.Provider value={{ key: `${principalKey}:${workspaceId}`, active: session.ready }}>
    {!session.ready && fence}<div hidden={!session.ready} inert={!session.ready || undefined}><RecordPage active={session.ready} identity={{ id: definitionId ?? undefined, name: displayName, kind, pn: revision ? !visibleCatalog ? 'Unknown' : visibleCatalog.variants.map(row => `${row.manufacturer} ${row.part_number}`).join(' · ') || 'Unassigned' : undefined }} state={state}
      actions={<><Button size="xs" variant="quiet" onClick={onBack}>Back to {backLabel}</Button><Button size="xs" variant="quiet" onClick={() => void session.refresh()}>Refresh record</Button>{definitionId && <Button size="xs" variant="quiet" onClick={() => setVersions(true)}>Versions</Button>}{create.allowed && <Button size="xs" variant="quiet" onClick={() => props.onDuplicate(kind, structuredClone(content), `${displayName} copy`)}>Duplicate</Button>}
        {revision && kind !== 'kit' && create.allowed && <Button size="xs" variant="quiet" onClick={() => setAdding(true)}>Add to kit</Button>}
        {revision && edit.allowed && <Button size="xs" onClick={() => props.onSelect(null, true)}>Continue draft</Button>}
        {session.editing && <><Button size="xs" variant="quiet" disabled={!session.canUndo || session.busy || !editable} onClick={session.undoEdit}>Undo</Button>{session.base && <Button size="xs" variant="quiet" disabled={session.busy} onClick={() => setDiscard(true)}>Revert local edits</Button>}<Button size="xs" loading={session.busy} disabled={!session.ready || !session.name.trim()} {...edit.props} onClick={() => void session.save().then(() => cache.invalidateQueries({ queryKey: ['workspace', 'library'] }))}>Save draft</Button><Button size="xs" variant="quiet" disabled={!session.base || session.dirty || session.busy} {...freeze.props} onClick={() => void session.freeze()}>Freeze saved draft</Button></>}
      </>}
      notice={<Stack gap={4}>{session.error && <Alert color="red">{session.error}</Alert>}{session.notice && <Text role="status">{session.notice}</Text>}{!definitionId && <TextInput label={kind === 'kit' ? 'Kit name' : 'Part name'} maxLength={200} disabled={session.busy || !edit.allowed} value={session.name} onChange={event => session.setName(event.currentTarget.value)} />}
        {props.addRevision && kit && props.addRevision !== acceptedAdd && <Alert title="Selected part to add"><Text>This exact part is not yet in your local kit buffer. Its quantity will remain unknown.</Text><Button disabled={!editable || kit.lines.length >= 256} onClick={() => { session.change({ ...content, kit: { ...kit, lines: appendLine(kit.lines, props.addRevision!) } }); setAcceptedAdd(props.addRevision!); }}>Add selected part to this buffer</Button><Button variant="quiet" onClick={() => setAcceptedAdd(props.addRevision!)}>Dismiss addition</Button></Alert>}
      </Stack>}
      views={kind === 'kit' ? [{ id: 'parts', label: 'Parts list', content: <KitLines content={content} editable={editable} change={session.change} /> }] : [{ id: 'model', label: 'Model', content: <><Suspense fallback={<Text>Loading model view…</Text>}><PartModel active={session.ready && currentView === 'model'} scopeKey={`${principalKey}:${workspaceId}`} rows={selectedModels} onAccessLost={() => void session.refresh()} /></Suspense>{catalog.isError && <Alert color="red">{catalog.error.message}</Alert>}{details}</> }, { id: 'details', label: 'Details', content: details }]}
      view={kind === 'kit' ? 'parts' : currentView} onView={changeView} inspectorTab={inspector} onInspectorTab={setInspector}
      inspector={[
        { id: 'properties', label: 'Properties', content: () => <><InspectionScope permission={definitionId ? 'design.edit' : 'item.create'}>{properties()}</InspectionScope>{session.editing && <ReadOnlyNote permission={definitionId ? 'design.edit' : 'item.create'} />}</> },
        { id: 'sources', label: 'Sources & lots', content: () => revision ? <Stack>{catalog.isError && <Alert color="red">{catalog.error.message}</Alert>}<PartAssociations key={revision.revision_id} revisionId={revision.revision_id} workspaceId={workspaceId} principalKey={principalKey} active={session.ready && inspector === 'sources'} catalog={visibleCatalog} refresh={() => void catalog.refetch()} onFailure={() => void session.refresh()} /><Group><Button size="xs" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - 50))}>Previous catalog records</Button><Button size="xs" disabled={!visibleCatalog || Math.max(visibleCatalog.variants.length, visibleCatalog.lots.length, visibleCatalog.representations.length, visibleCatalog.source_identifiers.length) < 50} onClick={() => setOffset(offset + 50)}>More catalog records</Button></Group></Stack> : <Text>Freeze this draft to link sources, manufacturer variants and physical lots to an exact revision.</Text> },
        ...(kind !== 'kit' ? [{ id: 'kits', label: 'In kits', content: () => revision ? <PartRelations key={revision.revision_id} active={session.ready && inspector === 'kits'} principalKey={principalKey} workspaceId={workspaceId} revisionId={revision.revision_id} onOpen={(id, number) => props.onOpenKit(id, number)} /> : <Text>Kit membership is declared against exact frozen revisions.</Text> }] : []),
        { id: 'facts', label: 'Facts', content: () => definitionId ? <PartFacts principalKey={principalKey} workspaceId={workspaceId} active={session.ready && inspector === 'facts'} definitionId={definitionId} revisionId={revision?.revision_id ?? null} /> : <Text>Save this definition before opening its fact ledger.</Text> },
        { id: 'used', label: 'Where used', content: () => revision ? <RevisionWhereUsed revisionId={revision.revision_id} principalKey={principalKey} active={session.ready && inspector === 'used'} /> : <Text>Choose a frozen revision to inspect exact engineering parents.</Text> },
        { id: 'pins', label: 'Exact identity', content: () => <ExactPins pins={[{ label: 'Definition ID', value: definitionId }, ...(revision ? [{ label: 'Revision ID', value: revision.revision_id }, { label: 'Snapshot ID', value: revision.snapshot_id }, { label: 'SHA-256', value: revision.sha256 }] : [{ label: 'Draft ID', value: session.base?.draft_id ?? null }, { label: 'Save token', value: session.base?.state ?? null }])]} /> },
        { id: 'use', label: 'Projects', content: () => <Stack>{metadata.isError && <Alert color="red">{metadata.error.message}</Alert>}{actions.error && <Alert color="red">{actions.error}</Alert>}{actions.notice && <Text role="status">{actions.notice}</Text>}{referenceRecord && <><AddButton record={referenceRecord} projects={projects} busy={actions.busy} gate={projectEdit} label="Use in project…" onAdd={choice => actions.add(referenceRecord, choice, projects.find(project => project.project_id === choice.projectId)?.name ?? 'the project')} /><UsedInList record={referenceRecord} currentProjectId={null} toolLabel={kind === 'kit' ? 'Kits' : 'Parts'} onOpen={props.onOpenInProject} /></>}</Stack> },
      ]} />
    </div>
    <Modal opened={session.ready && versions} onClose={() => setVersions(false)} title="Record versions"><Stack>{revision && <><Text>Frozen r{revision.number}</Text><Text size="xs">{revision.revision_id}</Text><Text size="xs">SHA-256 {revision.sha256}</Text><Button disabled={revision.number <= 1} onClick={() => { props.onSelect(revision.number - 1, false); setVersions(false); }}>Previous exact revision</Button></>}<Button onClick={() => { props.onSelect(null, false); setVersions(false); }}>Latest frozen revision</Button><Button onClick={() => { props.onSelect(null, true); setVersions(false); }}>Working draft</Button><TextInput label="Explicit working draft ID" value={draftId} onChange={event => setDraftId(event.currentTarget.value)} /><Button disabled={!draftId.trim()} onClick={() => { if (!session.dirty || window.confirm('Replace retained local edits with the chosen working draft?')) { session.chooseDraft(draftId.trim()); props.onSelect(null, true); setVersions(false); } }}>Open chosen draft</Button></Stack></Modal>
    <Modal opened={session.ready && discard} onClose={() => setDiscard(false)} title="Discard local edits?"><Text>The saved working draft will replace this local buffer. Frozen revisions remain unchanged.</Text><Group><Button variant="quiet" onClick={() => setDiscard(false)}>Keep local edits</Button><Button onClick={() => { setDiscard(false); void session.refresh(true); }}>Reload saved draft</Button></Group></Modal>
    <Modal opened={session.ready && adding} onClose={() => setAdding(false)} title="Add exact part to a kit"><Stack><Text>The part will be staged for explicit addition in the kit's local buffer. Existing lines and unsaved edits remain retained.</Text><DefinitionSelect label="Kit" kind="kit" value={kitId} onChange={setKitId} /><Button disabled={!kitId || !revision} onClick={() => { setAdding(false); props.onOpenKit(kitId!, null, revision!.revision_id); }}>Open kit for addition</Button></Stack></Modal>
  </DefinitionPickerScope.Provider></MantineThemeProvider>;
}
