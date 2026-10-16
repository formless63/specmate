import type { PartRecord } from '../parts/api';
import { usePermission } from '../../lib/permissions';
import { Button, Group } from '@mantine/core';
import { useNavigation } from '../navigation';
import { emptyProfile as blankPreparation, type Profile as Preparation } from '../preparation/api';
import { emptyProfile as blankEndPreparation } from '../end-preparation/api';
import { ProfileApplications } from '../preparation/ProfileApplications';
import { PreparationRecordFields } from '../preparation/PreparationRecordFields';
import { blankAssertion, blankComparison } from '../pcb-disagreement/api';
import { ReviewRecordFields } from '../pcb-disagreement/ReviewRecordFields';
import { PassageRecordFields } from '../passive-passages/PassageRecordFields';
import type { Model } from '../passive-passages/api';
import { SecondaryLibrary, type SecondaryConfig, type SecondaryLibraryProps } from './SecondaryLibrary';
import { authorizeSecondaryContent, secondaryContentSignature } from './secondary-authority';
export type EngineeringSecondaryProps=Omit<SecondaryLibraryProps,'config'>;
export function EngineeringSecondaryLibrary(props:EngineeringSecondaryProps){
 const create=usePermission('item.create'),nav=useNavigation(), {toolId,principalKey,workspaceId}=props;
 const config=engineeringSecondaryConfig(toolId,principalKey,workspaceId,nav?.location.filters?.kind);
 return <>{props.active&&toolId==='pcb-disagreement'&&!nav?.location.probe&&<Group><Button {...create.props} variant="quiet" onClick={()=>create.allowed&&nav?.navigate({filters:{status:'new',kind:'pcb_assertion'}})}>New human assertion</Button><Button {...create.props} variant="quiet" onClick={()=>create.allowed&&nav?.navigate({filters:{status:'new',kind:'pcb_comparison'}})}>New independent comparison</Button></Group>}<SecondaryLibrary {...props} config={config}/></>;
}

export function engineeringSecondaryConfig(toolId:string,principalKey:string,workspaceId:string,newKind?:string):SecondaryConfig {
 const scopeKey=`${principalKey}:${workspaceId}`;
 const common={contentSignature:secondaryContentSignature,authorizeContent:(content:Record<string,unknown>, selected?:PartRecord)=>authorizeSecondaryContent(content,workspaceId,selected)};
 const configs:Record<string,SecondaryConfig>={
  preparation:{...common,title:'Preparation profile',collectionLabel:'Cut preparation profiles',viewLabel:'Formulas',allowedKinds:['preparation_profile'],freezeOperation:'preparation.freeze',initial:{kind:'preparation_profile',content:{preparation_profile:blankPreparation()}},canSave:ctx=>!!(ctx.content.preparation_profile as Preparation)?.stock_revision_id,inspector:context=>[{id:'applications',label:'Apply',content:()=> <ProfileApplications context={context} scopeKey={scopeKey} workspaceId={workspaceId}/>}],renderContent:context=><PreparationRecordFields context={context} scopeKey={scopeKey}/>},
  'end-preparation':{...common,title:'End preparation profile',collectionLabel:'End preparation profiles',viewLabel:'End instructions',allowedKinds:['end_preparation_profile'],freezeOperation:'end_preparation.freeze',initial:{kind:'end_preparation_profile',content:{end_preparation_profile:blankEndPreparation()}},canSave:ctx=>!!(ctx.content.end_preparation_profile as Preparation)?.stock_revision_id,inspector:context=>[{id:'applications',label:'Apply',content:()=> <ProfileApplications context={context} scopeKey={scopeKey} workspaceId={workspaceId} end/>}],renderContent:context=><PreparationRecordFields context={context} scopeKey={scopeKey} end/>},
  'pcb-disagreement':{...common,title:'PCB source review',collectionLabel:'PCB source reviews',viewLabel:'Assertions & findings',allowedKinds:['pcb_assertion','pcb_comparison'],freezeOperation:'pcb_disagreement.freeze',initial:newKind==='pcb_comparison'?{kind:'pcb_comparison',content:{pcb_comparison:blankComparison()}}:{kind:'pcb_assertion',content:{pcb_assertion:blankAssertion()}},renderContent:context=><ReviewRecordFields context={context} workspaceId={workspaceId} scopeKey={scopeKey}/>},
  'passive-passages':{...common,createPermission:'design.edit',title:'Passive model',collectionLabel:'Passive models',viewLabel:'Passages & interpretation',allowedKinds:['passage_model'],freezeOperation:'passage.freeze',initial:{kind:'passage_model',content:{passages:{root_revision_id:'',assumptions:'ideal_lumped_components',model_basis:'',conditions:[],passages:[]} satisfies Model}},canSave:ctx=>!!(ctx.content.passages as Model)?.root_revision_id&&!!(ctx.content.passages as Model)?.model_basis.trim(),renderContent:context=><PassageRecordFields context={context} principalKey={principalKey} workspaceId={workspaceId}/>}
 };
 return configs[toolId]!;
}
