import { Alert, Badge, Button, Checkbox, Group, NativeSelect, Stack, Table, Text, TextInput, Title } from '@mantine/core';
import { useEffect, useState } from 'react';
import { ApiError } from '../workspace/api';
import { operation, type AuthoringContext, type Described } from './api';
import { ConstraintEditor } from './ConstraintEditor';
import { useQuery } from '@tanstack/react-query';
import { RevisionPicker } from '../cables/RevisionPicker';
import { LIBRARY_VIEWS } from '../shell/scope';
import {
  blankChoice, blankConstraint, blankOption, DOMAIN_KINDS, DOMAINS, EXCLUDED_KINDS, OCCURRENCE_DOMAINS, REVISION_DOMAINS, validateOptionSet,
  type ChoiceBody, type Domain, type OptionBody, type OptionSetBody,
} from './optionSet';

type Occurrence = NonNullable<AuthoringContext['target']>['occurrences'][number];
/** Controlled declarations: record host owns Save, Freeze and the original CAS token. */
export function OptionSetFields({body,onChange,active,editable,onDenied,scopeKey}: {body:OptionSetBody;onChange:(body:OptionSetBody)=>void;active:boolean;editable:boolean;onDenied:()=>void;scopeKey:string}) {
 const pins=[...new Set(body.options.flatMap(option=>option.choices.map(choice=>choice.revision_id).filter((id):id is string=>!!id)))].sort();
 const signature=JSON.stringify([body.target_revision_id,pins]);
 const context=useQuery({queryKey:['option-set-authoring',scopeKey,signature],enabled:active,retry:false,queryFn:async()=>{
  const pages:AuthoringContext[]=[];
  for(let at=0;at<pins.length;at+=100) pages.push(await operation<AuthoringContext>('configuration.authoring_context',{revision_ids:pins.slice(at,at+100)}));
  if(body.target_revision_id) pages.push(await operation<AuthoringContext>('configuration.authoring_context',{target_revision_id:body.target_revision_id,revision_ids:[]}));
  return {target:pages.find(page=>page.target)?.target??null,revisions:pages.flatMap(page=>page.revisions)};
 }});
 useEffect(()=>{if(context.error instanceof ApiError&&[401,403,404].includes(context.error.status))onDenied();},[context.error]);
 const descriptions=active&&!context.isFetching&&!context.error?context.data:undefined;
 const described=Object.fromEntries((descriptions?.revisions??[]).map(row=>[row.revision_id,row]));
 const problems=validateOptionSet(body);
 return <Stack gap="sm">
  <Text size="sm">Choices pin exact frozen revisions or declare values. A declared default is used only when no explicit selection is saved. Compatibility remains unevaluated outside declared constraints.</Text>
  {context.error&&<Alert color="red">{context.error.message}<Button variant="quiet" onClick={onDenied}>Refresh record access</Button></Alert>}
  <RevisionPicker label="Target assembly" kind="assembly" value={body.target_revision_id??''} onChange={id=>onChange({...body,target_revision_id:id||null})} onAccessDenied={onDenied}/>
  {descriptions?.target&&<Text>{descriptions.target.name} · rev {descriptions.target.number}</Text>}
  {body.options.map((option,index)=><OptionEditor key={index} option={option} disabled={!editable} editable={editable} occurrences={descriptions?.target?.occurrences??[]} described={described} onChange={value=>onChange({...body,options:body.options.map((row,i)=>i===index?value:row)})} onRemove={()=>onChange({...body,options:body.options.filter((_,i)=>i!==index)})}/>)}
  {!body.options.length&&<Text>No options declared.</Text>}
  {editable&&<Button variant="quiet" onClick={()=>onChange({...body,options:[...body.options,blankOption(body)]})}>Add option</Button>}
  <Title order={5}>Constraints</Title><Text size="sm">Only declared rules are evaluated. Missing facts remain unknown.</Text>
  {body.constraints.map((rule,index)=><ConstraintEditor key={index} rule={rule} options={body.options} disabled={!editable} editable={editable} onChange={value=>onChange({...body,constraints:body.constraints.map((row,i)=>i===index?value:row)})} onRemove={()=>onChange({...body,constraints:body.constraints.filter((_,i)=>i!==index)})}/>)}
  {!body.constraints.length&&<Text>No constraints declared.</Text>}
  {editable&&<Group>{(['requires','excludes','fact_limit'] as const).map(kind=><Button key={kind} variant="quiet" disabled={body.options.length<(kind==='fact_limit'?1:2)} onClick={()=>onChange({...body,constraints:[...body.constraints,blankConstraint(body,kind)]})}>Add {kind==='fact_limit'?'fact limit':`${kind} rule`}</Button>)}</Group>}
  {!!problems.length&&<Alert color="yellow" title="Not yet valid">{problems.map(problem=><Text key={problem}>{problem}</Text>)}</Alert>}
 </Stack>;
}

