import { Alert, Button, Card, Group, Stack, Table, Text, Title } from '@mantine/core';
import { useQuery } from '@tanstack/react-query';
import type { Source } from '../workshop-profiles/api';
import { ApplicationInspection } from '../end-preparation/ApplyPreparation';
import { FormulaInspection } from '../preparation/ProfileEditor';
import { authorityDenied, read, type Actual, type Result } from './api';

function Evidence({ value }: { value: Source | null }) {
  if (!value) return <Text size="xs">No registered source evidence.</Text>;
  return <Text size="xs">{value.kind === 'citation' ? `Unverified citation: ${value.citation}` : `Source ${value.bundle_revision_id} · ${value.path} · ${value.sha256} · rights ${value.rights} · ${value.locator}`}</Text>;
}
function ActualTable({ value }: { value: Actual | null }) {
  if (!value) return <Text>Actual retained material and waste not recorded.</Text>;
  return <Stack gap="xs"><Text>Live authorized Inventory returns; frozen observations remain independent.</Text><Text>Actual entire batch: {value.status}</Text><Text>Issued {value.issued ?? 'unknown'} {value.unit}; returned {value.returned ?? 'unknown'} {value.unit}; net issued {value.net_issued ?? 'unknown'} {value.unit}</Text><Text>Retained {value.record.retained.amount ?? 'unknown'} {value.unit}; discarded {value.record.waste.amount ?? 'unknown'} {value.unit}; unallocated {value.unallocated ?? 'unknown'} {value.unit}</Text><Text>{value.record.basis}</Text><Evidence value={value.record.source} />{value.inventory_entries.map(e => <Text key={e.consumption_id} size="xs">Consumption {e.consumption_id} · account {e.account_id} · work {e.work_batch_id} · physical unit {e.physical_unit_id ?? 'not attributed'} · {e.assertion_status} · {e.assertion_source}</Text>)}</Stack>;
}
export function BuildSheetContent({ value }: { value: Result }) {
  return <Stack><Title order={3}>Preparation material build sheet</Title><Text>Plan {value.revision_id} · {value.sha256}</Text><Text>Exact subject {value.subject_revision_id} · {value.subject_sha256}</Text><Text>Quantity {value.quantity ?? 'unknown'} · {value.decision}. Physical qualification: not evaluated.</Text>
    {value.decision === 'buy' && <Text>Purchase the subject: {value.purchased_subject_quantity ?? 'unknown'} ea. Its stock and process consumables are excluded from procurement.</Text>}
    <Table><Table.Thead><Table.Tr>{['Physical material', 'Installed / retained declaration', 'Selected cut', 'Extra waste beyond cut', 'Procurement'].map(title => <Table.Th key={title}>{title}</Table.Th>)}</Table.Tr></Table.Thead><Table.Tbody>{value.pieces.map(p => <Table.Tr key={p.section_id ?? 'cable'}>
      <Table.Td>{p.section_id ?? 'Cable piece'}<Text size="xs">{p.stock_revision_id} · {p.stock_sha256}</Text><Text size="xs">Segments: {p.segment_ids.join(', ') || 'not applicable'}</Text></Table.Td>
      <Table.Td>{p.installed_mm ?? 'unknown'} mm / piece<Text>Total: {p.installed_total_mm ?? 'unknown'} mm</Text></Table.Td><Table.Td>{p.cut_mm ?? 'unknown'} mm / piece<Text>Total: {p.cut_total_mm ?? 'unknown'} mm</Text><Text size="xs">{p.cut_basis} · independent saved cut {p.declared_cut_mm ?? 'unknown'} mm</Text><Text size="xs">Cut minus installed: {p.cut_minus_installed_mm ?? 'unknown'} mm, unclassified surplus</Text></Table.Td><Table.Td>{p.extra_waste_mm ?? 'unknown'} mm / piece<Text>Total: {p.extra_waste_total_mm ?? 'unknown'} mm</Text></Table.Td><Table.Td>{p.procurement_mm ?? 'unknown'} mm<Text size="xs">{p.procurement_status}</Text></Table.Td>
    </Table.Tr>)}</Table.Tbody></Table>
    {value.pieces.map((p, i) => <Card key={p.section_id ?? 'cable'} withBorder><Stack><Title order={4}>{p.section_id ?? 'Cable piece'} preparation and observations</Title><Text>Installed basis: {value.plan.pieces[i]?.installed.basis}</Text><Evidence value={value.plan.pieces[i]?.installed.source ?? null} /><Text>Extra waste basis: {value.plan.pieces[i]?.extra_waste.basis}</Text><Evidence value={value.plan.pieces[i]?.extra_waste.source ?? null} />{p.preparation && <><Text>Exact profile {p.preparation.profile_revision_id} · {p.preparation.profile_sha256}</Text><FormulaInspection formula={p.preparation.formula} /></>}<ActualTable value={p.reconciliation} /></Stack></Card>)}
    {value.unplanned_sections.map(section => <Alert key={section ?? 'cable'} color="yellow">Physical section {section ?? 'Cable piece'} has no material plan. Its procurement remains unresolved.</Alert>)}
    <Title order={4}>Separate consumables</Title>{value.consumables.map(c => <Card key={c.local_id} withBorder><Stack><Text>{c.local_id} · {c.revision_id} · {c.sha256}</Text><Group><Text>Net: {c.net_quantity ?? 'unknown'} {c.unit}</Text><Text>Additive waste: {c.waste_quantity ?? 'unknown'} {c.unit}</Text><Text>Procurement: {c.procurement_quantity ?? 'unknown'} {c.unit} · {c.procurement_status}</Text></Group><Text>{c.declaration.basis}</Text><Evidence value={c.declaration.source} /><Text>Waste basis: {c.declaration.waste?.basis ?? 'not evaluated'}</Text><ActualTable value={c.reconciliation} /></Stack></Card>)}
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
