import { Alert, Button, Card, Group, MultiSelect, Select, Stack, Table, Text, TextInput, Textarea, Title } from '@mantine/core';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import type { Definition } from '../identity/api';
import { RevisionChoice } from '../preparation-documents/RevisionChoice';
import { SbProvenance, SbQuantity, SbQuantityField, SbStatus, SbUnknown, type SbLed } from '../../components/sb';
import { RevisionLabel } from '../../lib/IdentityLabel';
import { InspectionScope, ReadOnlyNote, usePermission } from '../../lib/permissions';
import { randomUUID } from '../../lib/random-id';
import {
  ApiError, candidates, createRelease, downloadRelease, listConfigurations, listReleases, readRelease, requestJson, reviewRelease, verifyRelease,
  type CatalogRights, type ReleaseRecord, type ReleaseRequest, type ReleaseReview, type ReleaseReviewBody, type RightsReview, type UnresolvedItem, type Verification,
} from './api';

const ROOT_KINDS = ['assembly', 'cable', 'harness'];
const STATUS_LED = { clear: 'active', unresolved: 'review', blocked: 'failed' } satisfies Record<ReleaseReviewBody['status'], SbLed>;
const CATEGORY = { quantity: 'Quantity', artifacts: 'Artifacts', configuration: 'Configuration', dependencies: 'Dependencies', evidence: 'Evidence', rights: 'Rights' } as const;

function message(e: unknown, fallback: string) { return e instanceof Error ? e.message : fallback; }

/** Reviewed release closures: workspace items a project may reference (EVD-004). */
export function ReleasesPanel({ workspaceId, projectId = null }: { workspaceId: string; projectId?: string | null }) {
  const [selected, setSelected] = useState<string | null>(null);
  const releases = useQuery({ queryKey: ['releases', workspaceId, projectId], queryFn: () => listReleases(workspaceId, projectId), staleTime: 0 });
  return <Stack gap="sm" key={projectId ?? 'library'}>
    <Title order={2}>Releases</Title>
    <Text size="sm">A release freezes one exact root's revisions, configurations, dependencies, package artifacts and rights decisions, with every unresolved item listed. It is not manufacturing approval, physical qualification or permission to distribute.</Text>
    <Card withBorder padding="sm"><Stack gap="xs">
      <Title order={4}>{projectId ? 'Releases this project references' : 'Workspace releases'}</Title>
      {releases.isError && <Alert color="red">Releases unavailable: {releases.error.message}</Alert>}
      {releases.data && releases.data.releases.length === 0 && <Text size="sm">No releases recorded{projectId ? ' for this project' : ''}.</Text>}
      {releases.data && releases.data.releases.length > 0 && <Table striped withTableBorder><Table.Thead><Table.Tr><Table.Th>Release</Table.Th><Table.Th>Root</Table.Th><Table.Th>Status</Table.Th><Table.Th>Unresolved</Table.Th><Table.Th>Released</Table.Th><Table.Th /></Table.Tr></Table.Thead><Table.Tbody>
        {releases.data.releases.map(row => <Table.Tr key={row.release_id}>
          <Table.Td>{row.name}</Table.Td><Table.Td><RevisionLabel id={row.root.revision_id} /></Table.Td>
          <Table.Td><SbStatus led={STATUS_LED[row.status]} dimension="closure" value={row.status} /></Table.Td>
          <Table.Td><SbQuantity value={row.unresolved_count} /></Table.Td>
          <Table.Td>{row.released_by} · {new Date(row.released_at).toLocaleString()}</Table.Td>
          <Table.Td><Button size="xs" variant="subtle" onClick={() => setSelected(row.release_id)}>Inspect {row.name}</Button></Table.Td>
        </Table.Tr>)}
      </Table.Tbody></Table>}
    </Stack></Card>
    {selected && <ReleaseDetail key={selected} releaseId={selected} />}
    <ReleaseReviewForm workspaceId={workspaceId} projectId={projectId} onReleased={id => { setSelected(id); void releases.refetch(); }} />
  </Stack>;
}