function occurrenceLabel(item: Occurrence) {
  return `${item.display_ref ? `${item.display_ref} · ` : ''}${item.path.join('/')} · ${item.revision.name} rev ${item.revision.number}`;
}

type OptionEditorProps = {
  option: OptionBody; disabled: boolean; editable: boolean; occurrences: Occurrence[]; described: Record<string, Described>;
 onChange: (option: OptionBody) => void; onRemove: () => void;
};

function OptionEditor({ option, disabled, editable, occurrences, described, onChange, onRemove }: OptionEditorProps) {
  const occurrenceOnly = OCCURRENCE_DOMAINS.has(option.domain);
  const paths = occurrences.filter((item) => !occurrenceOnly || item.revision.kind === 'pcb_population');
  const path = option.path?.join('/') ?? '';
  const at = occurrences.find((item) => item.path.join('/') === path);
  const label = option.label.trim() || option.key;
  function setChoice(index: number, choice: ChoiceBody) {
    onChange({ ...option, choices: option.choices.map((item, position) => position === index ? choice : item) });
  }
  function removeChoice(index: number) {
    const removed = option.choices[index]?.key;
    onChange({ ...option, default_choice: option.default_choice === removed ? null : option.default_choice, choices: option.choices.filter((_, position) => position !== index) });
  }
  return <fieldset style={{ minWidth: 0, border: '1px solid var(--sb-border-subtle)', padding: 'var(--mantine-spacing-xs)', margin: 0 }}>
    <legend className="sb-silk">{label}</legend>
    <Stack gap="xs">
      <Group align="end" gap="xs">
        <TextInput label="Key" aria-label={`Key of ${label}`} disabled={disabled} value={option.key} w={140} onChange={(event) => onChange({ ...option, key: event.currentTarget.value })} />
        <TextInput label="Label" aria-label={`Label of ${label}`} disabled={disabled} value={option.label} onChange={(event) => onChange({ ...option, label: event.currentTarget.value })} />
        <NativeSelect label="Domain" aria-label={`Domain of ${label}`} disabled={disabled} value={option.domain} data={DOMAINS} onChange={(event) => onChange({ ...option, domain: event.currentTarget.value as Domain })} />
        <NativeSelect label="Occurrence" aria-label={`Occurrence of ${label}`} disabled={disabled || occurrences.length === 0} value={path}
          data={[{ value: '', label: occurrences.length ? (occurrenceOnly ? 'Select an occurrence' : 'Whole configuration') : 'No target occurrences' }, ...paths.map((item) => ({ value: item.path.join('/'), label: occurrenceLabel(item) }))]}
          onChange={(event) => { const value = event.currentTarget.value; onChange({ ...option, path: value ? value.split('/') : null }); }} />
        <NativeSelect label="Default" aria-label={`Default of ${label}`} disabled={disabled} value={option.default_choice ?? ''} data={[{ value: '', label: 'No default' }, ...option.choices.map((choice) => ({ value: choice.key, label: choice.label || choice.key }))]}
          onChange={(event) => onChange({ ...option, default_choice: event.currentTarget.value || null })} />
        <Checkbox label="Required" disabled={disabled} checked={option.required} onChange={(event) => onChange({ ...option, required: event.currentTarget.checked })} />
        {editable && <Button variant="risk" disabled={disabled} onClick={onRemove}>Remove option</Button>}
      </Group>
      {at && <Text className="sb-silk">Base pin at this occurrence: {at.revision.name} rev {at.revision.number}{at.revision.kind === 'pcb_population' ? ` · firmware ${at.firmware_revision_id ? at.firmware_revision_id.slice(0, 8) : 'unassigned'}` : ''}</Text>}
      <Table.ScrollContainer minWidth={620}><Table>
        <Table.Thead><Table.Tr><Table.Th>Choice key</Table.Th><Table.Th>Label</Table.Th><Table.Th>{REVISION_DOMAINS.has(option.domain) ? 'Exact revision' : 'Declared value'}</Table.Th><Table.Th>Notes</Table.Th><Table.Th /></Table.Tr></Table.Thead>
        <Table.Tbody>{option.choices.map((choice, index) => <ChoiceEditor key={index} option={option} choice={choice} disabled={disabled} editable={editable} at={at} described={described}
          onChange={(next) => setChoice(index, next)} onRemove={() => removeChoice(index)} />)}</Table.Tbody>
      </Table></Table.ScrollContainer>
      {editable && <Group><Button variant="quiet" disabled={disabled} onClick={() => onChange({ ...option, choices: [...option.choices, blankChoice(option)] })}>Add choice</Button></Group>}
    </Stack>
  </fieldset>;
}

