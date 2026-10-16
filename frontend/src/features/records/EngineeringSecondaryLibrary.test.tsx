import { MantineProvider } from '@mantine/core';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { PermissionsProvider } from '../../lib/permissions';
import { SecondaryRecordPage, type SecondaryRecordProps } from './SecondaryRecordPage';
import { engineeringSecondaryConfig } from './EngineeringSecondaryLibrary';
import { secondaryPins, secondaryContentSignature, authorizeSecondaryContent } from './secondary-authority';
import type { Content } from '../parts/api';
import { emptyFormula } from '../preparation/api';
import { emptyProfile as blankEnd } from '../end-preparation/api';
import { blankAssertion, blankComparison } from '../pcb-disagreement/api';
const reply=(value:unknown,status=200)=>new Response(JSON.stringify(value),{status});
const stock='10000000-0000-0000-0000-000000000001',source='10000000-0000-0000-0000-000000000002',root='10000000-0000-0000-0000-000000000003';
const graph={root_revision_id:root,snapshot_id:'root-snapshot',snapshot_sha256:'a'.repeat(64),occurrence_path:[],nodes:[],edges:[],boundaries:[],components:[],selected_component_id:null,continuity:'not_evaluated',compatibility:'not_evaluated',physical_qualification:'not_evaluated',limitations:[]};
const cases:[string,string,Content][]=[
 ['preparation','preparation_profile',{preparation_profile:{stock_revision_id:stock,formulas:[{...emptyFormula(1),label:'Synthetic cut'}]},opaque:['preserved']}],
 ['end-preparation','end_preparation_profile',{end_preparation_profile:{...blankEnd(),stock_revision_id:stock},opaque:['preserved']}],
 ['pcb-disagreement','pcb_assertion',{pcb_assertion:{...blankAssertion(),source:{source_revision_id:source,manifest_sha256:'b'.repeat(64),path:'synthetic.sch',sha256:'c'.repeat(64),rights:'Synthetic'},coverage_basis:'Independent declaration'},opaque:['preserved']}],
 ['pcb-disagreement','pcb_comparison',{pcb_comparison:blankComparison(),opaque:['preserved']}],
 ['passive-passages','passage_model',{passages:{root_revision_id:root,assumptions:'ideal_lumped_components',model_basis:'Ideal synthetic model',passages:[],conditions:[]},opaque:['preserved']}],
];
beforeEach(()=>vi.stubGlobal('ResizeObserver',class{observe(){}disconnect(){}unobserve(){}}));
afterEach(()=>{cleanup();vi.unstubAllGlobals();});
function serve(kind:string,content:Content){let denied=false,reviewDenied=false;const deniedSources=new Set<string>();const readRequests:Record<string,unknown>[]=[],calls:string[]=[],commands:{operation:string;expected_state:string;payload:Record<string,unknown>}[]=[];
 vi.stubGlobal('fetch',vi.fn(async(path:string,options?:RequestInit)=>{calls.push(path);if(path.endsWith('/preparation/compute')){const body=JSON.parse(String(options?.body));readRequests.push(body);return reply({revision_id:body.revision_id,sha256:'a'.repeat(64),quantity:body.quantity,physical_piece_count:null,rows:[],unprofiled_sections:[]});}if(options?.method==='POST'){const body=JSON.parse(String(options.body));commands.push(body);return reply({result:body.operation.endsWith('.freeze')?{number:8,draft:{draft_id:'own-draft',state:'draft-v10',content,base_revision_id:'own-r8'}}:{draft_id:'own-draft',state:'draft-v9',content:body.payload.changes??body.payload.content,base_revision_id:'own-r7'}});}
 if(path.includes('/record?'))return denied?reply({error:{message:'Selected secondary unavailable'}},403):reply({definition_id:'own-definition',workspace_id:'workspace',kind,name:'Synthetic secondary',selected:path.includes('working=true')?{kind:'draft',draft_id:'own-draft',state:'draft-v8',content,base_revision_id:'own-r7'}:{kind:'revision',revision_id:'own-r7',number:7,snapshot_id:'own-snapshot',sha256:'d'.repeat(64),content}});
 if(path.includes('revision-labels')){const p=new URL(path,'http://synthetic').searchParams;return reply({labels:p.getAll('revision_ids').map(revision_id=>({revision_id,readable:!denied,name:'Synthetic reference',number:1})),source_labels:p.getAll('source_revision_ids').map(revision_id=>({revision_id,readable:!denied&&!deniedSources.has(revision_id),name:'Synthetic source',number:1}))});}
 if(path.includes('/workspaces/workspace/definitions'))return reply([]);
 if(path.includes('/snapshot'))return reply({content:{stock:{structure:{id:'stock',kind:'group',children:[]}}}});
 if(path.includes('copper/revisions'))return reply(graph);
 if(path.includes('passive-passages/revisions'))return reviewDenied?reply({error:{message:'Current passive review evidence denied'}},403):reply({revision_id:'own-r7',snapshot_id:'own-snapshot',sha256:'d'.repeat(64),model:content.passages,graph,state:'passage-review-v0',decision:'unreviewed',reviews:[]});
 if(path.includes('pcb-disagreement/revisions')||path.includes('pcb-disagreement/drafts'))return reply({definition_id:'own-definition',draft_id:'own-draft',revision_id:'own-r7',state:'draft-v8',content,projection:{parity:'not_evaluated',physical_qualification:'not_evaluated'}});
 return reply({results:[],revisions:[],files:[],labels:[],source_labels:[],next_after:null});}));return{readRequests,calls,commands,deny:(value:boolean)=>{denied=value;},denyReview:(value:boolean)=>{reviewDenied=value;},denySource:(id:string,value:boolean)=>{if(value)deniedSources.add(id);else deniedSources.delete(id);}};}
