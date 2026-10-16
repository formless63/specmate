import { MantineProvider, TextInput } from '@mantine/core';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { PermissionsProvider } from '../../lib/permissions';
import { SecondaryRecordPage, type SecondaryContext, type SecondaryRecordProps } from './SecondaryRecordPage';
const reply=(value:unknown,status=200)=>new Response(JSON.stringify(value),{status});
beforeEach(()=>vi.stubGlobal('ResizeObserver',class{observe(){} disconnect(){} unobserve(){}}));
afterEach(()=>{cleanup();vi.unstubAllGlobals();});
function Fields({content,change,editable}:SecondaryContext){const [partial,setPartial]=useState('');return <><TextInput label="Declared basis" readOnly={!editable} value={String(content.basis)} onChange={e=>change({...content,basis:e.currentTarget.value})}/><TextInput label="Incomplete add row" value={partial} onChange={e=>setPartial(e.currentTarget.value)}/></>;}
function mount(changes:Partial<SecondaryRecordProps>={}){
 const cache=new QueryClient({defaultOptions:{queries:{retry:false}}});
 const props:SecondaryRecordProps={active:true,principalKey:'owner',workspaceId:'workspace',definitionId:'secondary',revisionNumber:null,draftRequested:true,allowedKinds:['preparation_profile'],initial:{kind:'preparation_profile',content:{basis:''}},title:'Preparation profile',collectionLabel:'Preparation profiles',renderContent:ctx=><Fields {...ctx}/>,renderInspection:ctx=><p>Frozen basis: {String(ctx.content.basis)}</p>,onCreated:vi.fn(),onSelect:vi.fn(),onBack:vi.fn(),...changes};
 const tree=(next=props)=><MantineProvider env="test"><QueryClientProvider client={cache}><PermissionsProvider permissions={['workspace.read','item.create','design.edit','design.freeze']}><SecondaryRecordPage {...next}/></PermissionsProvider></QueryClientProvider></MantineProvider>;
 const view=render(tree());return {props,...view,rerender:(next:Partial<SecondaryRecordProps>)=>view.rerender(tree({...props,...next}))};
}
test('working editor sub-buffers survive frozen selection and authorization withdrawal, with original save CAS',async()=>{
 let denied=false;const commands:Record<string,unknown>[]=[];const paths:string[]=[];
 vi.stubGlobal('fetch',vi.fn(async(path:string,options?:RequestInit)=>{paths.push(path);if(options?.method==='POST'){const body=JSON.parse(String(options.body));commands.push(body);return reply({result:{draft_id:'draft',state:'draft-v8',content:body.payload.changes}});}return denied?reply({error:{message:'Access withdrawn'}},403):reply({definition_id:'secondary',workspace_id:'workspace',kind:'preparation_profile',name:'Synthetic preparation',selected:path.includes('revision_number=3')?{kind:'revision',number:3,revision_id:'historic',snapshot_id:'snapshot',sha256:'a'.repeat(64),content:{basis:'Historic'}}:{kind:'draft',draft_id:'draft',state:'draft-v7',content:{basis:'Saved'}}});}));
 const view=mount();fireEvent.change(await screen.findByLabelText('Declared basis'),{target:{value:'Local edit'}});fireEvent.change(screen.getByLabelText('Incomplete add row'),{target:{value:'Unsubmitted row'}});
 view.rerender({revisionNumber:3,draftRequested:false});await screen.findByText('Frozen basis: Historic');expect((screen.getByLabelText('Incomplete add row') as HTMLInputElement).value).toBe('Unsubmitted row');
 fireEvent.click(screen.getByRole('button',{name:'Versions'})); await screen.findByRole('dialog',{name:'Preparation profile versions'}); denied=true; fireEvent(window,new Event('focus'));await screen.findByText('Access withdrawn'); await waitFor(()=>expect(screen.queryByRole('dialog')).toBeNull()); expect(screen.queryByRole('textbox',{name:'Incomplete add row'})).toBeNull();
 denied=false;view.rerender({revisionNumber:null,draftRequested:true});await waitFor(()=>expect(screen.getByRole('textbox',{name:'Declared basis'})).toHaveProperty('value','Local edit'));
 expect((screen.getByRole('textbox',{name:'Incomplete add row'}) as HTMLInputElement).value).toBe('Unsubmitted row');fireEvent.click(screen.getByRole('button',{name:'Save draft'}));await screen.findByText('Saved working draft.');expect(commands[0]).toMatchObject({operation:'draft.update',expected_state:'draft-v7',payload:{draft_id:'draft',changes:{basis:'Local edit'}}});expect(paths.some(path=>path.includes('/catalog/definitions/secondary?'))).toBe(false);
});
test('a wrong returned kind withdraws content instead of showing an initial fallback editor',async()=>{
 vi.stubGlobal('fetch',vi.fn(async()=>reply({definition_id:'secondary',workspace_id:'workspace',kind:'part',name:'Wrong item',selected:{kind:'draft',draft_id:'draft',state:'draft-v1',content:{basis:'Wrong'}}})));
 mount();await screen.findByText('The selected record is unavailable.');expect(screen.queryByRole('textbox',{name:'Declared basis'})).toBeNull();expect(screen.queryByRole('button',{name:'Save draft'})).toBeNull();
});
test.each([422,403])('explicit draft recovery is metadata-free and available only for the choice response (%s)',async status=>{
 vi.stubGlobal('fetch',vi.fn(async(path:string)=>path.includes('draft_id=chosen')?reply({definition_id:'secondary',workspace_id:'workspace',kind:'preparation_profile',name:'Synthetic chosen',selected:{kind:'draft',draft_id:'chosen',state:'draft-v3',content:{basis:'Explicit'}}}):reply({error:{message:'Choose an explicit working draft.'}},status)));
 mount();await screen.findByText('Choose an explicit working draft.');
 if(status===403){expect(screen.queryByText('Advanced: choose a working draft')).toBeNull();return;}
 fireEvent.click(screen.getByText('Advanced: choose a working draft'));fireEvent.change(screen.getByLabelText('Explicit working draft ID'),{target:{value:'chosen'}});fireEvent.click(screen.getByRole('button',{name:'Open chosen draft'}));await screen.findByRole('heading',{name:'Synthetic chosen'});expect(screen.getByLabelText('Declared basis')).toHaveProperty('value','Explicit');
});
test('new local reference denial offers a metadata-free undo without exposing the retained editor',async()=>{
 vi.stubGlobal('fetch',vi.fn(async()=>reply({})));
 mount({definitionId:null,revisionNumber:null,authorizeContent:async content=>{if(content.basis==='Denied local pin')throw new Error('Local reference denied');}});
 fireEvent.change(await screen.findByRole('textbox',{name:'Declared basis'}),{target:{value:'Denied local pin'}});await screen.findByText('Local reference denied');expect(screen.queryByRole('textbox',{name:'Declared basis'})).toBeNull();
 fireEvent.click(screen.getByRole('button',{name:'Undo last local edit'}));await waitFor(()=>expect(screen.getByRole('textbox',{name:'Declared basis'})).toHaveProperty('value',''));
});
