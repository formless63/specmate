import { Alert, Button, Group, Modal, Stack, Table, Text, TextInput, Title } from '@mantine/core';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { DefinitionPickerScope } from '../../components/library/DefinitionSelect';
import { RecordPage, type RecordState } from '../../components/record';
import { ExactPins, RevisionLabel } from '../../lib/IdentityLabel';
import { usePermission } from '../../lib/permissions';
import { listLibraryTable } from '../library-gallery/table-api';
import { useNavigation, formatLocation } from '../navigation';
import { usePartSession } from '../parts/usePartSession';
import { blankFamily, readLineup, readVersions, type Exact, type Family, type LineupRow } from './api';
import { FamilyFields } from './FamilyFields';
import { ExactLink } from './ExactLink';

type Props = { active: boolean; toolId: string; principalKey: string; workspaceId: string; projectId: string | null };
const FAMILY_KINDS = ['product_family'];
const familyLink = (row: Exact, project: string | null) => formatLocation({ area: 'products', lens: 'families', project, probe: { object: row.definition_id, rev: row.number, path: [] } });
const designLink = (row: Exact, project: string | null) => formatLocation({ area: 'designs', lens: row.kind === 'assembly' ? 'assemblies' : row.kind === 'harness' ? 'harnesses' : 'cables', project, probe: { object: row.definition_id, rev: row.number, path: [] } });
export function VariantTable({ rows, projectId = null }: { rows: LineupRow[]; projectId?: string | null }) {
  return <div className="sb-ws-scroll"><Table aria-label="Product lineup"><Table.Thead><Table.Tr><Table.Th>Family</Table.Th><Table.Th>Variant</Table.Th><Table.Th>Number</Table.Th><Table.Th>Exact design</Table.Th><Table.Th>Declared length</Table.Th><Table.Th>Options</Table.Th></Table.Tr></Table.Thead><Table.Tbody>{rows.map(row => <Table.Tr key={`${row.family.revision_id}:${row.variant.local_id}`}>
    <Table.Td><ExactLink href={familyLink(row.family, projectId)}>{row.family.name} · r{row.family.number}</ExactLink>{row.family_number && <Text size="xs">{row.family_number}</Text>}</Table.Td><Table.Td>{row.variant.label ?? row.variant.local_id}<Text size="xs">{row.variant.local_id}</Text></Table.Td><Table.Td>{row.variant.number ?? 'Not declared'}</Table.Td>
    <Table.Td><ExactLink href={designLink(row.design, projectId)}>{row.design.name} · r{row.design.number}</ExactLink><RevisionLabel id={row.design.revision_id} known={row.design} sha256={row.design.sha256} /></Table.Td><Table.Td>{row.variant.declared_length_mm === null ? 'Unknown' : `${row.variant.declared_length_mm} mm`}</Table.Td><Table.Td>{row.selected_options.map(option => `${option.axis_label}: ${option.value_label}`).join(', ') || 'Not declared'}<ExactPins summary="Advanced: option IDs" pins={row.selected_options.map(option => ({ label: option.axis_id, value: option.value_id }))} /></Table.Td>
  </Table.Tr>)}</Table.Tbody></Table></div>;
}
export function ProductsWorkspace(props: Props) { return <ProductsSession key={`${props.principalKey}:${props.workspaceId}`} {...props} />; }
function ProductsSession({ active, toolId, principalKey, workspaceId, projectId }: Props) {
  const nav = useNavigation(), create = usePermission('item.create');
  const [visits, setVisits] = useState<{ key: string; id: string | null }[]>([]), [pending, setPending] = useState('new:0');
  const count = useRef(0), selection = useRef(new Map<string, { number: number | null; working: boolean }>());
  const familyActive = active && toolId === 'families', object = familyActive ? nav?.location.probe?.object ?? null : null;
  const creating = familyActive && nav?.location.filters?.status === 'new';
  const chosen = creating ? pending : object ? visits.find(v => v.id === object)?.key ?? object : null;
  if (chosen) selection.current.set(chosen, { number: nav?.location.probe?.rev ?? null, working: nav?.location.filters?.status === 'draft' });
  useEffect(() => { if (chosen) setVisits(current => current.some(v => v.key === chosen) ? current : [...current, { key: chosen, id: creating ? null : object }]); }, [chosen, creating, object]);
  const go = (id: string | null, number: number | null = null, status?: string) => nav?.navigate({ area: 'products', lens: 'families', probe: id ? { object: id, rev: number, path: [] } : null, filters: status ? { status } : {} });
  return <>
    {familyActive && !chosen && <FamilyList key={projectId ?? 'workspace'} active={familyActive} principalKey={principalKey} workspaceId={workspaceId} projectId={projectId} onOpen={id => go(id)} onNew={() => go(null, null, 'new')} />}
    {creating && visits.filter(v => !v.id).length > 1 && <Group>{visits.filter(v => !v.id).map(v => <Button key={v.key} onClick={() => { setPending(v.key); go(null, null, 'new'); }}>Unsaved family {v.key}</Button>)}</Group>}
    {visits.map(visit => <div hidden={!familyActive || chosen !== visit.key} key={visit.key}><FamilyRecord active={familyActive && chosen === visit.key} principalKey={principalKey} workspaceId={workspaceId} definitionId={visit.id} revisionNumber={selection.current.get(visit.key)?.number ?? null} draftRequested={selection.current.get(visit.key)?.working ?? false}
      onBack={() => go(null)} onSelect={(number, working) => go(visit.id, number, working ? 'draft' : undefined)} onCreated={(id, open) => { setVisits(current => current.map(v => v.key === visit.key ? { ...v, id } : v)); if (pending === visit.key) setPending(`new:${++count.current}`); if (open) go(id, null, 'draft'); }} /></div>)}
    {active && toolId === 'lineup' && <Lineup key={projectId ?? 'workspace'} active={active} principalKey={principalKey} workspaceId={workspaceId} projectId={projectId} />}
    {familyActive && !chosen && !create.allowed && <Text size="sm">Read-only: inspect families and their exact frozen variants.</Text>}
  </>;
}
function FamilyList({ active, principalKey, workspaceId, projectId, onOpen, onNew }: Omit<Props, 'toolId'> & { onOpen: (id: string) => void; onNew: () => void }) {
  const create = usePermission('item.create'), [query, setQuery] = useState(''), [after, setAfter] = useState<string | null>(null), [previous, setPrevious] = useState<(string | null)[]>([]);
  const page = useQuery({ queryKey: ['products-families', principalKey, workspaceId, projectId, query, after], enabled: active, retry: false, refetchOnWindowFocus: 'always', queryFn: () => listLibraryTable({ kinds: FAMILY_KINDS, query, projectFilterId: projectId, after }) });
  const rows = active && !page.isFetching && !page.isError ? page.data?.results : undefined;
  return <Stack><Group justify="space-between"><Title order={1}>Families</Title><Button {...create.props} onClick={onNew}>New family</Button></Group><Text>Group exact designs into descriptive variants. Drafts remain working records; Lineup uses frozen families only.</Text><TextInput label="Find families" value={query} onChange={e => { setQuery(e.currentTarget.value); setAfter(null); setPrevious([]); }} />
    {page.isError && <Alert color="red">{page.error.message}</Alert>}{page.isFetching && <Text role="status">Reading families…</Text>}
    {rows && <div className="sb-ws-scroll"><Table aria-label="Product families"><Table.Thead><Table.Tr><Table.Th>Family</Table.Th><Table.Th>State</Table.Th><Table.Th>Number</Table.Th><Table.Th>Variants</Table.Th><Table.Th /></Table.Tr></Table.Thead><Table.Tbody>{rows.map(row => <Table.Tr key={row.record_id}><Table.Td>{row.label}</Table.Td><Table.Td>{row.summary.basis === 'unknown' ? 'Current content unavailable' : row.latest_revision === null ? 'Working draft' : `Frozen r${row.latest_revision}`}</Table.Td><Table.Td>{row.summary.fields.find(field => field.key === 'number')?.value ?? 'Not declared'}</Table.Td><Table.Td>{row.summary.fields.find(field => field.key === 'variants')?.value ?? 'Unknown'}</Table.Td><Table.Td><Button variant="quiet" onClick={() => onOpen(row.record_id)}>Open {row.label}</Button></Table.Td></Table.Tr>)}</Table.Tbody></Table></div>}
    {rows?.length === 0 && <Text>No product families in this view.</Text>}<Group><Button variant="quiet" disabled={!previous.length || page.isFetching} onClick={() => { setAfter(previous.at(-1) ?? null); setPrevious(previous.slice(0, -1)); }}>Previous families</Button><Button variant="quiet" disabled={!rows || !page.data?.next_after} onClick={() => { setPrevious([...previous, after]); setAfter(page.data!.next_after); }}>More families</Button></Group></Stack>;
}
function Lineup({ active, principalKey, workspaceId, projectId }: Omit<Props, 'toolId'>) {
  const [after, setAfter] = useState<string | null>(null), [previous, setPrevious] = useState<(string | null)[]>([]);
  const query = useQuery({ queryKey: ['products-lineup', principalKey, workspaceId, projectId, after], enabled: active, retry: false, refetchOnWindowFocus: 'always', staleTime: 0, queryFn: () => readLineup(workspaceId, projectId, after) });
  const page = active && !query.isFetching && !query.isError ? query.data : undefined;
  return <Stack><Title order={1}>Lineup</Title><Text>Latest frozen family revisions with exact pinned designs. Declared lengths and options do not alter the designs. Release approval is recorded separately in Releases.</Text>
    {query.isError && <Alert color="red">{query.error.message}</Alert>}{query.isFetching && <Text role="status">Reading lineup…</Text>}{page && <><VariantTable rows={page.results} projectId={projectId} />{!page.results.length && <Text>No readable frozen variants on this page.</Text>}<Text size="xs">Family selection as of {page.as_of}; access checked for this read.</Text></>}
    <Group><Button variant="quiet" disabled={!previous.length || query.isFetching} onClick={() => { setAfter(previous.at(-1) ?? null); setPrevious(previous.slice(0, -1)); }}>Previous lineup</Button><Button variant="quiet" disabled={!page?.next_after} onClick={() => { setPrevious([...previous, after]); setAfter(page!.next_after); }}>More lineup</Button><Button variant="quiet" onClick={() => { setAfter(null); setPrevious([]); void query.refetch(); }}>Refresh lineup</Button></Group></Stack>;
}
type FamilyRecordProps = { active: boolean; principalKey: string; workspaceId: string; definitionId: string | null; revisionNumber: number | null; draftRequested: boolean; onCreated: (id: string, open: boolean) => void; onSelect: (n: number | null, working: boolean) => void; onBack: () => void };
export function FamilyRecord(props: FamilyRecordProps) { return <FamilyRecordSession key={`${props.principalKey}:${props.workspaceId}`} {...props} />; }
function FamilyRecordSession(props: FamilyRecordProps) {
  const session = usePartSession({ ...props, allowedKinds: FAMILY_KINDS, initial: { kind: 'product_family', content: { product_family: blankFamily() } } }), cache = useQueryClient();
  const edit = usePermission(props.definitionId ? 'design.edit' : 'item.create'), freeze = usePermission('design.freeze');
  const [versions, setVersions] = useState(false), [revert, setRevert] = useState(false);
  const content = session.content ?? session.buffer, family = content.product_family as Family | undefined;
  const editable = session.ready && session.editing && edit.allowed && !session.busy;
  const selected = session.selected, frozen = selected?.kind === 'revision' ? selected : null;
  const state: RecordState = frozen ? { kind: 'revision', id: frozen.revision_id, number: frozen.number } : session.base ? { kind: 'draft', id: session.base.draft_id, version: Number(session.base.state.replace('draft-v', '')) || 1, dirty: session.dirty } : { kind: 'new' };
  const fields = family && <FamilyFields value={family} editable={editable} change={value => session.change({ ...content, product_family: value })} />;
  return <DefinitionPickerScope.Provider value={{ key: `${props.principalKey}:${props.workspaceId}`, active: session.ready }}><Stack><Group><Button variant="quiet" onClick={props.onBack}>Back to Families</Button><Button variant="quiet" disabled={!props.definitionId} onClick={() => setVersions(true)}>Versions</Button><Button variant="quiet" onClick={() => void session.refresh()}>Refresh access</Button></Group>
    <RecordPage active={props.active} identity={{ id: props.definitionId ?? undefined, name: session.ready ? session.record?.name ?? (session.name || 'New family') : 'Family unavailable', kind: 'product_family', pn: session.ready ? family?.number ?? undefined : undefined }} state={state}
      actions={session.editing ? <><Button variant="quiet" disabled={!editable || !session.canUndo} onClick={session.undoEdit}>Undo</Button>{session.base && <Button variant="quiet" disabled={session.busy} onClick={() => setRevert(true)}>Revert local edits</Button>}<Button {...edit.props} disabled={!editable || !session.name.trim()} loading={session.busy} onClick={() => void session.save().then(() => cache.invalidateQueries({ queryKey: ['products-families'] }))}>Save draft</Button><Button {...freeze.props} disabled={!freeze.allowed || !session.ready || session.busy || !session.base || session.dirty} onClick={() => void session.freeze().then(() => cache.invalidateQueries({ queryKey: ['products-lineup'] }))}>Freeze saved draft</Button></> : edit.allowed && <Button disabled={!session.ready} onClick={() => props.onSelect(null, true)}>Continue draft</Button>}
      notice={<Stack gap={4}>{session.error && <Alert color="red">{session.error}</Alert>}{session.notice && <Text role="status">{session.notice}</Text>}{!props.definitionId && <TextInput label="Family name" maxLength={200} disabled={session.busy || !edit.allowed} value={session.name} onChange={e => session.setName(e.currentTarget.value)} />}</Stack>}
      views={[{ id: 'variants', label: 'Variants', content: session.ready ? fields : <Text>Family contents withdrawn until current access is confirmed. Local edits are retained.</Text> }]} view="variants" onView={() => {}}
      inspector={[{ id: 'identity', label: 'Identity', content: () => session.ready ? <Stack><Text>{session.editing ? 'Working draft; changes remain local until Save.' : `Frozen family r${frozen?.number}.`}</Text><Text>Family freezing does not approve or release the pinned designs. Family numbers are explicitly authored and are not auto-assigned.</Text><ExactPins pins={[{ label: 'Definition ID', value: props.definitionId }, { label: 'Revision ID', value: frozen?.revision_id }, { label: 'Snapshot ID', value: frozen?.snapshot_id }, { label: 'SHA-256', value: frozen?.sha256 }, { label: 'Draft ID', value: session.base?.draft_id }]} /></Stack> : <Text>Access unavailable.</Text> }]} />
    <Modal opened={props.active && versions} onClose={() => setVersions(false)} title="Family versions">{props.definitionId && <FamilyVersions active={props.active && versions} principalKey={props.principalKey} definitionId={props.definitionId} onSelect={(revision, draft) => { if (draft) { if (session.editing && session.dirty && !window.confirm('Replace local edits with the selected saved working draft?')) return; session.chooseDraft(draft); } props.onSelect(revision, !!draft); setVersions(false); }} />}</Modal>
    <Modal opened={props.active && revert} onClose={() => setRevert(false)} title="Discard local family edits?"><Text>The saved draft will replace this buffer.</Text><Button onClick={() => { setRevert(false); void session.refresh(true); }}>Reload saved draft</Button></Modal>
  </Stack></DefinitionPickerScope.Provider>;
}

