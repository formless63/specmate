import { Alert, Button, Card, Group, Select, Stack, Table, Text, TextInput, Title } from '@mantine/core';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { ApiError } from '../workspace/api';
import { command, initialPlan, inspectTarget, keyOf, read, terminalText, type Definition, type Draft, type Evidence, type Identity, type Inspection, type Label, type Pair, type TestPlan } from './api';

export function CableTestIntentPanel({ projectId }: { projectId: string }) {
  const cache = useQueryClient();
  const [name, setName] = useState('');
  const [value, setValue] = useState(initialPlan);
  const [definitionId, setDefinitionId] = useState<string | null>(null);
  const [draftId, setDraftId] = useState<string | null>(null);
  const [revisionId, setRevisionId] = useState<string | null>(null);
  const [offset, setOffset] = useState(0);
  const [blocked, setBlocked] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const authorityVersion = useRef(0);
  const restoreAttempt = useRef<object | null>(null);
  const activePlan = useRef<{ draftId: string; value: TestPlan } | null>(null);
  const [refresh, setRefresh] = useState(0);
  const [targetDenied, setTargetDenied] = useState(true);
  const [saved, setSaved] = useState<Draft | null>(null);
  const [retainedDraft, setRetainedDraft] = useState<Draft | null>(null);
  const activeEditor = useRef({ projectId, definitionId, draftId, generation: 0 });
  if (activeEditor.current.projectId !== projectId || activeEditor.current.definitionId !== definitionId || activeEditor.current.draftId !== draftId) activeEditor.current = { projectId, definitionId, draftId, generation: activeEditor.current.generation + 1 };
  const editorGeneration = activeEditor.current.generation;
  function workspaceDenied(e: Error) {
    if (activeEditor.current.generation !== editorGeneration) return;
    if (e instanceof ApiError && [401, 403, 404].includes(e.status)) {
      authorityVersion.current += 1;
      setBlocked(true);
    }
  }
  async function guardedRead<T>(path: string) {
    try { return await read<T>(path); }
    catch (e) { if (e instanceof Error) workspaceDenied(e); throw e; }
  }
  const definitions = useQuery({ queryKey: ['test-plan-definitions', projectId, refresh], queryFn: () => guardedRead<Definition[]>(`projects/${projectId}/definitions`) });
  const identity = useQuery({ queryKey: ['test-plan-identity', definitionId, offset, refresh], queryFn: () => guardedRead<Identity>(`catalog/definitions/${definitionId}?offset=${offset}`), enabled: !!definitionId });
  const draft = useQuery({ queryKey: ['test-plan-draft', draftId, refresh], queryFn: () => guardedRead<Draft>(`cable-test-intent/drafts/${draftId}`), enabled: !!draftId });
  useEffect(() => { if (draft.data?.draft_id === draftId && !draft.isError) setRetainedDraft(draft.data); }, [draft.data, draftId, draft.isError]);
  const editorDraft = draft.data ?? (retainedDraft?.draft_id === draftId ? retainedDraft : null);
  const hidden = blocked || restoring || definitions.isError || identity.isError || draft.isError || definitions.isFetching;
  const error = workspaceDenied;
  const create = useMutation({ mutationFn: (submitted: { projectId: string; name: string; value: TestPlan; generation: number }) => command<Draft>('cable_test_plan.create', { project_id: submitted.projectId, name: submitted.name, test_plan: submitted.value }), onSuccess: async (d, submitted) => { if (activeEditor.current.generation !== submitted.generation) return; setSaved(d); setDefinitionId(d.definition_id); setDraftId(d.draft_id); await cache.invalidateQueries({ queryKey: ['test-plan-definitions', projectId] }); }, onError: (e, submitted) => { if (activeEditor.current.generation === submitted.generation) error(e); } });
  useEffect(() => { setName(''); setValue(initialPlan()); setDefinitionId(null); setDraftId(null); setRevisionId(null); setSaved(null); setRetainedDraft(null); setOffset(0); setBlocked(false); setRestoring(false); restoreAttempt.current = null; activePlan.current = null; }, [projectId]);
  async function refreshAuthority() {
    const attempt = {};
    restoreAttempt.current = attempt;
    const version = authorityVersion.current;
    const selectedDraft = draftId && activePlan.current?.draftId === draftId ? activePlan.current.value : null;
    setRestoring(true);
    try {
      const checks: Promise<unknown>[] = [read<Definition[]>(`projects/${projectId}/definitions`)];
      if (definitionId) checks.push(read<Identity>(`catalog/definitions/${definitionId}?offset=${offset}`));
      if (draftId) checks.push(read<Draft>(`cable-test-intent/drafts/${draftId}`));
      if (revisionId) checks.push(read<Inspection>(`cable-test-intent/revisions/${revisionId}`));
      // Recheck the unsaved target too; fresh server draft reads never replace its values or CAS.
      if (selectedDraft) checks.push(inspectTarget(selectedDraft));
      else if (value.root_revision_id && value.cable_revision_id) checks.push(inspectTarget(value));
      const results = await Promise.allSettled(checks);
      if (activeEditor.current.generation !== editorGeneration || restoreAttempt.current !== attempt) return;
      if (results.some(result => result.status === 'rejected') || authorityVersion.current !== version) {
        setBlocked(true);
        return;
      }
      setBlocked(false);
      setRefresh(n => n + 1);
    } finally {
      if (restoreAttempt.current === attempt) setRestoring(false);
    }
  }
  return <Stack>
    <Title order={2}>Cable test intent and labels</Title>
    <Text>Declare expected terminal pairs for an exact cable revision or contextual occurrence. Expectations and label text record intent; this plan records no performed physical test or qualification.</Text>
    <Button loading={restoring} disabled={restoring} onClick={() => void refreshAuthority()}>Refresh test-plan access</Button>
    {hidden && <Alert color="red">Retained test-plan content is hidden while access is unavailable or being rechecked.</Alert>}
    <div hidden={hidden}><fieldset disabled={create.isPending} style={{ border: 0, padding: 0 }}><Card withBorder><Stack>
      <Title order={3}>New test plan</Title><TextInput label="Test-plan name" value={name} onChange={e => setName(e.currentTarget.value)} />
      <PlanEditor disabled={create.isPending} key={projectId} value={value} onChange={setValue} refresh={refresh} hidden={hidden} onAuthorityChange={setTargetDenied} />
      <Button disabled={targetDenied || !name.trim() || hidden} loading={create.isPending} onClick={() => create.mutate({ projectId, name, value, generation: editorGeneration })}>Create test-plan draft</Button>
    </Stack></Card></fieldset></div>
    {create.isError && <Alert color="red">{create.error.message}</Alert>}
    {[definitions, identity, draft].filter(q => q.isError).map((q, i) => <Alert key={i} color="red">{q.error?.message}</Alert>)}
    {!hidden && <Select label="Test-plan definition" disabled={create.isPending} searchable data={(definitions.data ?? []).filter(d => d.kind === 'cable_test_plan').map(d => ({ value: d.definition_id, label: d.name }))} value={definitionId} onChange={id => { setDefinitionId(id); setDraftId(null); setRevisionId(null); setSaved(null); setOffset(0); }} />}
    {!hidden && identity.data && <>
      <Select label="Test-plan draft" disabled={create.isPending} data={identity.data.drafts.map(d => ({ value: d.draft_id, label: `${d.draft_id} · ${d.state}` }))} value={draftId} onChange={id => { if (id !== draftId) { setDraftId(id); setSaved(null); } }} />
      <Select label="Frozen test plan" data={identity.data.revisions.map(r => ({ value: r.revision_id, label: `Revision ${r.number} · ${r.revision_id}` }))} value={revisionId} onChange={setRevisionId} />
      <Group><Button disabled={offset === 0} onClick={() => setOffset(n => Math.max(0, n - 50))}>Earlier plans</Button><Button disabled={Math.max(identity.data.drafts.length, identity.data.revisions.length) < 50} onClick={() => setOffset(n => n + 50)}>Later plans</Button></Group>
    </>}
    {editorDraft && <DraftEditor key={`${projectId}:${editorDraft.draft_id}`} draft={editorDraft} committed={saved} hidden={hidden || draft.isFetching} refresh={refresh} onValueChange={v => { if (activeEditor.current.generation === editorGeneration && draftId) activePlan.current = { draftId, value: v }; }} onError={e => { if (activeEditor.current.generation === editorGeneration) error(e); }} onSaved={async d => { if (activeEditor.current.generation !== editorGeneration) return; setSaved(d); await cache.invalidateQueries({ queryKey: ['test-plan-draft', d.draft_id] }); }} onFrozen={async (r, d) => { if (activeEditor.current.generation !== editorGeneration) return; setRevisionId(r); setSaved(d); await cache.invalidateQueries({ queryKey: ['test-plan-draft', d.draft_id] }); await cache.invalidateQueries({ queryKey: ['test-plan-identity', definitionId] }); }} />}
    {revisionId && <PlanInspector key={`${projectId}:${revisionId}`} revisionId={revisionId} hidden={hidden} refresh={refresh} onAccessDenied={workspaceDenied} />}
  </Stack>;
}

