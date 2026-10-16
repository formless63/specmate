import { Alert, Button, Group, Select, Stack, Tabs, Text, TextInput } from '@mantine/core';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState } from 'react';
import { RecordSections } from '../../components/record';
import { RevisionLabel } from '../../lib/IdentityLabel';
import { getIntake, type PopulationReview } from '../pcb/api';
import { requestJson } from '../workspace/api';
import { AssertionEditor, ComparisonEditor, SourcePicker } from '../pcb-disagreement/Editors';
import { ProjectionView } from '../pcb-disagreement/ProjectionView';
import { NativeExtraction } from '../pcb-disagreement/NativeExtraction';
import { blankAssertion, blankComparison, type Draft, type FilePin, type Frozen, type Input, type NativeAccepted, type NativeAttempts, type Projection, type SourceFiles, type Value } from '../pcb-disagreement/api';
import { FrozenDefinitionPicker } from './FrozenDefinitionPicker';
import { ContextRecordChoices } from './ContextRecordChoices';
import { useContextRecord, type ContextAdapter } from './useContextRecord';
import { exactUuid, type WorkingPins } from './working-authority';

type Props = { review: PopulationReview; active: boolean; principalKey: string; workspaceId: string; onAccessLost: (error: unknown) => void };
const validFile = (source: FilePin) => exactUuid(source.source_revision_id) && /^[0-9a-f]{64}$/.test(source.manifest_sha256) && !!source.path && /^[0-9a-f]{64}$/.test(source.sha256) && !!source.rights;
const fileKey = (value: FilePin) => [value.source_revision_id, value.manifest_sha256, value.path, value.sha256, value.rights];
const inputKey = (value: Input) => JSON.stringify(value.kind === 'assertion_revision' ? [value.kind, value.revision_id, value.snapshot_sha256] : [value.kind, value.interpretation_id, value.report_sha256, fileKey(value.source)]);
const inputPins = (input: Input): WorkingPins => input.kind === 'assertion_revision' ? { revisions: input.revision_id ? [input.revision_id] : [], sources: [] } : { revisions: [], sources: input.source.source_revision_id ? [input.source.source_revision_id] : [] };
const completeInput = (input: Input) => input.kind === 'assertion_revision' ? exactUuid(input.revision_id) && /^[0-9a-f]{64}$/.test(input.snapshot_sha256) : exactUuid(input.interpretation_id) && /^[0-9a-f]{64}$/.test(input.report_sha256) && validFile(input.source);
function reviewPins(value: Value): WorkingPins { if (value.kind === 'pcb_assertion') return { revisions: [], sources: value.source.source_revision_id ? [value.source.source_revision_id] : [] }; const left = inputPins(value.left); const right = inputPins(value.right); return { revisions: [...left.revisions, ...right.revisions], sources: [...left.sources, ...right.sources] }; }

