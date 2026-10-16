import { createHash } from 'node:crypto';
import { MantineProvider } from '@mantine/core';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { StockRecipePanel } from './StockRecipePanel';
import { generate, exampleCoax } from './builder';
import type { StockRecord } from './api';
const command=vi.hoisted(()=>vi.fn());
vi.mock('../identity/api',()=>({command}));
vi.mock('../cables/RevisionPicker',()=>({RevisionPicker:({onChange,value}:{onChange:(value:string)=>void;value:string})=><button onClick={()=>onChange('new-copper')}>Replace {value}</button>}));
afterEach(()=>{cleanup();vi.unstubAllGlobals();vi.clearAllMocks();});
function sample():StockRecord {return {definition_id:'stock',draft_id:'draft',state:'draft-v4',name:'Synthetic',content:{stock:generate(exampleCoax()),stock_recipe:{schema_version:'1',source:'Synthetic source',template:generate(exampleCoax()),constituents:[{local_id:'copper',revision_id:'old-copper',snapshot_sha256:'a'.repeat(64)}],bindings:[{element_path:'stock.center',target_field:'outer_diameter_mm',formula:'identity',inputs:[{constituent_local_id:'copper',field:'outer_diameter_mm'}]}]}}};}
function mount(current=sample()) {const done=vi.fn();const client=new QueryClient({defaultOptions:{queries:{retry:false}}});const tree=(principalKey='owner',active=true)=><MantineProvider env="test"><QueryClientProvider client={client}><StockRecipePanel active={active} principalKey={principalKey} current={current} revisionId={null} editable dirty={false} onCompiled={done}/></QueryClientProvider></MantineProvider>;
 const view=render(tree());return {...view,done,rerender:(key:string,active=true)=>view.rerender(tree(key,active))};}
test('replacement hashes exact canonical bytes, then deliberate compile uses saved CAS and retains old recipe',async()=>{
 const canonical=JSON.stringify({content:{stock_constituent:{kind:'conductor'}}});vi.stubGlobal('fetch',vi.fn(async()=>new Response(canonical)));
 const current=sample(),original=structuredClone(current);command.mockResolvedValue(current);const view=mount(current);
 fireEvent.click(screen.getByText('Replace old-copper'));await screen.findByText('Replace new-copper');
 expect(command).not.toHaveBeenCalled();fireEvent.click(screen.getByRole('button',{name:'Compile reviewed recipe'}));
 await waitFor(()=>expect(view.done).toHaveBeenCalledWith(current));
 expect(command).toHaveBeenCalledWith('wire_stock.compile_recipe',expect.objectContaining({draft_id:'draft',recipe:expect.objectContaining({constituents:[{local_id:'copper',revision_id:'new-copper',snapshot_sha256:createHash('sha256').update(canonical).digest('hex')}]})}),'draft-v4');
 expect(current).toEqual(original);
});
test('late replacement cannot cross principal/hide boundary and compile conflict retains the proposal',async()=>{
 let release!:(value:Response)=>void;vi.stubGlobal('fetch',vi.fn(()=>new Promise<Response>(resolve=>{release=resolve;})));
 const view=mount();fireEvent.click(screen.getByText('Replace old-copper'));view.rerender('viewer',false);
 await act(async()=>release(new Response(JSON.stringify({content:{stock_constituent:{}}}))));
 expect(command).not.toHaveBeenCalled();expect(screen.queryByText('Replace new-copper')).toBeNull();
 view.rerender('owner');command.mockRejectedValue(new Error('Draft changed. Review the latest saved state.'));
 fireEvent.click(screen.getByRole('button',{name:'Compile reviewed recipe'}));await screen.findByText('Draft changed. Review the latest saved state.');expect(view.done).not.toHaveBeenCalled();
});
