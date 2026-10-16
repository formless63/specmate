import { Alert, Stack, Text } from '@mantine/core';
import { useQuery } from '@tanstack/react-query';
import { useEffect } from 'react';
import { RevisionLabel } from '../../lib/IdentityLabel';
import { BoardPassiveReview, PassageModelFields } from '../boards/BoardAdvanced';
import { FrozenDefinitionPicker } from '../boards/FrozenDefinitionPicker';
import type { Graph } from '../copper/api';
import type { SecondaryContext } from '../records/SecondaryRecordPage';
import { requestJson } from '../workspace/api';
import type { Inspection, Model } from './api';
export function PassageRecordFields({context,principalKey,workspaceId}:{context:SecondaryContext;principalKey:string;workspaceId:string}){
 const value=context.content.passages as Model|undefined, revision=context.selected?.kind==='revision'?context.selected.revision_id:null;
 const graph=useQuery({queryKey:['secondary-model-root',principalKey,workspaceId,value?.root_revision_id],enabled:context.active&&!!value?.root_revision_id,retry:false,staleTime:0,refetchOnWindowFocus:'always',queryFn:()=>requestJson<Graph>(`/api/v0/copper/revisions/${encodeURIComponent(value!.root_revision_id)}`,{cache:'no-store'})});
 const frozen=useQuery({queryKey:['secondary-model-frozen',principalKey,workspaceId,revision],enabled:context.active&&!!revision,retry:false,staleTime:0,refetchOnWindowFocus:'always',queryFn:()=>requestJson<Inspection>(`/api/v0/passive-passages/revisions/${revision}`,{cache:'no-store'})});
 useEffect(()=>{if(context.active&&(graph.isError||frozen.isError))context.refreshAccess();},[context.active,graph.isError,graph.error,frozen.isError,frozen.error]);
 if(!value)return <Text>Typed passive model content is unavailable.</Text>;
 const ready=context.active&&!graph.isError&&!graph.isFetching?graph.data:undefined;
 return <Stack><Text>Ideal model declarations are separate from native copper and physical measurements. Unknown component behavior remains unknown; model review is recorded independently.</Text>{[graph.error,frozen.error].filter(Boolean).map((error,index)=><Alert key={index} color="red">{error!.message}</Alert>)}
  {context.editing&&<><FrozenDefinitionPicker label="Model root" kinds={['board','pcb_population','cable','harness','assembly']} principalKey={principalKey} active={context.active} onPick={choice=>context.change({...context.content,passages:{...value,root_revision_id:choice.revision_id}})}/>{ready&&<PassageModelFields value={value} root={ready} disabled={!context.editable} onChange={model=>context.change({...context.content,passages:model})}/>}</>}
  {!context.editing&&frozen.data&&!frozen.isFetching&&!frozen.isError&&<><fieldset disabled style={{border:0,padding:0,minWidth:0}}><PassageModelFields value={frozen.data.model} root={frozen.data.graph} disabled onChange={()=>{}}/></fieldset><Stack>{frozen.data.assertion_evidence?.map(row=><Stack key={row.local_id} gap={2}><Text>{row.local_id} evidence · {row.evidence.status}</Text>{row.evidence.source_bundle_revision_id&&<RevisionLabel kind="source" id={row.evidence.source_bundle_revision_id} role="Exact evidence source"/>}<Text>{row.evidence.source_path} · {row.evidence.sha256} · {row.evidence.rights}</Text></Stack>)}</Stack><BoardPassiveReview review={frozen.data} active={context.active} principalKey={principalKey} workspaceId={workspaceId} onAccessLost={context.refreshAccess} onChanged={()=>void frozen.refetch()}/></>}
 </Stack>;
}
