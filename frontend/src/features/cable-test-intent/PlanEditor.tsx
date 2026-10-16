import { SbStatus, SbUnknown } from '../../components/sb';
import { Alert, Button, Card, Group, Select, Stack, Table, Text, TextInput, Title } from '@mantine/core';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { ApiError } from '../workspace/api';
import { deriveFromIntent, inspectTarget, keyOf, read, terminalText, type Derivation, type Evidence, type Inspection, type Label, type Pair, type TestPlan } from './api';
import { RevisionLabel } from "../../lib/IdentityLabel";

export function PlanEditor({ value, onChange, hidden = false, refresh = 0, disabled = false, onAuthorityChange, onAccessDenied, fixedTarget = false, active = true, principalKey }: { principalKey?: string; fixedTarget?: boolean; active?: boolean; onAccessDenied?: (error: Error) => void; disabled?: boolean; value: TestPlan; onChange: (v: TestPlan) => void; hidden?: boolean; refresh?: number; onAuthorityChange?: (denied: boolean) => void }) {
  const [authorityBlocked, setAuthorityBlocked] = useState(false);
  const refreshRef = useRef({ epoch: refresh, pending: false });
  if (refreshRef.current.epoch !== refresh) refreshRef.current = { epoch: refresh, pending: true };
  const previousActive = useRef(active);
  if (previousActive.current !== active) { previousActive.current = active; if (active) refreshRef.current = { epoch: refresh, pending: true }; }
  const [first, setFirst] = useState<string | null>(null);
  const [second, setSecond] = useState<string | null>(null);
  const [pairId, setPairId] = useState('');
  const [intent, setIntent] = useState<Pair['intent']>('unknown');
  const [basis, setBasis] = useState('');
  const [pairEvidence, setPairEvidence] = useState<Evidence>({ status: 'unknown' });
  const [labelId, setLabelId] = useState('');
  const [labelText, setLabelText] = useState('');
  const [labelTarget, setLabelTarget] = useState<string | null>('cable');
  const [labelBasis, setLabelBasis] = useState('');
  const [labelEvidence, setLabelEvidence] = useState<Evidence>({ status: 'unknown' });
  const enabled = !!value.root_revision_id && !!value.cable_revision_id;
  const scopeKey = JSON.stringify([value.root_revision_id, value.cable_revision_id, value.occurrence_path]);
  const currentScope = useRef(scopeKey); currentScope.current = scopeKey;
  const explicitRefresh = useRef({ pending: false, scope: scopeKey });
  const target = useQuery({
    queryKey: ['test-plan-target', value.root_revision_id, value.cable_revision_id, value.occurrence_path, refresh, principalKey],
    enabled: enabled && active,
    queryFn: async () => {
      const manual = explicitRefresh.current;
      try {
        const result = await inspectTarget(value);
        if (currentScope.current === scopeKey) {
          if (refreshRef.current.epoch === refresh && refreshRef.current.pending) {
            refreshRef.current.pending = false;
            setAuthorityBlocked(false);
          }
          if (explicitRefresh.current === manual && manual.pending && manual.scope === scopeKey) {
            manual.pending = false;
            setAuthorityBlocked(false);
          }
        }
        return result;
      } catch (e) {
        // A revoked query remains relevant when only its observer or target input changed.
        if (e instanceof ApiError && [401, 403, 404].includes(e.status)) { setAuthorityBlocked(true); onAccessDenied?.(e); }
        throw e;
      }
    },
  });
  const denied = hidden || !active || authorityBlocked || !enabled || target.isError || target.isFetching || !target.data;
  useEffect(() => onAuthorityChange?.(denied), [denied, onAuthorityChange]);
  const choices = denied ? [] : target.data!.terminals.map(t => ({ value: keyOf(t.terminal), label: `${terminalText(t.terminal)}${t.label ? ` · ${t.label}` : ''}` }));
  const lookup = (key: string | null) => denied ? undefined : target.data!.terminals.find(t => keyOf(t.terminal) === key)?.terminal;
  const a = lookup(first); const b = lookup(second);
  const addPair = () => { if (a && b) { onChange({ ...value, pairs: [...value.pairs, { local_id: pairId, first: a, second: b, intent, basis, evidence: pairEvidence }] }); setPairId(''); } };
  const labelChoices = denied ? [] : [{ value: 'cable', label: 'Whole selected cable' }, ...target.data!.endpoints.map(e => ({ value: `end:${e.local_id}`, label: `Endpoint ${e.local_id}` })), ...choices.map(c => ({ value: `terminal:${c.value}`, label: c.label }))];
  const addLabel = () => {
    const label: Label = { local_id: labelId, text: labelText, basis: labelBasis, evidence: labelEvidence };
    if (labelTarget?.startsWith('end:')) label.endpoint_id = labelTarget.slice(4);
    if (labelTarget?.startsWith('terminal:')) label.terminal = lookup(labelTarget.slice(9));
    onChange({ ...value, labels: [...value.labels, label] }); setLabelId(''); setLabelText('');
  };
  return <Stack>
    {!fixedTarget && <><TextInput disabled={disabled} label="Exact cable revision ID" value={value.cable_revision_id} onChange={e => onChange({ ...value, cable_revision_id: e.currentTarget.value })} />
    <TextInput disabled={disabled} label="Exact scope root revision ID" description="For a standalone cable use its revision ID. For an occurrence use its frozen assembly root." value={value.root_revision_id} onChange={e => onChange({ ...value, root_revision_id: e.currentTarget.value })} />
    <TextInput disabled={disabled} label="Occurrence path" description="Stable local IDs separated by /; empty for standalone." value={value.occurrence_path.join('/')} onChange={e => onChange({ ...value, occurrence_path: e.currentTarget.value ? e.currentTarget.value.split('/') : [] })} /></>}
    <Button disabled={!enabled || disabled} loading={target.isFetching} onClick={() => { explicitRefresh.current = { pending: true, scope: scopeKey }; void target.refetch(); }}>Refresh exact target access</Button>
    {authorityBlocked && !target.isError && <Alert color="red">Target access must be explicitly rechecked before retained expectations can be shown.</Alert>}
    {target.isError && <Alert color="red">{target.error.message}</Alert>}
    {!denied && <>
      <Text size="sm">Root snapshot {target.data!.root_snapshot_id} · SHA-256 {target.data!.root_sha256}. Cable SHA-256 {target.data!.cable_sha256}.</Text>
      <ProposeFromIntent value={value} disabled={disabled} onUse={(proposal) => onChange({ ...value, pairs: proposal.pairs, labels: proposal.labels })} />
      <Title order={4}>Expected terminal pairs</Title>
      <PairTable pairs={value.pairs} />
      {value.pairs.map(p => <Button disabled={disabled} key={p.local_id} variant="subtle" onClick={() => onChange({ ...value, pairs: value.pairs.filter(row => row !== p) })}>Remove pair {p.local_id}</Button>)}
    </>}
    {!denied && <Stack>
      <TextInput disabled={disabled} label="Pair stable ID" value={pairId} onChange={e => setPairId(e.currentTarget.value)} />
      <Select disabled={disabled} label="First test terminal" searchable data={choices} value={denied ? null : first} onChange={setFirst} />
      <Select disabled={disabled} label="Second test terminal" searchable data={choices} value={denied ? null : second} onChange={setSecond} />
      <Select disabled={disabled} label="Pair expected intent" data={['unknown', 'continuity', 'isolation']} value={intent} onChange={v => setIntent(v as Pair['intent'])} />
      <TextInput disabled={disabled} label="Pair declaration basis" value={basis} onChange={e => setBasis(e.currentTarget.value)} />
      <EvidenceEditor disabled={disabled} prefix="Pair" value={pairEvidence} onChange={setPairEvidence} />
      <Button disabled={disabled || denied || !pairId || !a || !b || first === second || !basis.trim()} onClick={addPair}>Add expected pair</Button>
      <Title order={4}>Labels</Title>
      <LabelTable labels={value.labels} />
      {value.labels.map(l => <Button disabled={disabled} key={l.local_id} variant="subtle" onClick={() => onChange({ ...value, labels: value.labels.filter(row => row !== l) })}>Remove label {l.local_id}</Button>)}
      <TextInput disabled={disabled} label="Label stable ID" value={labelId} onChange={e => setLabelId(e.currentTarget.value)} />
      <TextInput disabled={disabled} label="Label text" value={labelText} onChange={e => setLabelText(e.currentTarget.value)} />
      <Select disabled={disabled} label="Label target" searchable data={labelChoices} value={denied ? null : labelTarget} onChange={setLabelTarget} />
      <TextInput disabled={disabled} label="Label declaration basis" value={labelBasis} onChange={e => setLabelBasis(e.currentTarget.value)} />
      <EvidenceEditor disabled={disabled} prefix="Label" value={labelEvidence} onChange={setLabelEvidence} />
      <Button disabled={disabled || denied || !labelId || !labelText.trim() || !labelBasis.trim() || !labelChoices.some(c => c.value === labelTarget)} onClick={addLabel}>Add cable label</Button>
    </Stack>}
  </Stack>;
}

