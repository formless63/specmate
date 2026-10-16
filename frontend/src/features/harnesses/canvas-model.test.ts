import { expect, test } from 'vitest';
import { initialHarness, terminalKey, type Terminal } from './api';
import { addHarnessJoint, joinHarnessStack, harnessGraph, harnessHandle, harnessNode, placeHarnessDrop } from './canvas-model';
import type { ResolvedStack } from '../end-assemblies/api';
const revision = '00000000-0000-4000-8000-000000000001';
const terminal = (id: string): Terminal => ({ kind: 'endpoint', endpoint_id: id, layer_id: 'layer/"', terminal_id: 'contact/"[]' });
const stack: ResolvedStack = { layers: [{ layer_id: 'layer/"', kind: 'connector', name: 'Exact connector', terminals: [{ terminal_id: 'contact/"[]', label: 'Visible pin label', kind: 'contact', reaches: [] }] }], joins: [], connector_layer_id: 'layer/"', body_revision_id: revision, pinout_revision_id: revision, evaluation: [], continuity: 'not_evaluated' };
test('repeated endpoints retain exact selector-safe handles and no inferred edges', () => {
 const harness = { ...initialHarness(), endpoints: ['left', 'right'].map(local_id => ({ local_id, label: 'Repeated connector', stack: null, end_assembly_revision_id: revision })) };
 const graph = harnessGraph(harness, { stocks: {}, ends: { left: stack, right: stack } });
 expect(graph.edges).toEqual([]); expect(graph.terminals.size).toBe(2); expect(graph.items.map(item => item.id)).toEqual([harnessNode('endpoint','left','layer/"'),harnessNode('endpoint','right','layer/"')]);
 const handle = harnessHandle(terminal('left')); expect(handle).not.toMatch(/["'\[\]\\]/); expect(decodeURIComponent(handle)).toBe(terminalKey(terminal('left'))); expect(graph.terminals.get(handle)).toEqual(terminal('left'));
 const next=addHarnessJoint(harness,terminal('left'),terminal('right'),'termination','Reviewed exact contacts');
 const connected=harnessGraph(next,{stocks:{},ends:{left:stack,right:stack}});expect(connected.edges).toHaveLength(1);expect(connected.edges[0]).toMatchObject({source:harnessNode('endpoint','left','layer/"'),target:harnessNode('endpoint','right','layer/"'),sourceHandle:handle});expect(harness.joints).toEqual([]);
});
test('unresolved paths retain their declarations and never create substitute terminals',()=>{
 const left=terminal('left'),right=terminal('right'),harness=addHarnessJoint(initialHarness(),left,right,'splice','Declared unresolved members');
 const graph=harnessGraph(harness,{stocks:{},ends:{}});expect(graph.edges).toEqual([]);expect(graph.unresolved).toBe(1);expect(harness.joints[0]?.members).toEqual([left,right]);
});
test('one-terminal ownership and explicit basis fence graphical joints',()=>{
 const left=terminal('left'),right=terminal('right');expect(()=>addHarnessJoint(initialHarness(),left,left,'termination','basis')).toThrow('different');expect(()=>addHarnessJoint(initialHarness(),left,right,'splice',' ')).toThrow('basis');
 const harness=addHarnessJoint(initialHarness(),left,right,'termination','basis');expect(()=>addHarnessJoint(harness,left,terminal('third'),'shield_bond','reviewed')).toThrow('already belongs');
});
test('stock placement creates one physical piece with unknown cut while preserving spans/joints/breakouts',()=>{
 const original=addHarnessJoint(initialHarness(),terminal('a'),terminal('b'),'splice','Old basis');const first=placeHarnessDrop(original,{kind:'wire_stock',revisionId:revision}),second=placeHarnessDrop(first.harness,{kind:'wire_stock',revisionId:revision});
 expect(second.harness.sections).toHaveLength(2);expect(second.harness.segments.map(span=>span.section_id)).toEqual(['section-1','section-2']);expect(second.harness.sections.every(section=>section.planned_cut_length_mm===null)).toBe(true);expect(second.harness.joints).toEqual(original.joints);expect(second.harness.breakouts).toEqual(original.breakouts);
});
test('exact endpoint placements remain separate and preserve unknown inline values',()=>{
 const saved=placeHarnessDrop(initialHarness(),{kind:'end_assembly',revisionId:revision});const local=placeHarnessDrop(saved.harness,{kind:'declared_capacitor'});
 expect(local.harness.endpoints[0]).toMatchObject({local_id:'end-1',end_assembly_revision_id:revision,stack:null});expect(local.harness.endpoints[1]).toMatchObject({local_id:'end-2',end_assembly_revision_id:null,stack:{layers:[{kind:'inline',parts:[{component:{kind:'capacitor',value:null,capacitance_f:null}}]}]}});
});

test('adding a board layer to an existing endpoint preserves its connector, identity and existing topology',()=>{
 const original={...initialHarness(),endpoints:[{local_id:'left',label:'Existing end',end_assembly_revision_id:null,stack:{layers:[{kind:'connector' as const,layer_id:'connector',body_revision_id:revision,pinout_revision_id:revision}],joins:[]}}]};
 const next=placeHarnessDrop(original,{kind:'board',revisionId:revision},undefined,'left');expect(next.harness.endpoints).toHaveLength(1);expect(next.harness.endpoints[0]).toMatchObject({local_id:'left',label:'Existing end',stack:{layers:[{kind:'board',board_revision_id:revision},{kind:'connector',body_revision_id:revision,pinout_revision_id:revision}]}});expect(original.endpoints[0]!.stack.layers).toHaveLength(1);
});
test('saved-stack layering requires an explicit exact local copy and retains the saved pin until Apply',()=>{
 const original={...initialHarness(),endpoints:[{local_id:'saved',label:null,end_assembly_revision_id:revision,stack:null}]};expect(()=>placeHarnessDrop(original,{kind:'board',revisionId:revision},undefined,'saved')).toThrow('exact saved stack');
 const next=placeHarnessDrop(original,{kind:'board',revisionId:revision},undefined,'saved',{layers:[{kind:'connector',layer_id:'connector',body_revision_id:revision,pinout_revision_id:revision}],joins:[]});expect(next.harness.endpoints[0]?.end_assembly_revision_id).toBeNull();expect(next.harness.endpoints[0]?.stack?.layers.map(layer=>layer.kind)).toEqual(['board','connector']);expect(original.endpoints[0]?.end_assembly_revision_id).toBe(revision);
});
test('separate inline component nodes retain original exact terminal IDs',()=>{
 const harness={...initialHarness(),endpoints:[{local_id:'end',label:'Board end',end_assembly_revision_id:revision,stack:null}]};const resolved={...stack,layers:[{layer_id:'parts',kind:'inline' as const,name:'Declared parts',parts:[{local_id:'r1',name:'First resistor',summary:'resistor · value unknown'},{local_id:'c1',name:'Capacitor',summary:'capacitor · value unknown'}],terminals:[{terminal_id:'r1.a',label:'R1 A',kind:'lead',part:'r1',reaches:[]},{terminal_id:'c1.a',label:'C1 A',kind:'lead',part:'c1',reaches:[]}]}]};
 const graph=harnessGraph(harness,{stocks:{},ends:{end:resolved}});expect(graph.items).toHaveLength(2);expect(graph.items[0]?.ports[0]?.id).toBe(harnessHandle({kind:'endpoint',endpoint_id:'end',layer_id:'parts',terminal_id:'r1.a'}));expect(graph.items[1]?.ports[0]?.id).toBe(harnessHandle({kind:'endpoint',endpoint_id:'end',layer_id:'parts',terminal_id:'c1.a'}));expect(graph.items[0]?.id).not.toBe(graph.items[1]?.id);expect(graph.items[1]!.position.y).toBeGreaterThan(260);
});

test('many exact stock rows determine spacing and recorded colors carry through declared joints',async()=>{
 const {stock}=await import('../cable-workbench/fixtures');const specification=stock();
 const harness={...initialHarness(),sections:[{local_id:'piece',stock_revision_id:revision,planned_cut_length_mm:null,cut_basis:null}],segments:['span1','span2'].map(local_id=>({local_id,section_id:'piece',label:null,element_paths:null})),endpoints:[{local_id:'end',label:null,end_assembly_revision_id:revision,stack:null}],joints:[{local_id:'landing',kind:'termination' as const,basis:'Exact manual mapping',members:[{kind:'segment' as const,segment_id:'span1',end:'a' as const,element_path:'stock.core-1.center'},terminal('end')]}]};
 const graph=harnessGraph(harness,{stocks:{[revision]:specification},ends:{end:stack}});expect(graph.items[1]!.position.y).toBeGreaterThan(260);expect(graph.items[0]?.artwork).toBeTruthy();const port=graph.items[0]!.ports.find(port=>port.id===harnessHandle(harness.joints[0]!.members[0]!));expect(port?.color).toBe('#d62728');expect(graph.edges[0]?.style?.stroke).toBe('#d62728');expect(graph.items[2]!.ports[0]?.color).toBe('#d62728');
});

test('catalog Part layering requires declared use and pins provenance without inventing behavior',()=>{
 const original={...initialHarness(),endpoints:[{local_id:'end',label:null,end_assembly_revision_id:null,stack:{layers:[],joins:[]}}]};expect(()=>placeHarnessDrop(original,{kind:'part',revisionId:revision},undefined,'end')).toThrow('declare');const next=placeHarnessDrop(original,{kind:'part',revisionId:revision},undefined,'end',undefined,{use:'inline',declaredTwoLead:true,componentKind:'unknown'});expect(next.harness.endpoints[0]?.stack?.layers[0]).toMatchObject({kind:'inline',parts:[{part_revision_id:revision,component:{kind:'unknown',value:null,resistance_ohm:null,capacitance_f:null}}]});
});

const declaredInline = { layers: [{ kind: 'inline' as const, layer_id: 'parts', parts: ['r1','r2'].map(local_id => ({ local_id, label: null, component: { kind: 'unknown' as const, reference: null, value: null, resistance_ohm: null, capacitance_f: null } })) }], joins: [] };
const lead = (id: string): Terminal => ({ kind: 'endpoint', endpoint_id: 'left', layer_id: 'parts', terminal_id: id });
test('same-end inline leads use the shared stack join while cross-end declarations stay in Harness joints',()=>{
 const harness={...initialHarness(),endpoints:[{local_id:'left',label:'Exact local end',end_assembly_revision_id:null,stack:declaredInline}]};const next=joinHarnessStack(harness,lead('r1.2'),lead('r2.1'),'Explicit crimp between declared leads','crimp');expect(next.joints).toEqual([]);expect(next.endpoints[0]?.stack?.joins).toEqual([{local_id:'joint-1',a:{layer_id:'parts',terminal_id:'r1.2'},b:{layer_id:'parts',terminal_id:'r2.1'},kind:'crimp',basis:'Explicit crimp between declared leads'}]);expect(next.endpoints[0]?.stack?.layers).toEqual(declaredInline.layers);expect(harness.endpoints[0]?.stack?.joins).toEqual([]);expect(()=>joinHarnessStack(harness,lead('r1.1'),lead('r1.2'),'Do not bypass one part','solder')).toThrow('different inline parts');expect(()=>joinHarnessStack(harness,lead('r1.2'),lead('r2.1'),'','solder')).toThrow('basis');expect(()=>joinHarnessStack(harness,lead('r1.2'),lead('r2.1'),'Wrong shell bond','bond')).toThrow('shell');
});
test('same-end saved stack join needs exact read-copy and preserves its pinned layer/Part identities',()=>{
 const harness={...initialHarness(),endpoints:[{local_id:'left',label:'Saved local end',end_assembly_revision_id:revision,stack:null}]};expect(()=>joinHarnessStack(harness,lead('r1.2'),lead('r2.1'),'Explicit solder','solder')).toThrow('exact saved stack');const next=joinHarnessStack(harness,lead('r1.2'),lead('r2.1'),'Explicit solder','solder',declaredInline);expect(next.endpoints[0]?.end_assembly_revision_id).toBeNull();expect(next.endpoints[0]?.stack?.layers).toEqual(declaredInline.layers);expect(harness.endpoints[0]?.end_assembly_revision_id).toBe(revision);expect(next.joints).toEqual([]);
});