function Unresolved({ items, title }: { items: UnresolvedItem[]; title: string }) {
  if (items.length === 0) return null;
  return <Stack gap={4}>
    <Title order={5}>{title}</Title>
    <Table withTableBorder><Table.Thead><Table.Tr><Table.Th>Category</Table.Th><Table.Th>Item</Table.Th></Table.Tr></Table.Thead><Table.Tbody>
      {items.map(row => <Table.Tr key={row.id}><Table.Td>{CATEGORY[row.category] ?? row.category}</Table.Td><Table.Td><Text size="sm">{row.reason}</Text><Text size="xs" c="dimmed">{row.id}</Text></Table.Td></Table.Tr>)}
    </Table.Tbody></Table>
  </Stack>;
}

const RIGHTS_LED = { cleared: 'active', restricted: 'review', unknown: 'not-evaluated' } as const;

/** Read-only: declared catalog rights as recorded; anything not cleared is listed as unresolved. */
function CatalogRightsTable({ catalog }: { catalog: CatalogRights }) {
  return <Stack gap="xs">
    <Title order={5}>Declared catalog rights</Title>
    <Text size="sm">{catalog.counts.cleared} cleared, {catalog.counts.restricted} restricted, {catalog.counts.unknown} unknown; {catalog.undeclared_revision_ids.length} revisions declare none.</Text>
    {catalog.items.length > 0 && <Table withTableBorder><Table.Thead><Table.Tr><Table.Th>Revision</Table.Th><Table.Th>Record</Table.Th><Table.Th>Declared rights</Table.Th><Table.Th>Status</Table.Th></Table.Tr></Table.Thead><Table.Tbody>
      {catalog.items.map(row => <Table.Tr key={row.subject}>
        <Table.Td><RevisionLabel id={row.revision_id} /></Table.Td>
        <Table.Td>{row.record}: {row.label}</Table.Td>
        <Table.Td>{row.declared_rights ?? <SbUnknown what="Declared rights" />}</Table.Td>
        <Table.Td><SbStatus led={RIGHTS_LED[row.rights_status]} dimension="rights" value={row.rights_status} /></Table.Td>
      </Table.Tr>)}
    </Table.Tbody></Table>}
  </Stack>;
}

function ClosureSummary({ body }: { body: ReleaseReviewBody }) {
  const pins = [...body.revisions, ...body.dependencies.revisions];
  return <Stack gap="xs">
    <Group gap="md">
      <SbStatus led={STATUS_LED[body.status]} dimension="closure" value={body.status} />
      <SbStatus led={body.artifacts.coherence === 'coherent' ? 'active' : body.artifacts.coherence === 'incoherent' ? 'failed' : 'not-evaluated'} dimension="artifacts" value={body.artifacts.coherence} />
      <SbStatus led={body.rights.uncleared ? 'review' : 'active'} dimension="rights" value={`${body.rights.cleared} cleared, ${body.rights.uncleared} uncleared`} />
    </Group>
    <Group gap="xs"><Text size="sm">Root quantity:</Text>{body.quantity.amount === null ? <SbUnknown what="Root quantity" /> : <SbQuantity value={body.quantity.amount} unit="ea" />}</Group>
    <Title order={5}>Pinned revisions</Title>
    <Table striped withTableBorder><Table.Thead><Table.Tr><Table.Th>Revision</Table.Th><Table.Th>Role</Table.Th><Table.Th>Kind</Table.Th><Table.Th>Later revision</Table.Th></Table.Tr></Table.Thead><Table.Tbody>
      {pins.map(row => <Table.Tr key={row.revision_id}><Table.Td><RevisionLabel id={row.revision_id} sha256={row.snapshot_sha256} /></Table.Td><Table.Td>{row.role}</Table.Td><Table.Td>{row.kind}</Table.Td>
        <Table.Td>{row.later_revision_number ? <SbStatus led="stale" dimension="not adopted" value={`r${row.later_revision_number} exists`} /> : '—'}</Table.Td></Table.Tr>)}
    </Table.Tbody></Table>
    {body.configurations.length > 0 && <>
      <Title order={5}>Configurations</Title>
      {body.configurations.map(row => <SbProvenance key={row.resolved_configuration_id} label="Configuration" summary={`${row.status} · constraints ${row.constraint_outcome}`} pins={[{ label: 'Resolved configuration', value: row.resolved_configuration_id }, { label: 'Resolution SHA-256', value: row.resolution_sha256 }, { label: 'Target revision', value: row.target_revision_id }]} />)}
    </>}
    <Title order={5}>Artifacts</Title>
    <SbProvenance label="Package" summary={`${body.artifacts.outputs.length} retained outputs · ${body.artifacts.files.length} files · ${body.artifacts.completeness}`} pins={[{ label: 'Manifest SHA-256', value: body.artifacts.package_manifest_sha256 }]} />
    <Title order={5}>Evidence applicability</Title>
    <Text size="sm">{Object.entries(body.evidence.counts).map(([status, n]) => `${status.replaceAll('_', ' ')}: ${n}`).join(' · ') || 'No evidence recorded for the pinned revisions.'}{body.evidence.not_evaluated_revisions ? ` · ${body.evidence.not_evaluated_revisions} revisions not reviewed` : ''}</Text>
  </Stack>;
}