function EvidenceEditor({ prefix, value, onChange, disabled = false }: { disabled?: boolean; prefix: string; value: Evidence; onChange: (v: Evidence) => void }) {
  return <Stack gap="xs"><Select disabled={disabled} label={`${prefix} evidence status`} data={['unknown', 'unverified_citation', 'registered_file']} value={value.status} onChange={status => onChange({ status: status as Evidence['status'] })} />
    {value.status === 'unverified_citation' && <TextInput disabled={disabled} label={`${prefix} unverified citation`} value={value.citation ?? ''} onChange={e => onChange({ ...value, citation: e.currentTarget.value })} />}
    {value.status === 'registered_file' && <><TextInput disabled={disabled} label={`${prefix} source bundle revision ID`} value={value.source_bundle_revision_id ?? ''} onChange={e => onChange({ ...value, source_bundle_revision_id: e.currentTarget.value })} /><TextInput disabled={disabled} label={`${prefix} exact source path`} value={value.source_path ?? ''} onChange={e => onChange({ ...value, source_path: e.currentTarget.value })} /></>}
  </Stack>;
}
const resistanceText = (p: Pair) => p.expected_resistance_ohm != null ? `${p.expected_resistance_ohm} Ω` : p.intent === 'continuity' ? 'none stated' : '';
function PairTable({ pairs }: { pairs: Pair[] }) {
  return <Table><Table.Thead><Table.Tr><Table.Th>Pair</Table.Th><Table.Th>Exact first terminal</Table.Th><Table.Th>Exact second terminal</Table.Th><Table.Th>Expected intent</Table.Th><Table.Th>Signal</Table.Th><Table.Th>Series resistance</Table.Th><Table.Th>Basis</Table.Th></Table.Tr></Table.Thead><Table.Tbody>{pairs.map(p => <Table.Tr key={p.local_id}><Table.Td>{p.local_id}</Table.Td><Table.Td>{terminalText(p.first)}</Table.Td><Table.Td>{terminalText(p.second)}</Table.Td><Table.Td><SbStatus led={p.intent === 'unknown' ? 'unknown' : 'info'} dimension="expect" value={p.intent} /></Table.Td><Table.Td>{p.signal ?? ''}</Table.Td><Table.Td>{resistanceText(p)}</Table.Td><Table.Td>{p.basis}</Table.Td></Table.Tr>)}</Table.Tbody></Table>;
}