function mount(tool:string,kind:string,changes:Partial<SecondaryRecordProps>={},permissions=['workspace.read','item.create','design.edit','design.freeze']){
 const config=engineeringSecondaryConfig(tool,'owner','workspace',kind);const props:SecondaryRecordProps={...config,active:true,principalKey:'owner',workspaceId:'workspace',definitionId:'own-definition',revisionNumber:7,draftRequested:false,onCreated:vi.fn(),onSelect:vi.fn(),onBack:vi.fn(),...changes};
 const cache=new QueryClient({defaultOptions:{queries:{retry:false}}});return{props,...render(<MantineProvider env="test"><QueryClientProvider client={cache}><PermissionsProvider permissions={permissions}><SecondaryRecordPage {...props}/></PermissionsProvider></QueryClientProvider></MantineProvider>)};
}
test.each(cases)('%s %s opens its own exact revision and preserves its identity independently of the parent',async(tool,kind,content)=>{
 const api=serve(kind,content),view=mount(tool,kind);await screen.findByRole('heading',{name:'Synthetic secondary'});expect(api.calls.some(path=>path.includes('/definitions/own-definition/record?revision_number=7'))).toBe(true);expect(api.calls.some(path=>path.includes('/catalog/definitions/own-definition?'))).toBe(false);
 fireEvent.click(screen.getByRole('tab',{name:'Exact identity'}));await screen.findAllByText('own-r7');expect(screen.queryByText('New passive model name')).toBeNull();expect(screen.queryByLabelText('Existing preparation definition')).toBeNull();expect(api.commands).toHaveLength(0);fireEvent.click(screen.getByRole('button',{name:'Continue draft'}));expect(view.props.onSelect).toHaveBeenCalledWith(null,true);
});
test.each(cases)('%s %s retains its saved CAS and uses the registered typed freeze operation',async(tool,kind,content)=>{
 const api=serve(kind,content),view=mount(tool,kind,{revisionNumber:null,draftRequested:true});await screen.findByRole('heading',{name:'Synthetic secondary'});fireEvent.click(screen.getByRole('button',{name:'Freeze saved draft'}));await waitFor(()=>expect(api.commands).toHaveLength(1));expect(api.commands[0]).toMatchObject({operation:engineeringSecondaryConfig(tool,'owner','workspace').freezeOperation,expected_state:'draft-v8',payload:{draft_id:'own-draft'}});expect(view.props.onSelect).toHaveBeenCalledWith(8,false);
});
test('retained authored formulas withdraw on current source denial and restore original values/CAS',async()=>{
 const [tool,kind,content]=cases[0]!,api=serve(kind,content);mount(tool,kind,{revisionNumber:null,draftRequested:true});const label=await screen.findByLabelText('Formula 1 label');label.focus();fireEvent.change(label,{target:{value:'Local'}});fireEvent.change(label,{target:{value:'Local retained'}});fireEvent.change(label,{target:{value:'Local retained formula'}});expect(document.activeElement).toBe(label);api.deny(true);fireEvent(window,new Event('focus'));await screen.findByText('Selected secondary unavailable');expect(screen.queryByRole('textbox',{name:'Formula 1 label'})).toBeNull();api.deny(false);fireEvent.click(screen.getByRole('button',{name:'Refresh access'}));await waitFor(()=>expect(screen.getByRole('textbox',{name:'Formula 1 label'})).toHaveProperty('value','Local retained formula'));fireEvent.click(screen.getByRole('button',{name:'Save draft'}));await waitFor(()=>expect(api.commands[0]).toMatchObject({expected_state:'draft-v8',payload:{changes:{opaque:['preserved'],preparation_profile:{formulas:[{label:'Local retained formula'}]}}}}));
});
test('reference signature includes unsaved source and end bond pins without treating formula text as authority',()=>{
 const original=cases[0]![2], changed=structuredClone(original);(changed.preparation_profile as {formulas:{label:string}[]}).formulas[0]!.label='Local basis change';expect(secondaryContentSignature(changed)).toBe(secondaryContentSignature(original));
 const end={...blankEnd(),stock_revision_id:stock,a:{review:'unreviewed',review_basis:null,instructions:[{kind:'bond_expectation',local_id:'bond',element_path:'stock.shield',basis:null,source:{kind:'source_file',bundle_revision_id:source,path:'test.txt',sha256:'a'.repeat(64),rights:'Synthetic',locator:''},treatment:'bond',target:{kind:'endpoint_contact',body_revision_id:root,contact_id:'shell'}}]}};
 expect(secondaryPins({end_preparation_profile:end})).toMatchObject({revisions:[stock,root].sort(),sources:[source]});expect(secondaryContentSignature({end_preparation_profile:end})).not.toBe(secondaryContentSignature(original));
});
test('exact native board comparison pin rechecks its real source intake before disclosure',async()=>{
 const paths:string[]=[];vi.stubGlobal('fetch',vi.fn(async(path:string)=>{paths.push(path);if(path.includes('revision-labels'))return reply({labels:[],source_labels:[{revision_id:source,readable:true}]});if(path.includes('sources/revisions'))return reply({workspace_id:'source-workspace'});if(path.includes('workspaces/source-workspace/intakes'))return reply([{intake_id:'exact-intake',source_revision_id:source}]);return reply({interpretations:[{interpretation_id:'native-exact'}]});}));
 const value={...blankComparison(),left:{kind:'pcb_interpretation',interpretation_id:'native-exact',report_sha256:'d'.repeat(64),source:{source_revision_id:source,manifest_sha256:'b'.repeat(64),path:'test.pcb',sha256:'c'.repeat(64),rights:'Synthetic'}}};await authorizeSecondaryContent({pcb_comparison:value},'workspace');expect(paths).toContain('/api/v0/pcb/intakes/exact-intake');
});

