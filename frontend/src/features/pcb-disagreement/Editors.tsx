import { Alert, Button, Card, Group, Select, Stack, Table, Text, TextInput, Title } from '@mantine/core';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { RevisionPicker } from '../harnesses/RevisionPicker';
import { getIntake, listIntakes } from '../pcb/api';
import { blankInput, blankSource, isUuid, label, read, terminalLabel, type Assertion, type Comparison, type Definition, type FilePin, type Frozen, type Input, type NativeAccepted, type NativeAttempts, type Projection, type SourceFiles, type Terminal } from './api';
import { RevisionLabel } from "../../lib/IdentityLabel";

export function SourcePicker({ value, onChange, onDenied }: { value: FilePin; onChange: (v: FilePin) => void; onDenied: (v: boolean) => void }) {
  const files = useQuery({ queryKey: ['pcb-review-source', value.source_revision_id], queryFn: () => read<SourceFiles>(`pcb-disagreement/sources/${value.source_revision_id}`), enabled: isUuid(value.source_revision_id) });
  useEffect(() => onDenied(files.isError), [files.isError, onDenied]);
  return <Stack><TextInput label="Preserved source revision ID" value={value.source_revision_id} onChange={e => onChange({ ...blankSource(), source_revision_id: e.currentTarget.value })} description="Preserve originals in PCB intake first, then select the exact file." />
    {files.isError && <Alert color="red">{files.error.message}</Alert>}
    <Select label="Preserved source file" searchable disabled={files.isError} value={files.isError ? null : value.path || null} data={files.isError ? [] : (files.data?.files ?? []).map(f => f.path)} onChange={path => { const file = files.data?.files.find(f => f.path === path); if (file) onChange(file); }} />
    {!files.isError && value.path && <Text size="sm">SHA-256: {value.sha256} · Rights: {value.rights}</Text>}
  </Stack>;
}
export function AssertionEditor({ value, onChange, onDenied }: { value: Assertion; onChange: (v: Assertion) => void; onDenied: (v: boolean) => void }) {
  const [denied, setDenied] = useState(false);
  const [id, setId] = useState(''); const [reference, setReference] = useState(''); const [pin, setPin] = useState('');
  const [state, setState] = useState<Terminal['net_state']>('unknown'); const [net, setNet] = useState(''); const [basis, setBasis] = useState('');
  const [nativeComponent, setNativeComponent] = useState(''); const [nativeTerminal, setNativeTerminal] = useState('');
  useEffect(() => onDenied(denied), [denied, onDenied]);
  return <Stack><Text>Human assertions are independently recorded statements about preserved bytes. They are not native extraction or automatic schematic parity. Entered native IDs remain human assertions.</Text>
    <SourcePicker value={value.source} onChange={source => onChange({ ...value, source })} onDenied={setDenied} />
    {!denied && <><Select label="Asserted source role" data={['pcb', 'schematic', 'netlist']} value={value.source_role} onChange={v => onChange({ ...value, source_role: v as Assertion['source_role'] })} />
    <Select label="Asserted coverage" value={value.coverage} data={[{ value: 'partial', label: 'Partial / unknown completeness' }, { value: 'declared_complete', label: 'Human declares complete terminal inventory' }]} onChange={v => onChange({ ...value, coverage: v as Assertion['coverage'] })} />
    <TextInput label="Coverage declaration basis" value={value.coverage_basis} onChange={e => onChange({ ...value, coverage_basis: e.currentTarget.value })} />
    <Title order={4}>Asserted terminals</Title>{value.terminals.map((t, i) => <Group key={t.local_id}><Text>{terminalLabel(t)} · {label(t.net_state)} · {t.net_name ?? 'no net name'} · {t.basis}</Text><Button variant="subtle" onClick={() => onChange({ ...value, terminals: value.terminals.filter((_, j) => j !== i) })}>Remove terminal {t.local_id}</Button></Group>)}
      <Group><TextInput label="Assertion terminal ID" value={id} onChange={e => setId(e.currentTarget.value)} /><TextInput label="Component reference label" value={reference} onChange={e => setReference(e.currentTarget.value)} /><TextInput label="Pin label" value={pin} onChange={e => setPin(e.currentTarget.value)} /></Group>
      <Group><TextInput label="Asserted native component ID (optional)" value={nativeComponent} onChange={e => setNativeComponent(e.currentTarget.value)} /><TextInput label="Asserted native terminal ID (optional)" value={nativeTerminal} onChange={e => setNativeTerminal(e.currentTarget.value)} /></Group>
      <Select label="Net assertion state" value={state} data={['assigned', 'unconnected', 'unknown']} onChange={v => setState(v as Terminal['net_state'])} />{state === 'assigned' && <TextInput label="Asserted net name" value={net} onChange={e => setNet(e.currentTarget.value)} />}
      <TextInput label="Terminal assertion basis" value={basis} onChange={e => setBasis(e.currentTarget.value)} />
      <Button disabled={!id || !reference || !pin || !basis || state === 'assigned' && !net || value.terminals.some(t => t.local_id === id)} onClick={() => { onChange({ ...value, terminals: [...value.terminals, { local_id: id, component_ref: reference, pin, native_component_id: nativeComponent || null, native_terminal_id: nativeTerminal || null, net_state: state, net_name: state === 'assigned' ? net : null, basis }] }); setId(''); }}>Add asserted terminal</Button>
    </>}
  </Stack>;
}
function InputPicker({ side, projectId, value, onChange, definitions, onDenied }: { side: string; projectId: string; value: Input; onChange: (v: Input) => void; definitions: Definition[]; onDenied: (v: boolean) => void }) {
  const [intakeId, setIntakeId] = useState<string | null>(null);
  const intakes = useQuery({ queryKey: ['pcb-review-intakes', projectId], queryFn: () => listIntakes(projectId), enabled: value.kind === 'pcb_interpretation' });
  const intake = useQuery({ queryKey: ['pcb-review-intake', intakeId], queryFn: () => getIntake(intakeId!), enabled: !!intakeId && value.kind === 'pcb_interpretation' });
  const natives = useQuery({ queryKey: ['pcb-native-attempts', projectId], queryFn: () => read<NativeAttempts>(`pcb-disagreement/native?project_id=${projectId}`), enabled: value.kind === 'source_net_interpretation' });
  const nativeId = value.kind === 'source_net_interpretation' ? value.interpretation_id : '';
  const native = useQuery({ queryKey: ['pcb-native-interpretation', nativeId], queryFn: () => read<NativeAccepted>(`pcb-disagreement/native/${nativeId}`), enabled: isUuid(nativeId) });
  const rid = value.kind === 'assertion_revision' ? value.revision_id : '';
  const assertion = useQuery({ queryKey: ['pcb-review-input', rid], queryFn: () => read<Frozen>(`pcb-disagreement/revisions/${rid}`), enabled: isUuid(rid) });
  const denied = value.kind === 'assertion_revision' ? assertion.isError : value.kind === 'source_net_interpretation' ? natives.isError || native.isError : intakes.isError || intake.isError;
  useEffect(() => onDenied(denied), [denied, onDenied]);
  return <Card withBorder><Stack><Title order={4}>{side} source input</Title><Select label={`${side} input method`} value={value.kind} data={[{ value: 'assertion_revision', label: 'Frozen human assertion' }, { value: 'pcb_interpretation', label: 'Accepted native board report' }, { value: 'source_net_interpretation', label: 'Accepted schematic / netlist extraction' }]} onChange={v => onChange(v === 'assertion_revision' ? blankInput() : { kind: v as 'pcb_interpretation' | 'source_net_interpretation', interpretation_id: '', report_sha256: '', source: blankSource() })} />
    {value.kind === 'assertion_revision' ? <><RevisionPicker label={`${side} assertion`} kind="pcb_assertion" value={value.revision_id} definitions={definitions} onChange={revision_id => onChange({ kind: 'assertion_revision', revision_id, snapshot_sha256: '' })} />
      {assertion.isError && <Alert color="red">{assertion.error.message}</Alert>}
      {assertion.data && !assertion.isError && <><Text>Exact assertion snapshot: {assertion.data.sha256}</Text><Button disabled={!assertion.data.projection.assertion} onClick={() => onChange({ ...value, snapshot_sha256: assertion.data!.sha256 })}>Pin {side.toLowerCase()} assertion snapshot</Button></>}
    </> : value.kind === 'source_net_interpretation' ? <>{natives.isError && <Alert color="red">{natives.error.message}</Alert>}{native.isError && <Alert color="red">{native.error.message}</Alert>}
      <Select label={`${side} accepted schematic or netlist`} value={denied ? null : value.interpretation_id || null} disabled={denied} data={denied ? [] : (natives.data?.attempts ?? []).filter(a => a.interpretation).map(a => ({ value: a.interpretation!.interpretation_id, label: `${a.source.path} · ${a.source_role} · ${a.interpretation!.interpretation_id}` }))} onChange={id => { const attempt = natives.data?.attempts.find(a => a.interpretation?.interpretation_id === id); if (attempt?.interpretation) onChange({ kind: 'source_net_interpretation', ...attempt.interpretation, source: attempt.source }); }} />
      {!denied && native.data && <Text>{label(native.data.report.method)} · exact XML {native.data.report.xml_sha256}</Text>}
    </> : <>{intakes.isError && <Alert color="red">{intakes.error.message}</Alert>}{intake.isError && <Alert color="red">{intake.error.message}</Alert>}
      <Select label={`${side} board intake`} value={denied ? null : intakeId} disabled={denied} data={intakes.isError ? [] : (intakes.data ?? []).map(i => ({ value: i.intake_id, label: `${i.board_path || 'Unselected board'} · ${i.intake_id}` }))} onChange={setIntakeId} />
      <Select label={`${side} accepted board report`} value={denied ? null : value.interpretation_id || null} disabled={denied} data={denied ? [] : (intake.data?.interpretations ?? []).map(i => ({ value: i.interpretation_id, label: `${i.interpretation_id} · ${i.sha256}` }))} onChange={id => { const data = intake.data; const report = data?.interpretations.find(i => i.interpretation_id === id); const file = data?.files.find(f => f.path === data.board_path); if (data && report && file) onChange({ kind: 'pcb_interpretation', interpretation_id: report.interpretation_id, report_sha256: report.sha256, source: { source_revision_id: data.source_revision_id, manifest_sha256: data.source_manifest_sha256, path: file.path, sha256: file.sha256, rights: file.rights } }); }} />
      {!denied && value.interpretation_id && <Text>Selected exact report: {value.interpretation_id}</Text>}
    </>}
  </Stack></Card>;
}
export function ComparisonEditor({ projectId, value, onChange, definitions, projection, sourcePinsCurrent, onDenied }: { projectId: string; value: Comparison; onChange: (v: Comparison) => void; definitions: Definition[]; projection?: Projection; sourcePinsCurrent: boolean; onDenied: (v: boolean) => void }) {
  const [leftDenied, setLeftDenied] = useState(false), [rightDenied, setRightDenied] = useState(false);
  const [id, setId] = useState(''), [basis, setBasis] = useState('');
  const [left, setLeft] = useState<string | null>(null), [right, setRight] = useState<string | null>(null);
  const denied = leftDenied || rightDenied;
  useEffect(() => onDenied(denied), [denied, onDenied]);
  const inputs = !denied && sourcePinsCurrent ? projection?.inputs : undefined;
  return <Stack><Text>Save independent input pins first, then record exact terminal correspondence. Reference labels are display aids; duplicate labels do not identify the same terminal.</Text>
    <InputPicker side="Left" projectId={projectId} value={value.left} onChange={v => onChange({ ...value, left: v })} definitions={definitions} onDenied={setLeftDenied} />
    <InputPicker side="Right" projectId={projectId} value={value.right} onChange={v => onChange({ ...value, right: v })} definitions={definitions} onDenied={setRightDenied} />
    {!denied && <>{value.correspondences.map((c, i) => <Group key={c.local_id}><Text>{c.local_id}: {c.left_terminal_id ?? 'Declared absent'} ↔ {c.right_terminal_id ?? 'Declared absent'} · {c.basis}</Text><Button variant="subtle" onClick={() => onChange({ ...value, correspondences: value.correspondences.filter((_, j) => j !== i) })}>Remove correspondence {c.local_id}</Button></Group>)}
      {inputs && <><TextInput label="Correspondence stable ID" value={id} onChange={e => setId(e.currentTarget.value)} /><Select clearable searchable label="Left exact terminal; blank declares absent" value={left} data={inputs.left.terminals.filter(t => !value.correspondences.some(c => c.left_terminal_id === t.local_id)).map(t => ({ value: t.local_id, label: terminalLabel(t) }))} onChange={setLeft} /><Select clearable searchable label="Right exact terminal; blank declares absent" value={right} data={inputs.right.terminals.filter(t => !value.correspondences.some(c => c.right_terminal_id === t.local_id)).map(t => ({ value: t.local_id, label: terminalLabel(t) }))} onChange={setRight} /><TextInput label="Correspondence basis" value={basis} onChange={e => setBasis(e.currentTarget.value)} /><Button disabled={!id || !basis || !left && !right || value.correspondences.some(c => c.local_id === id)} onClick={() => { onChange({ ...value, correspondences: [...value.correspondences, { local_id: id, left_terminal_id: left, right_terminal_id: right, basis }] }); setId(''); setLeft(null); setRight(null); }}>Add explicit correspondence</Button></>}
      {!!value.reviews.length && <Button variant="subtle" onClick={() => onChange({ ...value, reviews: [] })}>Clear review decisions before changing comparison</Button>}
    </>}
  </Stack>;
}
export function SourceSummary({ value }: { value: Projection['assertion'] }) {
  if (!value) return null;
  return <Stack gap="xs"><Text fw={600}>{label(value.method)} · {value.source_role}</Text><Text>{label(value.coverage)} · {value.coverage_basis}</Text><Text size="sm"><RevisionLabel kind="source" id={value.source.source_revision_id} role="Source" /> · {value.source.path}</Text><Text size="sm">Source SHA-256: {value.source.sha256} · Rights: {value.source.rights}</Text>{value.extractor && <Text size="sm">Extractor: {value.extractor.adapter} · Tool {value.extractor.tool_version} · Report SHA-256: {value.extractor.report_sha256}</Text>}{value.unsupported.map(text => <Text size="sm" key={text}>{text}</Text>)}</Stack>;
}
export function AssertionTable({ terminals }: { terminals: Terminal[] }) {
  const [page, setPage] = useState(0);
  return <Stack><Table><Table.Thead><Table.Tr><Table.Th>Exact terminal evidence</Table.Th><Table.Th>Reported net</Table.Th><Table.Th>Native identity fields</Table.Th><Table.Th>Basis</Table.Th></Table.Tr></Table.Thead><Table.Tbody>{terminals.slice(page * 50, page * 50 + 50).map(t => <Table.Tr key={t.local_id}><Table.Td>{terminalLabel(t)}</Table.Td><Table.Td>{label(t.net_state)} · {t.net_name ?? 'no net name'}</Table.Td><Table.Td>{t.native_terminal_id ?? 'unknown'} / {t.native_component_id ?? 'unknown'}{t.sheet_path && ` · Sheet ${t.sheet_path}`}{t.unit && ` · Unit ${t.unit}`}</Table.Td><Table.Td>{t.basis}</Table.Td></Table.Tr>)}</Table.Tbody></Table><Group><Button disabled={page === 0} onClick={() => setPage(page - 1)}>Previous asserted terminals</Button><Button disabled={(page + 1) * 50 >= terminals.length} onClick={() => setPage(page + 1)}>Next asserted terminals</Button></Group></Stack>;
}