type ChoiceEditorProps = {
  option: OptionBody; choice: ChoiceBody; disabled: boolean; editable: boolean; at: Occurrence | undefined; described: Record<string, Described>;
 onChange: (choice: ChoiceBody) => void; onRemove: () => void;
};

function ChoiceEditor({ option, choice, disabled, editable, at, described, onChange, onRemove }: ChoiceEditorProps) {
  const pinned = choice.revision_id ? described[choice.revision_id] : undefined;
  const [chosenPartKind,setPartKind]=useState<string|null>(null);
  const partKind=chosenPartKind??pinned?.kind??'part';
  const choiceKinds=[...new Set(['part','material','hardware',partKind,...Object.values(LIBRARY_VIEWS).filter(view=>view.family==='definition').flatMap(view=>view.kinds)])].filter(kind=>!EXCLUDED_KINDS.has(kind));
  const name = choice.label.trim() || choice.key;
  const declared = pinned?.declared_target?.population_revision_id;
  return <Table.Tr>
    <Table.Td><TextInput aria-label={`Choice key of ${name}`} disabled={disabled} value={choice.key} w={120} onChange={(event) => onChange({ ...choice, key: event.currentTarget.value })} /></Table.Td>
    <Table.Td><TextInput aria-label={`Choice label of ${name}`} disabled={disabled} value={choice.label} onChange={(event) => onChange({ ...choice, label: event.currentTarget.value })} /></Table.Td>
    <Table.Td>{REVISION_DOMAINS.has(option.domain) ? <Group gap="xs" wrap="nowrap">
      {option.domain==='part'&&<NativeSelect aria-label={`Choice kind for ${name}`} value={partKind} disabled={disabled} data={choiceKinds} onChange={event=>{setPartKind(event.currentTarget.value);onChange({...choice,revision_id:null,population_option_id:null});}}/>}
      <RevisionPicker label={`Choice ${name}`} kind={DOMAIN_KINDS[option.domain]??partKind} value={choice.revision_id??''} onChange={revision_id=>onChange({...choice,revision_id:revision_id||null,population_option_id:null})}/>
      {option.domain === 'population' && <NativeSelect aria-label={`Population option for ${name}`} disabled={disabled || !pinned} value={choice.population_option_id ?? ''}
        data={[{ value: '', label: pinned ? 'Select a population option' : 'Pin a revision first' }, ...(pinned?.population_options ?? []).map((item) => ({ value: item.local_id, label: item.name }))]}
        onChange={(event) => onChange({ ...choice, population_option_id: event.currentTarget.value || null })} />}
    </Group> : <TextInput aria-label={`Value for ${name}`} disabled={disabled} value={choice.value ?? ''} onChange={(event) => onChange({ ...choice, value: event.currentTarget.value })} />}</Table.Td>
    <Table.Td>
      {option.domain === 'firmware' && pinned && <Text size="sm">{!at ? 'Declared target not compared: choose an occurrence.' : declared === at.revision.revision_id ? 'Declares this occurrence’s exact population as its target.' : 'Declares a different population target than this occurrence; adoption will be blocked.'}</Text>}
      {choice.revision_id && !pinned && <Text size="sm">Pin not described yet.</Text>}
      {option.default_choice === choice.key && <Badge variant="outline">Default</Badge>}
    </Table.Td>
    <Table.Td>{editable && <Button variant="subtle" disabled={disabled} aria-label={`Remove choice ${name}`} onClick={onRemove}>Remove</Button>}</Table.Td>
  </Table.Tr>;
}