test('a newly authored source pin is separately rechecked before retained formulas reappear',async()=>{
 const [tool,kind]=cases[0]!,content={preparation_profile:{stock_revision_id:stock,formulas:[{...emptyFormula(1),label:'Retained source formula',allowances:[{local_id:'a',kind:'preparation',scope:'whole_piece',amount_mm:null,basis:'Independent source',source:{kind:'source_file',bundle_revision_id:source,path:'original.txt',locator:'row1',sha256:'a'.repeat(64),rights:'Synthetic'}}]}]}};
 const api=serve(kind,content), newSource='10000000-0000-0000-0000-000000000009';api.denySource(newSource,true);mount(tool,kind,{revisionNumber:null,draftRequested:true});
 fireEvent.change(await screen.findByLabelText('Formula 1 allowance 1 source bundle_revision_id'),{target:{value:newSource}});await screen.findByText('A working reference is unavailable. Local edits and the original editing token are retained.');expect(screen.queryByRole('textbox',{name:'Formula 1 label'})).toBeNull();
 api.denySource(newSource,false);fireEvent.click(screen.getByRole('button',{name:'Refresh access'}));await waitFor(()=>expect(screen.getByRole('textbox',{name:'Formula 1 allowance 1 source bundle_revision_id'})).toHaveProperty('value',newSource));fireEvent.click(screen.getByRole('button',{name:'Save draft'}));await waitFor(()=>expect(api.commands[0]).toMatchObject({operation:'draft.update',expected_state:'draft-v8',payload:{changes:{preparation_profile:{formulas:[{allowances:[{source:{bundle_revision_id:newSource}}]}]}}}}));
});

test('current passive review authority gates the whole frozen record before any disclosure',async()=>{
 const [tool,kind,content]=cases[4]!,api=serve(kind,content);api.denyReview(true);mount(tool,kind);await screen.findByText('Current passive review evidence denied');expect(screen.queryByRole('heading',{name:'Synthetic secondary'})).toBeNull();expect(screen.queryByRole('button',{name:'Interpret exact reviewed model'})).toBeNull();expect(api.calls.filter(path=>path.includes('/record?'))).toHaveLength(1);
 api.denyReview(false);fireEvent.click(screen.getByRole('button',{name:'Refresh access'}));await screen.findByRole('heading',{name:'Synthetic secondary'});expect(api.calls.filter(path=>path.includes('/record?'))).toHaveLength(2);
});

test('profile application starts from its own exact revision and remains a read with unknown quantity',async()=>{
 const [tool,kind,content]=cases[0]!,api=serve(kind,content);mount(tool,kind);await screen.findByRole('heading',{name:'Synthetic secondary'});fireEvent.change(await screen.findByLabelText('Preparation subject exact revision ID'),{target:{value:root}});fireEvent.change(screen.getByLabelText('Requested units'),{target:{value:''}});fireEvent.click(screen.getByRole('button',{name:'Compute preparation cuts'}));await waitFor(()=>expect(api.readRequests).toEqual([{revision_id:root,applications:[{section_id:null,profile_revision_id:'own-r7'}],quantity:null}]));expect(api.commands).toHaveLength(0);
 fireEvent.click(screen.getByRole('tab',{name:'Exact identity'}));fireEvent(window,new Event('focus'));await screen.findByRole('heading',{name:'Synthetic secondary'});expect(api.readRequests).toHaveLength(1);
});
