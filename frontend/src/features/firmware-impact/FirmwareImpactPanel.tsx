import { Alert, Button, Card, Checkbox, Group, NativeSelect, Stack, Table, Text, Title } from '@mantine/core';
import { useEffect, useRef, useState } from 'react';
import { targetLabel, valueLabel, type Facts, type Subject } from '../facts/api';
import type { FirmwareSummary } from '../firmware/api';
import { operation, type OccurrenceInspection } from '../firmware-occurrences/api';
import { read, type Definition, type Identity } from '../identity/api';
import { compareImpact, type FirmwareReference, type ImpactResult } from './api';

export function FirmwareImpactPanel({ projectId }: { projectId: string }) {
  return <Workspace key={projectId} projectId={projectId} />;
}

function Workspace({ projectId }: { projectId: string }) {
  const generation = useRef(0);
  const [opened, setOpened] = useState(false);
  const [firmware, setFirmware] = useState<FirmwareSummary[]>([]);
  const [assemblies, setAssemblies] = useState<Definition[]>([]);
  const [baseline, setBaseline] = useState('');
  const [candidate, setCandidate] = useState('');
  const [baselineContext, setBaselineContext] = useState<Partial<FirmwareReference>>({});
  const [candidateContext, setCandidateContext] = useState<Partial<FirmwareReference>>({});
  const [assertions, setAssertions] = useState<string[]>([]);
  const [result, setResult] = useState<ImpactResult | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [pickerKey, setPickerKey] = useState(0);
  function clear() { generation.current++; setResult(null); setError(''); setBusy(false); }
  function deny(message: string) {
    clear(); setFirmware([]); setAssemblies([]); setBaseline(''); setCandidate('');
    setBaselineContext({}); setCandidateContext({}); setAssertions([]); setPickerKey(key => key + 1); setError(message);
  }
  async function refresh() {
    const token = ++generation.current;
    setResult(null); setFirmware([]); setAssemblies([]); setError(''); setBusy(true);
    setBaseline(''); setCandidate(''); setBaselineContext({}); setCandidateContext({}); setAssertions([]);
    setPickerKey(key => key + 1);
    try {
      const [records, definitions] = await Promise.all([
        read<{ firmware: FirmwareSummary[] }>(`pcb/projects/${projectId}/firmware`),
        read<Definition[]>(`projects/${projectId}/definitions`),
      ]);
      if (token === generation.current) { setFirmware(records.firmware); setAssemblies(definitions.filter(item => item.kind === 'assembly')); }
    } catch (failure) { if (token === generation.current) setError((failure as Error).message); }
    finally { if (token === generation.current) setBusy(false); }
  }
  useEffect(() => {
    if (!opened) return;
    void refresh();
    const focus = () => { void refresh(); };
    window.addEventListener('focus', focus);
    return () => { generation.current++; window.removeEventListener('focus', focus); };
  }, [opened]);
  const options = [{ value: '', label: 'Select a frozen firmware revision' }, ...firmware.flatMap(item => item.revisions.map(revision => ({ value: revision.revision_id, label: `${item.name} · revision ${revision.number}` })))];
  async function inspect(observationOffset = 0) {
    const token = ++generation.current;
    setResult(null); setError(''); setBusy(true);
    try {
      const value = await compareImpact({ project_id: projectId,
        baseline: { firmware_revision_id: baseline, ...baselineContext },
        candidate: { firmware_revision_id: candidate, ...candidateContext }, assertion_ids: assertions, observation_offset: observationOffset });
      if (token === generation.current) setResult(value);
    } catch (failure) { if (token === generation.current) deny((failure as Error).message); }
    finally { if (token === generation.current) setBusy(false); }
  }
  return <Card withBorder><Stack>
    <Title order={3}>Firmware change and observation review</Title>
    <Text>Compare exact frozen hardware, sources, configuration and pin assumptions. Historical observations remain attached to their original subjects; changes require deliberate review.</Text>
    <Button onClick={() => { clear(); setOpened(!opened); }}>{opened ? 'Hide firmware impact' : 'Show firmware impact'}</Button>
    {opened && <>
      <Button disabled={busy} onClick={() => { void refresh(); }}>Refresh authorized impact inputs</Button>
      {error && <Alert color="red">{error}</Alert>}
      <NativeSelect label="Baseline firmware revision" value={baseline} data={options} onChange={event => { clear(); setBaseline(event.currentTarget.value); setBaselineContext({}); }} />
      <NativeSelect label="Candidate firmware revision" value={candidate} data={options} onChange={event => { clear(); setCandidate(event.currentTarget.value); setCandidateContext({}); }} />
      {baseline && <ContextSelector key={`baseline:${pickerKey}:${baseline}`} label="Baseline" firmwareId={baseline} assemblies={assemblies} onDenied={deny} onChange={context => { clear(); setBaselineContext(context); }} />}
      {candidate && <ContextSelector key={`candidate:${pickerKey}:${candidate}`} label="Candidate" firmwareId={candidate} assemblies={assemblies} onDenied={deny} onChange={context => { clear(); setCandidateContext(context); }} />}
      <EvidenceSelector key={pickerKey} projectId={projectId} onChange={ids => { clear(); setAssertions(ids); }} onDenied={deny} />
      <Button disabled={busy || !baseline || !candidate} onClick={() => { void inspect(); }}>Compare firmware impact</Button>
      {result && <>
        <ImpactReview result={result} />
        <Group><Button disabled={busy || result.observation_offset === 0} onClick={() => { void inspect(Math.max(0, result.observation_offset - 100)); }}>Previous impact observations</Button><Button disabled={busy || !result.observations_has_more} onClick={() => { void inspect(result.observation_offset + 100); }}>Next impact observations</Button></Group>
      </>}
    </>}
  </Stack></Card>;
}

