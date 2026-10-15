/**
 * Probe relations of the cable drawing: which marks light up when one is selected. Physical
 * marks (wires, terminals, parts, traces) relate through declared landings, joins, board paths
 * and inline parts; check rows relate through the terminals and wires on their declared path.
 * This is declared topology for display, never measured continuity.
 */
import { STOCK_KEY, endKey, proposedKey, rowKey, wireKey, type CheckIndex, type Drawing } from "./model";

export type Graph = Map<string, Set<string>>;

function connect(graph: Graph, a: string, b: string) {
  if (!graph.has(a)) graph.set(a, new Set());
  if (!graph.has(b)) graph.set(b, new Set());
  graph.get(a)!.add(b);
  graph.get(b)!.add(a);
}

/** Undirected physical graph of a drawing: landings, joins, board paths and inline parts. */
export function physicalGraph(drawing: Drawing): Graph {
  const graph: Graph = new Map();
  for (const wire of drawing.wires) {
    if (wire.aTerminal) connect(graph, wire.key, wire.aTerminal);
    if (wire.bTerminal) connect(graph, wire.key, wire.bTerminal);
  }
  for (const end of drawing.ends) {
    for (const join of end.joins) connect(graph, join.a, join.b);
    for (const trace of end.traces) { connect(graph, trace.from, trace.key); connect(graph, trace.key, trace.to); }
    for (const part of end.parts) for (const lead of part.leads) connect(graph, part.key, lead);
  }
  return graph;
}

function component(graph: Graph, start: string): Set<string> {
  const seen = new Set([start]);
  const queue = [start];
  while (queue.length) {
    const node = queue.shift()!;
    for (const next of graph.get(node) ?? []) if (!seen.has(next)) { seen.add(next); queue.push(next); }
  }
  return seen;
}

/**
 * Every mark related to the selection, the selection included; null when nothing is selected.
 * A physical mark lights its whole declared net and every check row passing it; a row lights
 * the marks on its path; a proposed row lights its wires and proposed terminals.
 */
export function relatedKeys(drawing: Drawing, graph: Graph, index: CheckIndex, selection: string | null): Set<string> | null {
  if (!selection) return null;
  const lit = new Set<string>([selection]);
  if (selection === STOCK_KEY) {
    for (const wire of drawing.wires) lit.add(wire.key);
    return lit;
  }
  if (selection.startsWith("e:")) {
    const end = drawing.ends.find((e) => endKey(e.endpointId) === selection);
    for (const t of end?.terminals ?? []) lit.add(t.key);
    for (const p of end?.parts ?? []) lit.add(p.key);
    for (const t of end?.traces ?? []) lit.add(t.key);
    return lit;
  }
  if (selection.startsWith("r:")) {
    for (const key of index.rowRefs.get(selection.slice(2)) ?? []) lit.add(key);
    // Parts and traces between two lit terminals are on the path too.
    for (const [node, neighbors] of graph) if (!lit.has(node) && (node.startsWith("p:")) && [...neighbors].filter((n) => lit.has(n)).length >= 2) lit.add(node);
    return lit;
  }
  if (selection.startsWith("q:")) {
    for (const p of drawing.proposals.filter((x) => proposedKey(x.rowId) === selection)) { lit.add(wireKey(p.path)); lit.add(p.terminal); }
    return lit;
  }
  for (const key of component(graph, selection)) lit.add(key);
  for (const key of [...lit]) for (const row of index.rowsOf.get(key) ?? []) lit.add(rowKey(row));
  for (const p of drawing.proposals) if (lit.has(wireKey(p.path))) lit.add(proposedKey(p.rowId));
  return lit;
}
