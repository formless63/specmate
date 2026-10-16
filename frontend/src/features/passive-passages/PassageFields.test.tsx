import { MantineProvider } from '@mantine/core';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { PermissionsProvider } from '../../lib/permissions';
import { BoardPassiveReview, PassageModelFields } from '../boards/BoardAdvanced';
import type { Graph, Inspection, Interpretation, Model } from './api';
beforeEach(()=>vi.stubGlobal('ResizeObserver',class{observe(){} disconnect(){} unobserve(){}}));
afterEach(()=>{cleanup();vi.unstubAllGlobals();});
const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const a = `terminal-${"a".repeat(64)}`;
const b = `terminal-${"b".repeat(64)}`;
const graph: Graph = { root_revision_id: "root-revision", snapshot_id: "root-snapshot", snapshot_sha256: "a".repeat(64), occurrence_path: [], nodes: [{ id: a, occurrence_path: ["left"], revision_id: "body-revision", terminal: { contact_id: "one" }, label: "pin one", feature_kind: "contact", provenance: { occurrence_path: ["left"], revision_id: "body-revision", snapshot_sha256: "b".repeat(64) } }, { id: b, occurrence_path: ["right"], revision_id: "body-revision", terminal: { contact_id: "two" }, label: "pin two", feature_kind: "contact", provenance: { occurrence_path: ["right"], revision_id: "body-revision", snapshot_sha256: "b".repeat(64) } }], edges: [], boundaries: [{ id: "candidate-boundary", kind: "resistor", members: [a, b], status: "not_evaluated", reason: "Extracted candidate; no reviewed electrical model.", provenance: { occurrence_path: [], revision_id: "root-revision", snapshot_sha256: "a".repeat(64) } }], components: [], selected_component_id: null, continuity: "not_evaluated", compatibility: "not_evaluated", physical_qualification: "not_evaluated", limitations: [] };
const model: Model = { root_revision_id: "root-revision", assumptions: "ideal_lumped_components", model_basis: "Synthetic ideal circuit only", passages: [{ local_id: "r1", kind: "resistor", from_terminal_id: a, to_terminal_id: b, resistance_ohm: "330", capacitance_f: null, condition: null, native_candidate_boundary_id: "candidate-boundary", basis: "Independent explicit declaration", evidence: { status: "unknown" } }] };
const inspection: Inspection = { revision_id: "model-revision", sha256: "c".repeat(64), snapshot_id: "model-snapshot", model, graph, state: "passage-review-v0", decision: "unreviewed", reviews: [] };
const unknown: Interpretation = { revision_id: "model-revision", sha256: "c".repeat(64), review_state: "passage-review-v0", query: "dc_continuity", status: "unknown", reason: "current_accepted_model_review_required", paths: [], physical_continuity: "not_evaluated", signal_transfer: "not_evaluated", physical_qualification: "not_evaluated" };

