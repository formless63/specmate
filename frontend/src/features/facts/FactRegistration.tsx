import { Alert, Button, Card, Group, MantineThemeProvider, Select, Stack, Text, TextInput, Title } from '@mantine/core';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { ReadOnlyNote, InspectionScope, usePermission } from '../../lib/permissions';
import { randomUUID } from '../../lib/random-id';
import { newestFirst, revisionOptionLabel } from '../../lib/revision-labels';
import { listLibraryTable } from '../library-gallery/table-api';
import { requestJson, runOperation, type Project } from '../workspace/api';
import type { Identity, Subject, Target } from './api';

type Props = { workspaceId: string; principalKey: string; active: boolean; projects?: Project[]; projectId?: string; onRegistered: (id: string) => void };
/** Explicit subject registration; no subject list or implicit workspace/project selection. */
export function FactRegistration(props: Props) { return <Registration key={`${props.principalKey}:${props.workspaceId}`} {...props} />; }
function Registration({ workspaceId, principalKey, active, projects = [], projectId, onRegistered }: Props) {
  const registerGate = usePermission('item.create'), manageGate = usePermission('inventory.manage');
  const [kind, setKind] = useState<Target['kind']>(projectId ? 'project' : 'definition'), [selectedProject, setProject] = useState<string | null>(projectId ?? null);
  const [definitionId, setDefinitionId] = useState<string | null>(null), [revisionId, setRevisionId] = useState<string | null>(null), [offset, setOffset] = useState(0);
  const [snapshotId, setSnapshotId] = useState(''), [path, setPath] = useState(''), [featureId, setFeatureId] = useState(''), [unitId, setUnitId] = useState<string | null>(null), [unitOffset, setUnitOffset] = useState(0), [created, setCreated] = useState<string | null>(null);
  const live = useRef(true), current = useRef({ active, principalKey, workspaceId }); current.current = { active, principalKey, workspaceId };
  useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);
  const access = useQuery({ queryKey: ['fact-registration-access', principalKey, workspaceId], enabled: active, retry: false, refetchOnWindowFocus: 'always', queryFn: async () => { const result = await requestJson<{ workspace_id: string }>('/api/v0/access/workspace', { cache: 'no-store' }); if (result.workspace_id !== workspaceId) throw new Error('Workspace unavailable.'); return result; } });
  useEffect(() => { if (active) void access.refetch(); }, [active, access.refetch]);
  const readable = active && !access.isError && !access.isFetching && !!access.data;
  const identity = useQuery({ queryKey: ['fact-definition', principalKey, workspaceId, definitionId, offset], queryFn: () => requestJson<Identity>(`/api/v0/catalog/definitions/${definitionId}?offset=${offset}`, { cache: 'no-store' }), enabled: readable && kind === 'revision' && !!definitionId, retry: false });
  const units = useQuery({ queryKey: ['fact-physical-units', principalKey, workspaceId, unitOffset], queryFn: () => requestJson<{ units: { unit_id: string; serial: string; revision_id: string }[] }>(`/api/v0/physical-units/workspaces/${workspaceId}?offset=${unitOffset}&limit=50`, { cache: 'no-store' }), enabled: readable && kind === 'physical_unit', retry: false });
  const keys = useRef(new Map<string, string>());
  const register = useMutation({ mutationFn: ({ target, key }: { target: Target; key: string }) => runOperation<Subject>('facts.register_subject', { target }, { idempotencyKey: key }).then(result => result.result), onSuccess: result => { if (!live.current || current.current.principalKey !== principalKey || current.current.workspaceId !== workspaceId) return; setCreated(result.subject_id); if (current.current.active) onRegistered(result.subject_id); } });
  const missingTarget = kind === 'project' ? !selectedProject : kind === 'definition' ? !definitionId : kind === 'revision' ? !revisionId || identity.isError || identity.isFetching : kind === 'occurrence' ? !snapshotId || !path : !unitId || units.isError || units.isFetching;
  const gate = kind === 'physical_unit' ? manageGate : registerGate;
  function submit() {
    if (!readable || !gate.allowed || register.isPending || missingTarget) return;
    const target: Target = kind === 'project' ? { kind, project_id: selectedProject! } : kind === 'definition' ? { kind, definition_id: definitionId!, feature_id: featureId || null } : kind === 'revision' ? { kind, revision_id: revisionId!, feature_id: featureId || null } : kind === 'physical_unit' ? { kind, unit_id: unitId! } : { kind, snapshot_id: snapshotId, path: path.split('/'), feature_id: featureId || null };
    const fingerprint = JSON.stringify(target); if (!keys.current.has(fingerprint)) keys.current.set(fingerprint, randomUUID()); register.mutate({ target, key: keys.current.get(fingerprint)! });
  }
  const projectChoices = projects.filter(project => !project.archived).map(project => ({ value: project.project_id, label: project.name }));
  if (projectId && !projectChoices.some(project => project.value === projectId)) projectChoices.push({ value: projectId, label: projectId });
  return <MantineThemeProvider theme={{ components: { Select: Select.extend({ defaultProps: { comboboxProps: { withinPortal: false } } }) } }}><Stack>
    {active && !readable && <Alert color={access.isError ? 'red' : 'blue'}>{access.error?.message ?? 'Rechecking subject registration access…'}<Button onClick={() => void access.refetch()}>Refresh registration access</Button></Alert>}
    {register.isError && <Alert color="red">{register.error.message}</Alert>}
    <div hidden={!readable} inert={!readable || undefined}><fieldset disabled={register.isPending} style={{ border: 0, padding: 0 }}><Card withBorder><Stack>
      <Title order={2}>Register a fact ledger</Title><Text>Choose the exact engineering subject. Assertions remain attached evidence; they never rewrite a frozen design.</Text>
      <InspectionScope permission={kind === 'physical_unit' ? 'inventory.manage' : 'item.create'}>
        <Select label="Fact subject kind" value={kind} allowDeselect={false} data={[{ value: 'project', label: 'project' }, 'definition', 'revision', 'occurrence', { value: 'physical_unit', label: 'Physical unit' }]} onChange={value => { setKind(value as Target['kind']); setCreated(null); }} />
        {kind === 'project' && <Select label="Fact project" searchable value={selectedProject} data={projectChoices} onChange={setProject} />}
        {(kind === 'definition' || kind === 'revision') && <FactDefinition principalKey={principalKey} workspaceId={workspaceId} active={readable} value={definitionId} onChange={id => { setDefinitionId(id); setRevisionId(null); setOffset(0); }} />}
        {kind === 'revision' && <><Select label="Fact exact revision" value={identity.isError || identity.isFetching ? null : revisionId} disabled={identity.isError || identity.isFetching} data={newestFirst(identity.isError || identity.isFetching ? [] : identity.data?.revisions ?? []).map(row => ({ value: row.revision_id, label: revisionOptionLabel(identity.data?.name, row.number) }))} onChange={setRevisionId} /><Group><Button disabled={!offset} onClick={() => { setOffset(Math.max(0, offset - 50)); setRevisionId(null); }}>Previous subject revisions</Button><Button disabled={(identity.data?.revisions.length ?? 0) < 50 || identity.isError} onClick={() => { setOffset(offset + 50); setRevisionId(null); }}>Next subject revisions</Button></Group></>}
        {kind === 'occurrence' && <><TextInput label="Fact root assembly snapshot ID" value={snapshotId} onChange={event => setSnapshotId(event.currentTarget.value)} /><TextInput label="Fact contextual occurrence path" description="Stable local occurrence IDs separated by /." value={path} onChange={event => setPath(event.currentTarget.value)} /></>}
        {kind === 'physical_unit' && <><Text>Choose an actual serialized subject. Measurements attach only to that unit, with procedure and instrument provenance; they do not qualify a lot or release.</Text><Select label="Actual physical unit" searchable value={units.isError || units.isFetching ? null : unitId} data={(units.isError || units.isFetching ? [] : units.data?.units ?? []).map(unit => ({ value: unit.unit_id, label: `${unit.serial} · revision ${unit.revision_id}` }))} onChange={setUnitId} /><Group><Button disabled={!unitOffset} onClick={() => { setUnitOffset(Math.max(0, unitOffset - 50)); setUnitId(null); }}>Previous actual units</Button><Button disabled={(units.data?.units.length ?? 0) < 50 || units.isError} onClick={() => { setUnitOffset(unitOffset + 50); setUnitId(null); }}>Next actual units</Button></Group></>}
        {kind !== 'project' && kind !== 'physical_unit' && <TextInput label="Fact stable feature ID" description="Optional; feature existence is not evaluated by this form." value={featureId} onChange={event => setFeatureId(event.currentTarget.value)} />}
      </InspectionScope>
      <Button disabled={missingTarget || !readable} loading={register.isPending} {...gate.props} onClick={submit}>Open fact ledger</Button><ReadOnlyNote permission={kind === 'physical_unit' ? 'inventory.manage' : 'item.create'}>Opening a new fact ledger is unavailable; existing ledgers can be read.</ReadOnlyNote>
      {identity.isError && <Alert color="red">{identity.error.message}</Alert>}{units.isError && <Alert color="red">{units.error.message}</Alert>}
      {created && <Button onClick={() => onRegistered(created)}>Open registered fact ledger</Button>}
    </Stack></Card></fieldset></div>
  </Stack></MantineThemeProvider>;
}
function FactDefinition({ active, principalKey, workspaceId, value, onChange }: { active: boolean; principalKey: string; workspaceId: string; value: string | null; onChange: (id: string | null) => void }) {
  const [opened, setOpened] = useState(false), [search, setSearch] = useState(''), [after, setAfter] = useState<string | null>(null), [picked, setPicked] = useState<{ value: string; label: string } | null>(null);
  const page = useQuery({ queryKey: ['fact-definition-choices', principalKey, workspaceId, search, after], enabled: active && opened, retry: false, queryFn: () => listLibraryTable({ kinds: [], query: search, projectFilterId: null, after }) });
  const choices = !active || page.isError || page.isFetching ? [] : (page.data?.results ?? []).filter(record => record.family === 'definition').map(record => ({ value: record.record_id, label: `${record.label} (${record.kind})` }));
  const data = !page.isError && !page.isFetching && active && picked && !choices.some(choice => choice.value === picked.value) ? [picked, ...choices] : choices;
  return <Stack gap={4}><Select label="Fact definition" searchable dropdownOpened={active && opened} onDropdownOpen={() => setOpened(true)} onDropdownClose={() => setOpened(false)} searchValue={search} onSearchChange={text => { setSearch(text); setAfter(null); }} value={page.isError ? null : value} data={data} filter={({ options }) => options} onChange={id => { setPicked(data.find(row => row.value === id) ?? null); onChange(id); }} />{opened && page.isError && <Alert color="red">{page.error.message}</Alert>}{opened && <Group><Button disabled={!after} onClick={() => setAfter(null)}>First definitions</Button><Button disabled={!page.data?.next_after || page.isError || page.isFetching} onClick={() => setAfter(page.data!.next_after)}>More definitions</Button></Group>}</Stack>;
}
