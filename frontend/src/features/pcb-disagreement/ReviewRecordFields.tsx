import { Alert, Button, Select, Stack, Text, TextInput } from '@mantine/core';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { exactUuid } from '../boards/working-authority';
import { RevisionLabel } from '../../lib/IdentityLabel';
import type { SecondaryContext } from '../records/SecondaryRecordPage';
import { requestJson } from '../workspace/api';
import { canonical } from '../parts/api';
import { AssertionEditor, ComparisonEditor } from './Editors';
import { ProjectionView } from './ProjectionView';
import { blankSource, type Assertion, type Comparison, type Draft, type FilePin, type Frozen, type SourceFiles } from './api';

type SourcePage={revisions:{revision_id:string;name:string;number:number;role:string}[];next_after:string|null};
function SourceChoice({value,change,context,workspaceId,scopeKey}:{value:FilePin;change:(v:FilePin)=>void;context:SecondaryContext;workspaceId:string;scopeKey:string}){
 const [after,setAfter]=useState<string|null>(null),[supplied,setSupplied]=useState(value.source_revision_id);
 const sources=useQuery({queryKey:['secondary-review-sources',scopeKey,after],enabled:context.active,retry:false,queryFn:()=>requestJson<SourcePage>(`/api/v0/sources/workspaces/${workspaceId}/revisions${after?`?after=${encodeURIComponent(after)}`:''}`,{cache:'no-store'})});
 const files=useQuery({queryKey:['secondary-review-files',scopeKey,value.source_revision_id],enabled:context.active&&!!value.source_revision_id,retry:false,refetchOnWindowFocus:'always',queryFn:()=>requestJson<SourceFiles>(`/api/v0/pcb-disagreement/sources/${encodeURIComponent(value.source_revision_id)}`,{cache:'no-store'})});
 useEffect(()=>{if(context.active&&files.isError)context.refreshAccess();},[context.active,files.isError,files.error]);
 const rows=context.active&&!sources.isError&&!sources.isFetching?sources.data?.revisions??[]:[], entries=context.active&&!files.isError&&!files.isFetching?files.data?.files??[]:[];
 return <Stack><RevisionLabel kind="source" id={value.source_revision_id||null} role="Preserved source"/><Select label="Preserved source bundle" searchable value={rows.some(row=>row.revision_id===value.source_revision_id)?value.source_revision_id:null} data={rows.map(row=>({value:row.revision_id,label:`${row.name} · r${row.number} (${row.role})`}))} onChange={id=>{setSupplied(id??'');change({...blankSource(),source_revision_id:id??''});}}/><Button variant="quiet" disabled={!sources.data?.next_after} onClick={()=>setAfter(sources.data?.next_after??null)}>More preserved sources</Button><Select label="Preserved source file" searchable value={value.path||null} data={entries.map(row=>row.path)} onChange={path=>{const file=entries.find(row=>row.path===path);if(file)change(file);}}/>{[sources.error,files.error].filter(Boolean).map((error,index)=><Alert key={index} color="red">{error!.message}</Alert>)}<details><summary>Advanced: exact preserved source</summary><TextInput label="Exact preserved source revision ID" value={supplied} onChange={event=>setSupplied(event.currentTarget.value)}/><Button disabled={!exactUuid(supplied)} onClick={()=>change({...blankSource(),source_revision_id:supplied})}>Use exact preserved source</Button><Text>{value.source_revision_id} · {value.path} · {value.sha256} · {value.rights||'Rights unknown'}</Text></details></Stack>;
}
export function ReviewRecordFields({context,workspaceId,scopeKey}:{context:SecondaryContext;workspaceId:string;scopeKey:string}){
 const {content,change,active,editing,selected}=context, assertion=content.pcb_assertion as Assertion|undefined, comparison=content.pcb_comparison as Comparison|undefined;
 const projection=useQuery({queryKey:['secondary-review-projection',scopeKey,selected?.kind==='draft'?selected.draft_id:selected?.revision_id,selected?.kind==='draft'?selected.state:'frozen'],enabled:active&&!!selected,retry:false,staleTime:0,refetchOnWindowFocus:'always',queryFn:()=>requestJson<Draft|Frozen>(`/api/v0/pcb-disagreement/${selected!.kind==='draft'?`drafts/${selected!.draft_id}`:`revisions/${selected!.revision_id}`}`,{cache:'no-store'})});
 useEffect(()=>{if(active&&projection.isError)context.refreshAccess();},[active,projection.isError,projection.error]);
 const saved=active&&!projection.isFetching&&!projection.isError?projection.data:undefined;
 const pinsCurrent=!!comparison&&!!saved?.content.pcb_comparison&&canonical([comparison.left,comparison.right])===canonical([saved.content.pcb_comparison.left,saved.content.pcb_comparison.right]);
 const findingsCurrent=pinsCurrent&&canonical(comparison?.correspondences)===canonical(saved?.content.pcb_comparison?.correspondences);
 return <Stack><Text>Independent source statements and comparison findings do not choose a correct source or establish physical qualification.</Text>
  {editing&&assertion&&<AssertionEditor value={assertion} onChange={value=>change({...content,pcb_assertion:value})} onDenied={()=>{}} sourceControls={<SourceChoice context={context} value={assertion.source} change={source=>change({...content,pcb_assertion:{...assertion,source}})} workspaceId={workspaceId} scopeKey={scopeKey}/>}/>}
  {editing&&comparison&&<ComparisonEditor scopeKey={scopeKey} active={active} workspaceId={workspaceId} value={comparison} onChange={value=>change({...content,pcb_comparison:value})} projection={saved?.projection} sourcePinsCurrent={pinsCurrent} onDenied={denied=>{if(denied&&active)context.refreshAccess();}}/>}
  {projection.isError&&<Alert color="red">{projection.error.message}</Alert>}{saved&&<ProjectionView projection={saved.projection} reviewValue={context.editable&&findingsCurrent?comparison:undefined} onReviewChange={value=>change({...content,pcb_comparison:value})}/>}
 </Stack>;
}
