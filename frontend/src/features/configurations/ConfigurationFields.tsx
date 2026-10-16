import { Alert, NativeSelect, Stack, Text } from '@mantine/core';
import { useQuery } from '@tanstack/react-query';
import { useEffect } from 'react';
import { RevisionPicker } from '../cables/RevisionPicker';
import { ApiError, requestJson } from '../workspace/api';
import { parseOptionSet } from './optionSet';
import type { ConfigurationBody } from './api';
/** Local selection authoring; defaults remain absent selections rather than invented choices. */
export function ConfigurationFields({value,onChange,active,editable,scopeKey,onDenied}:{value:ConfigurationBody;onChange:(value:ConfigurationBody)=>void;active:boolean;editable:boolean;scopeKey:string;onDenied:()=>void}) {
 const optionSet=useQuery({queryKey:['configuration-option-set',scopeKey,value.option_set_revision_id],enabled:active&&!!value.option_set_revision_id,retry:false,queryFn:()=>requestJson<{content:unknown}>(`/api/v0/revisions/${encodeURIComponent(value.option_set_revision_id)}/snapshot`,{cache:'no-store'})});
 useEffect(()=>{if(optionSet.error instanceof ApiError&&[401,403,404].includes(optionSet.error.status))onDenied();},[optionSet.error]);
 const options=active&&!optionSet.isFetching&&!optionSet.error?parseOptionSet(optionSet.data?.content).options:[];
 return <Stack><Text size="sm">A configuration pins one frozen option set. Save declarations, then review and capture the saved resolution. Capturing does not release or approve a design.</Text>
  <RevisionPicker label="Option set" kind="option_set" value={value.option_set_revision_id} onChange={id=>onChange({...value,option_set_revision_id:id})} onAccessDenied={onDenied}/>
  {optionSet.error&&<Alert color="red">{optionSet.error.message}</Alert>}
  {options.map(option=>{const selected=value.selections.find(row=>row.option_key===option.key);const choices=[{value:'',label:option.default_choice?'Use declared default':'No selection'},...(!option.required?[{value:'__none__',label:'Explicitly none'}]:[]),...option.choices.map(choice=>({value:choice.key,label:choice.label||choice.key}))];return <NativeSelect key={option.key} label={`Selection for ${option.label||option.key}`} value={selected?selected.choice_key??'__none__':''} disabled={!editable} data={choices} onChange={event=>{const chosen=event.currentTarget.value;onChange({...value,selections:[...value.selections.filter(row=>row.option_key!==option.key),...(chosen?[{option_key:option.key,choice_key:chosen==='__none__'?null:chosen}]:[])]});}}/>;})}
  {value.selections.filter(row=>!options.some(option=>option.key===row.option_key)).map(row=><Text key={row.option_key}>Retained undeclared selection: {row.option_key} = {row.choice_key??'explicitly none'}. Review its resolution before changing it.</Text>)}
 </Stack>;
}
