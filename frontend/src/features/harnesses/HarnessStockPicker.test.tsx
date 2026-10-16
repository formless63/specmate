import { MantineProvider } from '@mantine/core';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { HarnessEditor } from './HarnessEditor';
import { initialHarness, type Harness } from './api';
const response=(body:unknown)=>new Response(JSON.stringify(body),{status:200});
beforeEach(()=>{vi.stubGlobal('ResizeObserver',class{observe(){}disconnect(){}unobserve(){}});Element.prototype.scrollIntoView=vi.fn();});afterEach(()=>{cleanup();vi.unstubAllGlobals();});
test('stock picker names the existing exact pin without replacing it and each new definition chooses its newest exact revision',async()=>{
 const picks:string[]=[];
 vi.stubGlobal('fetch',vi.fn(async(path:string)=>{
 if(path.includes('/revision-labels'))return response({labels:[{revision_id:'first-old',readable:true,definition_id:'first',name:'Original stock',kind:'wire_stock',number:1}],source_labels:[]});
 if(path.includes('/catalog/definitions/')){const id=path.includes('/second')?'second':'first';return response({definition_id:id,name:id==='first'?'Original stock':'Different stock',revisions:[{revision_id:`${id}-old`,number:1},{revision_id:`${id}-new`,number:2}],drafts:[]});}
 if(path.includes('/snapshot'))return response({content:{stock:{structure:{id:'root',kind:'group',children:[]}}}});return response({});}));
 function Form(){const [value,setValue]=useState<Harness>({...initialHarness(),sections:[{local_id:'piece',stock_revision_id:'first-old',planned_cut_length_mm:null,cut_basis:null}]});return <HarnessEditor value={value} section="sections" definitions={[{definition_id:'first',kind:'wire_stock',name:'Original stock'},{definition_id:'second',kind:'wire_stock',name:'Different stock'}]} onChange={next=>{picks.push(next.sections[0]!.stock_revision_id);setValue(next);}}/>;}
 render(<MantineProvider env="test"><QueryClientProvider client={new QueryClient({defaultOptions:{queries:{retry:false}}})}><Form/></QueryClientProvider></MantineProvider>);
 const definition=await screen.findByRole('combobox',{name:'Section piece stock definition'});await waitFor(()=>expect((definition as HTMLInputElement).value).toBe('Original stock'));expect(picks).toEqual([]);
 fireEvent.click(definition);fireEvent.click(await screen.findByRole('option',{name:'Different stock'}));await waitFor(()=>expect(picks.at(-1)).toBe('second-new'));
 fireEvent.click(definition);fireEvent.click(await screen.findByRole('option',{name:'Original stock'}));await waitFor(()=>expect(picks.at(-1)).toBe('first-new'));
 expect(screen.queryByLabelText('Section piece stock exact revision ID')).toBeNull();fireEvent.click(screen.getByRole('button',{name:'Advanced: paste exact revision ID for Section piece stock'}));expect((screen.getByLabelText('Section piece stock exact revision ID') as HTMLInputElement).value).toBe('first-new');
});