/** Each visited exact report retains its independent review buffers when the primary state changes. */
export function BoardSourceReview(props: Props) {
  const [contexts, setContexts] = useState<PopulationReview[]>([]);
  const id = props.review.interpretation.interpretation_id;
  useEffect(() => { if (props.active) setContexts(current => current.some(value => value.interpretation.interpretation_id === id) ? current : [...current, props.review]); }, [props.active, id]);
  return <>{contexts.map(review => <SelectedReview key={`${props.principalKey}:${review.interpretation.interpretation_id}`} {...props} review={review} active={props.active && review.interpretation.interpretation_id === id} />)}</>;
}
function SelectedReview({ review, active, principalKey, workspaceId, onAccessLost }: Props) {
  const pin = review.interpretation;
  const intake = useQuery({ queryKey: ['board-source-review-intake', principalKey, pin.intake_id], enabled: active, retry: false,
    queryFn: ({ signal }) => getIntake(pin.intake_id, signal) });
  const source = intake.data?.files.find(file => file.path === pin.board_path);
  const ready = !intake.isError && !intake.isFetching && source?.sha256 === review.report.source_sha256 && intake.data?.source_revision_id === pin.source_revision_id && intake.data.source_manifest_sha256 === pin.source_manifest_sha256;
  const retainedSource = useRef<FilePin | null>(null);
  if (ready && source) retainedSource.current = { source_revision_id: pin.source_revision_id, manifest_sha256: pin.source_manifest_sha256, path: pin.board_path, sha256: source.sha256, rights: source.rights };
  useEffect(() => { if (intake.isError) onAccessLost(intake.error); }, [intake.isError, intake.error, onAccessLost]);
  const [mode, setMode] = useState<string | null>('assertion');
  const sourcePin = retainedSource.current;
  return <Stack gap="xs">{active && !ready && <Text role="status">{intake.isError ? 'Exact source review basis unavailable. Retained review buffers are hidden.' : 'Reading exact source review basis…'}</Text>}
    {sourcePin && <div hidden={!active || !ready} inert={!active || !ready}><Tabs value={mode} onChange={setMode} keepMounted><Tabs.List><Tabs.Tab value="assertion">Human assertion</Tabs.Tab><Tabs.Tab value="comparison">Source comparison</Tabs.Tab></Tabs.List>
      <Tabs.Panel value="assertion"><ReviewEditor mode="pcb_assertion" basis={sourcePin} review={review} active={active && !!ready && mode === 'assertion'} principalKey={principalKey} workspaceId={workspaceId} /></Tabs.Panel>
      <Tabs.Panel value="comparison"><ReviewEditor mode="pcb_comparison" basis={sourcePin} review={review} active={active && !!ready && mode === 'comparison'} principalKey={principalKey} workspaceId={workspaceId} /></Tabs.Panel>
    </Tabs></div>}
  </Stack>;
}
function ReviewEditor({ mode, basis, review, active, principalKey, workspaceId }: { mode: Value['kind']; basis: FilePin; review: PopulationReview; active: boolean; principalKey: string; workspaceId: string }) {
  const scopeKey = `${review.interpretation.interpretation_id}:${mode}`;
  const left: Input = { kind: 'pcb_interpretation', interpretation_id: review.interpretation.interpretation_id, report_sha256: review.interpretation.sha256, source: basis };
  const adapter = useMemo<ContextAdapter<Value, Frozen>>(() => {
    const check = (value: Value) => { if (value.kind !== mode || value.kind === 'pcb_comparison' && inputKey(value.left) !== inputKey(left)) throw new Error('This source review does not retain the selected exact native basis. Its buffer was not substituted.'); return value; };
    const normalize = (result: unknown) => { const draft = result as Draft; const value = check(draft.content.pcb_assertion ?? draft.content.pcb_comparison!); return { ...draft, value, raw: draft }; };
    return { kind: mode, create: 'pcb_disagreement.create', update: 'pcb_disagreement.update', freeze: 'pcb_disagreement.freeze', initial: () => mode === 'pcb_assertion' ? { ...blankAssertion(), source: basis } : { ...blankComparison(), left }, pins: reviewPins,
      complete: value => value.kind === 'pcb_assertion' ? validFile(value.source) : completeInput(value.left) && completeInput(value.right),
      readDraft: async (id, signal) => normalize(await requestJson<Draft>(`/api/v0/pcb-disagreement/drafts/${id}`, { signal })),
      readFrozen: async (id, signal) => { const result = await requestJson<Frozen>(`/api/v0/pcb-disagreement/revisions/${id}`, { signal }); check(result.content.pcb_assertion ?? result.content.pcb_comparison!); return result; },
      fromOperation: normalize, payload: value => ({ value }) };
  }, [scopeKey, basis]);
  const editor = useContextRecord({ adapter, active, principalKey, workspaceId, scopeKey });
  const saved = editor.saved.data?.raw as Draft | undefined;
  const projection: Projection | undefined = saved?.projection;
  const pinsCurrent = editor.value.kind === 'pcb_comparison' && saved?.content.pcb_comparison && inputKey(editor.value.left) === inputKey(saved.content.pcb_comparison.left) && inputKey(editor.value.right) === inputKey(saved.content.pcb_comparison.right);
  const findingsCurrent = pinsCurrent && editor.value.kind === 'pcb_comparison' && saved?.content.pcb_comparison && JSON.stringify(editor.value.correspondences.map(row => [row.local_id, row.left_terminal_id, row.right_terminal_id, row.basis])) === JSON.stringify(saved.content.pcb_comparison.correspondences.map(row => [row.local_id, row.left_terminal_id, row.right_terminal_id, row.basis]));
  const available = active && !editor.checking && !editor.unavailable;
  return <Stack gap="xs">{active && editor.checking && <Text role="status">Rechecking current source-review authority…</Text>}{active && editor.unavailable && <><Alert color="red">Source review unavailable. Local buffers and original editing tokens are retained.</Alert><Button size="xs" onClick={() => void editor.refresh()}>Refresh source-review access</Button></>}
    <div hidden={!available} inert={!available}><Stack gap="xs"><Text size="xs">Independent exact-source records. Human assertions, accepted native extraction, disagreement and review stay distinct; no source is silently chosen as correct.</Text>
      {editor.error && <Alert color="red">{editor.error}</Alert>}{editor.incomplete && <Text size="xs">Complete exact source/input pins before saving.</Text>}
      <fieldset className="board-record-fields" disabled={!editor.gate.allowed || editor.busy}>
        {!editor.current && <TextInput size="xs" label={`${mode === 'pcb_assertion' ? 'Assertion' : 'Comparison'} name`} value={editor.name} onChange={event => editor.setName(event.currentTarget.value)} />}
        {editor.value.kind === 'pcb_assertion' ? <AssertionEditor value={editor.value} onChange={editor.change} onDenied={() => {}} sourceControls={<ExactSourceFiles value={editor.value.source} active={active} principalKey={principalKey} onChange={source => editor.value.kind === 'pcb_assertion' && editor.change({ ...editor.value, source })} onAccessLost={editor.failAuthority} />} />
          : <ComparisonEditor workspaceId={workspaceId} value={editor.value} onChange={editor.change} definitions={[]} projection={projection} sourcePinsCurrent={!!pinsCurrent} onDenied={() => {}}
            inputControls={<Stack gap="xs"><Text fw={500}>Left · selected accepted native board report</Text><RevisionLabel kind="source" id={basis.source_revision_id} role="Exact source" /><Text size="xs">{basis.path} · report {review.interpretation.sha256}</Text><ReviewRightInput value={editor.value.right} active={active} principalKey={principalKey} workspaceId={workspaceId} onChange={right => editor.value.kind === 'pcb_comparison' && editor.change({ ...editor.value, right, correspondences: [], reviews: [] })} onAccessLost={editor.failAuthority} /></Stack>} />}
      </fieldset>
      {projection && <ProjectionView projection={projection} reviewValue={findingsCurrent && editor.value.kind === 'pcb_comparison' ? editor.value : undefined} onReviewChange={findingsCurrent && editor.gate.allowed ? editor.change : undefined} />}
      <Text size="xs">{editor.current ? `${editor.current.state}${editor.dirty ? ' · unsaved' : ' · saved draft'}` : 'New · unsaved'}</Text>
      <Group gap="xs"><Button size="xs" disabled={editor.busy || editor.incomplete || !editor.current && !editor.name.trim()} {...editor.gate.props} onClick={() => void editor.save()}>Save source review</Button><Button size="xs" variant="quiet" disabled={editor.busy || !editor.current || editor.dirty} {...editor.freezeGate.props} onClick={() => void editor.freeze()}>Freeze source review</Button></Group>
      <RecordSections sections={[{ id: 'saved', label: 'Saved exact-source reviews', content: () => <ContextRecordChoices kind={mode} label="source review" active={active} principalKey={principalKey} scopeKey={scopeKey} editor={editor} /> }]} />
      {editor.frozen.data && !editor.frozen.isError && !editor.frozen.isFetching && <Stack gap="xs"><Text fw={500}>Frozen source review</Text><RevisionLabel id={editor.frozenId} /><ProjectionView projection={editor.frozen.data.projection} /></Stack>}
      <Button size="xs" variant="quiet" disabled={editor.busy} {...editor.gate.props} onClick={editor.newRecord}>New source review (discard local edits)</Button>
    </Stack></div>
  </Stack>;
}
function ExactSourceFiles({ value, active, principalKey, onChange, onAccessLost }: { value: FilePin; active: boolean; principalKey: string; onChange: (value: FilePin) => void; onAccessLost: (error: unknown) => void }) {
  const files = useQuery({ queryKey: ['board-review-source-files', principalKey, value.source_revision_id], enabled: active && exactUuid(value.source_revision_id), retry: false, queryFn: ({ signal }) => requestJson<SourceFiles>(`/api/v0/pcb-disagreement/sources/${value.source_revision_id}`, { signal }) });
  useEffect(() => { if (files.isError) onAccessLost(files.error); }, [files.isError, files.error, onAccessLost]);
  const choices = files.isError || files.isFetching ? [] : files.data?.files ?? [];
  return <Stack gap="xs"><RevisionLabel kind="source" id={value.source_revision_id} role="Preserved source" /><Select size="xs" label="Exact preserved source file" searchable value={files.isError ? null : value.path} data={choices.map(file => ({ value: file.path, label: file.path }))} onChange={path => { const file = choices.find(row => row.path === path); if (file) onChange(file); }} /><Text size="xs">{value.sha256} · {value.rights || 'Rights unknown'}</Text><RecordSections sections={[{ id: 'other-source', label: 'Advanced · choose another preserved source', content: () => <SourcePicker active={active} value={value} onChange={onChange} onDenied={() => {}} /> }]} /></Stack>;
}
function ReviewRightInput({ value, active, principalKey, workspaceId, onChange, onAccessLost }: { value: Input; active: boolean; principalKey: string; workspaceId: string; onChange: (value: Input) => void; onAccessLost: (error: unknown) => void }) {
  const [method, setMethod] = useState<Input['kind']>(value.kind); const [candidate, setCandidate] = useState<string | null>(null);
  const assertion = useQuery({ queryKey: ['board-review-right-assertion', principalKey, candidate], enabled: active && method === 'assertion_revision' && !!candidate, retry: false, queryFn: ({ signal }) => requestJson<Frozen>(`/api/v0/pcb-disagreement/revisions/${candidate}`, { signal }) });
  const population = useQuery({ queryKey: ['board-review-right-population', principalKey, candidate], enabled: active && method === 'pcb_interpretation' && !!candidate, retry: false, queryFn: ({ signal }) => requestJson<PopulationReview>(`/api/v0/pcb/population-revisions/${candidate}/review`, { signal }) });
  const populationIntake = useQuery({ queryKey: ['board-review-right-population-source', principalKey, population.data?.interpretation.intake_id], enabled: active && method === 'pcb_interpretation' && !!population.data && !population.isError, retry: false, queryFn: ({ signal }) => getIntake(population.data!.interpretation.intake_id, signal) });
  const natives = useQuery({ queryKey: ['board-review-native-choices', principalKey, workspaceId], enabled: active && method === 'source_net_interpretation', retry: false, queryFn: ({ signal }) => requestJson<NativeAttempts>(`/api/v0/pcb-disagreement/native?workspace_id=${workspaceId}`, { signal }) });
  const native = useQuery({ queryKey: ['board-review-right-native', principalKey, candidate], enabled: active && method === 'source_net_interpretation' && !!candidate, retry: false, queryFn: ({ signal }) => requestJson<NativeAccepted>(`/api/v0/pcb-disagreement/native/${candidate}`, { signal }) });
  const unavailable = method === 'assertion_revision' ? assertion.isError : method === 'pcb_interpretation' ? population.isError || populationIntake.isError : natives.isError || native.isError;
  useEffect(() => { const selected = value.kind === 'assertion_revision' ? value.revision_id === candidate : value.interpretation_id === candidate; if (!selected || !unavailable) return; for (const query of method === 'assertion_revision' ? [assertion] : method === 'pcb_interpretation' ? [population, populationIntake] : [natives, native]) if (query.isError) onAccessLost(query.error); }, [unavailable, method, candidate, value, onAccessLost]);
  const readyAssertion = assertion.data && !assertion.isFetching && !assertion.isError && !!assertion.data.content.pcb_assertion;
  const readyNative = native.data && !native.isFetching && !native.isError;
  const rightPopulation = population.data; const file = populationIntake.data?.files.find(row => row.path === rightPopulation?.interpretation.board_path);
  const readyPopulation = rightPopulation && file && !population.isFetching && !populationIntake.isFetching && !unavailable;
  return <Stack gap="xs"><Select size="xs" label="Right independent input method" value={method} data={[{ value: 'assertion_revision', label: 'Frozen human assertion' }, { value: 'source_net_interpretation', label: 'Accepted schematic/netlist extraction' }, { value: 'pcb_interpretation', label: 'Accepted native PCB report' }]} onChange={method => { setMethod(method as Input['kind']); setCandidate(null); }} />
    {unavailable && <Alert color="red">Right input unavailable. Retained choices are hidden.</Alert>}
    {method === 'assertion_revision' && <><FrozenDefinitionPicker label="Right assertion" kinds={['pcb_assertion']} active={active} principalKey={principalKey} onPick={choice => setCandidate(choice.revision_id)} /><Button size="xs" disabled={!readyAssertion} onClick={() => assertion.data && onChange({ kind: 'assertion_revision', revision_id: assertion.data.revision_id, snapshot_sha256: assertion.data.sha256 })}>Pin right assertion</Button></>}
    {method === 'pcb_interpretation' && <><FrozenDefinitionPicker label="Right PCB population" kinds={['pcb_population']} active={active} principalKey={principalKey} onPick={choice => setCandidate(choice.revision_id)} /><Button size="xs" disabled={!readyPopulation} onClick={() => { if (rightPopulation && file) onChange({ kind: 'pcb_interpretation', interpretation_id: rightPopulation.interpretation.interpretation_id, report_sha256: rightPopulation.interpretation.sha256, source: { source_revision_id: rightPopulation.interpretation.source_revision_id, manifest_sha256: rightPopulation.interpretation.source_manifest_sha256, path: file.path, sha256: file.sha256, rights: file.rights } }); }}>Pin right PCB report</Button></>}
    {method === 'source_net_interpretation' && <><Select size="xs" label="Accepted right schematic or netlist" value={unavailable ? null : candidate} data={(natives.isError || natives.isFetching ? [] : natives.data?.attempts ?? []).filter(attempt => attempt.interpretation).map(attempt => ({ value: attempt.interpretation!.interpretation_id, label: `${attempt.source.path} · ${attempt.source_role}` }))} onChange={setCandidate} /><Button size="xs" disabled={!readyNative} onClick={() => native.data && onChange({ kind: 'source_net_interpretation', interpretation_id: native.data.interpretation_id, report_sha256: native.data.report_sha256, source: native.data.source })}>Pin right native source</Button><Text size="xs">Accepted native choices are limited to the existing100-attempt read.</Text><RecordSections sections={[{ id: 'extract', label: 'Preserve/request a native schematic or netlist extraction', content: () => <NativeExtraction active={active} workspaceId={workspaceId} /> }]} /></>}
    <Text size="xs">Current saved/working right pin: {value.kind === 'assertion_revision' ? value.revision_id || 'Not selected' : value.interpretation_id || 'Not selected'}. Choosing a method does not silently replace this pin; use its Pin action.</Text>
  </Stack>;
}