export function DraftEditor({ draft, committed, hidden = false, refresh = 0, onError, onSaved, onFrozen, onValueChange }: { onValueChange?: (value: TestPlan) => void; draft: Draft; committed?: Draft | null; hidden?: boolean; refresh?: number; onError: (e: Error) => void; onSaved: (d: Draft) => Promise<void>; onFrozen: (r: string, d: Draft) => Promise<void> }) {
  const [base, setBase] = useState(draft);
  const [value, setValue] = useState(draft.content.test_plan);
  const [denied, setDenied] = useState(true);
  useEffect(() => onValueChange?.(value), [value, onValueChange]);
  useEffect(() => { if (committed?.draft_id === base.draft_id) setBase(committed); }, [committed, base.draft_id]);
  const save = useMutation({ mutationFn: () => command<Draft>('cable_test_plan.update', { draft_id: base.draft_id, test_plan: value }, base.state), onSuccess: async d => { setBase(d); setValue(d.content.test_plan); await onSaved(d); }, onError });
  const freeze = useMutation({ mutationFn: () => command<{ revision_id: string; draft: Draft }>('cable_test_plan.freeze', { draft_id: base.draft_id }, base.state), onSuccess: async r => { setBase(r.draft); await onFrozen(r.revision_id, r.draft); }, onError });
  // Keep the editing baseline and unsaved values mounted through query refresh/denial.
  return <div hidden={hidden}><fieldset disabled={save.isPending || freeze.isPending} style={{ border: 0, padding: 0 }}><Card withBorder><Stack><Title order={3}>Edit test-plan draft</Title><Text>{base.state}</Text>
    <PlanEditor disabled={save.isPending || freeze.isPending} value={value} onChange={setValue} hidden={hidden} refresh={refresh} onAuthorityChange={setDenied} onAccessDenied={onError} />
    <Group><Button disabled={denied || hidden || save.isPending || freeze.isPending} loading={save.isPending} onClick={() => save.mutate()}>Save test-plan draft</Button><Button disabled={denied || hidden || save.isPending || freeze.isPending} loading={freeze.isPending} onClick={() => freeze.mutate()}>Freeze saved test plan</Button></Group>
    <Text size="sm">Freezing captures the saved draft. Save changed expectations first.</Text>
    {save.isError && <Alert color="red">{save.error.message}</Alert>}{freeze.isError && <Alert color="red">{freeze.error.message}</Alert>}
  </Stack></Card></fieldset></div>;
}

