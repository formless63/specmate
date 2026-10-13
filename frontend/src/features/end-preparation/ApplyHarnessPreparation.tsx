import { Alert, Button, Card, Group, Select, Stack, Text, TextInput, Title } from '@mantine/core';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import type { Inspection } from '../harnesses/api';
import { authorityDenied, postRead, read, type Definition, type HarnessRequest, type HarnessResult } from './api';
import { RevisionPicker } from './EndPreparationPanel';
import { InstructionInspection } from './ProfileEditor';

export function ApplyHarnessPreparation({ definitions, onDenied, onReferenceDenied, authorityScope = 0, hidden = false }: { definitions: Definition[]; onDenied?: (request: HarnessRequest, generation: number) => void; onReferenceDenied?: (definition: string, generation: number) => void; authorityScope?: number; hidden?: boolean }) {
  const [fields, setFields] = useState<HarnessRequest>({ harness_revision_id: '', section_id: '', profile_revision_id: '', a_physical_end_id: null, b_physical_end_id: null, mapping_basis: '', mapping_review: 'unreviewed' });
  const [request, setRequest] = useState<HarnessRequest | null>(null);
  const [denied, setDenied] = useState(false);
  const currentScope = useRef(authorityScope); currentScope.current = authorityScope;
  useEffect(() => { if (!hidden) setDenied(false); }, [hidden]);
  const fail = (reason: unknown, submitted: HarnessRequest, generation: number) => { if (generation === currentScope.current && authorityDenied(reason)) { setDenied(true); onDenied?.(submitted, generation); } };
  const change = (patch: Partial<HarnessRequest>) => { setFields({ ...fields, ...patch }); setRequest(null); };
  const harness = useQuery({ queryKey: ['end-preparation-harness', fields.harness_revision_id], queryFn: async () => { const submitted = fields; const generation = authorityScope; try { return await read<Inspection>(`harnesses/revisions/${submitted.harness_revision_id}`); } catch (reason) { fail(reason, submitted, generation); throw reason; } }, enabled: !!fields.harness_revision_id && !hidden && !denied, retry: false });
  const result = useQuery({ queryKey: ['end-preparation-harness-application', request], queryFn: async () => { const submitted = request!; const generation = authorityScope; try { return await postRead<HarnessResult>('apply-harness', submitted); } catch (reason) { fail(reason, submitted, generation); throw reason; } }, enabled: !!request && !hidden && !denied, retry: false });
  if (hidden) return null;
  if (denied) return <Alert color="red">Harness preparation access must be restored before retained evidence is shown.</Alert>;
  const sections = harness.data && !harness.isError && !harness.isFetching ? harness.data.harness.sections : [];
  const selected = sections.find(section => section.local_id === fields.section_id);
  const ends = selected?.physical_ends ?? [];
  const choices = ends.map(end => ({ value: end.local_id, label: `${end.local_id} · ${end.label ?? 'unknown label'}` }));
  return <Card withBorder><Stack><Title order={3}>Apply end preparation to a Harness physical section</Title><Text>One exact section is one piece. Choose declared physical end IDs explicitly. Segment direction, repeated labels and electrical relationships never choose the mapping.</Text>
    <RevisionPicker label="End preparation harness" definitions={definitions} kinds={['harness']} value={fields.harness_revision_id} onChange={harness_revision_id => change({ harness_revision_id, section_id: '', a_physical_end_id: null, b_physical_end_id: null })} onDenied={id => onReferenceDenied?.(id, authorityScope)} />
    <Select label="End preparation physical section" data={sections.map(section => ({ value: section.local_id, label: `${section.local_id} · stock ${section.stock_revision_id}` }))} value={fields.section_id || null} onChange={section_id => change({ section_id: section_id ?? '', a_physical_end_id: null, b_physical_end_id: null })} />
    <RevisionPicker label="Harness end preparation profile" definitions={definitions} kinds={['end_preparation_profile']} value={fields.profile_revision_id} onChange={profile_revision_id => change({ profile_revision_id })} onDenied={id => onReferenceDenied?.(id, authorityScope)} />
    {selected && <><Text>Declared physical ends: {ends.length}. Section {selected.local_id} counts once, regardless of segment count.</Text>{ends.length !== 2 && <Alert>Two-end profile application is unresolved. Author explicit physical ends in the Harness editor; multi-end sections remain declared without guessed assignments.</Alert>}{ends.map(end => <Text key={end.local_id}>{end.local_id}: {end.segment_ends.map(ref => `${ref.segment_id}/${ref.end}`).join(', ')}; endpoint {end.endpoint_id ?? 'unknown'}; {end.review}: {end.basis}</Text>)}</>}
    <Select clearable label="Profile A exact physical end" data={choices} value={fields.a_physical_end_id} onChange={a_physical_end_id => change({ a_physical_end_id })} /><Select clearable label="Profile B exact physical end" data={choices} value={fields.b_physical_end_id} onChange={b_physical_end_id => change({ b_physical_end_id })} />
    <TextInput label="Physical end mapping basis" value={fields.mapping_basis} onChange={e => change({ mapping_basis: e.currentTarget.value })} /><Select label="Physical end mapping review" data={['unreviewed', 'reviewed']} value={fields.mapping_review} onChange={mapping_review => change({ mapping_review: mapping_review as HarnessRequest['mapping_review'] })} />
    <Group><Button disabled={result.isFetching || !fields.harness_revision_id || !fields.section_id || !fields.profile_revision_id || !fields.mapping_basis.trim()} onClick={() => { if (JSON.stringify(request) === JSON.stringify(fields)) void result.refetch(); else setRequest(fields); }}>Apply Harness end preparation</Button><Button disabled={!request} loading={result.isFetching} onClick={() => { void result.refetch(); }}>Refresh Harness preparation access</Button></Group>
    {[harness.error, result.error].filter(Boolean).map((reason, i) => <Alert key={i} color="red">{reason!.message}</Alert>)}
    {result.data && request && !result.isError && !result.isFetching && <HarnessApplicationInspection result={result.data} />}
  </Stack></Card>;
}

