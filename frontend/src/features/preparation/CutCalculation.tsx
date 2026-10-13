import { Alert, Button, Card, Group, Stack, Table, Text, TextInput, Title } from '@mantine/core';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { authorityDenied, postRead, type Application, type Definition, type Request, type Result } from './api';
import { FormulaInspection } from './ProfileEditor';
import { RevisionChoice } from './RevisionChoice';

export function CutCalculation({ definitions, onDenied, authorityScope = 0 }: { definitions: Definition[]; onDenied?: (request: Request) => void; authorityScope?: number }) {
  const [target, setTarget] = useState('');
  const [applications, setApplications] = useState<Application[]>([{ section_id: null, profile_revision_id: '' }]);
  const [quantity, setQuantity] = useState('1');
  const [requestScope, setRequestScope] = useState(authorityScope);
  const [request, setRequest] = useState<Request | null>(null);
  const result = useQuery({ queryKey: ['preparation-computation', request], queryFn: () => postRead<Result>('compute', request!), enabled: !!request, retry: false });
  useEffect(() => { if (requestScope === authorityScope && request && result.isError && authorityDenied(result.error)) onDenied?.(request); }, [requestScope, authorityScope, request, result.isError, result.error, onDenied]);
  const validQuantity = quantity === '' || (/^[1-9][0-9]*$/.test(quantity) && Number(quantity) <= 1000000);
  return <Card withBorder><Stack><Title order={3}>Apply exact profiles to frozen cable or harness</Title>
    <RevisionChoice label="Preparation subject" kinds={['cable', 'harness']} definitions={definitions} value={target} onChange={id => { setTarget(id); setRequest(null); }} />
    <Text>One application per retained physical section. Leave section ID blank for a cable. Shared harness segments do not create extra stock pieces.</Text>
    {applications.map((a, index) => <Card key={index} withBorder><Stack><TextInput label={`Application ${index + 1} harness section ID`} value={a.section_id ?? ''} onChange={e => { setApplications(applications.map((item, i) => i === index ? { ...item, section_id: e.currentTarget.value || null } : item)); setRequest(null); }} /><RevisionChoice label={`Application ${index + 1} profile`} kinds={['preparation_profile']} definitions={definitions} value={a.profile_revision_id} onChange={id => { setApplications(applications.map((item, i) => i === index ? { ...item, profile_revision_id: id } : item)); setRequest(null); }} /><Button variant="subtle" onClick={() => { setApplications(applications.filter((_, i) => i !== index)); setRequest(null); }}>Remove application {index + 1}</Button></Stack></Card>)}
    <Button onClick={() => { setApplications([...applications, { section_id: null, profile_revision_id: '' }]); setRequest(null); }}>Add physical-section application</Button>
    <TextInput label="Requested units" description="Blank means unknown quantity." value={quantity} onChange={e => { setQuantity(e.currentTarget.value); setRequest(null); }} />
    <Group><Button disabled={!target || !applications.length || applications.some(a => !a.profile_revision_id) || !validQuantity} onClick={() => { setRequestScope(authorityScope); const next = { revision_id: target, applications, quantity: quantity ? Number(quantity) : null }; if (JSON.stringify(next) === JSON.stringify(request)) void result.refetch(); else setRequest(next); }}>Compute preparation cuts</Button><Button disabled={!request} loading={result.isFetching} onClick={() => { setRequestScope(authorityScope); void result.refetch(); }}>Refresh computed cut access</Button></Group>
    {result.isError && <Alert color="red">{result.error.message}</Alert>}
    {result.data && !result.isError && !result.isFetching && request && <CutResult result={result.data} />}
  </Stack></Card>;
}
const mm = (value: string | null) => value === null ? 'unknown' : `${value} mm`;
export function CutResult({ result }: { result: Result }) {
  const [offset, setOffset] = useState(0);
  return <Stack><Title order={4}>Computed cut suggestions</Title><Text>Subject {result.revision_id} · {result.sha256}; requested units {result.quantity ?? 'unknown'}; selected physical pieces {result.physical_piece_count ?? 'unknown'}.</Text><Text>Stock and conductor totals are separate. Suggestions are not applied to saved cuts, inventory, or workshop geometry.</Text>{result.unprofiled_sections.length > 0 && <Alert color="orange">Unprofiled sections: {result.unprofiled_sections.map(id => id ?? 'cable').join(', ')}</Alert>}
    <Table><Table.Thead><Table.Tr><Table.Th>Physical identity</Table.Th><Table.Th>Input</Table.Th><Table.Th>Cut / total</Table.Th><Table.Th>Independent declaration</Table.Th></Table.Tr></Table.Thead><Table.Tbody>{result.rows.slice(offset, offset + 20).map((r, index) => <Table.Tr key={`${r.section_id}:${r.formula.local_id}:${index}`}><Table.Td>{r.section_id ?? 'cable'} · {r.target} · {r.element_path ?? 'whole stock'} · {r.element_kind ?? 'stock piece'}<Text size="sm">Segments: {r.segment_ids.join(', ') || 'none'}</Text></Table.Td><Table.Td>{mm(r.input_mm)} · {r.formula.input_basis}</Table.Td><Table.Td>{mm(r.cut_mm)} / {mm(r.total_mm)} · {r.status}</Table.Td><Table.Td>{mm(r.declared_cut_mm)}{r.declaration_matches_result === false && <Text c="orange">Differs from computed suggestion</Text>}</Table.Td></Table.Tr>)}</Table.Tbody></Table>
    {result.rows.slice(offset, offset + 20).map((r, index) => <Card key={index} withBorder><Text size="sm">Section {r.section_id ?? 'cable'}; profile {r.profile_revision_id} · {r.profile_sha256}; stock {r.stock_revision_id} · {r.stock_sha256}</Text><Text size="sm">Input declaration basis: {r.input_provenance?.declaration?.basis ?? 'unknown'} · {r.input_provenance?.declaration?.explanation ?? 'unknown'}</Text>{r.input_provenance?.model && <Stack gap={0}><Text size="sm">Input model: {r.input_provenance.model.source} · {r.input_provenance.model.review} · {r.input_provenance.model.review_basis ?? 'unknown'}</Text>{r.input_provenance.model.allowances.map((a, i) => <Text key={i} size="sm">{a.kind} {a.amount_mm ?? 'unknown'} mm · {a.scope} {a.endpoint_id ?? ''} · {a.explanation}</Text>)}</Stack>}<FormulaInspection formula={r.formula} /></Card>)}
    <Group><Button disabled={!offset} onClick={() => setOffset(Math.max(0, offset - 20))}>Previous cut rows</Button><Text>{Math.min(offset + 20, result.rows.length)} of {result.rows.length}</Text><Button disabled={offset + 20 >= result.rows.length} onClick={() => setOffset(offset + 20)}>Next cut rows</Button></Group>
  </Stack>;
}
