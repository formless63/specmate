import type { Edge } from '@xyflow/react';
import { sectionLayout, renderSectionSvg, type StockSpecification } from '../../../../packages/section-layout/src';
import { layoutKey } from '../manual-canvas/layout';
import type { FlowItem } from '../manual-canvas/EngineeringFlow';
import { placeLibraryDrop, manualJoin, inlineNodeId, type LibraryDrop, type PartPlacement } from '../manual-canvas/model';
import { ConnectorFace, geometryForBody } from '../../../../packages/connector-art/src';
import { faceFrame } from '../cable-workbench/model';
import { rowLook } from '../cable-views/Swatch';
import type { Body } from '../interfaces/api';
import type { EndStack, JoinKind, ResolvedStack } from '../end-assemblies/api';
import { initialCable } from '../cables/api';
import { terminalKey, terminalLabel, type Harness, type Joint, type Terminal } from './api';

/** Domain addresses are encoded in full; labels and selector syntax never become identities. */
export const harnessHandle = (terminal: Terminal) => encodeURIComponent(terminalKey(terminal));
export const harnessNode = (kind: 'segment' | 'endpoint', id: string, ...details: string[]) => encodeURIComponent(JSON.stringify([kind, id, ...details]));
export type HarnessCanvasData = { stocks: Record<string, StockSpecification>; ends: Record<string, ResolvedStack>; bodies?: Record<string, Body> };
const lines = (text: string) => Math.max(1, Math.ceil(text.length / 22));
function nodeHeight(item: FlowItem, artworkHeight: number) {
  const rows = new Map<string, string>(); for (const port of item.ports) rows.set(port.row ?? port.id, port.rowLabel ?? port.label);
  return 100 + lines(item.title) * 24 + lines(item.detail ?? '') * 18 + artworkHeight + [...rows.values()].reduce((height, text) => height + Math.max(28, lines(text) * 18 + 8), 0);
}
export function harnessGraph(harness: Harness, data: HarnessCanvasData) {
  const terminals = new Map<string, Terminal>(), nodes = new Map<string, string>(), items: FlowItem[] = [], edges: Edge[] = [], colors = new Map<string, string>();
  let segmentY = 0; const endpointY = [0, 0];
  for (const segment of harness.segments) {
    const section = harness.sections.find(item => item.local_id === segment.section_id), stock = section && data.stocks[section.stock_revision_id];
    const rows = stock ? sectionLayout(stock).rows.filter(row => ['conductor', 'shield', 'drain'].includes(row.kind) && (segment.element_paths === null || segment.element_paths.includes(row.path))) : [];
    const id = harnessNode('segment', segment.local_id);
    const ports = rows.flatMap(row => (['a', 'b'] as const).map(end => {
      const terminal: Terminal = { kind: 'segment', segment_id: segment.local_id, end, element_path: row.path }, handle = harnessHandle(terminal);
      terminals.set(handle, terminal); nodes.set(handle, id); const look = rowLook(row), color = ['recorded', 'conventional-name'].includes(look.fillSource) ? look.base : undefined; if (color) colors.set(handle, color);
      return { id: handle, label: `${end.toUpperCase()} · ${row.label} · ${row.path}`, row: row.path, rowLabel: row.label, side: end === 'a' ? 'left' as const : 'right' as const, color: colors.get(handle), unknown: !colors.has(handle) };
    }));
    items.push({ id, title: segment.label ?? segment.local_id, detail: `Section ${segment.section_id} · cut ${section?.planned_cut_length_mm ?? 'unknown'}${section?.planned_cut_length_mm ? ' mm' : ''} · A ← → B`, ports, artwork: stock ? <div className="manual-stock-art" dangerouslySetInnerHTML={{ __html: renderSectionSvg(sectionLayout(stock), `Section ${segment.section_id} exact cross-section`, { idPrefix: 'harness-' + layoutKey(id), callouts: false }) }} /> : <div className="sb-hatch">Stock geometry unknown</div>, position: { x: 400, y: segmentY } });
    segmentY += nodeHeight(items[items.length - 1]!, stock ? 180 : 110);
  }
  for (const [index, endpoint] of harness.endpoints.entries()) {
    const resolved = data.ends[endpoint.local_id], body = resolved?.body_revision_id ? data.bodies?.[resolved.body_revision_id] : undefined;
    const geometry = body?.geometry_key ? geometryForBody({ geometry: body.geometry_key, mating_role: body.mating_role }) : null;
    const groups = (resolved?.layers ?? []).flatMap(layer => layer.kind === 'inline' && layer.parts?.length
      ? layer.parts.map(part => ({ layer, part: part.local_id, title: part.name, detail: part.summary, terminals: layer.terminals.filter(terminal => terminal.part === part.local_id) })).concat(layer.terminals.some(terminal => !terminal.part) ? [{ layer, part: '', title: 'Unassigned inline terminals', detail: 'Part identity unknown', terminals: layer.terminals.filter(terminal => !terminal.part) }] : [])
      : [{ layer, part: '', title: layer.name ?? layer.kind, detail: layer.kind, terminals: layer.terminals }]);
    if (!groups.length) items.push({ id: harnessNode('endpoint', endpoint.local_id), title: endpoint.label ?? endpoint.local_id, detail: 'Drop exact layers here; unresolved terminals remain unknown', endpointId: endpoint.local_id, ports: [], position: { x: index % 2 ? 850 : 0, y: endpointY[index % 2]! } });
    for (const group of groups) {
      const id = group.part ? inlineNodeId(endpoint.local_id, group.layer.layer_id, group.part) : harnessNode('endpoint', endpoint.local_id, group.layer.layer_id);
      const ports = group.terminals.map(item => {
        const terminal: Terminal = { kind: 'endpoint', endpoint_id: endpoint.local_id, layer_id: group.layer.layer_id, terminal_id: item.terminal_id }, handle = harnessHandle(terminal);
        terminals.set(handle, terminal); nodes.set(handle, id);
        return { id: handle, label: `${item.label}${item.signal ? ' · ' + item.signal.name : ''}`, side: index % 2 ? 'left' as const : 'right' as const, unknown: true };
      });
      const artwork = group.layer.kind === 'connector' ? geometry ? <ConnectorFace geometry={geometry} view="mating" pins={body?.contacts.map(contact => ({ id: contact.contact_id, label: contact.label, state: 'unknown' }))} size={190} title={`${endpoint.label ?? endpoint.local_id} · exact declared mating face`} /> : <div className="sb-hatch">Connector face geometry unknown</div> : group.layer.kind === 'inline' ? <div className="harness-component" aria-label={group.detail}>{group.detail || 'Declared inline component · value unknown'}</div> : undefined;
      items.push({ id, title: group.title, detail: `${endpoint.label ?? endpoint.local_id} · ${group.detail}`, endpointId: endpoint.local_id, ports, artwork, position: { x: index % 2 ? 850 : 0, y: endpointY[index % 2]! } });
      endpointY[index % 2]! += nodeHeight(items[items.length - 1]!, artwork ? group.layer.kind === 'connector' && geometry ? faceFrame(geometry, 190).height + 30 : 110 : 0);
    }
    if (!groups.length) endpointY[index % 2]! += 240;
  }
  let unresolved = 0;
  function edge(id: string, left: Terminal, right: Terminal, label: string, dashed = false) {
    const a = harnessHandle(left), b = harnessHandle(right);
    if (!nodes.has(a) || !nodes.has(b)) { unresolved += 1; return; }
    edges.push({ id: encodeURIComponent(id), source: nodes.get(a)!, target: nodes.get(b)!, sourceHandle: a, targetHandle: b, label, style: { stroke: colors.get(a) ?? colors.get(b) ?? 'var(--sb-text-tertiary)', strokeWidth: 2, strokeDasharray: dashed || !colors.has(a) && !colors.has(b) ? '6 4' : undefined } });
  }
  for (const endpoint of harness.endpoints) for (const join of data.ends[endpoint.local_id]?.joins ?? []) {
    for (const [index, target] of [join.b, ...(join.through ? [join.through] : [])].entries()) edge(JSON.stringify(['end-join', endpoint.local_id, join.local_id, index]), { kind: 'endpoint', endpoint_id: endpoint.local_id, ...join.a }, { kind: 'endpoint', endpoint_id: endpoint.local_id, ...target }, `${join.kind}${index ? ' · same carrier solder point' : ''} · ${join.basis}`, join.status === 'unknown');
  }
  for (const joint of harness.joints) for (const member of joint.members.slice(1)) edge(JSON.stringify(['joint', joint.local_id, terminalKey(member)]), joint.members[0]!, member, `${joint.kind} · ${joint.basis}`);
  for (const breakout of harness.breakouts) for (const fate of breakout.fates) if (fate.kind === 'through') edge(JSON.stringify(['through', breakout.local_id, fate.local_id]), fate.trunk, fate.leg, `Declared uncut passage · ${fate.basis}`, true);
  // Endpoint colors are projected only from explicit joint membership with one known stock hue.
  for (const item of items) for (const port of item.ports) if (!colors.has(port.id)) {
    const terminal = terminals.get(port.id); if (!terminal) continue;
    const hues = [...new Set(harness.joints.filter(joint => joint.members.some(member => terminalKey(member) === terminalKey(terminal))).flatMap(joint => joint.members.map(member => colors.get(harnessHandle(member))).filter((color): color is string => !!color)))];
    if (hues.length === 1) { port.color = hues[0]; port.unknown = false; }
  }
  return { items, edges, terminals, unresolved };
}
export function addHarnessJoint(harness: Harness, left: Terminal, right: Terminal, kind: Joint['kind'], basis: string): Harness {
  if (terminalKey(left) === terminalKey(right)) throw new Error('Choose two different exact terminals.');
  if (!basis.trim()) throw new Error('Record a basis for this declared joint.');
  if (harness.joints.some(joint => joint.members.some(member => [terminalKey(left), terminalKey(right)].includes(terminalKey(member))))) throw new Error('A terminal already belongs to a joint. Edit that declared joint explicitly.');
  let index = 1; while (harness.joints.some(joint => joint.local_id === `joint-${index}`)) index += 1;
  return { ...harness, review: 'unreviewed', review_basis: null, joints: [...harness.joints, { local_id: `joint-${index}`, kind, members: [left, right], basis: basis.trim() }] };
}
/** Same-end internals remain in the existing end-stack domain, with original layer and lead IDs. */
export function joinHarnessStack(harness: Harness, left: Terminal, right: Terminal, basis: string, kind: JoinKind, savedStack?: EndStack): Harness {
  if (left.kind !== 'endpoint' || right.kind !== 'endpoint' || left.endpoint_id !== right.endpoint_id) throw new Error('Choose two exact terminals on the same harness endpoint.');
  const cable = manualJoin({ ...initialCable(), endpoints: harness.endpoints.map(endpoint => ({ ...endpoint, stock_end: 'unknown' as const })) }, { type: 'terminal', endpointId: left.endpoint_id, layerId: left.layer_id, terminalId: left.terminal_id }, { type: 'terminal', endpointId: right.endpoint_id, layerId: right.layer_id, terminalId: right.terminal_id }, basis, kind, savedStack);
  return { ...harness, review: 'unreviewed', review_basis: null, endpoints: cable.endpoints.map(({ stock_end: _, ...endpoint }) => endpoint) };
}
/** Reuse the exact end-stack placement adapter, while preserving Harness's own section and topology records. */
export function placeHarnessDrop(harness: Harness, drop: LibraryDrop, source?: unknown, targetId: string | null = null, savedStack?: EndStack, partUse?: PartPlacement): { harness: Harness; node: string } {
  if (drop.kind === 'wire_stock') {
    let index = 1; while (harness.sections.some(section => section.local_id === `section-${index}`) || harness.segments.some(segment => segment.local_id === `span-${index}`)) index += 1;
    const section = `section-${index}`, segment = `span-${index}`;
    return { harness: { ...harness, review: 'unreviewed', review_basis: null, sections: [...harness.sections, { local_id: section, stock_revision_id: drop.revisionId!, planned_cut_length_mm: null, cut_basis: null }], segments: [...harness.segments, { local_id: segment, section_id: section, label: null, element_paths: null }] }, node: harnessNode('segment', segment) };
  }
  let index = 1; while (harness.endpoints.some(endpoint => endpoint.local_id === `end-${index}`)) index += 1;
  const id = targetId ?? `end-${index}`, existing = harness.endpoints.find(endpoint => endpoint.local_id === targetId);
  if (targetId && !existing) throw new Error('The selected endpoint is unavailable.');
  const cable = placeLibraryDrop({ ...initialCable(), endpoints: [{ ...(existing ?? { local_id: id, label: null, end_assembly_revision_id: null, stack: { layers: [], joins: [] } }), stock_end: 'unknown' }] }, drop, id, source, savedStack, partUse);
  const placed = cable.endpoints[0]!, endpoint = { local_id: placed.local_id, label: placed.label, end_assembly_revision_id: placed.end_assembly_revision_id, stack: placed.stack };
  return { harness: { ...harness, review: 'unreviewed', review_basis: null, endpoints: existing ? harness.endpoints.map(item => item === existing ? endpoint : item) : [...harness.endpoints, endpoint] }, node: harnessNode('endpoint', id) };
}
export const describeHarnessTerminal = terminalLabel;