function ContextSelector({ label, firmwareId, assemblies, onChange, onDenied }: { label: string; firmwareId: string; assemblies: Definition[]; onDenied: (message: string) => void; onChange: (context: Partial<FirmwareReference>) => void }) {
  const generation = useRef(0);
  const [definition, setDefinition] = useState('');
  const [identity, setIdentity] = useState<Identity | null>(null);
  const [offset, setOffset] = useState(0);
  const [revision, setRevision] = useState('');
  const [inspection, setInspection] = useState<OccurrenceInspection | null>(null);
  const [path, setPath] = useState('');
  const [error, setError] = useState('');
  useEffect(() => {
    const token = ++generation.current;
    setIdentity(null); setInspection(null); setRevision(''); setPath(''); setError('');
    if (definition) read<Identity>(`catalog/definitions/${definition}?offset=${offset}`)
      .then(value => { if (token === generation.current) setIdentity(value); })
      .catch((failure: Error) => { if (token === generation.current) { setError(failure.message); onDenied(failure.message); } });
    return () => { generation.current++; };
  }, [definition, offset]);
  async function choose(value: string) {
    const token = ++generation.current;
    setRevision(value); setInspection(null); setPath(''); setError(''); onChange({});
    if (!value) return;
    try {
      const frozen = await read<{ snapshot_id: string }>(`revisions/${value}`);
      if (token !== generation.current) return;
      const data = await operation<OccurrenceInspection>('firmware_occurrence.inspect', { snapshot_id: frozen.snapshot_id });
      if (token === generation.current) setInspection(data);
    } catch (failure) { if (token === generation.current) { setError((failure as Error).message); onDenied((failure as Error).message); } }
  }
  return <Stack>
    <NativeSelect label={`${label} assembly context (optional)`} value={definition} data={[{ value: '', label: 'No contextual occurrence selected' }, ...assemblies.map(item => ({ value: item.definition_id, label: item.name }))]} onChange={event => { onChange({}); setDefinition(event.currentTarget.value); setOffset(0); }} />
    {identity && <>
      <NativeSelect label={`${label} frozen assembly revision`} value={revision} data={[{ value: '', label: 'Select frozen assembly' }, ...identity.revisions.map(item => ({ value: item.revision_id, label: `Frozen revision ${item.number}` }))]} onChange={event => { void choose(event.currentTarget.value); }} />
      <Group><Button disabled={!offset} onClick={() => { onChange({}); setOffset(Math.max(0, offset - 50)); }}>Previous {label.toLowerCase()} assembly revisions</Button><Button disabled={identity.revisions.length < 50} onClick={() => { onChange({}); setOffset(offset + 50); }}>Next {label.toLowerCase()} assembly revisions</Button></Group>
    </>}
    {inspection && <NativeSelect label={`${label} exact board occurrence`} value={path} data={[{ value: '', label: 'Select occurrence or compare without context' }, ...inspection.occurrences.filter(item => item.kind === 'pcb_population' && item.firmware_revision_id === firmwareId).map(item => ({ value: JSON.stringify(item.path), label: `${item.path.join('/')} · ${item.display_ref || item.name}` }))]} onChange={event => { const value = event.currentTarget.value; setPath(value); onChange(value ? { assembly_snapshot_id: inspection.snapshot_id!, path: JSON.parse(value) as string[] } : {}); }} />}
    {error && <Alert color="red">{error}</Alert>}
  </Stack>;
}