function wrap(children:React.ReactNode, edit=true){return <MantineProvider env="test"><QueryClientProvider client={new QueryClient({defaultOptions:{queries:{retry:false}}})}><PermissionsProvider permissions={edit?['workspace.read','design.edit']:['workspace.read']}>{children}</PermissionsProvider></QueryClientProvider></MantineProvider>;}
function reviewed(value=inspection){return {...value,decision:'accepted'};}
function queryView(value=inspection, edit=true){return render(wrap(<BoardPassiveReview review={reviewed(value)} active principalKey="owner" workspaceId="workspace" onChanged={vi.fn()}/>,edit));}
function selectQuery(){fireEvent.change(screen.getByLabelText('Query from terminal'),{target:{value:a}});fireEvent.change(screen.getByLabelText('Query to terminal'),{target:{value:b}});}
test('native candidate starts unknown and exact electrical decimal is explicitly authored',async()=>{
 let authored:Model={...model,passages:[]};
 vi.stubGlobal('fetch',vi.fn(async()=>reply({labels:[]})));
 function Editor(){const [value,setValue]=useState(authored);authored=value;return <PassageModelFields value={value} root={graph} onChange={setValue} disabled={false}/>;}
 render(wrap(<Editor/>));fireEvent.click(screen.getByRole('button',{name:'Declare separate passage for candidate'}));expect(screen.getByLabelText('Passage 1 kind')).toHaveProperty('value','unknown');expect(screen.queryByLabelText(/resistance in ohm/)).toBeNull();
 fireEvent.change(screen.getByLabelText('Passage 1 kind'),{target:{value:'resistor'}});fireEvent.change(screen.getByLabelText('Passage 1 resistance in ohm'),{target:{value:'1e-30'}});expect(authored.passages[0]).toMatchObject({kind:'resistor',resistance_ohm:'1e-30',from_terminal_id:a,to_terminal_id:b,native_candidate_boundary_id:'candidate-boundary'});
});
test('exclusive condition declarations and ideal contact parameters remain separately authored',()=>{
 let authored:Model={...model,conditions:[{local_id:'selector',states:['left','right'],basis:'Declared exclusive switch'}],passages:[{...model.passages[0]!,kind:'conditional',resistance_ohm:null,conditional_contact:{condition_id:'selector',state:'left',behavior:'ideal_contact'}}]};
 function Editor(){const [value,setValue]=useState(authored);authored=value;return <PassageModelFields value={value} root={graph} onChange={setValue} disabled={false}/>;}
 render(wrap(<Editor/>));expect(screen.getByLabelText('Passage 1 ideal contact closed state')).toHaveProperty('value','left');fireEvent.change(screen.getByLabelText('Passage 1 ideal contact closed state'),{target:{value:'right'}});expect(authored.passages[0]?.conditional_contact?.state).toBe('right');expect(authored.conditions?.[0]?.states).toEqual(['left','right']);
});
test('query sends exact frequency, explicit assumptions and model identity without idempotency key',async()=>{
 const commands:Record<string,unknown>[]=[];vi.stubGlobal('fetch',vi.fn(async(path:string,init?:RequestInit)=>{if(!path.endsWith('/operations'))return reply({labels:[]});const body=JSON.parse(String(init?.body));commands.push(body);return reply({result:{...unknown,query:'signal'}});}));
 queryView();selectQuery();fireEvent.change(screen.getByLabelText('Passive query meaning'),{target:{value:'signal'}});fireEvent.click(screen.getByRole('button',{name:'Interpret exact reviewed model'}));await screen.findByText('Declared model query result');expect(commands[0]).toMatchObject({operation:'passage.interpret',payload:{revision_id:'model-revision',copper_assumption:'unspecified',condition_assignments:[]}});expect(commands[0]).not.toHaveProperty('idempotency_key');expect(commands[0]?.payload).not.toHaveProperty('frequency_hz');
 fireEvent.change(screen.getByLabelText('Signal frequency in hertz'),{target:{value:'1e3'}});fireEvent.click(screen.getByRole('button',{name:'Interpret exact reviewed model'}));await waitFor(()=>expect(commands[1]?.payload).toMatchObject({frequency_hz:'1e3'}));
});
test('stale query cannot repopulate after query meaning changes',async()=>{
 let resolve!:(response:Response)=>void;vi.stubGlobal('fetch',vi.fn(async(path:string)=>path.endsWith('/operations')?new Promise<Response>(done=>{resolve=done;}):reply({labels:[]})));
 queryView();selectQuery();fireEvent.click(screen.getByRole('button',{name:'Interpret exact reviewed model'}));await waitFor(()=>expect(resolve).toBeTypeOf('function'));fireEvent.change(screen.getByLabelText('Passive query meaning'),{target:{value:'resistance'}});await act(async()=>resolve(reply({result:unknown})));expect(screen.queryByText('Declared model query result')).toBeNull();
});
test('unspecified exclusive assignments stay unknown and changing an assignment fences pending results',async()=>{
 const current={...inspection,model:{...model,conditions:[{local_id:'selector',states:['left','right'],basis:'Declared exclusive switch'}]}};const commands:{payload:{condition_assignments:unknown[]}}[]=[];let resolve!:(response:Response)=>void;
 vi.stubGlobal('fetch',vi.fn(async(path:string,init?:RequestInit)=>{if(!path.endsWith('/operations'))return reply({labels:[]});commands.push(JSON.parse(String(init?.body)));if(commands.length===1)return reply({result:unknown});return new Promise<Response>(done=>{resolve=done;});}));queryView(current);selectQuery();expect(screen.getByLabelText('Query state for selector')).toHaveProperty('value','');fireEvent.click(screen.getByRole('button',{name:'Interpret exact reviewed model'}));await screen.findByText('Declared model query result');expect(commands[0]?.payload.condition_assignments).toEqual([]);
 fireEvent.change(screen.getByLabelText('Query state for selector'),{target:{value:'left'}});fireEvent.click(screen.getByRole('button',{name:'Interpret exact reviewed model'}));await waitFor(()=>expect(commands[1]?.payload.condition_assignments).toEqual([{condition_id:'selector',state:'left'}]));fireEvent.change(screen.getByLabelText('Query state for selector'),{target:{value:'right'}});await act(async()=>resolve(reply({result:unknown})));expect(screen.queryByText('Declared model query result')).toBeNull();
});
test('viewer can query a reviewed frozen model but cannot append a review',async()=>{
 vi.stubGlobal('fetch',vi.fn(async()=>reply({labels:[]})));queryView(inspection,false);fireEvent.click(screen.getByText('Review ideal model independently'));expect((await screen.findByRole('button',{name:'Append model review'})).matches(':disabled')).toBe(true);selectQuery();expect(screen.getByRole('button',{name:'Interpret exact reviewed model'}).matches(':disabled')).toBe(false);
});
