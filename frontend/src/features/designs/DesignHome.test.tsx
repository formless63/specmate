import { MantineProvider } from '@mantine/core';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory } from '@tanstack/react-router';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { NavigationProvider } from '../navigation';
import { PermissionsProvider } from '../../lib/permissions';
import { DesignHome } from './DesignHome';
vi.mock('./DesignList',()=>({DesignList:()=> <p>Design collection</p>}));
afterEach(()=>{cleanup();vi.unstubAllGlobals();});
test('needs are bounded and read-only with explicit record/design/proposal actions, and denied resume hides cached names',async()=>{
 let deny=false; const calls:URL[]=[]; vi.stubGlobal('ResizeObserver',class{observe(){}unobserve(){}disconnect(){}});vi.stubGlobal('fetch',vi.fn(async(path:string)=>{const url=new URL(path,'http://test');calls.push(url);return new Response(JSON.stringify(deny?{error:{message:'Unavailable'}}:{workspace_id:'w1',results:[{record_id:'n1',label:'Synthetic need',latest_revision:3}],next_after:null}),{status:deny?403:200});}));
 const history=createMemoryHistory({initialEntries:['/designs?view=needs']}),cache=new QueryClient({defaultOptions:{queries:{retry:false}}}),create=vi.fn();const tree=(active=true)=><MantineProvider env="test"><QueryClientProvider client={cache}><NavigationProvider history={history}><PermissionsProvider permissions={['workspace.read','item.create']}><DesignHome active={active} workspaceId="w1" principalKey="owner" projectFilterId={null} projects={[]} onOpen={vi.fn()} onCreate={create}/></PermissionsProvider></NavigationProvider></QueryClientProvider></MantineProvider>;const view=render(tree());fireEvent.click(await screen.findByRole('button',{name:'Open Synthetic need'}));await waitFor(()=>expect(history.location.pathname).toBe('/library/parts/n1@3'));expect(calls[0]!.searchParams.get('limit')).toBe('20');expect(calls[0]!.searchParams.getAll('kinds')).toEqual(['development_need']);expect(screen.queryByRole('button',{name:/accept|decline/i})).toBeNull();
 // Return via the actual tab route, then withdraw current read authority.
 await history.push('/designs?view=needs');await screen.findByRole('button',{name:'Open Synthetic need'});view.rerender(tree(false));deny=true;view.rerender(tree());await screen.findByText(/Needs are unavailable/);expect(screen.queryByRole('button',{name:'Open Synthetic need'})).toBeNull();deny=false;fireEvent.click(screen.getByRole('button',{name:'Retry needs'}));await screen.findByRole('button',{name:'Open Synthetic need'});fireEvent.click(screen.getByRole('button',{name:'Start a design'}));expect(create).toHaveBeenCalledOnce();fireEvent.click(screen.getByRole('button',{name:'Review enclosure proposals'}));await waitFor(()=>expect(`${history.location.pathname}${history.location.search}`).toBe('/designs'));expect(vi.mocked(fetch).mock.calls.every(([,options])=>!(options as RequestInit|undefined)?.method)).toBe(true);
});
