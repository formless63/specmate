import { MantineProvider } from '@mantine/core';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { PermissionsProvider } from '../../lib/permissions';
import { stock } from '../cable-workbench/fixtures';
import { HarnessRecordPage } from './HarnessRecordPage';
import { initialHarness } from './api';
vi.mock('./HarnessCanvas',()=>({HarnessCanvas:()=>null}));
vi.mock('../../components/editor/Documents',()=>({RootDocuments:()=> <p>Selected harness documents</p>}));
afterEach(()=>{cleanup();vi.unstubAllGlobals();});
test('source checks conceal prepared print settings and retain them through denial and exact recovery',async()=>{
 vi.stubGlobal('ResizeObserver',class{observe(){}unobserve(){}disconnect(){}});Element.prototype.scrollIntoView=vi.fn();
 const revision='00000000-0000-4000-8000-000000000001',harness={...initialHarness(),sections:[{local_id:'piece',stock_revision_id:revision,planned_cut_length_mm:'1250',cut_basis:'Declared cut'}],segments:[{local_id:'span',section_id:'piece',label:null,element_paths:null}]};
 let held:((response:Response)=>void)|null=null,hold=false,deny=false;const reply=(body:unknown,status=200)=>new Response(JSON.stringify(body),{status});
 vi.stubGlobal('fetch',vi.fn(async(path:string)=>{
  if(path.includes('/record?')){if(hold)return new Promise<Response>(resolve=>{held=resolve;});return reply(deny?{error:{message:'Selected root denied'}}:{definition_id:'harness',workspace_id:'workspace',name:'Synthetic harness',kind:'harness',selected:{kind:'revision',revision_id:'r3',number:3,snapshot_id:'s3',sha256:'a'.repeat(64),content:{harness}}},deny?403:200);}
  if(path.includes('/snapshot'))return reply({content:{stock:stock()}});if(path.includes('/revision-labels'))return reply({labels:[],source_labels:[]});return reply({});
 }));
 render(<MantineProvider env="test"><PermissionsProvider permissions={['workspace.read','design.edit']}><QueryClientProvider client={new QueryClient({defaultOptions:{queries:{retry:false}}})}><HarnessRecordPage active principalKey="owner" workspaceId="workspace" definitionId="harness" revisionNumber={3} draftRequested={false} onCreated={vi.fn()} onSelect={vi.fn()} projects={[]} onBack={vi.fn()} onOpenInProject={vi.fn()}/></QueryClientProvider></PermissionsProvider></MantineProvider>);
 await screen.findByRole('button',{name:'Continue draft'});fireEvent.click(screen.getByRole('tab',{name:'Documents'}));await screen.findByText('Selected harness documents');fireEvent.click(screen.getByText('Full-scale formboard and labels · print settings'));const margin=await screen.findByLabelText('Margin (mm)');fireEvent.change(margin,{target:{value:'23'}});
 hold=true;fireEvent(window,new Event('focus'));await screen.findByText('Checking exact harness state and current source access…');expect(screen.queryByRole('textbox',{name:'Margin (mm)'})).toBeNull();await waitFor(()=>expect(held).not.toBeNull());deny=true;await act(async()=>{held!(reply({error:{message:'Selected root denied'}},403));});await screen.findByText(/Exact harness state is unavailable/);expect(screen.queryByRole('textbox',{name:'Margin (mm)'})).toBeNull();hold=false;deny=false;fireEvent.click(screen.getByRole('button',{name:'Refresh harness'}));await screen.findByRole('button',{name:'Continue draft'});await waitFor(()=>expect((screen.getByRole('textbox',{name:'Margin (mm)'}) as HTMLInputElement).value).toBe('23'));
});
