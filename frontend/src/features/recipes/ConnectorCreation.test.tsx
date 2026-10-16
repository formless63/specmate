import { MantineProvider } from '@mantine/core';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { PermissionsProvider } from '../../lib/permissions';
import { ConnectorCreation } from './ConnectorCreation';
beforeEach(()=>{vi.stubGlobal('ResizeObserver',class{observe(){}unobserve(){}disconnect(){}});vi.stubGlobal('fetch',vi.fn(async()=>new Response(JSON.stringify({results:[],labels:[],source_labels:[],next_after:null}))));});
afterEach(()=>{cleanup();vi.unstubAllGlobals();});
test.each(['port','end_assembly'] as const)('partial New %s remains private across close/reopen and is never auto-picked',async kind=>{
 const cache=new QueryClient({defaultOptions:{queries:{retry:false}}}),pick=vi.fn();const tree=(active=true,opened=true,principalKey='owner')=><MantineProvider env="test"><QueryClientProvider client={cache}><PermissionsProvider permissions={['workspace.read','item.create','design.edit','design.freeze']}><ConnectorCreation kind={kind} active={active} opened={opened} workspaceId="w1" principalKey={principalKey} onClose={vi.fn()} onPick={pick}/></PermissionsProvider></QueryClientProvider></MantineProvider>;const view=render(tree());const field=await screen.findByRole('textbox',{name:'Connector name'});fireEvent.change(field,{target:{value:`Prepared ${kind}`}});view.rerender(tree(true,false));expect(screen.queryByRole('textbox',{name:'Connector name'})).toBeNull();view.rerender(tree());expect((await screen.findByRole('textbox',{name:'Connector name'}) as HTMLInputElement).value).toBe(`Prepared ${kind}`);view.rerender(tree(false));expect(screen.queryByRole('dialog')).toBeNull();view.rerender(tree(true,true,'another-principal'));expect((await screen.findByRole('textbox',{name:'Connector name'}) as HTMLInputElement).value).toBe('');expect(pick).not.toHaveBeenCalled();expect(vi.mocked(fetch).mock.calls.every(([,options])=>!(options as RequestInit|undefined)?.method || (options as RequestInit).method==='GET')).toBe(true);
});
