import { Alert, Button, Card, NumberInput, Select, Stack, Table, Text, Title } from '@mantine/core';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { RevisionLabel } from '../../lib/IdentityLabel';
import { authorityDenied } from '../cables/api';
import { HarnessViews } from '../harness-views/HarnessViews';
import { StackView } from '../end-assemblies/StackEditor';
import { read, terminalKey, terminalLabel, type Inspection } from './api';

export function HarnessInspector({ revisionId, authorityScope = 0, onDenied }: { revisionId: string; authorityScope?: number; onDenied?: (revisionId: string, generation: number) => void }) {
  const [quantity, setQuantity] = useState(1);
  const [terminal, setTerminal] = useState<string | null>(null);
  const result = useQuery({ queryKey: ['harness-inspect', revisionId, quantity], queryFn: async () => { const generation = authorityScope; try { return await read<Inspection>(`harnesses/revisions/${revisionId}?quantity=${quantity}`); } catch (reason) { if (authorityDenied(reason)) onDenied?.(revisionId, generation); throw reason; } }, retry: false });
  const value = result.isError || result.isFetching ? undefined : result.data;
  const relationships = value?.declared_relationships.filter(r => r.members.some(t => terminalKey(t) === terminal)) ?? [];
  return <Card withBorder><Stack><Title order={3}>Frozen harness inspection</Title><Text><RevisionLabel id={revisionId} /></Text>
    <Button loading={result.isFetching} onClick={() => { void result.refetch(); }}>Refresh frozen Harness access</Button>
    <NumberInput label="Harness quantity" min={1} max={1000000} allowDecimal={false} value={quantity} onChange={v => { if (typeof v === 'number' && Number.isInteger(v) && v >= 1) setQuantity(v); }} />
    {result.isError && <Alert color="red">{result.error.message}</Alert>}
    {value && <><Text>Planned stock pieces: {value.quantities.physical_piece_count ?? 'unknown'}; segment spans: {value.quantities.segment_count ?? 'unknown'}</Text><Text>Continuity: {value.continuity}. Compatibility: {value.compatibility}. Physical qualification: {value.physical_qualification}.</Text>
      <Table><Table.Thead><Table.Tr><Table.Th>Exact stock</Table.Th><Table.Th>Planned sections</Table.Th><Table.Th>Pieces</Table.Th><Table.Th>Planned cut total (mm)</Table.Th></Table.Tr></Table.Thead><Table.Tbody>{value.quantities.stock.map(row => <Table.Tr key={row.stock_revision_id}><Table.Td><RevisionLabel id={row.stock_revision_id} /></Table.Td><Table.Td>{row.section_ids.join(', ')}</Table.Td><Table.Td>{row.piece_count ?? 'unknown'}</Table.Td><Table.Td>{row.planned_cut_total_mm ?? 'unknown'}</Table.Td></Table.Tr>)}</Table.Tbody></Table>
      <Title order={4}>Formboard and build sheet</Title><HarnessViews key={`${revisionId}:${quantity}`} revisionId={revisionId} harness={value.harness} quantity={quantity} resolvedEnds={value.endpoints} />
      <Title order={4}>Endpoints</Title>{(value.endpoints ?? []).map(end => <Stack key={end.local_id} gap={4}><Text size="sm" fw={600}>{end.label ?? end.local_id}{end.end_assembly_name ? ` · ${end.end_assembly_name}` : ' · stack declared on this harness'}</Text><StackView resolved={end.resolved_stack} label={end.label ?? end.local_id} /></Stack>)}
      {value.stored_schema_version === '0.1' && <Text size="xs" c="dimmed">Stored as harness content 0.1: each endpoint reads as one connector layer.</Text>}
      <Title order={4}>Declared physical ends</Title>{value.harness.sections.map(section => <Stack key={section.local_id}><Text>Section {section.local_id}</Text>{!(section.physical_ends?.length) && <Text>Physical ends unknown; no segment directions imply end assignments.</Text>}{section.physical_ends?.map(end => <Text key={end.local_id}>{end.local_id} · {end.label ?? 'unknown label'} · {end.segment_ends.map(ref => `${ref.segment_id}/${ref.end}`).join(', ')} · endpoint {end.endpoint_id ?? 'unknown'} · {end.review}: {end.basis}</Text>)}</Stack>)}
      <Title order={4}>Segments and retained material</Title>{value.harness.segments.map(s => <Text key={s.local_id}>{s.local_id} → section {s.section_id}; conductive paths: {s.element_paths?.join(', ') ?? 'all declared conductive features'}</Text>)}
      <Title order={4}>Declared relationships</Title><Text>Only explicit relationships touching a selected terminal are shown. This does not trace longitudinal copper or establish measured continuity.</Text>
      <Select label="Inspect terminal declarations" searchable value={terminal} onChange={setTerminal} data={value.terminals.map(row => ({ value: terminalKey(row.terminal), label: `${terminalLabel(row.terminal)} (${row.feature_kind})` }))} />
      {terminal && (relationships.length ? relationships.map(r => <Card key={`${r.breakout_id ?? 'joint'}:${r.id}`} withBorder><Text>{r.kind}: {r.id}{r.breakout_id ? ` at ${r.breakout_id}` : ''}</Text><Text>{r.members.map(terminalLabel).join(' ↔ ')}</Text><Text>Basis: {r.basis}</Text></Card>) : <Text>No relationship declared for this terminal; continuity remains unknown.</Text>)}
      <Title order={4}>Breakout accountability</Title><Table><Table.Thead><Table.Tr><Table.Th>Breakout</Table.Th><Table.Th>Exact terminal</Table.Th><Table.Th>Declared fate</Table.Th></Table.Tr></Table.Thead><Table.Tbody>{value.breakout_fates.map(row => <Table.Tr key={`${row.breakout_id}:${terminalKey(row.terminal)}`}><Table.Td>{row.breakout_id}</Table.Td><Table.Td>{terminalLabel(row.terminal)}</Table.Td><Table.Td>{row.fate}</Table.Td></Table.Tr>)}</Table.Tbody></Table>
    </>}
  </Stack></Card>;
}
