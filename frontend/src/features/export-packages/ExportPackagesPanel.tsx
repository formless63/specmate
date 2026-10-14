import { Alert, Button, Card, Checkbox, Group, MultiSelect, Stack, Table, Text, Title } from '@mantine/core';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import type { Definition } from '../identity/api';
import { RevisionChoice } from '../preparation-documents/RevisionChoice';
import { SbQuantity, SbQuantityField, SbStatus, SbUnknown, type SbLed } from '../../components/sb';
import { RevisionLabel } from '../../lib/IdentityLabel';
import { MiddleTruncate } from '../../lib/MiddleTruncate';
import { ApiError, candidates, download, requestJson, review, saveArchive, type ExportRequest, type Review, type ScopeQuantity } from './api';

const ROOT_KINDS = ['assembly', 'cable', 'harness'];
const LED = { coherent: 'active', incoherent: 'failed', unknown: 'not-evaluated', complete: 'active', limited: 'review' } satisfies Record<string, SbLed>;

export function ExportPackagesPanel({ projectId = null }: { projectId?: string | null }) {
  // Keying resets every request/review field when the project context changes.
  return <ExportWorkspace key={projectId ?? 'library'} />;
}

function Quantity({ value }: { value: ScopeQuantity | null }) {
  if (!value || value.status === 'not_applicable') return <SbQuantity value={null} state="na" note="Not a contextual occurrence" />;
  return <SbQuantity value={value.amount} state={value.status === 'known' ? 'known' : 'unknown'} />;
}

