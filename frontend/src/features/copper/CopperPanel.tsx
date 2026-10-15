import { Alert, Button, Card, Group, Select, Stack, Table, Text, TextInput, Title } from '@mantine/core';
import { CopperProvenance } from './CopperProvenance';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { evidenceLabel, read, scopeLabel, type Definition, type Graph, type Identity } from './api';
import { revisionOptionLabel, newestFirst } from "../../lib/revision-labels";
import { RevisionLabel } from "../../lib/IdentityLabel";

export function CopperPanel({ projectId = null }: { projectId?: string | null }) { return <Workspace key={projectId ?? 'library'} projectId={projectId} />; }
function Workspace({ projectId }: { projectId: string | null }) {
  const [definition, setDefinition] = useState<string | null>(null);
  const [revision, setRevision] = useState<string | null>(null);
  const [exact, setExact] = useState('');
  const [offset, setOffset] = useState(0);
  const definitions = useQuery({ queryKey: ['copper-definitions', projectId], queryFn: () => read<Definition[]>('workspace/definitions') });
  const identity = useQuery({ queryKey: ['copper-identity', definition, offset], queryFn: () => read<Identity>(`catalog/definitions/${definition}?offset=${offset}`), enabled: !!definition });
  const denied = definitions.isError || identity.isError;
  const rows = definitions.isError ? [] : definitions.data ?? [];
  const current = denied ? undefined : identity.data;
  return <Stack><Title order={2}>Copper graph</Title>
    <Text>Inspect exact declared wire connections and PCB-reported net membership. Component passages and unspecified relationships remain boundaries; physical continuity is not evaluated.</Text>
    {definitions.isError && <Alert color="red">{definitions.error.message}</Alert>}
    {identity.isError && <Alert color="red">{identity.error.message}</Alert>}
    <Select label="Copper graph definition" searchable value={denied ? null : definition} data={rows.map(d => ({ value: d.definition_id, label: `${d.name} (${d.kind})` }))} disabled={definitions.isError} onChange={v => { setDefinition(v); setRevision(null); setOffset(0); }} />
    {current && <><Select label="Frozen graph revision" searchable value={revision} data={newestFirst(current.revisions).map((r) => ({ value: r.revision_id, label: revisionOptionLabel(current.name, r.number) }))} onChange={setRevision} /><Group><Button disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - 50))}>Earlier graph revisions</Button><Button disabled={current.revisions.length < 50} onClick={() => setOffset(offset + 50)}>Later graph revisions</Button></Group></>}
    <Group align="end"><TextInput label="Exact graph revision ID" value={exact} onChange={e => setExact(e.currentTarget.value)} /><Button disabled={!exact.trim() || denied} onClick={() => { setRevision(exact.trim()); }}>Inspect exact graph</Button></Group>
    {revision && !denied && <CopperInspector key={revision} revisionId={revision} />}
  </Stack>;
}
export function CopperInspector({ revisionId, active = true, graph, onRefresh }: { revisionId: string; active?: boolean; graph?: Graph; onRefresh?: () => void }) {
  const [terminal, setTerminal] = useState<string | null>(null);
  const [page, setPage] = useState(0);
  const [boundaryPage, setBoundaryPage] = useState(0);
  const [edgePage, setEdgePage] = useState(0);
  const query = useQuery({ queryKey: ['copper-graph', revisionId], queryFn: () => read<Graph>(`copper/revisions/${revisionId}`), enabled: active && !graph });
  const value = !active ? undefined : graph ?? (query.isError || query.isFetching ? undefined : query.data);
  const component = value?.components.find(c => c.members.includes(terminal ?? ''));
  const members = new Set(component?.members ?? []);
  const edgeIds = new Set(component?.edge_ids ?? []);
  const nodes = component ? value!.nodes.filter(n => members.has(n.id)) : [];
  const edges = component ? value!.edges.filter(e => edgeIds.has(e.id)) : [];
  const boundaries = value?.boundaries.filter(b => !component || !b.members.length || b.members.some(id => members.has(id))) ?? [];
  return <Card withBorder><Stack><Title order={3}>Frozen copper inspection</Title><Text><RevisionLabel id={revisionId} /></Text>
    <Button variant="light" loading={query.isFetching} onClick={() => onRefresh ? onRefresh() : void query.refetch()}>Refresh graph access</Button>
    {query.isError && <Alert color="red">{query.error.message}</Alert>}
    {query.isFetching && <Text>Loading currently authorized graph…</Text>}
    {value && <><Text>{value.nodes.length} terminals · {value.components.length} declared components · {value.boundaries.length} boundaries</Text>
      <Text>Continuity: {value.continuity}. Compatibility: {value.compatibility}. Physical qualification: {value.physical_qualification}.</Text>
      {value.limitations.map(line => <Text size="sm" key={line}>{line}</Text>)}
      <Select label="Inspect copper terminal" searchable clearable value={terminal} data={value.nodes.map(n => ({ value: n.id, label: `${scopeLabel(n.occurrence_path)} · ${n.label} (${n.feature_kind})` }))} onChange={v => { setTerminal(v); setPage(0); setBoundaryPage(0); setEdgePage(0); }} />
      {component && <><Title order={4}>Selected declared component</Title><Text>Evidence: {component.evidence.length ? component.evidence.map(evidenceLabel).join(', ') : 'No copper link declared; isolated terminal'}</Text><Text size="sm">Component identity: {component.id}</Text>
        {component.native_net_ids.map(id => <Text size="sm" key={id}>Native net identity: {id}</Text>)}
        <Table><Table.Thead><Table.Tr><Table.Th>Exact terminal</Table.Th><Table.Th>Occurrence and evidence</Table.Th></Table.Tr></Table.Thead><Table.Tbody>{nodes.slice(page * 100, page * 100 + 100).map(n => <Table.Tr key={n.id}><Table.Td>{n.label}<Text size="sm">{n.feature_kind}</Text><Text size="xs">{n.id}</Text></Table.Td><Table.Td><CopperProvenance value={n.provenance} /></Table.Td></Table.Tr>)}</Table.Tbody></Table>
        <Group><Button disabled={page === 0} onClick={() => setPage(page - 1)}>Previous terminals</Button><Button disabled={(page + 1) * 100 >= nodes.length} onClick={() => setPage(page + 1)}>Next terminals</Button></Group>
        <Title order={4}>Connection evidence</Title>{edges.slice(edgePage * 100, edgePage * 100 + 100).map(e => <Card key={e.id} withBorder><Text>{evidenceLabel(e.kind)} · {evidenceLabel(e.evidence)}</Text><Text>{e.basis}</Text><CopperProvenance value={e.provenance} /></Card>)}
        <Group><Button disabled={edgePage === 0} onClick={() => setEdgePage(edgePage - 1)}>Previous connections</Button><Button disabled={(edgePage + 1) * 100 >= edges.length} onClick={() => setEdgePage(edgePage + 1)}>Next connections</Button></Group>
      </>}
      <Title order={4}>Boundaries and unknowns</Title><Text>These records do not join copper components.</Text>
      {boundaries.length === 0 && <Text>No boundary is recorded in this selection; this is not a physical continuity result.</Text>}
      {boundaries.slice(boundaryPage * 50, boundaryPage * 50 + 50).map(b => <Card key={b.id} withBorder><Text fw={600}>{evidenceLabel(b.kind)} · {evidenceLabel(b.status)}</Text><Text>{b.reason}</Text><CopperProvenance value={b.provenance} /></Card>)}
      <Group><Button disabled={boundaryPage === 0} onClick={() => setBoundaryPage(boundaryPage - 1)}>Previous boundaries</Button><Button disabled={(boundaryPage + 1) * 50 >= boundaries.length} onClick={() => setBoundaryPage(boundaryPage + 1)}>Next boundaries</Button></Group>
      <Text size="xs">Snapshot: {value.snapshot_id} · SHA-256: {value.snapshot_sha256}</Text>
    </>}
  </Stack></Card>;
}
