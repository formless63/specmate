import { useRevisionLabel } from '../../lib/revision-labels';
import { LengthInspection, LengthImpactView } from './Lengths';
import { Alert, Card, Stack, Table, Text, Title } from '@mantine/core';
import { useQuery } from '@tanstack/react-query';
import { loadFrozenStock } from '../wire-stock/viewer-api';
import { CableViews, type CableEnd } from '../cable-views/CableViews';
import { read, type Inspection, type ResolvedTermination } from './api';
import { SbUnknown } from '../../components/sb';
import { StackView } from '../end-assemblies/StackEditor';
import { CableSummary, StockLink, endName } from './CableSummary';
import { RevisionLabel } from '../../lib/IdentityLabel';
import { CableWorkbench } from '../cable-workbench/CableWorkbench';
import { IntentCheckPanel } from '../intent-check/IntentCheckPanel';

export function CableInspector({ revisionId, revisions = [] }: { revisionId: string; revisions?: { revision_id: string; number: number }[] }) {
  const cableLabel = useRevisionLabel(revisionId).data; const cableName = cableLabel?.readable ? cableLabel.name : undefined;
  const result = useQuery({ queryKey: ['cable-inspection', revisionId], queryFn: () => read<Inspection>(`cables/revisions/${revisionId}`) });
  const stockId = result.data?.cable.stock_revision_id;
  const stock = useQuery({ queryKey: ['cable-stock', stockId], queryFn: () => loadFrozenStock(stockId!), enabled: !!stockId && !result.isError });
  const data = result.data;
  const endLabel = (id: string) => { const e = data?.endpoints.find(x => x.local_id === id); return e ? endName(e) : id; };
  const targetText = (assignment: ResolvedTermination) => assignment.contact_id ?? `${assignment.terminal_label ?? assignment.terminal_id}${assignment.reaches?.[0] ? ` → ${assignment.reaches[0].label}` : ''}`;
  // Ends with an unknown stock end are not placed on a stock end face: every end's landing is listed.
  const terminationLabels = Object.fromEntries((data?.conductors ?? []).map(row => [row.element_path,
    row.ends.map(end => `${endLabel(end.endpoint_id)}: ${end.assignment ? targetText(end.assignment) : 'unassigned'}`).join('; ')]));
  // Each cable end is drawn on the stock end face it records; its own landings label that face.
  const cableEnds: CableEnd[] = (data?.endpoints ?? []).map(e => ({ endpointId: e.local_id, label: endName(e), stockEnd: e.stock_end ?? 'unknown',
    terminations: Object.fromEntries((data?.conductors ?? []).flatMap(row => { const end = row.ends.find(x => x.endpoint_id === e.local_id); return end?.assignment ? [[row.element_path, targetText(end.assignment)]] : []; })) }));
  const number = revisions.find(r => r.revision_id === revisionId)?.number ?? (cableLabel?.readable ? cableLabel.number : undefined);
  const endDetails = (data?.endpoints ?? []).map(endpoint => <Stack key={endpoint.local_id} gap="xs"><Text fw={600}>{endName(endpoint)} ({endpoint.local_id})</Text>
    <Text size="sm">{endpoint.stock_end && endpoint.stock_end !== 'unknown' ? `Uses stock end ${endpoint.stock_end.toUpperCase()}` : <SbUnknown what="Stock end" />}</Text>
    {endpoint.end_assembly_revision_id && <Text size="sm"><RevisionLabel id={endpoint.end_assembly_revision_id} role="End assembly" /></Text>}
    {endpoint.resolved_stack && <StackView resolved={endpoint.resolved_stack} label={endName(endpoint)} />}
    {endpoint.body && endpoint.pinout && <>
      <Text size="sm"><RevisionLabel id={endpoint.body_revision_id!} role="Body" />; <RevisionLabel id={endpoint.pinout_revision_id!} role="pinout" /></Text><Text size="sm">Body drawing side: {endpoint.body.drawing_orientation.viewing_side}; pinout viewing side: {endpoint.pinout.orientation.viewing_side}</Text>
      <Table.ScrollContainer minWidth={420}><Table><Table.Thead><Table.Tr><Table.Th>Contact</Table.Th><Table.Th>Signal / role</Table.Th><Table.Th>Voltage range (V)</Table.Th><Table.Th>Current limit (A)</Table.Th></Table.Tr></Table.Thead><Table.Tbody>{endpoint.body.contacts.map(contact => { const electrical = endpoint.pinout!.assignments.find(a => a.contact_id === contact.contact_id)?.electrical; return <Table.Tr key={contact.contact_id}><Table.Td>{contact.contact_id} ({contact.physical_role})</Table.Td><Table.Td>{electrical?.signal ?? 'unknown'} / {electrical?.role ?? 'unknown'}</Table.Td><Table.Td>{electrical?.voltage_min_v ?? 'unknown'} to {electrical?.voltage_max_v ?? 'unknown'}</Table.Td><Table.Td>{electrical?.current_max_a ?? 'unknown'}</Table.Td></Table.Tr>; })}</Table.Tbody></Table></Table.ScrollContainer>
    </>}
    {!endpoint.body && <Text size="xs" c="dimmed">No connector layer: contact ratings are not evaluated for this end.</Text>}
  </Stack>);
  return <Stack gap="xs" aria-label="Frozen cable inspection">
    {result.isError && <Alert color="red">{result.error.message}</Alert>}
    {data && !result.isError && <CableWorkbench mode="frozen" name={cableName ?? 'Frozen cable'} cable={data.cable} stacks={data.endpoints.map(e => e.resolved_stack)} bodies={data.endpoints.map(e => e.body)}
      stock={stock.isError ? undefined : stock.data} conductors={data.conductors} revisionId={revisionId}
      revision={{ value: number ? `r${number}` : 'Frozen', sub: 'frozen · immutable' }}
      notices={data.stored_schema_version === '0.1' ? <Text size="xs" c="dimmed">Recorded before end stacks: each end reads as one connector layer, stock end unknown.</Text> : null}
      cableForm={<Stack gap="xs">
        <Text size="sm"><RevisionLabel id={revisionId} /></Text>
        <Text size="sm">Review: {data.cable.review}; basis: {data.cable.review_basis ?? 'unknown'}</Text>
        {data.intent && <Text size="sm">Intent: <RevisionLabel id={data.intent.revision_id} /></Text>}
        <Text size="sm">Continuity: {data.continuity}. Compatibility: {data.compatibility}. Physical qualification: {data.physical_qualification}.</Text>
        <StockLink revisionId={data.cable.stock_revision_id} />
        {data.lengths && <LengthInspection projection={data.lengths} />}
      </Stack>}
      endForms={endDetails}
      details={<details className="cwb-details">
        <summary>Recorded tables, check evidence and stock views</summary>
        <Stack gap="sm" mt="xs">
          <CableSummary cable={data.cable} elementCount={data.conductors.length} stacks={data.endpoints.map(e => e.resolved_stack)} />
          <IntentCheckPanel revisionId={revisionId} intentRevisionId={data.cable.intent_revision_id ?? null} />
          <Title order={4}>Terminations</Title>
          <Table.ScrollContainer minWidth={420}><Table aria-label="Cable terminations"><Table.Thead><Table.Tr><Table.Th>Stable stock feature</Table.Th>{data.endpoints.map(e => <Table.Th key={e.local_id}>{endName(e)} ({e.local_id})</Table.Th>)}</Table.Tr></Table.Thead><Table.Tbody>
            {data.conductors.map(row => <Table.Tr key={row.element_path}><Table.Td>{row.element_path} · {row.kind}</Table.Td>{row.ends.map(end => <Table.Td key={end.endpoint_id}>{end.assignment ? <>{end.assignment.layer_kind && end.assignment.layer_kind !== 'connector' ? `${end.assignment.layer_kind} ` : ''}{targetText(end.assignment)}{end.assignment.signal ? ` · ${end.assignment.signal.name}` : end.assignment.reaches?.[0]?.signal ? ` · ${end.assignment.reaches[0].signal.name}` : ''} · {end.assignment.basis}</> : 'unknown / unassigned'}</Table.Td>)}</Table.Tr>)}
          </Table.Tbody></Table></Table.ScrollContainer>
          <LengthImpactView key={`impact:${revisionId}`} afterRevision={revisionId} name={cableName} revisions={revisions} />
          <Card withBorder aria-label="Stock used"><Stack gap="xs">
            <Title order={4}>Stock used: <RevisionLabel id={data.cable.stock_revision_id} /></Title>
            <Text size="sm" c="dimmed">The wire material this cable is cut from. Its cross-section and end faces are the stock's, not the finished cable's.</Text>
            <StockLink revisionId={data.cable.stock_revision_id} />
            {stock.isError && <Alert color="red">{stock.error.message}</Alert>}
            {stock.data && !stock.isError && <CableViews stock={stock.data} name={`Stock ${stockId}`} revisionId={stockId} terminationLabels={terminationLabels} cableEnds={cableEnds} choosePreparation />}
          </Stack></Card>
        </Stack>
      </details>} />}
  </Stack>;
}
