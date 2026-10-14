import { Alert, Button, Card, Group, Stack, Table, Text, Title } from '@mantine/core';
import { useQuery } from '@tanstack/react-query';
import { SbQuantity } from "../../components/sb";
import type { Source } from '../workshop-profiles/api';
import { ApplicationInspection } from '../end-preparation/ApplyPreparation';
import { FormulaInspection } from '../preparation/ProfileEditor';
import { authorityDenied, read, type Actual, type Result } from './api';
import { RevisionLabel } from "../../lib/IdentityLabel";

function Evidence({ value }: { value: Source | null }) {
  if (!value) return <Text size="xs">No registered source evidence.</Text>;
  return <Text size="xs">{value.kind === 'citation' ? `Unverified citation: ${value.citation}` : `Source ${value.bundle_revision_id} · ${value.path} · ${value.sha256} · rights ${value.rights} · ${value.locator}`}</Text>;
}
function ActualTable({ value }: { value: Actual | null }) {
  if (!value) return <Text>Actual retained material and waste not recorded.</Text>;
  return <Stack gap="xs"><Text>Live authorized Inventory returns; frozen observations remain independent.</Text><Text>Actual entire batch: {value.status}</Text><Text>Issued <SbQuantity value={value.issued} unit={value.unit} />; returned <SbQuantity value={value.returned} unit={value.unit} />; net issued <SbQuantity value={value.net_issued} unit={value.unit} /></Text><Text>Retained <SbQuantity value={value.record.retained.amount} unit={value.unit} />; discarded <SbQuantity value={value.record.waste.amount} unit={value.unit} />; unallocated <SbQuantity value={value.unallocated} unit={value.unit} /></Text><Text>{value.record.basis}</Text><Evidence value={value.record.source} />{value.inventory_entries.map(e => <Text key={e.consumption_id} size="xs">Consumption {e.consumption_id} · account {e.account_id} · work {e.work_batch_id} · physical unit {e.physical_unit_id ?? 'not attributed'} · {e.assertion_status} · {e.assertion_source}</Text>)}</Stack>;
}
export function BuildSheetContent({ value }: { value: Result }) {
  return <Stack><Title order={3}>Preparation material build sheet</Title><Text><RevisionLabel id={value.revision_id} role="Plan" sha256={value.sha256} /></Text><Text><RevisionLabel id={value.subject_revision_id} role="subject" sha256={value.subject_sha256} /></Text><Text>Quantity <SbQuantity value={value.quantity} unit="ea" /> · {value.decision}. Physical qualification: not evaluated.</Text>
    {value.decision === 'buy' && <Text>Purchase the subject: <SbQuantity value={value.purchased_subject_quantity} unit="ea" />. Its stock and process consumables are excluded from procurement.</Text>}
    <Table><Table.Thead><Table.Tr>{['Physical material', 'Installed / retained declaration', 'Selected cut', 'Extra waste beyond cut', 'Procurement'].map(title => <Table.Th key={title}>{title}</Table.Th>)}</Table.Tr></Table.Thead><Table.Tbody>{value.pieces.map(p => <Table.Tr key={p.section_id ?? 'cable'}>
      <Table.Td>{p.section_id ?? 'Cable piece'}<Text size="xs"><RevisionLabel id={p.stock_revision_id} sha256={p.stock_sha256} /></Text><Text size="xs">Segments: {p.segment_ids.join(', ') || 'not applicable'}</Text></Table.Td>
      <Table.Td><SbQuantity value={p.installed_mm} unit="mm" /> / piece<Text>Total: <SbQuantity value={p.installed_total_mm} unit="mm" /></Text></Table.Td><Table.Td><SbQuantity value={p.cut_mm} unit="mm" /> / piece<Text>Total: <SbQuantity value={p.cut_total_mm} unit="mm" /></Text><Text size="xs">{p.cut_basis} · independent saved cut <SbQuantity value={p.declared_cut_mm} unit="mm" /></Text><Text size="xs">Cut minus installed: <SbQuantity value={p.cut_minus_installed_mm} unit="mm" />, unclassified surplus</Text></Table.Td><Table.Td><SbQuantity value={p.extra_waste_mm} unit="mm" /> / piece<Text>Total: <SbQuantity value={p.extra_waste_total_mm} unit="mm" /></Text></Table.Td><Table.Td><SbQuantity value={p.procurement_mm} unit="mm" /><Text size="xs">{p.procurement_status}</Text></Table.Td>
    </Table.Tr>)}</Table.Tbody></Table>
    {value.pieces.map((p, i) => <Card key={p.section_id ?? 'cable'} withBorder><Stack><Title order={4}>{p.section_id ?? 'Cable piece'} preparation and observations</Title><Text>Installed basis: {value.plan.pieces[i]?.installed.basis}</Text><Evidence value={value.plan.pieces[i]?.installed.source ?? null} /><Text>Extra waste basis: {value.plan.pieces[i]?.extra_waste.basis}</Text><Evidence value={value.plan.pieces[i]?.extra_waste.source ?? null} />{p.preparation && <><Text><RevisionLabel id={p.preparation.profile_revision_id} role="profile" sha256={p.preparation.profile_sha256} /></Text><FormulaInspection formula={p.preparation.formula} /></>}<ActualTable value={p.reconciliation} /></Stack></Card>)}
    {value.unplanned_sections.map(section => <Alert key={section ?? 'cable'} color="yellow">Physical section {section ?? 'Cable piece'} has no material plan. Its procurement remains unresolved.</Alert>)}
    <Title order={4}>Separate consumables</Title>{value.consumables.map(c => <Card key={c.local_id} withBorder><Stack><Text>{c.local_id} · <RevisionLabel id={c.revision_id} sha256={c.sha256} /></Text><Group><Text>Net: <SbQuantity value={c.net_quantity} unit={c.unit} /></Text><Text>Additive waste: <SbQuantity value={c.waste_quantity} unit={c.unit} /></Text><Text>Procurement: <SbQuantity value={c.procurement_quantity} unit={c.unit} /> · {c.procurement_status}</Text></Group><Text>{c.declaration.basis}</Text><Evidence value={c.declaration.source} /><Text>Waste basis: {c.declaration.waste?.basis ?? 'not evaluated'}</Text><ActualTable value={c.reconciliation} /></Stack></Card>)}
    {value.end_preparation && <ApplicationInspection result={value.end_preparation} />}
    {value.limitations.map(line => <Text size="sm" key={line}>{line}</Text>)}
  </Stack>;
}
export function BuildSheet({ revisionId, editorGeneration, onDenied }: { revisionId: string; editorGeneration: number; onDenied: () => void }) {
  const result = useQuery({ queryKey: ['material-sheet', revisionId, editorGeneration], queryFn: async () => {
    try { return await read<Result>(`material-accounting/revisions/${revisionId}`); }
    catch (error) { if (authorityDenied(error)) onDenied(); throw error; }
  } });
  return <Card withBorder><Stack><Button loading={result.isFetching} onClick={() => result.refetch()}>Refresh material build sheet access</Button>{result.isError && <Alert color="red">{result.error.message}</Alert>}{result.data && !result.isError && !result.isFetching && <BuildSheetContent value={result.data} />}</Stack></Card>;
}
