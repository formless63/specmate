import type { Cable } from '../cables/api';
import { addLayer, type EndStack, type EndAssembly, type StackLayer } from '../end-assemblies/api';
import type { InlineComponent } from '../boards/api';
import type { Pinout } from '../interfaces/api';

export const DROP_KINDS = ['wire_stock', 'connector_body', 'pinout', 'board', 'end_assembly', 'part', 'declared_resistor', 'declared_capacitor'] as const;
export type DropKind = typeof DROP_KINDS[number];
export type LibraryDrop = { kind: DropKind; revisionId?: string };
export const DROP_MIME = 'application/x-specmate-library-revision';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function parseDrop(raw: string): LibraryDrop | null {
  if (raw.length > 512) return null;
  try { const value = JSON.parse(raw) as LibraryDrop; if (!DROP_KINDS.includes(value.kind)) return null; if (value.kind.startsWith('declared_')) return { kind: value.kind }; return value.revisionId && UUID.test(value.revisionId) ? { kind: value.kind, revisionId: value.revisionId } : null; } catch { return null; }
}
export type PartPlacement = {use:'shell'} | {use:'inline';declaredTwoLead:true;componentKind:InlineComponent['kind']};
/** Engineering edits retain endpoint IDs, stock-end declarations and all existing mappings. */
export function placeLibraryDrop(cable: Cable, drop: LibraryDrop, endpointId: string | null, source?: unknown, savedStack?: EndStack, partUse?:PartPlacement): Cable {
  if (drop.kind === 'wire_stock') return { ...cable, stock_revision_id: drop.revisionId!, review: 'unreviewed', review_basis: null };
  const endpoint = cable.endpoints.find(end => end.local_id === endpointId); if (!endpoint) throw new Error('Choose which cable end this part belongs to.');
  if (drop.kind === 'end_assembly') return { ...cable, endpoints: cable.endpoints.map(end => end === endpoint ? { ...end, end_assembly_revision_id: drop.revisionId!, stack: null } : end), review: 'unreviewed', review_basis: null };
  if (endpoint.end_assembly_revision_id && !savedStack) throw new Error('Read the exact saved stack before preparing a local copy.');
  let stack = structuredClone(savedStack ?? endpoint.stack ?? { layers: [], joins: [] });
  if(drop.kind==='part'&&(!partUse||partUse.use==='inline'&&!partUse.declaredTwoLead))throw new Error('Choose shell/hardware or explicitly declare a two-lead inline use.');
  const kind = drop.kind === 'connector_body' || drop.kind === 'pinout' ? 'connector' : drop.kind === 'board' ? 'board' : drop.kind === 'part' && partUse?.use!=='inline' ? 'shell' : 'inline';
  if (!stack.layers.some(layer => layer.kind === kind)) stack = addLayer(stack, kind);
  stack.layers = stack.layers.map((layer): StackLayer => {
    if (layer.kind !== kind) return layer;
    if (layer.kind === 'connector') {
      if (drop.kind === 'pinout') { const pinout = source as Pinout; if (pinout?.kind !== 'pinout' || !pinout.body_revision_id) throw new Error('The exact pinout has no readable connector-body pin.'); return { ...layer, body_revision_id: pinout.body_revision_id, pinout_revision_id: drop.revisionId! }; }
      return { ...layer, body_revision_id: drop.revisionId!, pinout_revision_id: layer.body_revision_id === drop.revisionId ? layer.pinout_revision_id : '' };
    }
    if (layer.kind === 'board') return { ...layer, board_revision_id: drop.revisionId!, carried_connector_id: null };
    if (layer.kind === 'shell') return { ...layer, part_revision_id: drop.revisionId! };
    const component = drop.kind === 'part'&&partUse?.use==='inline'?partUse.componentKind:drop.kind === 'declared_resistor' ? 'resistor' : 'capacitor';
    // addLayer starts with an empty resistor declaration; keep existing local components.
    const existing = (savedStack ?? endpoint.stack)?.layers.find(item => item.kind === 'inline');
    const parts = existing?.kind === 'inline' ? existing.parts : [];
    let index = 1; while (parts.some(part => part.local_id === `part-${index}`)) index += 1;
    return { ...layer, parts: [...parts, { local_id: `part-${index}`, label: null,...(drop.kind==='part'?{part_revision_id:drop.revisionId!}:{}), component: { kind: component, reference: null, value: null, resistance_ohm: null, capacitance_f: null } }] };
  });
  return { ...cable, endpoints: cable.endpoints.map(end => end === endpoint ? { ...end, end_assembly_revision_id: null, stack } : end), review: 'unreviewed', review_basis: null };
}
export type HandleAddress = { type: 'wire'; endpointId: string; path: string } | { type: 'terminal'; endpointId: string; layerId: string; terminalId: string };
export const handleId = (value: HandleAddress) => encodeURIComponent(JSON.stringify(value));
export function parseHandle(raw: string | null | undefined): HandleAddress | null {
 try {
  if (!raw || raw.length > 16384) return null;
  const value: unknown = JSON.parse(decodeURIComponent(raw));
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row=value as Record<string,unknown>, text=(key:string)=>typeof row[key]==='string'&&(row[key] as string).length>0&&(row[key] as string).length<=4096;
  if(!text('endpointId'))return null;
  if(row.type==='wire'&&Object.keys(row).length===3&&text('path'))return row as HandleAddress;
  if(row.type==='terminal'&&Object.keys(row).length===4&&text('layerId')&&text('terminalId'))return row as HandleAddress;
  return null;
 } catch { return null; }
}
export function manualLanding(cable: Cable, left: HandleAddress, right: HandleAddress, reason: string): Cable {
  const wire = left.type === 'wire' ? left : right.type === 'wire' ? right : null, terminal = left.type === 'terminal' ? left : right.type === 'terminal' ? right : null;
  if (!wire || !terminal || wire.endpointId !== terminal.endpointId) throw new Error('Connect a stock conductor to a terminal of the same cable end.');
  if (!reason.trim()) throw new Error('Record a basis for this manual landing.');
  return { ...cable, review: 'unreviewed', review_basis: null, assignments: [...cable.assignments.filter(item => !(item.endpoint_id === wire.endpointId && item.element_path === wire.path)), { endpoint_id: wire.endpointId, element_path: wire.path, layer_id: terminal.layerId, terminal_id: terminal.terminalId, basis: reason.trim() }] };
}
export type SavedAssembly = { interface: EndAssembly };

