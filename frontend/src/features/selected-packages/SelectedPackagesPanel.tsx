import { ReadOnlyNote, usePermission } from '../../lib/permissions';
import { Alert, Button, Card, Group, Select, Stack, Table, Text, Textarea, Title } from '@mantine/core';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import type { Definition, Identity } from '../identity/api';
import type { Projection } from '../assemblies/api';
import { download, requestJson, review, saveArchive, type Review, type RightsReview, type Selection } from './api';
import { ApiError } from '../workspace/api';

export function SelectedPackagesPanel({ projectId }: { projectId: string }) {
  // Keying the workspace resets all selection/review state on project change.
  return <PackageWorkspace key={projectId} projectId={projectId} />;
}

function PackageWorkspace({ projectId }: { projectId: string }) {
  const freezeGate = usePermission('design.freeze');
  const [definitionId, setDefinitionId] = useState<string | null>(null);
  const [offset, setOffset] = useState(0);
  const [rootId, setRootId] = useState<string | null>(null);
  const [path, setPath] = useState<string[]>([]);
  const [purpose, setPurpose] = useState<Selection['purpose']>('authorized_review');
  const [rights, setRights] = useState<RightsReview[]>([]);
  const [retained, setRetained] = useState<Review | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [blocked, setBlocked] = useState(false);
  const generation = useRef(0);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; generation.current += 1; }; }, []);
  const definitions = useQuery({ queryKey: ['package-definitions', projectId], queryFn: () => requestJson<Definition[]>(`/api/v0/projects/${projectId}/definitions`), staleTime: 0 });
  const identity = useQuery({ queryKey: ['package-identity', definitionId, offset], enabled: !!definitionId, queryFn: () => requestJson<Identity>(`/api/v0/catalog/definitions/${definitionId}?offset=${offset}`), staleTime: 0 });
  const selectedRoot = identity.data?.revisions.find(row => row.revision_id === rootId);
  // Catalog identity retains snapshots for exact roots; the snapshot is obtained through
  // a shared operation so arbitrary names never substitute for contextual addresses.
  const root = useQuery({ queryKey: ['package-root', rootId], enabled: !!rootId, queryFn: () => requestJson<{ snapshot_id: string }>(`/api/v0/revisions/${rootId}`), staleTime: 0 });
  const projection = useQuery({ queryKey: ['package-occurrences', root.data?.snapshot_id], enabled: !!root.data?.snapshot_id && identity.data?.kind === 'assembly', queryFn: () => requestJson<Projection>(`/api/v0/assemblies/snapshots/${root.data?.snapshot_id}`), staleTime: 0 });
  const hidden = blocked || definitions.isError || identity.isError || root.isError || projection.isError || definitions.isFetching || identity.isFetching || root.isFetching || projection.isFetching;
  const payload = (): Selection => ({ root_revision_id: rootId!, occurrence_path: path, purpose, rights_reviews: rights });
  function reset() { generation.current += 1; setRetained(null); setRights([]); setError(null); setBusy(false); }
  async function inspect() {
    const current = ++generation.current;
    setRetained(previous => previous ? { ...previous, sha256: '' } : null); setBusy(true); setError(null);
    try {
      const checked = await review(payload());
      if (current === generation.current && alive.current) setRetained(checked);
    } catch (e) { if (current === generation.current) { if (e instanceof ApiError && [401, 403, 404].includes(e.status)) { setBlocked(true); setRetained(null); } setError(e instanceof Error ? e.message : 'Package unavailable.'); } }
    finally { if (current === generation.current) setBusy(false); }
  }
  async function getArchive() {
    if (!retained) return;
    const current = generation.current;
    setBusy(true); setError(null);
    try { const blob = await download(payload(), retained.sha256); if (current === generation.current && alive.current) saveArchive(blob); }
    catch (e) { if (current === generation.current) { setRetained(null); if (e instanceof ApiError && [401, 403, 404].includes(e.status)) setBlocked(true); setError(e instanceof Error ? e.message : 'Download unavailable.'); } }
    finally { if (current === generation.current) setBusy(false); }
  }
  const reviewed = !hidden && retained;
  function updateRights(subject: string, decision: RightsReview['decision'], basis: string) {
    generation.current += 1;
    // Retain subject rows as an editor, but clear the review hash until reinspection.
    setRights(rows => [...rows.filter(row => row.subject !== subject), { subject, decision, basis }]);
    setRetained(current => current ? { ...current, sha256: '' } : current);
  }
  return <Stack>
    <Title order={2}>Selected assembly packages</Title>
    <Button disabled={busy} onClick={() => { generation.current += 1; setRetained(null); setError(null); setBusy(true); const current = generation.current; void Promise.all([definitions.refetch({ throwOnError: true }), ...(definitionId ? [identity.refetch({ throwOnError: true })] : []), ...(rootId ? [root.refetch({ throwOnError: true }), review(payload())] : []), ...(identity.data?.kind === 'assembly' && root.data ? [projection.refetch({ throwOnError: true })] : [])]).then(() => { if (current === generation.current && alive.current) setBlocked(false); }).catch(e => { if (current === generation.current) { setBlocked(true); setError(e instanceof Error ? e.message : 'Access unavailable.'); } }).finally(() => { if (current === generation.current) setBusy(false); }); }}>Refresh package selection access</Button>
    <Text>Select an exact frozen revision or contextual occurrence. The local review document preserves selected engineering data, boundary declarations, hashes and unresolved items. It records no physical qualification.</Text>
    {error && <Alert color="red">{error}</Alert>}
    {hidden && <Alert color="red">Package contents are hidden while current access is unavailable or being checked.</Alert>}
    {[definitions, identity, root, projection].filter(q => q.isError).map((q, i) => <Alert key={i} color="red">{q.error?.message}</Alert>)}
    {!hidden && <>
      <Select label="Package root definition" searchable disabled={busy} data={(definitions.data ?? []).map(row => ({ value: row.definition_id, label: `${row.name} (${row.kind})` }))} value={definitionId} onChange={value => { reset(); setDefinitionId(value); setOffset(0); setRootId(null); setPath([]); }} />
      <Select label="Exact package root revision" disabled={busy} data={(identity.data?.revisions ?? []).map(row => ({ value: row.revision_id, label: `Revision ${row.number} · ${row.revision_id}` }))} value={rootId} onChange={value => { reset(); setRootId(value); setPath([]); }} />
      <Group><Button disabled={busy || offset === 0} onClick={() => { reset(); setRootId(null); setPath([]); setOffset(n => Math.max(0, n - 50)); }}>Earlier frozen revisions</Button><Button disabled={busy || (identity.data?.revisions.length ?? 0) < 50} onClick={() => { reset(); setRootId(null); setPath([]); setOffset(n => n + 50); }}>Later frozen revisions</Button></Group>
      {rootId && <Card withBorder><Stack><Title order={3}>Select the export boundary</Title>
        <Button variant={path.length ? 'outline' : 'filled'} disabled={busy} onClick={() => { reset(); setPath([]); }}>Whole exact revision</Button>
        {projection.data?.occurrences.map(row => <Button key={JSON.stringify(row.address.path)} variant={JSON.stringify(row.address.path) === JSON.stringify(path) ? 'filled' : 'outline'} disabled={busy} onClick={() => { reset(); setPath(row.address.path); }}>{row.address.path.join('/')} · {row.display_ref || row.kind}</Button>)}
        <Text>Selected address: {path.join('/') || 'standalone exact root'} · {selectedRoot?.revision_id}</Text>
      </Stack></Card>}
      <Select label="Package purpose" disabled={busy} data={[{ value: 'authorized_review', label: 'Private authorized review' }, { value: 'distribution', label: 'Reviewed distribution data', disabled: !freezeGate.allowed }]} value={purpose} onChange={value => { generation.current += 1; setPurpose(value as Selection['purpose']); setRetained(previous => previous ? { ...previous, sha256: '' } : null); setError(null); }} />
      <ReadOnlyNote permission="design.freeze">Reviewed distribution data is unavailable; private review remains available.</ReadOnlyNote>
      <Text size="sm">Private review may preserve unknown distribution rights visibly. Source bytes require an explicit permitted declaration. Distribution requires review of every design and source file and separate engineering authority; generation publishes nothing.</Text>
      <Button disabled={busy || !rootId} loading={busy} onClick={() => void inspect()}>Review exact selected package</Button>
      {reviewed && <Card withBorder><Stack><Title order={3}>Selected package review</Title>
        <Text>Selected revision: {reviewed.manifest.scope.selected_revision_id}</Text><Text>Selected SHA-256: {reviewed.manifest.scope.selected_sha256}</Text>
        <Text>Completeness: {reviewed.manifest.completeness} · {reviewed.manifest.rights}</Text>
        <Title order={4}>Selected occurrence pins</Title>
        {reviewed.manifest.occurrences.map(row => <Text key={JSON.stringify(row.path)}>{row.path.join('/') || 'Selected root'} · {row.revision_id} · firmware {row.assignments.firmware_revision_id ?? 'unassigned'}</Text>)}
        <Title order={4}>Boundary declarations</Title>
        {reviewed.manifest.boundary_interfaces.map((row, index) => <Stack key={index}><Text>{row.path.join('/') || 'Selected root'} · {row.kind} · {row.boundary_exposure}</Text><pre style={{ whiteSpace: 'pre-wrap' }}>{JSON.stringify(row.declaration ?? { endpoints: row.endpoints, terminals: row.terminals }, null, 2)}</pre></Stack>)}
        {reviewed.manifest.boundary_crossings.map((row, index) => <Text key={index}>{row.kind} · {row.selected_terminals.map(t => `${t.path.join('/') || 'Selected root'}:${t.feature_id ?? 'whole occurrence'}`).join(', ')} · external contract {row.external_contract}</Text>)}
        <Title order={4}>Rights declarations for exact selected subjects</Title>
        <Table><Table.Thead><Table.Tr><Table.Th>Exact subject and declared rights</Table.Th><Table.Th>Distribution review declaration</Table.Th><Table.Th>Review basis</Table.Th></Table.Tr></Table.Thead><Table.Tbody>
          {[...reviewed.manifest.design_revisions.map(row => ({ subject: row.rights_review.subject, label: `${row.kind} · ${row.revision_id}`, declared: 'Unknown design distribution rights', review: row.rights_review })), ...reviewed.manifest.source_files.map(row => ({ subject: row.rights_review.subject, label: `${row.source_path} · ${row.sha256}`, declared: row.declared_rights, review: row.rights_review }))].map(row => {
            const value = rights.find(r => r.subject === row.subject) ?? row.review;
            return <Table.Tr key={row.subject}><Table.Td><Text>{row.label}</Text><Text>{row.declared}</Text></Table.Td><Table.Td><Select aria-label={`Rights decision ${row.subject}`} disabled={busy} data={['unknown', 'permitted', 'withheld']} value={value.decision} onChange={v => updateRights(row.subject, v as RightsReview['decision'], value.basis)} /></Table.Td><Table.Td><Textarea aria-label={`Rights basis ${row.subject}`} disabled={busy} value={value.basis} onChange={e => updateRights(row.subject, value.decision, e.currentTarget.value)} /></Table.Td></Table.Tr>;
          })}
        </Table.Tbody></Table>
        {reviewed.manifest.unresolved.map((row, index) => <Alert key={index} color="yellow">{row.reason}{row.kinds ? ` ${row.kinds.join(', ')}` : ''}</Alert>)}
        <Text>Compatibility, physical continuity and physical qualification: not evaluated. Native processing: not performed.</Text>
        <Group><Button disabled={busy || !reviewed.sha256} onClick={() => void getArchive()}>Download reviewed package</Button></Group>
        {!reviewed.sha256 && <Text>Rights changed. Review the exact package again before download.</Text>}
      </Stack></Card>}
    </>}
  </Stack>;
}