function ExportWorkspace() {
  const [rootId, setRootId] = useState<string | null>(null);
  const [quantity, setQuantity] = useState('');
  const [bomId, setBomId] = useState<string | null>(null);
  const [testPlans, setTestPlans] = useState<string[]>([]);
  const [documentSets, setDocumentSets] = useState<string[]>([]);
  const [drawings, setDrawings] = useState<string[]>([]);
  const [builds, setBuilds] = useState<string[]>([]);
  const [firmwareBuilds, setFirmwareBuilds] = useState<string[]>([]);
  const [retained, setRetained] = useState<Review | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [blocked, setBlocked] = useState(false);
  const [acknowledged, setAcknowledged] = useState(false);
  const generation = useRef(0);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; generation.current += 1; }; }, []);
  const definitions = useQuery({ queryKey: ['export-definitions'], queryFn: () => requestJson<Definition[]>('/api/v0/workspace/definitions'), staleTime: 0 });
  const choices = useQuery({ queryKey: ['export-candidates', rootId], enabled: !!rootId, queryFn: () => candidates(rootId!), staleTime: 0 });
  const buildRefs = (choices.data?.pcb_fabrication_builds ?? []).filter(row => builds.includes(row.build_id));
  const firmwareRefs = (choices.data?.firmware_builds ?? []).filter(row => firmwareBuilds.includes(row.build_id));
  const amount = quantity.trim() === '' ? null : Number(quantity);
  const quantityValid = amount === null || (Number.isInteger(amount) && amount >= 1 && amount <= 1_000_000);
  const hidden = blocked || definitions.isError;

  // Any input change invalidates the reviewed hash; the manifest stays visible until rereview.
  function changed() { generation.current += 1; setAcknowledged(false); setRetained(previous => previous ? { ...previous, sha256: '' } : null); setError(null); }
  const payload = (): ExportRequest => ({
    root_revision_id: rootId!, quantity: amount, bom_plan_revision_id: bomId, bom_purpose: 'procurement',
    preparation_document_set_ids: documentSets, test_plan_revision_ids: testPlans,
    pcb_fabrication_builds: buildRefs, firmware_builds: firmwareRefs, scene_drawing_ids: drawings, purpose: 'authorized_review',
  });
  function denied(e: unknown) {
    if (e instanceof ApiError && [401, 403, 404].includes(e.status)) { setBlocked(true); setRetained(null); }
    setError(e instanceof Error ? e.message : 'Export package unavailable.');
  }
  async function inspect() {
    const current = ++generation.current;
    setBusy(true); setError(null);
    try { const checked = await review(payload()); if (current === generation.current && alive.current) { setRetained(checked); setBlocked(false); setAcknowledged(false); } }
    catch (e) { if (current === generation.current) { setRetained(null); denied(e); } }
    finally { if (current === generation.current) setBusy(false); }
  }
  async function getArchive() {
    if (!retained) return;
    const current = generation.current;
    setBusy(true); setError(null);
    try { const blob = await download(payload(), retained.sha256, acknowledged); if (current === generation.current && alive.current) saveArchive(blob); }
    catch (e) { if (current === generation.current) { setRetained(null); denied(e); } }
    finally { if (current === generation.current) setBusy(false); }
  }
  const manifest = !hidden ? retained?.manifest : undefined;
  const incoherent = manifest?.coherence === 'incoherent';
  const needsAcknowledgement = !!manifest?.rights.acknowledgement_required;
  return <Stack gap="sm">
    <Title order={2}>Coherent export packages</Title>
    <Text size="sm">One package pins system, cable, PCB, mechanical, spreadsheet and test outputs to the exact revisions of one frozen root, with independently counted scope quantities. Not a release, manufacturing approval or physical qualification.</Text>
    {error && <Alert color="red">{error}</Alert>}
    {hidden && <Alert color="red">Package contents are hidden while current access is unavailable. <Button size="xs" variant="subtle" onClick={() => { setBlocked(false); setError(null); void definitions.refetch(); void choices.refetch(); }}>Refresh access</Button></Alert>}
    {!hidden && <>
      <RevisionChoice label="Package root" kinds={ROOT_KINDS} definitions={definitions.data ?? []} value={rootId} disabled={busy} onChange={id => { changed(); setRootId(id); setTestPlans([]); setDocumentSets([]); setDrawings([]); setBuilds([]); setFirmwareBuilds([]); }} onDenied={denied} />
      <SbQuantityField label="Root quantity in scope" unit="ea" value={quantity} state={quantityValid ? undefined : 'invalid'} note="A whole number from 1 to 1,000,000" onChange={raw => { changed(); setQuantity(raw); }} next="Leave empty to keep every scope quantity unknown." />
      <RevisionChoice label="BOM plan" kinds={['bom_plan']} definitions={definitions.data ?? []} value={bomId} disabled={busy} onChange={id => { changed(); setBomId(id); }} onDenied={denied} />
      <Card withBorder padding="sm"><Stack gap="xs"><Title order={4}>Retained outputs to include</Title>
        {!rootId && <Text size="sm">Choose a package root to list its retained outputs.</Text>}
        {choices.isError && <Alert color="red">Retained outputs unavailable: {choices.error.message}</Alert>}
        {rootId && choices.data && <>
          <MultiSelect label="Preparation document sets" disabled={busy} data={choices.data.preparation_document_sets.map(row => ({ value: row.document_set_id, label: `${row.name} · quantity ${row.quantity ?? 'unknown'} · ${row.created_at}` }))} value={documentSets} onChange={value => { changed(); setDocumentSets(value); }} />
          <MultiSelect label="Cable test plans" disabled={busy} data={choices.data.test_plans.map(row => ({ value: row.revision_id, label: `${row.name} · r${row.number} · ${row.occurrence_path.join('/') || 'standalone'}` }))} value={testPlans} onChange={value => { changed(); setTestPlans(value); }} />
          <MultiSelect label="PCB fabrication builds" disabled={busy} data={choices.data.pcb_fabrication_builds.map(row => ({ value: row.build_id, label: `Build ${row.build_id.slice(0, 8)} · intake ${row.intake_id.slice(0, 8)}` }))} value={builds} onChange={value => { changed(); setBuilds(value); }} />
          <MultiSelect label="Firmware builds" disabled={busy} data={choices.data.firmware_builds.map(row => ({ value: row.build_id, label: `Build ${row.build_id.slice(0, 8)} · firmware ${row.firmware_revision_id.slice(0, 8)} · ${row.path.join('/') || 'any board'}` }))} value={firmwareBuilds} onChange={value => { changed(); setFirmwareBuilds(value); }} />
          <MultiSelect label="Scene drawings" disabled={busy} data={choices.data.scene_drawings.map(row => ({ value: row.drawing_id, label: `${row.name} · ${row.renderer_version} · ${row.created_at}` }))} value={drawings} onChange={value => { changed(); setDrawings(value); }} />
          <Text size="xs">Lists show the latest readable candidates rooted in this closure; the review still checks every cited revision and quantity.</Text>
        </>}
      </Stack></Card>
      <Group><Button disabled={busy || !rootId || !quantityValid} loading={busy} onClick={() => void inspect()}>Review export package</Button></Group>
      {manifest && <Card withBorder padding="sm"><Stack gap="xs">
        <Title order={3}>Export package review</Title>
        <Group gap="md"><SbStatus led={LED[manifest.coherence]} dimension="coherence" value={manifest.coherence} /><SbStatus led={LED[manifest.completeness]} dimension="completeness" value={manifest.completeness} /></Group>
        {retained?.sha256
          ? <Group gap="xs" wrap="nowrap" aria-label="Package manifest SHA-256">
              <Text size="sm" fw={600}>Package manifest SHA-256 (verify with <code>verify/verification.py</code>)</Text>
              <Text size="sm" component="span"><MiddleTruncate text={retained.sha256} /></Text>
            </Group>
          : <Text size="sm">Package manifest SHA-256 unavailable until the export package is reviewed again.</Text>}
        {retained?.sha256 && <Text size="xs" className="sb-mono" data-testid="verifier-command">{`python3 -I -S verify/verification.py package.zip --manifest-sha256 ${retained.sha256}`}</Text>}
        <Text size="sm"><RevisionLabel id={manifest.scope.root.revision_id} role="Root" /> · Root snapshot SHA-256 (design content, not the package manifest) <MiddleTruncate text={manifest.scope.root.sha256} /></Text>
        <Group gap="xs"><Text size="sm">Root quantity:</Text>{manifest.scope.quantity === null ? <SbUnknown what="Root quantity" /> : <SbQuantity value={manifest.scope.quantity} unit="ea" />}</Group>
        <Table striped withTableBorder><Table.Thead><Table.Tr><Table.Th>Section</Table.Th><Table.Th>Output</Table.Th><Table.Th>Coherence</Table.Th><Table.Th>Scope quantity</Table.Th><Table.Th>Findings</Table.Th></Table.Tr></Table.Thead><Table.Tbody>
          {manifest.outputs.map(row => <Table.Tr key={row.id}><Table.Td>{row.section}</Table.Td><Table.Td>{row.kind}</Table.Td><Table.Td><SbStatus led={LED[row.coherence]} dimension="cites" value={row.coherence} /></Table.Td><Table.Td><Quantity value={row.scope_quantity} /></Table.Td><Table.Td>{row.findings.map(f => f.reason).join(', ') || '—'}</Table.Td></Table.Tr>)}
        </Table.Tbody></Table>
        {manifest.outputs.length === 0 && <Text size="sm">No retained outputs included; generated system, cable, PCB, mechanical and spreadsheet files still pin the exact closure.</Text>}
        <Title order={4}>Pinned revisions</Title>
        <Table striped withTableBorder><Table.Thead><Table.Tr><Table.Th>Revision</Table.Th><Table.Th>Kind</Table.Th><Table.Th>Per root</Table.Th><Table.Th>Scope quantity</Table.Th></Table.Tr></Table.Thead><Table.Tbody>
          {manifest.pins.map(row => <Table.Tr key={row.revision_id}><Table.Td><RevisionLabel id={row.revision_id} /></Table.Td><Table.Td>{row.kind}</Table.Td><Table.Td>{row.per_root_occurrences === null ? <SbQuantity value={null} state="na" /> : <SbQuantity value={row.per_root_occurrences} />}</Table.Td><Table.Td><Quantity value={row.scope_quantity} /></Table.Td></Table.Tr>)}
        </Table.Tbody></Table>
        {manifest.unresolved.map((row, index) => <Alert key={index} color="yellow">{row.output} · {row.reason}</Alert>)}
        <Title order={4}>Declared rights</Title>
        <Group gap="md">{(['cleared', 'restricted', 'unknown'] as const).map(status => <Text key={status} size="sm">{status}: {manifest.rights.counts[status]}</Text>)}</Group>
        {manifest.rights.items.length > 0 && <Table striped withTableBorder><Table.Thead><Table.Tr><Table.Th>Revision</Table.Th><Table.Th>Record</Table.Th><Table.Th>Rights status</Table.Th><Table.Th>Declared rights</Table.Th></Table.Tr></Table.Thead><Table.Tbody>
          {manifest.rights.items.map(row => <Table.Tr key={row.subject}><Table.Td><RevisionLabel id={row.revision_id} /></Table.Td><Table.Td>{row.record} · {row.label}</Table.Td><Table.Td><SbStatus led={row.rights_status === 'cleared' ? 'active' : row.rights_status === 'restricted' ? 'review' : 'not-evaluated'} dimension="rights" value={row.rights_status} /></Table.Td><Table.Td>{row.declared_rights || <SbUnknown what="Declared rights" />}</Table.Td></Table.Tr>)}
        </Table.Tbody></Table>}
        {manifest.rights.undeclared_revision_ids.length > 0 && <Text size="sm">{manifest.rights.undeclared_revision_ids.length} pinned revisions have no rights declaration.</Text>}
        <Title order={4}>Unsupported output semantics</Title>
        {manifest.unsupported.map(row => <Text key={row.id} size="sm">{row.section} · {row.reason}</Text>)}
        {needsAcknowledgement && <Checkbox label="Some declared rights are unknown or restricted. I acknowledge this package is for authorized internal review only." checked={acknowledged} disabled={busy} onChange={e => setAcknowledged(e.currentTarget.checked)} />}
        <Group><Button disabled={busy || !retained?.sha256 || incoherent || (needsAcknowledgement && !acknowledged)} onClick={() => void getArchive()}>Download export package</Button></Group>
        {incoherent && <Text size="sm">Included outputs cite different revisions or quantities; correct the selection before download.</Text>}
        {!retained?.sha256 && <Text size="sm">Inputs changed. Review the export package again before download.</Text>}
      </Stack></Card>}
    </>}
  </Stack>;
}
