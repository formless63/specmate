import { Alert, Stack, Text } from '@mantine/core';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import type { SecondaryContext } from '../records/SecondaryRecordPage';
import { requestJson } from '../workspace/api';
import type { Definition } from '../identity/api';
import { ApplyPreparation } from '../end-preparation/ApplyPreparation';
import { ApplyHarnessPreparation } from '../end-preparation/ApplyHarnessPreparation';
import { CutCalculation } from './CutCalculation';
/** Each exact profile retains separate read-only application inputs; no parent design is edited. */
export function ProfileApplications({context,scopeKey,workspaceId,end=false}:{context:SecondaryContext;scopeKey:string;workspaceId:string;end?:boolean}){
 const revision=context.selected?.kind==='revision'?context.selected.revision_id:null, active=context.active&&context.inspectorTab==='applications';
 const [visited,setVisited]=useState<string[]>([]);
 useEffect(()=>{if(active&&revision)setVisited(current=>current.includes(revision)?current:[...current,revision]);},[active,revision]);
 const definitions=useQuery({queryKey:['secondary-application-choices',scopeKey],enabled:active,retry:false,refetchOnWindowFocus:'always',queryFn:()=>requestJson<Definition[]>(`/api/v0/workspaces/${workspaceId}/definitions`,{cache:'no-store'})});
 const choices=active&&!definitions.isError&&!definitions.isFetching?definitions.data??[]:[];
 return <Stack>{!revision&&<Text>Choose a frozen profile to apply its exact declarations. Application reads never alter designs or establish physical qualification.</Text>}{definitions.error&&<Alert color="red">{definitions.error.message}</Alert>}{visited.map(id=><div key={id} hidden={!active||revision!==id} inert={!active||revision!==id||undefined}>
  {end?<><ApplyPreparation definitions={choices} profileRevisionId={id} scopeKey={scopeKey} hidden={!active||revision!==id}/><ApplyHarnessPreparation definitions={choices} profileRevisionId={id} scopeKey={scopeKey} hidden={!active||revision!==id}/></>:<CutCalculation definitions={choices} profileRevisionId={id} scopeKey={scopeKey} active={active&&revision===id}/>}
 </div>)}</Stack>;
}
