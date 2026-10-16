import { MantineProvider } from '@mantine/core';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { PermissionsProvider } from '../../lib/permissions';
import { ProbeProvider } from '../probe';
import { interfaceConfig } from '../interfaces/InterfaceRecords';
import { EmbeddedRecords } from './EmbeddedRecords';
beforeEach(()=>vi.stubGlobal('ResizeObserver',class{observe(){}unobserve(){}disconnect(){}}));afterEach(()=>{cleanup();vi.unstubAllGlobals();});
test('embedded assessment retains its own incomplete fields across parent revision and visibility changes without rewriting parent identity',async()=>{
 vi.stubGlobal('fetch',vi.fn(async()=>new Response(JSON.stringify({}))));const root=vi.fn(),cache=new QueryClient({defaultOptions:{queries:{retry:false}}});const tree=(active:boolean,revision:number)=><MantineProvider env="test"><QueryClientProvider client={cache}><PermissionsProvider permissions={['workspace.read','item.create','design.edit']}><ProbeProvider probe={{object:'device',rev:revision,path:['right','board']}} onProbe={root}><EmbeddedRecords active={active} principalKey="owner" workspaceId="workspace" choices={[{kind:'interface_assessment',label:'Interface assessment',config:interfaceConfig('interface_assessment')}]}/></ProbeProvider></PermissionsProvider></QueryClientProvider></MantineProvider>;
 const view=render(tree(true,1));fireEvent.click(screen.getByRole('button',{name:'New interface assessment'}));const field=await screen.findByRole('textbox',{name:'New correspondence row ID'});fireEvent.change(field,{target:{value:'incomplete-own-row'}});view.rerender(tree(false,2));expect(screen.queryByRole('textbox',{name:'New correspondence row ID'})).toBeNull();view.rerender(tree(true,2));await waitFor(()=>expect((screen.getByRole('textbox',{name:'New correspondence row ID'}) as HTMLInputElement).value).toBe('incomplete-own-row'));expect(root).not.toHaveBeenCalled();
});
