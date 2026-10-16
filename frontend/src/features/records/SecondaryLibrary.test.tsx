import { MantineProvider, TextInput } from '@mantine/core';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory } from '@tanstack/react-router';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { PermissionsProvider } from '../../lib/permissions';
import { NavigationProvider, formatLocation, useNavigation } from '../navigation';
import { ProbeProvider } from '../probe';
import { SecondaryLibrary } from './SecondaryLibrary';
beforeEach(()=>vi.stubGlobal('ResizeObserver',class{observe(){}disconnect(){}unobserve(){}}));
afterEach(()=>{cleanup();vi.unstubAllGlobals();});
test('new kinds retain distinct local visits and return to their own buffers through real navigation',async()=>{
 const history=createMemoryHistory({initialEntries:[formatLocation({area:'library',project:null,lens:'pcb-disagreement',probe:null,filters:{status:'new',kind:'pcb_assertion'}})]});const requests:unknown[]=[];
 vi.stubGlobal('fetch',vi.fn(async(_path:string,options?:RequestInit)=>{if(options?.method==='POST')requests.push(JSON.parse(String(options.body)));return new Response(JSON.stringify({results:[],next_after:null}));}));
 function Host(){const nav=useNavigation()!,kind=nav.location.filters?.kind==='pcb_comparison'?'pcb_comparison':'pcb_assertion';return <ProbeProvider probe={nav.location.probe??null} onProbe={probe=>nav.navigate({probe})}><SecondaryLibrary active principalKey="owner" workspaceId="workspace" toolId="pcb-disagreement" projects={[]} projectFilterId={null} onOpenInProject={vi.fn()} config={{title:'Source review',collectionLabel:'Source reviews',initial:{kind,content:{note:''}},allowedKinds:['pcb_assertion','pcb_comparison'],renderContent:ctx=><TextInput label="Local note" value={String(ctx.content.note)} onChange={e=>ctx.change({...ctx.content,note:e.currentTarget.value})}/>}}/></ProbeProvider>;}
 render(<MantineProvider env="test"><QueryClientProvider client={new QueryClient({defaultOptions:{queries:{retry:false}}})}><PermissionsProvider permissions={['workspace.read','item.create','design.edit']}><NavigationProvider history={history}><Host/></NavigationProvider></PermissionsProvider></QueryClientProvider></MantineProvider>);
 fireEvent.change(await screen.findByRole('textbox',{name:'Local note'}),{target:{value:'Unsubmitted assertion'}});fireEvent.change(screen.getByRole('textbox',{name:'Source review name'}),{target:{value:'Synthetic assertion'}});
 await act(async()=>history.push(formatLocation({area:'library',project:null,lens:'pcb-disagreement',probe:null,filters:{status:'new',kind:'pcb_comparison'}})));fireEvent.change(await screen.findByRole('textbox',{name:'Local note'}),{target:{value:'Unsubmitted comparison'}});
 fireEvent.click(screen.getByRole('button',{name:'New source review 1'}));expect(await screen.findByRole('textbox',{name:'Local note'})).toHaveProperty('value','Unsubmitted assertion');expect(screen.getByRole('textbox',{name:'Source review name'})).toHaveProperty('value','Synthetic assertion');
 fireEvent.click(screen.getByRole('button',{name:'New source review 2'}));expect(await screen.findByRole('textbox',{name:'Local note'})).toHaveProperty('value','Unsubmitted comparison');expect(requests).toHaveLength(0);
});