export function manualJoin(cable: Cable, left: HandleAddress, right: HandleAddress, reason: string, kind: EndStack['joins'][number]['kind'], savedStack?: EndStack): Cable {
  if (left.type !== 'terminal' || right.type !== 'terminal' || left.endpointId !== right.endpointId || left.layerId === right.layerId && left.terminalId === right.terminalId) throw new Error('Choose two different terminals on the same end stack.');
  if (!reason.trim()) throw new Error('Record a basis for this declared joint.');
  const endpoint = cable.endpoints.find(end => end.local_id === left.endpointId); if (!endpoint || endpoint.end_assembly_revision_id && !savedStack) throw new Error('Read the exact saved stack before preparing a local joint.');
  const stack = structuredClone(savedStack ?? endpoint.stack); if (!stack) throw new Error('No editable end stack is available.');
  const a=stack.layers.find(layer=>layer.layer_id===left.layerId),b=stack.layers.find(layer=>layer.layer_id===right.layerId);
  if(!a||!b)throw new Error('Choose terminals on declared end-stack layers.');
  if(left.layerId===right.layerId){const owner=(id:string)=>a.kind==='inline'?a.parts.find(part=>[`${part.local_id}.1`,`${part.local_id}.2`].includes(id))?.local_id:null;const first=owner(left.terminalId),second=owner(right.terminalId);if(!first||!second||first===second)throw new Error('Same-layer joints require declared leads of different inline parts.');}
  const shell=a.kind==='shell'||b.kind==='shell';if(kind==='bond'&&!shell||shell&&kind!=='bond')throw new Error('A shell requires a bond; other layers cannot declare a shell bond.');
  let index = 1; while (stack.joins.some(join => join.local_id === `joint-${index}`)) index += 1;
  stack.joins.push({ local_id: `joint-${index}`, a: {layer_id:left.layerId,terminal_id:left.terminalId}, b: {layer_id:right.layerId,terminal_id:right.terminalId},kind,basis:reason.trim() });
  return {...cable,review:'unreviewed',review_basis:null,endpoints:cable.endpoints.map(end=>end===endpoint?{...end,end_assembly_revision_id:null,stack}:end)};
}

export const inlineNodeId=(endpointId:string,layerId:string,partId:string)=>`inline:${encodeURIComponent(endpointId)}:${encodeURIComponent(layerId)}:${encodeURIComponent(partId)}`;