/**
 * Propose pairs and labels from the cable's pinned intent. The proposal replaces the
 * editor's unsaved pairs and labels only when chosen; saving and freezing stay separate.
 */
function ProposeFromIntent({ value, disabled, onUse }: { value: TestPlan; disabled: boolean; onUse: (plan: TestPlan) => void }) {
  const [proposal, setProposal] = useState<Derivation | null>(null);
  const derive = useMutation({ mutationFn: () => deriveFromIntent(value), onSuccess: setProposal });
  const current = proposal && proposal.test_plan.cable_revision_id === value.cable_revision_id && proposal.test_plan.root_revision_id === value.root_revision_id ? proposal : null;
  return <Card withBorder padding="sm"><Stack gap="xs">
    <Group justify="space-between"><Title order={4}>Propose from cable intent</Title>
      <Button size="compact-sm" variant="default" disabled={disabled} loading={derive.isPending} onClick={() => derive.mutate()}>Propose expectations</Button></Group>
    <Text size="sm" c="dimmed">Continuity per intent row through the declared paths, isolation between signals and for must-not-connect pins. Nothing is saved until you save the draft.</Text>
    {derive.isError && <Alert color="red">{derive.error.message}</Alert>}
    {current && <>
      <Text size="sm">From {current.intent_name} r{current.intent_number}: {current.counts.continuity} continuity · {current.counts.isolation} isolation · {current.counts.unknown} unknown{current.limited ? ' · pair limit reached' : ''}</Text>
      <Table aria-label="Proposal by intent row"><Table.Thead><Table.Tr><Table.Th>Row</Table.Th><Table.Th>Signal</Table.Th><Table.Th>Pairs</Table.Th><Table.Th>Not proposed because</Table.Th></Table.Tr></Table.Thead>
        <Table.Tbody>{current.rows.map(row => <Table.Tr key={row.row_id}><Table.Td>{row.row_id}{row.requirement === 'must_not_connect' ? ' · must not connect' : row.requirement === 'optional' ? ' · optional' : ''}</Table.Td><Table.Td>{row.signal ?? <SbUnknown what="signal" />}</Table.Td><Table.Td>{row.pairs.length ? row.pairs.join(', ') : <SbStatus led="not-evaluated" dimension="pairs" value="none proposed" />}</Table.Td><Table.Td>{row.reasons.join(' ')}</Table.Td></Table.Tr>)}</Table.Tbody></Table>
      <Group><Button size="compact-sm" disabled={disabled} onClick={() => onUse(current.test_plan)}>Use proposed pairs and labels</Button><Text size="xs" c="dimmed">Replaces the unsaved pairs and labels in this editor.</Text></Group>
    </>}
  </Stack></Card>;
}
function LabelTable({ labels }: { labels: Label[] }) {
  return <Table><Table.Thead><Table.Tr><Table.Th>Label</Table.Th><Table.Th>Text</Table.Th><Table.Th>Target</Table.Th><Table.Th>Basis</Table.Th></Table.Tr></Table.Thead><Table.Tbody>{labels.map(l => <Table.Tr key={l.local_id}><Table.Td>{l.local_id}</Table.Td><Table.Td>{l.text}</Table.Td><Table.Td>{l.terminal ? terminalText(l.terminal) : l.endpoint_id ?? 'whole cable'}</Table.Td><Table.Td>{l.basis}</Table.Td></Table.Tr>)}</Table.Tbody></Table>;
}
export function PlanInspector({ revisionId, hidden = false, refresh = 0, onAccessDenied, active = true }: { active?: boolean; onAccessDenied?: (error: Error) => void; revisionId: string; hidden?: boolean; refresh?: number }) {
  const [blocked, setBlocked] = useState(false);
  const refreshRef = useRef({ epoch: refresh, pending: false });
  if (refreshRef.current.epoch !== refresh) refreshRef.current = { epoch: refresh, pending: true };
  const previousActive = useRef(active);
  if (previousActive.current !== active) { previousActive.current = active; if (active) refreshRef.current = { epoch: refresh, pending: true }; }
  const explicitRefresh = useRef({ pending: false });
  const query = useQuery({
    queryKey: ['test-plan-inspection', revisionId, refresh], enabled: active,
    queryFn: async () => {
      const manual = explicitRefresh.current;
      try {
        const data = await read<Inspection>(`cable-test-intent/revisions/${revisionId}`);
        if (refreshRef.current.epoch === refresh && refreshRef.current.pending) {
          refreshRef.current.pending = false;
          setBlocked(false);
        }
        if (explicitRefresh.current === manual && manual.pending) {
          manual.pending = false;
          setBlocked(false);
        }
        return data;
      } catch (e) {
        if (e instanceof ApiError && [401, 403, 404].includes(e.status)) { setBlocked(true); onAccessDenied?.(e); }
        throw e;
      }
    },
  });
  const available = active && !blocked && !hidden && !query.isFetching && !query.isError && query.data;
  return <Card withBorder><Stack><Title order={3}>Frozen test plan</Title><Button loading={query.isFetching} onClick={() => { explicitRefresh.current = { pending: true }; void query.refetch(); }}>Refresh frozen test-plan access</Button>
    {blocked && !query.isError && <Alert color="red">Frozen test-plan access must be explicitly rechecked.</Alert>}
    {query.isError && <Alert color="red">{query.error.message}</Alert>}
    {available && <><Text><RevisionLabel id={query.data!.revision_id} role="plan" /> · SHA-256 {query.data!.sha256}</Text><Text><RevisionLabel id={query.data!.test_plan.root_revision_id} role="Root" snapshotId={query.data!.root_snapshot_id} sha256={query.data!.root_sha256} /></Text><Text>Occurrence {query.data!.test_plan.occurrence_path.join('/') || 'standalone'} · <RevisionLabel id={query.data!.test_plan.cable_revision_id} role="cable" sha256={query.data!.cable_sha256} /></Text>
      <PairTable pairs={query.data!.test_plan.pairs} /><LabelTable labels={query.data!.test_plan.labels} />
      {query.data!.evidence.map(row => <Text key={`${row.kind}:${row.local_id}`}>{row.kind} {row.local_id}: {row.evidence.status} · {row.evidence.citation ?? row.evidence.source_path ?? 'unknown'} · {row.evidence.source_bundle_revision_id ?? 'no registered revision'} · SHA-256 {row.evidence.sha256 ?? 'unknown'} · rights {row.evidence.rights ?? 'unknown'}</Text>)}
      <Text>Physical test: {query.data!.physical_test}. Physical continuity: {query.data!.physical_continuity}. Qualification: {query.data!.physical_qualification}.</Text>
      <Button component="a" href={`/api/v0/cable-test-intent/revisions/${revisionId}/package`}>Download portable expectation package</Button><Text size="sm">The inert JSON package preserves cable design pins and source references with rights metadata. Source bytes are omitted; distribution rights remain unevaluated.</Text>
    </>}
  </Stack></Card>;
}