function FamilyVersions({ active, principalKey, definitionId, onSelect }: { active: boolean; principalKey: string; definitionId: string; onSelect: (number: number | null, draft: string | null) => void }) {
  const [offset, setOffset] = useState(0);
  const query = useQuery({ queryKey: ['product-versions', principalKey, definitionId, offset], enabled: active, retry: false, staleTime: 0, refetchOnWindowFocus: 'always', queryFn: () => readVersions(definitionId, offset) });
  const page = active && !query.isFetching && !query.isError ? query.data : undefined;
  return <Stack>{query.isError && <Alert color="red">{query.error.message}</Alert>}{query.isFetching && <Text>Reading authorized versions…</Text>}{page && <>{page.revisions.map(row => <Button key={row.revision_id} variant="quiet" onClick={() => onSelect(row.number, null)}>{row.name} · frozen r{row.number}</Button>)}{page.drafts.map(row => <Button key={row.draft_id} variant="quiet" onClick={() => onSelect(null, row.draft_id)}>{row.label}</Button>)}{!page.revisions.length && !page.drafts.length && <Text>No readable saved versions on this page.</Text>}<details><summary>Advanced: exact version IDs</summary>{page.revisions.map(row => <ExactPins key={row.revision_id} pins={[{ label: `Revision r${row.number}`, value: row.revision_id }]} />)}{page.drafts.map(row => <ExactPins key={row.draft_id} pins={[{ label: `Draft v${row.version}`, value: row.draft_id }]} />)}</details></>}<Group><Button variant="quiet" disabled={offset === 0 || query.isFetching} onClick={() => setOffset(Math.max(0, offset - 25))}>Previous versions</Button><Button variant="quiet" disabled={!page?.next_offset} onClick={() => setOffset(page!.next_offset!)}>More versions</Button></Group></Stack>;
}
