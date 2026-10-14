import { Alert, Button, Card, Group, MultiSelect, Stack, Table, Text, TextInput, Title } from '@mantine/core';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import type { Definition } from '../identity/api';
import { RevisionChoice } from '../preparation-documents/RevisionChoice';
import { SbQuantity, SbQuantityField, SbStatus, SbUnknown, type SbLed } from '../../components/sb';
import { RevisionLabel } from '../../lib/IdentityLabel';
import { ApiError, download, requestJson, review, saveArchive, type ExportRequest, type Review, type ScopeQuantity } from './api';

const ROOT_KINDS = ['assembly', 'cable', 'harness'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LED = { coherent: 'active', incoherent: 'failed', unknown: 'not-evaluated', complete: 'active', limited: 'review' } satisfies Record<string, SbLed>;

type DocumentSets = { document_sets: { document_set_id: string; manifest: { inputs: { root: { name: string; revision_id: string } } }; created_at: string }[] };

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
  const [testPlan, setTestPlan] = useState<string | null>(null);
  const [testPlans, setTestPlans] = useState<string[]>([]);
  const [documentSets, setDocumentSets] = useState<string[]>([]);
  const [drawingText, setDrawingText] = useState('');
  const [drawings, setDrawings] = useState<string[]>([]);
  const [intakeText, setIntakeText] = useState('');
  const [buildText, setBuildText] = useState('');
  const [builds, setBuilds] = useState<{ intake_id: string; build_id: string }[]>([]);
  const [retained, setRetained] = useState<Review | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [blocked, setBlocked] = useState(false);
  const generation = useRef(0);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; generation.current += 1; }; }, []);
  const definitions = useQuery({ queryKey: ['export-definitions'], queryFn: () => requestJson<Definition[]>('/api/v0/workspace/definitions'), staleTime: 0 });
  const sets = useQuery({ queryKey: ['export-document-sets'], queryFn: () => requestJson<DocumentSets>('/api/v0/preparation-documents/workspace'), staleTime: 0 });
  const amount = quantity.trim() === '' ? null : Number(quantity);
  const quantityValid = amount === null || (Number.isInteger(amount) && amount >= 1 && amount <= 1_000_000);
  const hidden = blocked || definitions.isError;

  // Any input change invalidates the reviewed hash; the manifest stays visible until rereview.
  function changed() { generation.current += 1; setRetained(previous => previous ? { ...previous, sha256: '' } : null); setError(null); }
  const payload = (): ExportRequest => ({
    root_revision_id: rootId!, quantity: amount, bom_plan_revision_id: bomId, bom_purpose: 'procurement',
    preparation_document_set_ids: documentSets, test_plan_revision_ids: testPlans,
    pcb_fabrication_builds: builds, scene_drawing_ids: drawings, purpose: 'authorized_review',
  });
  function denied(e: unknown) {
    if (e instanceof ApiError && [401, 403, 404].includes(e.status)) { setBlocked(true); setRetained(null); }
    setError(e instanceof Error ? e.message : 'Export package unavailable.');
  }
  async function inspect() {
    const current = ++generation.current;
    setBusy(true); setError(null);
    try { const checked = await review(payload()); if (current === generation.current && alive.current) { setRetained(checked); setBlocked(false); } }
    catch (e) { if (current === generation.current) { setRetained(null); denied(e); } }
    finally { if (current === generation.current) setBusy(false); }
  }
  async function getArchive() {
    if (!retained) return;
    const current = generation.current;
    setBusy(true); setError(null);
    try { const blob = await download(payload(), retained.sha256); if (current === generation.current && alive.current) saveArchive(blob); }
    catch (e) { if (current === generation.current) { setRetained(null); denied(e); } }
    finally { if (current === generation.current) setBusy(false); }
  }
  const manifest = !hidden ? retained?.manifest : undefined;
  const incoherent = manifest?.coherence === 'incoherent';
  return <Stack gap="sm">
    <Title order={2}>Coherent export packages</Title>
    <Text size="sm">One package pins system, cable, PCB, mechanical, spreadsheet and test outputs to the exact revisions of one frozen root, with independently counted scope quantities. Not a release, manufacturing approval or physical qualification.</Text>
    {error && <Alert color="red">{error}</Alert>}
    {hidden && <Alert color="red">Package contents are hidden while current access is unavailable. <Button size="xs" variant="subtle" onClick={() => { setBlocked(false); setError(null); void definitions.refetch(); void sets.refetch(); }}>Refresh access</Button></Alert>}
    {!hidden && <>
      <RevisionChoice label="Package root" kinds={ROOT_KINDS} definitions={definitions.data ?? []} value={rootId} disabled={busy} onChange={id => { changed(); setRootId(id); }} onDenied={denied} />
      <SbQuantityField label="Root quantity in scope" unit="ea" value={quantity} state={quantityValid ? undefined : 'invalid'} note="A whole number from 1 to 1,000,000" onChange={raw => { changed(); setQuantity(raw); }} next="Leave empty to keep every scope quantity unknown." />
      <RevisionChoice label="BOM plan" kinds={['bom_plan']} definitions={definitions.data ?? []} value={bomId} disabled={busy} onChange={id => { changed(); setBomId(id); }} onDenied={denied} />
      <Card withBorder padding="sm"><Stack gap="xs"><Title order={4}>Retained outputs to include</Title>
        <MultiSelect label="Preparation document sets" disabled={busy} data={(sets.data?.document_sets ?? []).map(row => ({ value: row.document_set_id, label: `${row.manifest.inputs.root.name} · ${row.created_at}` }))} value={documentSets} onChange={value => { changed(); setDocumentSets(value); }} />
        {sets.isError && <Text size="sm">Document sets unavailable: {sets.error.message}</Text>}
        <RevisionChoice label="Cable test plan" kinds={['cable_test_plan']} definitions={definitions.data ?? []} value={testPlan} disabled={busy} onChange={setTestPlan} onDenied={denied} />
        <Group><Button size="xs" disabled={busy || !testPlan || testPlans.includes(testPlan ?? '')} onClick={() => { changed(); setTestPlans(rows => [...rows, testPlan!]); }}>Include test plan</Button></Group>
        {testPlans.map(id => <Group key={id} gap="xs"><RevisionLabel id={id} role="Test plan" /><Button size="xs" variant="subtle" onClick={() => { changed(); setTestPlans(rows => rows.filter(row => row !== id)); }}>Remove</Button></Group>)}
        <Group align="end"><TextInput label="Scene drawing ID" value={drawingText} onChange={e => setDrawingText(e.currentTarget.value)} /><Button size="xs" disabled={busy || !UUID.test(drawingText.trim()) || drawings.includes(drawingText.trim())} onClick={() => { changed(); setDrawings(rows => [...rows, drawingText.trim()]); setDrawingText(''); }}>Include drawing</Button></Group>
        {drawings.map(id => <Group key={id} gap="xs"><Text size="sm" ff="monospace">drawing {id}</Text><Button size="xs" variant="subtle" onClick={() => { changed(); setDrawings(rows => rows.filter(row => row !== id)); }}>Remove</Button></Group>)}
        <Group align="end"><TextInput label="PCB intake ID" value={intakeText} onChange={e => setIntakeText(e.currentTarget.value)} /><TextInput label="Fabrication build ID" value={buildText} onChange={e => setBuildText(e.currentTarget.value)} /><Button size="xs" disabled={busy || !UUID.test(intakeText.trim()) || !UUID.test(buildText.trim()) || builds.some(b => b.build_id === buildText.trim())} onClick={() => { changed(); setBuilds(rows => [...rows, { intake_id: intakeText.trim(), build_id: buildText.trim() }]); setBuildText(''); }}>Include fabrication build</Button></Group>
        {builds.map(row => <Group key={row.build_id} gap="xs"><Text size="sm" ff="monospace">build {row.build_id}</Text><Button size="xs" variant="subtle" onClick={() => { changed(); setBuilds(rows => rows.filter(b => b.build_id !== row.build_id)); }}>Remove</Button></Group>)}
      </Stack></Card>
      <Group><Button disabled={busy || !rootId || !quantityValid} loading={busy} onClick={() => void inspect()}>Review export package</Button></Group>
      {manifest && <Card withBorder padding="sm"><Stack gap="xs">
        <Title order={3}>Export package review</Title>
        <Group gap="md"><SbStatus led={LED[manifest.coherence]} dimension="coherence" value={manifest.coherence} /><SbStatus led={LED[manifest.completeness]} dimension="completeness" value={manifest.completeness} /></Group>
        <Text size="sm"><RevisionLabel id={manifest.scope.root.revision_id} role="Root" /> · SHA-256 {manifest.scope.root.sha256}</Text>
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
        <Title order={4}>Unsupported output semantics</Title>
        {manifest.unsupported.map(row => <Text key={row.id} size="sm">{row.section} · {row.reason}</Text>)}
        <Group><Button disabled={busy || !retained?.sha256 || incoherent} onClick={() => void getArchive()}>Download export package</Button></Group>
        {incoherent && <Text size="sm">Included outputs cite different revisions or quantities; correct the selection before download.</Text>}
        {!retained?.sha256 && <Text size="sm">Inputs changed. Review the export package again before download.</Text>}
      </Stack></Card>}
    </>}
  </Stack>;
}
