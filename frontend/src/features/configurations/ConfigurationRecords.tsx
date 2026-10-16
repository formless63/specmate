import type { SecondaryConfig, SecondaryLibraryProps } from '../records/SecondaryLibrary';
import { SecondaryLibrary } from '../records/SecondaryLibrary';
import { useNavigation } from '../navigation';
import { useProbe } from '../probe';
import { authorizeSecondary, secondaryPins } from '../assemblies/secondary-authority';
import { OptionSetFields } from './OptionSetFields';
import { ConfigurationFields } from './ConfigurationFields';
import { ConfigurationResolution } from './ConfigurationResolution';
import { emptyOptionSet, parseOptionSet, serializeOptionSet, validateOptionSet } from './optionSet';
import type { ConfigurationBody } from './api';
import { Button, Group } from '@mantine/core';
import { usePermission } from '../../lib/permissions';

const blankConfiguration=():ConfigurationBody=>({schema_version:'0.1',option_set_revision_id:'',selections:[]});
export function configurationConfig(kind:'option_set'|'configuration',scopeKey:string,projectId:string|null=null,allowBoth=false):SecondaryConfig {
 const optionSet=kind==='option_set';
 const isOption=(context:{record:{kind:string}|null;content:Record<string,unknown>})=>context.record?context.record.kind==='option_set':!!context.content.option_set;
 return {title:allowBoth?'Options and configurations':optionSet?'Option set':'Configuration',collectionLabel:'Options and configurations',viewLabel:allowBoth?'Declarations':optionSet?'Options':'Selections',allowedKinds:allowBoth?['option_set','configuration']:[kind],createPermission:optionSet?'item.create':'design.edit',
 initial:{kind,content:optionSet?serializeOptionSet(emptyOptionSet()):{configuration:blankConfiguration()}},
 authorizeContent:authorizeSecondary,contentSignature:content=>JSON.stringify(secondaryPins(content)),
 canSave:context=>isOption(context)?!validateOptionSet(parseOptionSet(context.content)).length:!!(context.content.configuration as ConfigurationBody|undefined)?.option_set_revision_id,
 canFreeze:context=>isOption(context)&&!validateOptionSet(parseOptionSet(context.content)).length,
 renderContent:context=>isOption(context)?<OptionSetFields scopeKey={scopeKey} body={parseOptionSet(context.content)} onChange={value=>context.change({...context.content,...serializeOptionSet(value)})} active={context.active} editable={context.editable} onDenied={context.refreshAccess}/>:<ConfigurationFields value={(context.content.configuration as ConfigurationBody|undefined)??blankConfiguration()} onChange={value=>context.change({...context.content,configuration:value})} active={context.active} editable={context.editable} scopeKey={scopeKey} onDenied={context.refreshAccess}/>,
 inspector:context=>isOption(context)?[]:[{id:'resolution',label:'Resolution and captures',content:()=> <ConfigurationResolution context={{...context,active:context.active&&context.inspectorTab==='resolution'}} scopeKey={scopeKey} projectId={projectId}/>}],
 };
}
export function ConfigurationLibrary(props:Omit<SecondaryLibraryProps,'toolId'|'config'>) {
 const nav=useNavigation(),probe=useProbe(),create=usePermission('item.create'),edit=usePermission('design.edit');
 const kind=nav?.location.filters?.kind==='option_set'?'option_set':'configuration';
 const start=(kind:'option_set'|'configuration')=>nav?.navigate({area:'designs',lens:'configurations',probe:null,filters:{status:'new',kind}});
 return <>{!probe?.probe&&nav?.location.filters?.status!=='new'&&<Group>{create.allowed&&<Button onClick={()=>start('option_set')}>New option set</Button>}{edit.allowed&&<Button onClick={()=>start('configuration')}>New configuration</Button>}</Group>}<SecondaryLibrary {...props} toolId="configurations" config={configurationConfig(kind,`${props.principalKey}:${props.workspaceId}`,props.projectFilterId,!!probe?.probe)}/></>;
}