function EvidenceSelector({ projectId, onChange, onDenied }: { projectId: string; onChange: (ids: string[]) => void; onDenied: (message: string) => void }) {
  const subjectGeneration = useRef(0);
  const factGeneration = useRef(0);
  const [opened, setOpened] = useState(false);
  const [subjects, setSubjects] = useState<Subject[]>([]);
  const [subjectOffset, setSubjectOffset] = useState(0);
  const [subject, setSubject] = useState('');
  const [facts, setFacts] = useState<Facts | null>(null);
  const [factOffset, setFactOffset] = useState(0);
  const [selected, setSelected] = useState<string[]>([]);
  useEffect(() => {
    const token = ++subjectGeneration.current;
    setSubjects([]); setFacts(null);
    if (opened) read<Subject[]>(`facts/projects/${projectId}/subjects?offset=${subjectOffset}`)
      .then(value => { if (token === subjectGeneration.current) setSubjects(value); })
      .catch((failure: Error) => { if (token === subjectGeneration.current) { setSubjects([]); setFacts(null); onDenied(failure.message); } });
    return () => { subjectGeneration.current++; };
  }, [opened, subjectOffset]);
  useEffect(() => {
    const token = ++factGeneration.current; setFacts(null);
    if (subject) read<Facts>(`facts/subjects/${subject}?offset=${factOffset}`)
      .then(value => { if (token === factGeneration.current) setFacts(value); })
      .catch((failure: Error) => { if (token === factGeneration.current) { setFacts(null); onDenied(failure.message); } });
    return () => { factGeneration.current++; };
  }, [subject, factOffset]);
  return <Stack>
    <Text>Existing observations on exact baseline revisions, the selected occurrence, and physical units with those design pins are included automatically. Optionally inspect another subject and deliberately include its assertions.</Text>
    <Button onClick={() => { setOpened(!opened); setSelected([]); setSubject(''); onChange([]); }}>Choose additional historical observations</Button>
    {opened && <>
      <NativeSelect label="Historical observation subject" value={subject} data={[{ value: '', label: 'Select actual observation subject' }, ...subjects.map(item => ({ value: item.subject_id, label: targetLabel(item.target, item.physical_unit_serial) }))]} onChange={event => { setSubject(event.currentTarget.value); setFactOffset(0); setSelected([]); onChange([]); }} />
      <Group><Button disabled={!subjectOffset} onClick={() => { setSubject(''); setSelected([]); onChange([]); setSubjectOffset(Math.max(0, subjectOffset - 50)); }}>Previous observation subjects</Button><Button disabled={subjects.length < 50} onClick={() => { setSubject(''); setSelected([]); onChange([]); setSubjectOffset(subjectOffset + 50); }}>Next observation subjects</Button></Group>
      {facts && <>
        {facts.assertions.map(assertion => <Checkbox key={assertion.assertion_id} label={`${assertion.fact.property} · ${assertion.fact.status} · ${valueLabel(assertion.fact.value)} · ${assertion.fact.provenance.method}`} checked={selected.includes(assertion.assertion_id)} disabled={selected.length >= 100 && !selected.includes(assertion.assertion_id)} onChange={event => { const ids = event.currentTarget.checked ? [...selected, assertion.assertion_id] : selected.filter(id => id !== assertion.assertion_id); setSelected(ids); onChange(ids); }} />)}
        <Group><Button disabled={!factOffset} onClick={() => setFactOffset(Math.max(0, factOffset - 50))}>Previous subject assertions</Button><Button disabled={!facts.has_more} onClick={() => setFactOffset(factOffset + 50)}>Next subject assertions</Button></Group>
      </>}
    </>}
  </Stack>;
}

