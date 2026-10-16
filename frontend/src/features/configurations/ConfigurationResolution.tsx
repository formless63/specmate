import { Alert, Badge, Button, Card, Group, Stack, Table, Text, Textarea, Title } from '@mantine/core';
import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { randomUUID } from '../../lib/random-id';
import { ReadOnlyNote, usePermission } from '../../lib/permissions';
import { canonical } from '../parts/api';
import type { SecondaryContext } from '../records/SecondaryRecordPage';
import { ApiError } from '../workspace/api';
import { SbStatus } from '../../components/sb';
import { AdoptionReviewPanel } from './AdoptionReview';
import { ConstraintResults, evaluation, OUTCOME_LABEL, OUTCOME_LED } from './ConstraintResults';
import { DEVELOPMENT_LABEL, RuleProposals } from './DevelopmentProposals';
import { operation, type BuildInput, type Decision, type DraftResolution, type Selection, type Submission } from './api';
const NONE = '__none__';
function selectionMap(selections:Selection[]){return Object.fromEntries(selections.map(row=>[row.option_key,row.choice_key??NONE]));}
/** Inspection text for a selection the viewer cannot change. */
function selectionText(value: string, options?: { default_choice?: unknown; choices: { key: string; label: string }[] }) {
  if (value === NONE) return 'Explicitly none';
  if (value === '') return options?.default_choice ? 'Declared default' : 'No selection';
  return options?.choices.find((choice) => choice.key === value)?.label ?? value;
}
const STATUS_COLOR: Record<string, string> = { resolved: 'green', complete: 'green', none: 'blue', unresolved: 'yellow', incomplete: 'yellow', invalid: 'red' };
const SOURCE: Record<Decision['source'], string> = { selected: 'Selected', default: 'Option-set default', explicit_none: 'Explicitly none', not_selected: 'Not selected' };