export function PlanEditor({ value, onChange, hidden = false, refresh = 0, disabled = false, onAuthorityChange, onAccessDenied }: { onAccessDenied?: (error: Error) => void; disabled?: boolean; value: TestPlan; onChange: (v: TestPlan) => void; hidden?: boolean; refresh?: number; onAuthorityChange?: (denied: boolean) => void }) {
  const [authorityBlocked, setAuthorityBlocked] = useState(false);
  const refreshRef = useRef({ epoch: refresh, pending: false });
  if (refreshRef.current.epoch !== refresh) refreshRef.current = { epoch: refresh, pending: true };
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
    queryKey: ['test-plan-target', value.root_revision_id, value.cable_revision_id, value.occurrence_path, refresh],
    enabled,
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
  const denied = hidden || authorityBlocked || !enabled || target.isError || target.isFetching || !target.data;
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
    <TextInput disabled={disabled} label="Exact cable revision ID" value={value.cable_revision_id} onChange={e => onChange({ ...value, cable_revision_id: e.currentTarget.value })} />
    <TextInput disabled={disabled} label="Exact scope root revision ID" description="For a standalone cable use its revision ID. For an occurrence use its frozen assembly root." value={value.root_revision_id} onChange={e => onChange({ ...value, root_revision_id: e.currentTarget.value })} />
    <TextInput disabled={disabled} label="Occurrence path" description="Stable local IDs separated by /; empty for standalone." value={value.occurrence_path.join('/')} onChange={e => onChange({ ...value, occurrence_path: e.currentTarget.value ? e.currentTarget.value.split('/') : [] })} />
    <Button disabled={!enabled || disabled} loading={target.isFetching} onClick={() => { explicitRefresh.current = { pending: true, scope: scopeKey }; void target.refetch(); }}>Refresh exact target access</Button>
    {authorityBlocked && !target.isError && <Alert color="red">Target access must be explicitly rechecked before retained expectations can be shown.</Alert>}
    {target.isError && <Alert color="red">{target.error.message}</Alert>}
    {!denied && <>
      <Text size="sm">Root snapshot {target.data!.root_snapshot_id} · SHA-256 {target.data!.root_sha256}. Cable SHA-256 {target.data!.cable_sha256}.</Text>
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
function PairTable({ pairs }: { pairs: Pair[] }) {
  return <Table><Table.Thead><Table.Tr><Table.Th>Pair</Table.Th><Table.Th>Exact first terminal</Table.Th><Table.Th>Exact second terminal</Table.Th><Table.Th>Expected intent</Table.Th><Table.Th>Basis</Table.Th></Table.Tr></Table.Thead><Table.Tbody>{pairs.map(p => <Table.Tr key={p.local_id}><Table.Td>{p.local_id}</Table.Td><Table.Td>{terminalText(p.first)}</Table.Td><Table.Td>{terminalText(p.second)}</Table.Td><Table.Td>{p.intent}</Table.Td><Table.Td>{p.basis}</Table.Td></Table.Tr>)}</Table.Tbody></Table>;
}
function LabelTable({ labels }: { labels: Label[] }) {
  return <Table><Table.Thead><Table.Tr><Table.Th>Label</Table.Th><Table.Th>Text</Table.Th><Table.Th>Target</Table.Th><Table.Th>Basis</Table.Th></Table.Tr></Table.Thead><Table.Tbody>{labels.map(l => <Table.Tr key={l.local_id}><Table.Td>{l.local_id}</Table.Td><Table.Td>{l.text}</Table.Td><Table.Td>{l.terminal ? terminalText(l.terminal) : l.endpoint_id ?? 'whole cable'}</Table.Td><Table.Td>{l.basis}</Table.Td></Table.Tr>)}</Table.Tbody></Table>;
}
export function PlanInspector({ revisionId, hidden = false, refresh = 0, onAccessDenied }: { onAccessDenied?: (error: Error) => void; revisionId: string; hidden?: boolean; refresh?: number }) {
  const [blocked, setBlocked] = useState(false);
  const refreshRef = useRef({ epoch: refresh, pending: false });
  if (refreshRef.current.epoch !== refresh) refreshRef.current = { epoch: refresh, pending: true };
  const explicitRefresh = useRef({ pending: false });
  const query = useQuery({
    queryKey: ['test-plan-inspection', revisionId, refresh],
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
  const available = !blocked && !hidden && !query.isFetching && !query.isError && query.data;
  return <Card withBorder><Stack><Title order={3}>Frozen test plan</Title><Button loading={query.isFetching} onClick={() => { explicitRefresh.current = { pending: true }; void query.refetch(); }}>Refresh frozen test-plan access</Button>
    {blocked && !query.isError && <Alert color="red">Frozen test-plan access must be explicitly rechecked.</Alert>}
    {query.isError && <Alert color="red">{query.error.message}</Alert>}
    {available && <><Text>Exact plan {query.data!.revision_id} · SHA-256 {query.data!.sha256}</Text><Text>Root {query.data!.test_plan.root_revision_id} · snapshot {query.data!.root_snapshot_id} · SHA-256 {query.data!.root_sha256}</Text><Text>Occurrence {query.data!.test_plan.occurrence_path.join('/') || 'standalone'} · cable {query.data!.test_plan.cable_revision_id} · SHA-256 {query.data!.cable_sha256}</Text>
      <PairTable pairs={query.data!.test_plan.pairs} /><LabelTable labels={query.data!.test_plan.labels} />
      {query.data!.evidence.map(row => <Text key={`${row.kind}:${row.local_id}`}>{row.kind} {row.local_id}: {row.evidence.status} · {row.evidence.citation ?? row.evidence.source_path ?? 'unknown'} · {row.evidence.source_bundle_revision_id ?? 'no registered revision'} · SHA-256 {row.evidence.sha256 ?? 'unknown'} · rights {row.evidence.rights ?? 'unknown'}</Text>)}
      <Text>Physical test: {query.data!.physical_test}. Physical continuity: {query.data!.physical_continuity}. Qualification: {query.data!.physical_qualification}.</Text>
      <Button component="a" href={`/api/v0/cable-test-intent/revisions/${revisionId}/package`}>Download portable expectation package</Button><Text size="sm">The inert JSON package preserves cable design pins and source references with rights metadata. Source bytes are omitted; distribution rights remain unevaluated.</Text>
    </>}
  </Stack></Card>;
}