function ImpactReview({ result }: { result: ImpactResult }) {
  return <Stack>
    <Title order={4}>Exact change assessment</Title>
    <Text>Hardware compatibility: not evaluated. Compiler receipts are build evidence and are not assessed here. Flashing: not performed. Device operation: not observed. Physical qualification: none.</Text>
    <Text>Comparison hash: {result.comparison_sha256}</Text>
    {(['baseline', 'candidate'] as const).map(side => <Card key={side} withBorder><Stack>
      <Text fw={600}>{side === 'baseline' ? 'Baseline exact pins' : 'Candidate exact pins'}</Text>
      <Text>Firmware {result[side].inputs.firmware_revision_id} · snapshot {result[side].inputs.firmware_snapshot_sha256}</Text>
      <Text>Population {result[side].inputs.target.population_revision_id} · option {result[side].inputs.target.option_id} · native component {result[side].inputs.target.component_id}</Text>
      <Text>Native interpretation {result[side].evaluation.target.interpretation_id} · {result[side].evaluation.target.interpretation_sha256}</Text>
      <details><summary>Declared assumption evaluation: {result[side].evaluation.readiness}</summary>
        <Table><Table.Thead><Table.Tr><Table.Th>Assumption</Table.Th><Table.Th>Status</Table.Th><Table.Th>Reason</Table.Th></Table.Tr></Table.Thead><Table.Tbody>
          {result[side].evaluation.findings.map((finding, index) => <Table.Tr key={index}><Table.Td>{finding.subject.signal || finding.subject.key || finding.code}</Table.Td><Table.Td>{finding.status}</Table.Td><Table.Td>{finding.message}</Table.Td></Table.Tr>)}
        </Table.Tbody></Table>
      </details>
      {result[side].inputs.occurrence && <Text>Assembly {result[side].inputs.occurrence.assembly_snapshot_id} · {result[side].inputs.occurrence.assembly_snapshot_sha256} · {result[side].inputs.occurrence.path.join('/')}</Text>}
      {result[side].inputs.sources.map(source => <Text key={source.local_id}>Source {source.local_id} · {source.source_revision_id} · manifest {source.source_manifest_sha256} · {source.files.map(file => `${file.path} (${file.rights}, ${file.sha256})`).join('; ')}</Text>)}
    </Stack></Card>)}
    <Table><Table.Thead><Table.Tr><Table.Th>Assumption</Table.Th><Table.Th>Change</Table.Th><Table.Th>Baseline</Table.Th><Table.Th>Candidate</Table.Th><Table.Th>Review reason</Table.Th></Table.Tr></Table.Thead><Table.Tbody>
      {result.findings.map(finding => <Table.Tr key={finding.key}><Table.Td>{finding.key}</Table.Td><Table.Td>{finding.status}</Table.Td><Table.Td>{JSON.stringify(finding.baseline)}</Table.Td><Table.Td>{JSON.stringify(finding.candidate)}</Table.Td><Table.Td>{finding.reason}</Table.Td></Table.Tr>)}
    </Table.Tbody></Table>
    <Title order={4}>Historical observation applicability</Title>
    <Text>{result.observations_total} historical assertions in the declared scope. Observations remain immutable; no candidate result is created.</Text>
    {result.observations_truncated && <Alert color="yellow">This page shows up to 100 assertions from position {result.observation_offset + 1}. Review additional pages; all historical results remain preserved.</Alert>}
    {result.observations.map(row => <Card key={row.assertion.assertion_id} withBorder><Stack>
      <Text>{targetLabel(row.subject.target, row.subject.physical_unit_serial)} · {row.assertion.fact.property}</Text>
      <Text>{row.assertion.fact.status} · {valueLabel(row.assertion.fact.value)} · {row.assertion.fact.provenance.method} · {row.assertion.recorded_at}</Text>
      <Text>Assertion {row.assertion.assertion_id} · original subject {row.assertion.subject_id}</Text>
      <Text>{row.applicability} · {row.reason}</Text>
      <Text>Conditions: {row.assertion.fact.conditions.map(condition => `${condition.property}: ${condition.status} ${valueLabel(condition.value)}`).join('; ') || 'None recorded'}</Text>
      <Text>Observation basis: {row.assertion.fact.basis}</Text>
      <Text>Observed at: {row.assertion.fact.provenance.observed_at || 'Not recorded'} · Instrument: {row.assertion.fact.provenance.instrument || 'Not recorded'} · Procedure: {row.assertion.fact.provenance.procedure || 'Not recorded'}</Text>
      <Table><Table.Thead><Table.Tr><Table.Th>Historical evidence kind</Table.Th><Table.Th>Exact retained reference</Table.Th></Table.Tr></Table.Thead><Table.Tbody>
        {row.assertion.fact.provenance.evidence.map((evidence, index) => <Table.Tr key={index}><Table.Td>{evidence.kind}</Table.Td><Table.Td>{evidence.kind === 'citation' ? evidence.citation : evidence.kind === 'assertion' ? evidence.assertion_id : `${evidence.bundle_revision_id} · ${evidence.path} · ${evidence.locator || 'No locator'}`}</Table.Td></Table.Tr>)}
      </Table.Tbody></Table>
      <Text>Review assumptions: {row.review_keys.join(', ') || 'No changed recorded assumptions'}</Text>
    </Stack></Card>)}
  </Stack>;
}