function ReleaseDetail({ releaseId }: { releaseId: string }) {
  const release = useQuery({ queryKey: ['release', releaseId], queryFn: () => readRelease(releaseId), staleTime: 0 });
  const [verified, setVerified] = useState<Verification | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function run(action: () => Promise<void>) { setBusy(true); setError(null); try { await action(); } catch (e) { setError(message(e, 'Release unavailable.')); } finally { setBusy(false); } }
  if (release.isError) return <Alert color="red">Release unavailable: {release.error.message}</Alert>;
  const data: ReleaseRecord | undefined = release.data;
  if (!data) return null;
  const record = data.record;
  return <Card withBorder padding="sm"><Stack gap="xs">
    <Title order={3}>{data.name}</Title>
    <Text size="sm">Released by {data.released_by} · {new Date(data.released_at).toLocaleString()} · <RevisionLabel id={data.root.revision_id} role="Root" /></Text>
    {record.notes && <Text size="sm">{record.notes}</Text>}
    <SbProvenance label="Record" summary="Immutable approval record" pins={[{ label: 'Record SHA-256', value: data.record_sha256 }, { label: 'Review SHA-256', value: record.review_sha256 }, { label: 'Archive SHA-256', value: data.archive_sha256 }]} />
    {record.acknowledgement && <Alert color="yellow" title="Released with acknowledged unresolved items">{record.acknowledgement.reason}</Alert>}
    <ClosureSummary body={record.review} />
    <Unresolved title="Unresolved items at release" items={record.review.unresolved} />
    {error && <Alert color="red">{error}</Alert>}
    <Group>
      <Button size="xs" loading={busy} onClick={() => void run(async () => setVerified(await verifyRelease(releaseId)))}>Verify release</Button>
      <Button size="xs" variant="default" disabled={busy} onClick={() => void run(() => downloadRelease(releaseId))}>Download release package</Button>
    </Group>
    {verified && <Stack gap={4}>
      <Group gap="md"><SbStatus led={verified.status === 'verified' ? 'active' : 'failed'} dimension="integrity" value={verified.status} /><SbStatus led={verified.reconstruction === 'identical' ? 'active' : verified.reconstruction === 'differs' ? 'failed' : 'not-evaluated'} dimension="reconstruction" value={verified.reconstruction} /></Group>
      {verified.problems.map(problem => <Text key={problem} size="sm">{problem}</Text>)}
    </Stack>}
  </Stack></Card>;
}

