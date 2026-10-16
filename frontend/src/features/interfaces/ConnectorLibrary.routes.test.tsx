import { MantineProvider } from '@mantine/core';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { PermissionsProvider } from '../../lib/permissions';
import { ProbeProvider } from '../probe';
import { ConnectorLibrary } from './ConnectorLibrary';
import { initialInterface } from './api';
import { initialAssessment } from './assessment-api';
beforeEach(()=>vi.stubGlobal('ResizeObserver',class{observe(){}unobserve(){}disconnect(){}}));afterEach(()=>{cleanup();vi.unstubAllGlobals();});
test.each(['interface_map','interface_assessment'] as const)('old exact %s address opens its own typed record, independent of a Device and unrelated current drafts',async kind=>{
 const paths:string[]=[];vi.stubGlobal('fetch',vi.fn(async(path:string)=>{paths.push(path);const content={interface:kind==='interface_map'?initialInterface('interface_map'):initialAssessment()};if(path.includes('/record?'))return new Response(JSON.stringify({definition_id:'secondary',workspace_id:'workspace',name:'Exact secondary record',kind,selected:{kind:'revision',revision_id:'secondary-r75',number:75,snapshot_id:'secondary-s75',sha256:'a'.repeat(64),content}}));if(path.includes('/interfaces/revisions/'))return new Response(JSON.stringify({revision_id:'secondary-r75',interface:content.interface,compatibility:'not_evaluated',assessment:{left_pinout_revision_id:'',right_pinout_revision_id:'',findings:[],scope:'exact_pinout_pair',physical_qualification:false,limitations:[]}}));return new Response(JSON.stringify({error:{message:'Unrelated current draft denied'}}),{status:403});}));
 render(<MantineProvider env="test"><QueryClientProvider client={new QueryClient({defaultOptions:{queries:{retry:false}}})}><PermissionsProvider permissions={['workspace.read']}><ProbeProvider probe={{object:'secondary',rev:75,path:['passages','right']}} onProbe={vi.fn()}><ConnectorLibrary active recordKind={kind} toolId="interfaces" principalKey="viewer" workspaceId="workspace" projectFilterId={null} projects={[]} onOpenInProject={vi.fn()}/></ProbeProvider></PermissionsProvider></QueryClientProvider></MantineProvider>);
 await screen.findByRole('heading',{name:'Exact secondary record'});expect(screen.getByText('Frozen r75')).toBeTruthy();expect(paths.some(path=>path.includes('revision_number=75'))).toBe(true);expect(paths.some(path=>path.includes('/catalog/definitions/secondary?')||path.includes('/interfaces/drafts/'))).toBe(false);
});