export function HarnessApplicationInspection({ result }: { result: HarnessResult }) {
  return <Stack><Title order={4}>Physical-section instruction application</Title><Text>Harness {result.harness_revision_id} · {result.harness_sha256}</Text><Text>Section {result.section_id} · pieces {result.physical_piece_count}</Text><Text>Profile {result.profile_revision_id} · {result.profile_sha256}</Text><Text>Stock {result.stock_revision_id} · {result.stock_sha256}</Text><Text>Mapping {result.mapping_review}: {result.mapping_basis}</Text>{result.unresolved.map(reason => <Alert key={reason}>{reason}</Alert>)}
    {result.ends.map(end => <Card withBorder key={end.profile_end}><Stack><Title order={4}>Profile {end.profile_end.toUpperCase()} → physical end {end.physical_end.local_id}</Title><Text>Physical declaration {end.physical_end.review}: {end.physical_end.basis}</Text><Text>Segment references: {end.physical_end.segment_ends.map(ref => `${ref.segment_id}/${ref.end}`).join(', ')}</Text><Text>Endpoint {end.endpoint?.local_id ?? 'unknown'} · body {end.endpoint?.body_revision_id ?? 'unknown'} · pinout {end.endpoint?.pinout_revision_id ?? 'unknown'}</Text>{end.endpoint && <><Text>Body orientation: {end.endpoint.body.drawing_orientation.viewing_side}; rotation {end.endpoint.body.drawing_orientation.rotation_degrees ?? 'unknown'}; datum {end.endpoint.body.drawing_orientation.datum ?? 'unknown'}</Text><Text>Pinout orientation: {end.endpoint.pinout.orientation.viewing_side}; rotation {end.endpoint.pinout.orientation.rotation_degrees ?? 'unknown'}; datum {end.endpoint.pinout.orientation.datum ?? 'unknown'}</Text></>}<Text>Profile end {end.review}: {end.review_basis ?? 'unknown'}</Text>{end.instructions.map(row => <Card withBorder key={row.instruction.local_id}><InstructionInspection instruction={row.instruction} /><Text>{row.status}; unresolved: {row.unresolved.join(', ') || 'none declared'}; bond created: {String(row.bond_created)}</Text></Card>)}{end.missing_instructions.map(row => <Text key={`${row.element_path}:${row.kind}`}>{row.element_path} · {row.kind}: unknown</Text>)}</Stack></Card>)}
    <Text>Actual bonds: {result.actual_bonds}; measured preparation: {result.measured_preparation}; physical qualification: {result.physical_qualification}. Electrical continuity is not inferred.</Text>
  </Stack>;
}