function ReleaseReviewForm({ workspaceId, projectId, onReleased }: { workspaceId: string; projectId: string | null; onReleased: (id: string) => void }) {
  const freeze = usePermission('design.freeze');
  const [rootId, setRootId] = useState<string | null>(null);
  const [quantity, setQuantity] = useState('');
  const [configurations, setConfigurations] = useState<string[]>([]);
  const [testPlans, setTestPlans] = useState<string[]>([]);
  const [documentSets, setDocumentSets] = useState<string[]>([]);
  const [drawings, setDrawings] = useState<string[]>([]);
  const [builds, setBuilds] = useState<string[]>([]);
  const [firmwareBuilds, setFirmwareBuilds] = useState<string[]>([]);
  const [rights, setRights] = useState<RightsReview[]>([]);
  const [reviewed, setReviewed] = useState<ReleaseReview | null>(null);
  const [name, setName] = useState('');
  const [notes, setNotes] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const generation = useRef(0);
  const idempotency = useRef(randomUUID());
  useEffect(() => () => { generation.current += 1; }, []);
  const definitions = useQuery({ queryKey: ['release-definitions'], queryFn: () => requestJson<Definition[]>('/api/v0/workspace/definitions'), staleTime: 0 });
  const choices = useQuery({ queryKey: ['release-candidates', rootId], enabled: !!rootId, queryFn: () => candidates(rootId!), staleTime: 0 });
  const resolved = useQuery({ queryKey: ['release-configurations', workspaceId], queryFn: () => listConfigurations(workspaceId), staleTime: 0 });
  const amount = quantity.trim() === '' ? null : Number(quantity);
  const quantityValid = amount === null || (Number.isInteger(amount) && amount >= 1 && amount <= 1_000_000);

  // Any input change invalidates the reviewed hash; the last review stays visible until rereview.
  function changed() { generation.current += 1; idempotency.current = randomUUID(); setReviewed(previous => previous ? { ...previous, sha256: '' } : null); setError(null); }
  const payload = (): ReleaseRequest => ({
    root_revision_id: rootId!, quantity: amount, bom_plan_revision_id: null, bom_purpose: 'procurement',
    preparation_document_set_ids: documentSets, test_plan_revision_ids: testPlans,
    pcb_fabrication_builds: (choices.data?.pcb_fabrication_builds ?? []).filter(row => builds.includes(row.build_id)),
    firmware_builds: (choices.data?.firmware_builds ?? []).filter(row => firmwareBuilds.includes(row.build_id)),
    scene_drawing_ids: drawings, purpose: 'authorized_review', resolved_configuration_ids: configurations, rights_reviews: rights,
  });
  async function inspect() {
    const current = ++generation.current;
    setBusy(true); setError(null);
    try { const result = await reviewRelease(payload()); if (current === generation.current) setReviewed(result); }
    catch (e) { if (current === generation.current) { setReviewed(null); setError(message(e, 'Release review unavailable.')); } }
    finally { if (current === generation.current) setBusy(false); }
  }
  async function release() {
    if (!reviewed?.sha256) return;
    setBusy(true); setError(null);
    try {
      const unresolved = reviewed.review.unresolved.length > 0;
      const created = await createRelease(payload(), { name: name.trim(), notes, reviewed_sha256: reviewed.sha256, acknowledgement: unresolved ? { reason } : null, project_id: projectId }, idempotency.current);
      idempotency.current = randomUUID();
      setReviewed(null); setReason(''); setName(''); setNotes('');
      onReleased(created.release_id);
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) setReviewed(previous => previous ? { ...previous, sha256: '' } : null);
      setError(message(e, 'Release refused.'));
    } finally { setBusy(false); }
  }
  function decide(subject: string, decision: RightsReview['decision'], basis: string) {
    changed();
    setRights(rows => [...rows.filter(row => row.subject !== subject), { subject, decision, basis }]);
  }
  const body = reviewed?.review;
  const needsReason = !!body && body.unresolved.length > 0;
  const canRelease = !!reviewed?.sha256 && body?.status !== 'blocked' && !!name.trim() && (!needsReason || !!reason.trim());

  return <Card withBorder padding="sm"><Stack gap="xs">
    <Title order={3}>Review a release closure</Title>
    <RevisionChoice label="Release root" kinds={ROOT_KINDS} definitions={definitions.data ?? []} value={rootId} disabled={busy} onChange={id => { changed(); setRootId(id); setTestPlans([]); setDocumentSets([]); setDrawings([]); setBuilds([]); setFirmwareBuilds([]); setRights([]); }} onDenied={e => setError(message(e, 'Root unavailable.'))} />
    <SbQuantityField label="Root quantity in scope" unit="ea" value={quantity} state={quantityValid ? undefined : 'invalid'} note="A whole number from 1 to 1,000,000" onChange={raw => { changed(); setQuantity(raw); }} next="Leave empty to keep every scope quantity unknown." />
    <MultiSelect label="Resolved configurations" disabled={busy} data={(resolved.data?.resolved ?? []).map(row => ({ value: row.resolved_configuration_id, label: `${row.basis} · ${row.status} · ${row.created_at}` }))} value={configurations} onChange={value => { changed(); setConfigurations(value); }} />
    {rootId && choices.data && <>
      <MultiSelect label="Preparation document sets" disabled={busy} data={choices.data.preparation_document_sets.map(row => ({ value: row.document_set_id, label: `${row.name} · quantity ${row.quantity ?? 'unknown'} · ${row.created_at}` }))} value={documentSets} onChange={value => { changed(); setDocumentSets(value); }} />
      <MultiSelect label="Cable test plans" disabled={busy} data={choices.data.test_plans.map(row => ({ value: row.revision_id, label: `${row.name} · r${row.number} · ${row.occurrence_path.join('/') || 'standalone'}` }))} value={testPlans} onChange={value => { changed(); setTestPlans(value); }} />
      <MultiSelect label="PCB fabrication builds" disabled={busy} data={choices.data.pcb_fabrication_builds.map(row => ({ value: row.build_id, label: `Build ${row.build_id.slice(0, 8)} · intake ${row.intake_id.slice(0, 8)}` }))} value={builds} onChange={value => { changed(); setBuilds(value); }} />
      <MultiSelect label="Firmware builds" disabled={busy} data={choices.data.firmware_builds.map(row => ({ value: row.build_id, label: `Build ${row.build_id.slice(0, 8)} · firmware ${row.firmware_revision_id.slice(0, 8)} · ${row.path.join('/') || 'any board'}` }))} value={firmwareBuilds} onChange={value => { changed(); setFirmwareBuilds(value); }} />
      <MultiSelect label="Scene drawings" disabled={busy} data={choices.data.scene_drawings.map(row => ({ value: row.drawing_id, label: `${row.name} · ${row.renderer_version} · ${row.created_at}` }))} value={drawings} onChange={value => { changed(); setDrawings(value); }} />
    </>}
    <Group><Button disabled={busy || !rootId || !quantityValid} loading={busy} onClick={() => void inspect()}>Review release closure</Button></Group>
    {error && <Alert color="red">{error}</Alert>}
    {body && <Stack gap="xs">
      <Title order={4}>Release review</Title>
      <ClosureSummary body={body} />
      <Unresolved title="Blockers" items={body.blockers} />
      <Unresolved title="Unresolved items" items={body.unresolved} />
      {body.rights.catalog && <CatalogRightsTable catalog={body.rights.catalog} />}
      <Title order={5}>Rights for exact subjects</Title>
      <InspectionScope permission="design.freeze">
        <Table withTableBorder><Table.Thead><Table.Tr><Table.Th>Subject</Table.Th><Table.Th>Declared rights</Table.Th><Table.Th>Decision</Table.Th><Table.Th>Basis</Table.Th></Table.Tr></Table.Thead><Table.Tbody>
          {body.rights.subjects.map(row => {
            const value = rights.find(r => r.subject === row.subject) ?? row.review;
            return <Table.Tr key={row.subject}>
              <Table.Td>{row.kind === 'design' ? <RevisionLabel id={row.revision_id} /> : <Text size="sm">{row.path}</Text>}</Table.Td>
              <Table.Td>{row.declared_rights ?? <SbUnknown what="Declared rights" />}</Table.Td>
              <Table.Td><Select aria-label={`Rights decision ${row.subject}`} disabled={busy} data={['unknown', 'permitted', 'withheld']} value={value.decision} onChange={v => decide(row.subject, (v ?? 'unknown') as RightsReview['decision'], value.basis)} /></Table.Td>
              <Table.Td><Textarea aria-label={`Rights basis ${row.subject}`} disabled={busy} value={value.basis} onChange={e => decide(row.subject, value.decision, e.currentTarget.value)} /></Table.Td>
            </Table.Tr>;
          })}
        </Table.Tbody></Table>
      </InspectionScope>
      {!reviewed?.sha256 && <Text size="sm">Inputs changed. Review the release closure again before releasing.</Text>}
      {freeze.allowed ? <Stack gap="xs">
        <TextInput label="Release name" value={name} disabled={busy} onChange={e => setName(e.currentTarget.value)} />
        <Textarea label="Release notes" value={notes} disabled={busy} onChange={e => setNotes(e.currentTarget.value)} />
        {needsReason && <Textarea label="Acknowledgement reason" description={`Release with ${body.unresolved.length} unresolved items listed above. The reason is kept with the immutable record.`} value={reason} disabled={busy} onChange={e => setReason(e.currentTarget.value)} />}
        {body.status === 'blocked' && <Text size="sm">Blockers prevent this release; correct the selection and review again.</Text>}
        <Group><Button disabled={busy || !canRelease} onClick={() => void release()}>{needsReason ? 'Acknowledge and release' : 'Release'}</Button></Group>
      </Stack> : <ReadOnlyNote permission="design.freeze">Rights decisions and releasing are unavailable.</ReadOnlyNote>}
    </Stack>}
  </Stack></Card>;
}