/** Resolution/capture is separate from catalog Freeze and consumes only saved state. */
export function ConfigurationResolution({context,scopeKey,projectId=null}:{context:SecondaryContext;scopeKey:string;projectId?:string|null}) {
 const edit=usePermission('design.edit'), selected=context.selected?.kind==='draft'?context.selected:null;
 const draftId=selected?.draft_id??'',selectedState=selected?.state??'';
 const active=context.active&&!!selected;
 const dirty=!!selected&&canonical(context.workingContent)!==canonical(selected.content);
 const [basis,setBasis]=useState(''),[submission,setSubmission]=useState<Submission|null>(null),[buildInput,setBuildInput]=useState<BuildInput|null>(null),[adopting,setAdopting]=useState(''),[error,setError]=useState(''),[busy,setBusy]=useState(false);
 const stamp=active?`${scopeKey}:${draftId}:${selectedState}`:'';const live=useRef({stamp,epoch:0});if(live.current.stamp!==stamp)live.current={stamp,epoch:live.current.epoch+1};
 useEffect(()=>setBusy(false),[stamp]);
 const query=useQuery({queryKey:['configuration-resolution',scopeKey,draftId,selectedState],enabled:active,retry:false,queryFn:()=>operation<DraftResolution>('configuration.resolve',{draft_id:draftId})});
 const preview=active&&!query.isFetching&&!query.error?query.data:null;
 useEffect(()=>{if(!active||query.isFetching){setBuildInput(null);setAdopting('');}},[active,query.isFetching]);
 useEffect(()=>{if(query.error instanceof ApiError&&[401,403,404].includes(query.error.status))context.refreshAccess();},[query.error]);
 const refresh=()=>query.refetch();
 async function refreshDevelopment(){await refresh();}
 async function capture(retry=false){
  if(!preview||dirty||!active||preview.state!==selectedState)return;
  const token=live.current.epoch,request=retry&&submission?submission:{payload:{draft_id:draftId,review_sha256:preview.review_sha256,basis},state:preview.state,key:randomUUID()};
  setSubmission(request);setBusy(true);setError('');
  try{await operation('configuration.capture',request.payload,request);if(token!==live.current.epoch)return;setSubmission(null);setBasis('');await refresh();}
  catch(failure){if(token===live.current.epoch){setError((failure as Error).message);if(failure instanceof ApiError&&[401,403,404].includes(failure.status))context.refreshAccess();}}
  finally{if(token===live.current.epoch)setBusy(false);}
 }
 async function inspect(id:string){const token=live.current.epoch;setBuildInput(null);setError('');try{const found=await operation<BuildInput>('configuration.build_input',{resolved_configuration_id:id});if(token===live.current.epoch)setBuildInput(found);}catch(failure){if(token===live.current.epoch){setError((failure as Error).message);if(failure instanceof ApiError&&[401,403,404].includes(failure.status))context.refreshAccess();}}}
 const needs: never[]=[];
 if(!active)return <Text>Resolution and capture require an explicitly selected saved working configuration. Frozen catalog declarations remain exact; captured resolutions are retained separately.</Text>;
 if(query.error)return <Alert color="red">{query.error.message}<Button onClick={()=>void refresh()}>Retry resolution</Button></Alert>;
  const resolution = preview?.resolution;
  const constraints = resolution ? evaluation(resolution) : null;
  const development = preview?.development;
  return <Stack>
    {error && <Alert color="red">{error}</Alert>}
    <Group><Button variant="quiet" disabled={busy || !active} onClick={() => { void refresh(); }}>Refresh resolution</Button></Group>
    {preview && resolution && <>
      <dl className="sb-meter" style={{ display: 'flex', gap: 24, margin: 0, flexWrap: 'wrap' }}>
        <div><dt className="sb-silk">Resolution</dt><dd style={{ margin: 0 }}><Badge variant="outline" color={STATUS_COLOR[resolution.status]}>{resolution.status}</Badge></dd></div>
        <div><dt className="sb-silk">Draft</dt><dd style={{ margin: 0 }}><Badge variant="draft">{preview.state}</Badge></dd></div>
        <div><dt className="sb-silk">Option set</dt><dd style={{ margin: 0 }}><Badge variant="frozen">{resolution.option_set.name} · rev {resolution.option_set.number}</Badge></dd></div>
        <div><dt className="sb-silk">Target</dt><dd style={{ margin: 0 }}>{resolution.target ? <Badge variant="frozen">{resolution.target.name} · rev {resolution.target.number}</Badge> : <Text size="sm">None</Text>}</dd></div>
        <div><dt className="sb-silk">Unresolved</dt><dd style={{ margin: 0, fontFamily: 'var(--sb-font-data)' }}>{resolution.counts.unresolved}</dd></div>
        <div><dt className="sb-silk">Constraints</dt><dd style={{ margin: 0 }}>{constraints
          ? <SbStatus led={OUTCOME_LED[constraints.outcome]} dimension="overall" value={OUTCOME_LABEL[constraints.outcome]} />
          : <SbStatus led="not-evaluated" dimension="overall" value="not evaluated" />}</dd></div>
        {development && development.outcome !== development.constraint_outcome && <div><dt className="sb-silk">Development</dt><dd style={{ margin: 0 }}>
          <SbStatus led={OUTCOME_LED[development.constraint_outcome]} dimension="with proposals" value={DEVELOPMENT_LABEL[development.outcome]} /></dd></div>}
        {constraints && <div><dt className="sb-silk">Rules unknown</dt><dd style={{ margin: 0, fontFamily: 'var(--sb-font-data)' }}>{constraints.counts.unknown}</dd></div>}
        {constraints && <div><dt className="sb-silk">Rules invalid</dt><dd style={{ margin: 0, fontFamily: 'var(--sb-font-data)' }}>{constraints.counts.invalid}</dd></div>}
        <div><dt className="sb-silk">Other compatibility</dt><dd style={{ margin: 0 }}><Text size="sm">Not evaluated</Text></dd></div>
      </dl>
      <Table.ScrollContainer minWidth={620}><Table>
        <Table.Thead><Table.Tr><Table.Th>Option</Table.Th><Table.Th>Occurrence</Table.Th><Table.Th>Selection</Table.Th><Table.Th>Decision</Table.Th><Table.Th>Exact pin or value</Table.Th><Table.Th>Reason</Table.Th></Table.Tr></Table.Thead>
        <Table.Tbody>{resolution.decisions.map((decision) => {
          const options = preview.available.find((item) => item.option_key === decision.option_key);
          return <Table.Tr key={decision.option_key}>
            <Table.Td><Text size="sm">{decision.label}</Text><Text className="sb-silk">{decision.domain}{decision.required ? '' : ' · optional'}</Text></Table.Td>
            <Table.Td>{decision.path ? <Badge variant="occurrence">{decision.path.join('/')}</Badge> : <Text size="sm">Whole configuration</Text>}</Table.Td>
            <Table.Td><Text size="sm">{selectionText(selectionMap(preview.configuration.selections)[decision.option_key] ?? '', options)}</Text></Table.Td>
            <Table.Td><Badge variant="outline" color={STATUS_COLOR[decision.status]}>{decision.status}</Badge><Text className="sb-silk">{SOURCE[decision.source]}</Text></Table.Td>
            <Table.Td style={{ fontFamily: 'var(--sb-font-data)' }}>{decision.choice ? (decision.choice.revision
              ? <>{decision.choice.revision.name} · rev {decision.choice.revision.number}{decision.choice.population_option_id ? ` · option ${decision.choice.population_option_id}` : ''}<br />{decision.choice.revision.snapshot_sha256.slice(0, 12)}</>
              : decision.choice.value) : '-'}
              {decision.base && <><br /><Text span className="sb-silk">Base population {decision.base.population_revision_id.slice(0, 8)} · firmware {decision.base.firmware_revision_id?.slice(0, 8) ?? 'unassigned'}</Text></>}</Table.Td>
            <Table.Td><Text size="sm">{decision.reason}</Text></Table.Td>
          </Table.Tr>;
        })}</Table.Tbody>
      </Table></Table.ScrollContainer>
      {resolution.invalid_selections.map((item) => <Alert key={item.option_key} color="red">{item.option_key}: {item.reason}</Alert>)}
      <ConstraintResults resolution={resolution} proposals={development ? (rule) => <RuleProposals rule={rule} draftId={draftId} projectId={projectId} needs={needs}
        links={development.links.filter((link) => link.rule_key === rule.key)} onChanged={() => { void refreshDevelopment(); }} /> : undefined} />
      {development && development.links.some((link) => link.current_outcome === 'absent') && <Text size="sm">Proposals linked to rules this option-set revision does not declare: {[...new Set(development.links.filter((link) => link.current_outcome === 'absent').map((link) => link.rule_key))].join(', ')}</Text>}
      {development && development.links.length > 0 && <Text className="sb-silk">{development.note}</Text>}
      <ReadOnlyNote permission="design.edit" />
      {edit.allowed && <>
      {dirty&&<Text size="sm">Save local selections before reviewing or capturing their resolution. The results below describe the saved draft only.</Text>}
      <Textarea label="Capture basis" disabled={busy} value={basis} onChange={(event) => { setBasis(event.currentTarget.value); setSubmission(null); }} />
      <Group><Button variant="commit" disabled={dirty || busy || !active || preview.state !== selectedState || resolution.status === 'invalid' || !basis.trim()} onClick={() => { void capture(); }}>Capture resolved snapshot</Button>
        {submission && <Button variant="quiet" disabled={busy || dirty || !active} onClick={() => { void capture(true); }}>Retry capture</Button>}</Group>
      </>}
      {constraints && constraints.outcome !== 'valid' && constraints.outcome !== 'not_evaluated' && <Text size="sm">Capturing records the {OUTCOME_LABEL[constraints.outcome]} constraint outcome with its reasons as review evidence; it does not make the configuration valid.{constraints.outcome === 'invalid' ? ' Builds refuse an invalid snapshot.' : ''}</Text>}
      {resolution.status === 'incomplete' && <Text size="sm">An incomplete snapshot may be captured as review evidence; builds refuse it until every required option resolves.</Text>}
      <Title order={4}>Resolved snapshots</Title>
      {preview.resolved.length === 0 && <Text size="sm">No resolved snapshot captured for this draft.</Text>}
      {preview.resolved.map((item) => <Group key={item.resolved_configuration_id}>
        <Badge variant="frozen">{item.resolution_sha256.slice(0, 12)}</Badge><Badge variant="outline" color={STATUS_COLOR[item.status]}>{item.status}</Badge>
        <Text size="sm">{item.basis}</Text>
        <Button variant="quiet" onClick={() => { void inspect(item.resolved_configuration_id); }}>Inspect build input</Button>
        <Button variant="quiet" onClick={() => setAdopting(adopting === item.resolved_configuration_id ? '' : item.resolved_configuration_id)}>{adopting === item.resolved_configuration_id ? 'Hide adoption review' : 'Review adoption'}</Button>
      </Group>)}
      {adopting && <AdoptionReviewPanel key={adopting} resolvedId={adopting} />}
      {preview.history_truncated && <Text size="sm">Only the latest 100 resolved snapshots are listed.</Text>}
      {buildInput && <Card withBorder><Stack gap="xs">
        <Text className="sb-silk">Build input · snapshot {buildInput.snapshot_sha256.slice(0, 16)}</Text>
        {buildInput.choices.map((choice) => <Text key={choice.option_key} size="sm" style={{ fontFamily: 'var(--sb-font-data)' }}>{choice.option_key} = {choice.revision_id ?? choice.value ?? 'none'} ({choice.source})</Text>)}
        <Text className="sb-silk">{buildInput.pins.length} exact revision pins</Text>
        {buildInput.constraints && <Group gap="xs"><SbStatus led={OUTCOME_LED[buildInput.constraints.outcome]} dimension="captured constraints" value={OUTCOME_LABEL[buildInput.constraints.outcome]} />
          {buildInput.constraints.unknown.length > 0 && <Text size="sm">Unknown: {buildInput.constraints.unknown.join(', ')}</Text>}
          {buildInput.constraints.invalid.length > 0 && <Text size="sm">Invalid: {buildInput.constraints.invalid.join(', ')}</Text>}</Group>}
      </Stack></Card>}
    </>}
  </Stack>;
}
