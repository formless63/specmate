/**
 * Drawing derivation for the cable workbench: where each end's layers, terminals, parts and
 * joins sit, where each stock element runs, and which check outcome belongs to which mark.
 * Pure functions over the cable declaration, resolved end stacks, the frozen stock and an
 * optional intent check; nothing here reads the network or invents a connection.
 */
import { appearanceOf, type Appearance, type StockElement, type StockSpecification } from "../../../../packages/section-layout/src";
import type { Assignment, Cable } from "../cables/api";
import { LAYER_LABELS, LAYER_ORDER, type LayerKind, type ResolvedLayer, type ResolvedStack, type ResolvedTerminal, type SignalRef } from "../end-assemblies/api";
import type { CheckRow, IntentCheck, Status } from "../intent-check/api";
import type { Proposal } from "../intent-propose/ProposeWiring";
import { colorName } from "../wire-stock/builder";
import { worst } from "./palette";

// ---------------------------------------------------------------- keys

export const wireKey = (path: string) => `w:${path}`;
export const termKey = (endpointId: string, layerId: string, terminalId: string) => `t:${endpointId}/${layerId}/${terminalId}`;
export const partKey = (endpointId: string, layerId: string, id: string) => `p:${endpointId}/${layerId}/${id}`;
export const traceKey = (endpointId: string, layerId: string, id: string) => `p:${endpointId}/${layerId}/path:${id}`;
export const rowKey = (rowId: string) => `r:${rowId}`;
export const proposedKey = (rowId: string) => `q:${rowId}`;
export const endKey = (endpointId: string) => `e:${endpointId}`;
export const STOCK_KEY = "s:stock";

/** The parts of a terminal key (`t:end/layer/terminal`); terminal IDs may themselves contain "/". */
export function splitTermKey(key: string): { endpointId: string; layerId: string; terminalId: string } | null {
  if (!key.startsWith("t:")) return null;
  const rest = key.slice(2);
  const first = rest.indexOf("/");
  const second = rest.indexOf("/", first + 1);
  if (first < 0 || second < 0) return null;
  return { endpointId: rest.slice(0, first), layerId: rest.slice(first + 1, second), terminalId: rest.slice(second + 1) };
}

// ---------------------------------------------------------------- stock elements

export type ConductiveKind = "conductor" | "shield" | "drain";
export type ConductiveElement = { path: string; kind: ConductiveKind; label: string; display: string; look: Appearance; inStock: boolean };

/** Conductive elements of a stock: label and recorded color for display, path for identity. */
export function conductiveElements(node: StockElement, prefix = "", coreColor: string | null = null, group: string | null = null): ConductiveElement[] {
  const path = prefix ? `${prefix}.${node.id}` : node.id;
  if (node.kind === "group") {
    // A core's identifying color is its insulation color; its conductor is bare metal.
    const insulation = node.children.find((c) => c.kind === "insulation")?.color ?? null;
    return node.children.flatMap((child) => conductiveElements(child, path, insulation, prefix ? node.label?.trim() || node.id : null));
  }
  if (node.kind !== "conductor" && node.kind !== "shield" && node.kind !== "drain") return [];
  const construction = "construction" in node ? node.construction : null;
  const color = node.kind === "conductor" && coreColor ? coreColor : node.color;
  const look = appearanceOf({ kind: node.kind, color, material: node.material, construction });
  const own = node.label?.trim() || path;
  const name = group && !own.toLowerCase().includes(group.toLowerCase()) ? `${group} ${own.toLowerCase()}` : own;
  // A plain color word only when one is known; the drawn swatch shows any other recorded color.
  const word = color && colorName(color) !== color ? colorName(color) : null;
  return [{ path, kind: node.kind, label: node.label, display: word && !name.toLowerCase().includes(word) ? `${name} (${word})` : name, look, inStock: true }];
}

/** The stock's jacket (outermost jacket element), for the drawn body of the cable. */
export function jacketLook(stock: StockSpecification | undefined): Appearance | null {
  const jacket = stock?.structure.children.find((c) => c.kind === "jacket");
  if (!jacket || jacket.kind === "group") return null;
  return appearanceOf({ kind: "jacket", color: jacket.color, material: jacket.material, construction: null });
}

// ---------------------------------------------------------------- check index

export type CheckIndex = {
  /** Element keys (wires and terminals) on each row's declared path. */
  rowRefs: Map<string, Set<string>>;
  /** Rows whose path passes each element key. */
  rowsOf: Map<string, string[]>;
  /** Worst row outcome of each element key. */
  statusOf: Map<string, Status>;
  rows: Map<string, CheckRow>;
};

type ChipRef = { endpoint_id?: string; layer_id?: string; terminal_id?: string; element_path?: string };

/** Which wires and terminals each check row's path passes, from the chips' refs. */
export function indexCheck(check: IntentCheck | undefined | null): CheckIndex {
  const rowRefs = new Map<string, Set<string>>();
  const rowsOf = new Map<string, string[]>();
  const statuses = new Map<string, Status[]>();
  const rows = new Map<string, CheckRow>();
  for (const row of check?.rows ?? []) {
    rows.set(row.row_id, row);
    const refs = new Set<string>();
    for (const chip of row.path) {
      const ref = (chip as { ref?: ChipRef }).ref;
      if (!ref) continue;
      if (ref.element_path) refs.add(wireKey(ref.element_path));
      else if (ref.endpoint_id && ref.layer_id && ref.terminal_id) refs.add(termKey(ref.endpoint_id, ref.layer_id, ref.terminal_id));
    }
    rowRefs.set(row.row_id, refs);
    for (const key of refs) {
      rowsOf.set(key, [...(rowsOf.get(key) ?? []), row.row_id]);
      statuses.set(key, [...(statuses.get(key) ?? []), row.outcome]);
    }
  }
  const statusOf = new Map<string, Status>();
  for (const [key, list] of statuses) { const w = worst(list); if (w) statusOf.set(key, w); }
  return { rowRefs, rowsOf, statusOf, rows };
}

// ---------------------------------------------------------------- layout

export const PITCH = 18;
export const FACE = 112;
const WIDTHS: Record<LayerKind | "unknown", number> = { shell: 30, connector: 104, board: 160, inline: 96, unknown: 120 };
const GAP = 30;
const MARGIN = 14;
const FAN = 64;
const STOCK = 420;
const TOP = 22;

export type Point = { x: number; y: number };
export type DrawnTerminal = {
  key: string; endpointId: string; layerId: string; terminalId: string; layerKind: LayerKind | "unknown";
  label: string; kind: string; signal: SignalRef | null; signalStatus: string;
  x: number; y: number; halfWidth: number; status: Status | null; side: "connector" | "cable" | "middle";
};
export type DrawnColumn = { key: string; endpointId: string; layerId: string; kind: LayerKind | "unknown"; name: string | null; detail: string | null; x: number; width: number };
export type DrawnPart = { key: string; endpointId: string; layerId: string; name: string; summary: string; component: string; x: number; y: number; leads: string[] };
export type DrawnTrace = { key: string; endpointId: string; from: string; to: string; via: string; summary: string; status: "declared" | "unknown"; d: string; mid: Point };
export type DrawnJoin = { key: string; endpointId: string; a: string; b: string; kind: string; status: string; basis: string; d: string };
export type DrawnEnd = {
  endpointId: string; index: number; label: string; side: "left" | "right"; x0: number; x1: number; resolved: boolean;
  columns: DrawnColumn[]; terminals: DrawnTerminal[]; parts: DrawnPart[]; traces: DrawnTrace[]; joins: DrawnJoin[];
  connector: { layerId: string; cx: number; bodyRevisionId: string | null; name: string | null } | null;
};
export type DrawnWire = {
  key: string; path: string; kind: ConductiveKind; label: string; display: string; look: Appearance | null; inStock: boolean;
  lane: number; d: string; a: Point | null; b: Point | null; aTerminal: string | null; bTerminal: string | null;
  open: Point[]; status: Status | null; rows: string[]; signal: SignalRef | null;
};
export type DrawnProposal = { key: string; rowId: string; path: string; endpointId: string; terminal: string; terminalLabel: string; change: string; d: string };
export type Drawing = {
  width: number; height: number; bodyTop: number; bodyHeight: number; faceTop: number;
  ends: DrawnEnd[]; extraEnds: number; wires: DrawnWire[]; proposals: DrawnProposal[];
  terminals: Map<string, DrawnTerminal>;
  stock: { x0: number; x1: number; jacketX0: number; jacketX1: number; cy: number; height: number; breakX: number; dimY: number; callout: Point & { r: number }; jacket: Appearance | null };
};

export type DrawingInput = {
  cable: Cable;
  stacks: (ResolvedStack | undefined)[];
  stock?: StockSpecification;
  /** Conductive elements when the stock itself is not readable yet (frozen inspection rows). */
  conductors?: { element_path: string; kind: string; label: string }[];
  check?: IntentCheck | null;
  proposal?: Pick<Proposal, "rows" | "diff"> | null;
};

const collator = new Intl.Collator("en", { numeric: true, sensitivity: "base" });
const byLabel = (a: ResolvedTerminal, b: ResolvedTerminal) => (a.kind === "shell" ? 1 : 0) - (b.kind === "shell" ? 1 : 0) || collator.compare(a.label, b.label);
const sortedLayers = (stack: ResolvedStack) => [...stack.layers].sort((a, b) => LAYER_ORDER.indexOf(a.kind) - LAYER_ORDER.indexOf(b.kind));

type PlanLayer = { kind: LayerKind | "unknown"; layer: ResolvedLayer; layerOf: (t: ResolvedTerminal) => string };

/** What an end draws when its stack is not resolved: one unknown box listing each declared landing. */
function unresolvedLayer(cable: Cable, endpointId: string): PlanLayer {
  const own = cable.assignments.filter((a) => a.endpoint_id === endpointId);
  const unique = [...new Map(own.map((a) => [`${a.layer_id}/${a.terminal_id}`, a])).values()];
  const layers = new Map(unique.map((a) => [a.terminal_id, a.layer_id]));
  const terminals: ResolvedTerminal[] = unique.map((a) => ({ terminal_id: a.terminal_id, label: `${a.layer_id} ${a.terminal_id}`, kind: "unknown", reaches: [] }));
  return { kind: "unknown", layer: { layer_id: "", kind: "connector", name: null, terminals }, layerOf: (t) => layers.get(t.terminal_id) ?? "" };
}

function columnRows(layer: ResolvedLayer, stack: ResolvedStack | undefined): number {
  if (layer.kind === "inline") return Math.max(1, layer.parts?.length ?? 0);
  if (layer.kind === "shell") return 1;
  if (layer.kind === "board") {
    const sides = boardSides(layer, stack);
    return Math.max(sides.connector.length, sides.cable.length, 1);
  }
  return Math.max(1, layer.terminals.length);
}

/** A board's pads split by side: pads joined to the connector (or grouped as connector side), and the cable side. */
function boardSides(layer: ResolvedLayer, stack: ResolvedStack | undefined) {
  const connectorLayers = new Set((stack?.layers ?? []).filter((l) => l.kind === "connector").map((l) => l.layer_id));
  const joined = new Set<string>();
  for (const join of stack?.joins ?? []) {
    if (join.a.layer_id === layer.layer_id && connectorLayers.has(join.b.layer_id)) joined.add(join.a.terminal_id);
    if (join.b.layer_id === layer.layer_id && connectorLayers.has(join.a.layer_id)) joined.add(join.b.terminal_id);
  }
  const connector: ResolvedTerminal[] = [];
  const cable: ResolvedTerminal[] = [];
  for (const t of layer.terminals) (joined.has(t.terminal_id) || /connector/i.test(t.group ?? "") ? connector : cable).push(t);
  if (!connector.length || !cable.length) return { connector: [] as ResolvedTerminal[], cable: [...layer.terminals].sort(byLabel), single: true };
  return { connector, cable, single: false };
}

/** Evenly spaced row centers for `count` items around the band center. */
function rows(count: number, center: number): number[] {
  return Array.from({ length: count }, (_, i) => center + (i - (count - 1) / 2) * PITCH);
}

const curve = (from: Point, to: Point) => {
  const dx = (to.x - from.x) / 2;
  return `M${r(from.x)} ${r(from.y)}C${r(from.x + dx)} ${r(from.y)} ${r(to.x - dx)} ${r(to.y)} ${r(to.x)} ${r(to.y)}`;
};
const r = (n: number) => Math.round(n * 10) / 10;

/** The edge of a terminal mark that faces `toward` (an x position). */
export function anchor(t: Pick<DrawnTerminal, "x" | "y" | "halfWidth">, toward: number): Point {
  return { x: toward >= t.x ? t.x + t.halfWidth : t.x - t.halfWidth, y: t.y };
}

type EndPlan = { endpointId: string; index: number; label: string; stack: ResolvedStack | undefined; layers: PlanLayer[]; width: number; rows: number };

function planEnd(cable: Cable, index: number, stack: ResolvedStack | undefined): EndPlan {
  const endpoint = cable.endpoints[index]!;
  const label = endpoint.label?.trim() || `End ${endpoint.local_id.toUpperCase()}`;
  const layers: PlanLayer[] = stack
    ? sortedLayers(stack).map((layer) => ({ kind: layer.kind, layer, layerOf: () => layer.layer_id }))
    : [unresolvedLayer(cable, endpoint.local_id)];
  // The left end reads outward from the stock: shell outermost on the left.
  const ordered = index === 0 ? [...layers].reverse() : layers;
  const width = ordered.reduce((sum, l) => sum + WIDTHS[l.kind], 0) + GAP * Math.max(0, ordered.length - 1);
  const rowCount = Math.max(1, ...ordered.map((l) => l.kind === "unknown" ? l.layer.terminals.length : columnRows(l.layer, stack)));
  return { endpointId: endpoint.local_id, index, label, stack, layers: ordered, width, rows: rowCount };
}

function layoutEnd(plan: EndPlan, x0: number, center: number, index: CheckIndex): DrawnEnd {
  const side = plan.index === 0 ? "left" : "right";
  const stockward = side === "left" ? 1 : -1;
  const ep = plan.endpointId;
  const columns: DrawnColumn[] = [];
  const terminals: DrawnTerminal[] = [];
  const parts: DrawnPart[] = [];
  let connector: DrawnEnd["connector"] = null;
  // Connector contacts in reading order, so board pads can follow the contact they land on.
  const contactOrder = new Map<string, number>();
  for (const { layer } of plan.layers.filter((l) => l.kind === "connector")) [...layer.terminals].sort(byLabel).forEach((t, i) => contactOrder.set(t.terminal_id, i));
  const terminal = (plan_: PlanLayer, t: ResolvedTerminal, x: number, y: number, halfWidth: number, position: DrawnTerminal["side"]): DrawnTerminal => {
    const kind = plan_.kind;
    const layerId = plan_.layerOf(t);
    const key = termKey(ep, layerId, t.terminal_id);
    const drawn: DrawnTerminal = {
      key, endpointId: ep, layerId, terminalId: t.terminal_id, layerKind: kind, label: t.label, kind: t.kind,
      signal: t.signal ?? t.reaches.find((reach) => reach.signal)?.signal ?? null, signalStatus: t.signal_status ?? (t.reaches.length ? "declared" : "unknown"),
      x, y, halfWidth, status: index.statusOf.get(key) ?? null, side: position,
    };
    terminals.push(drawn);
    return drawn;
  };
  let x = x0;
  for (const planned of plan.layers) {
    const { kind, layer } = planned;
    const width = WIDTHS[kind];
    columns.push({ key: `${ep}/${layer.layer_id}`, endpointId: ep, layerId: layer.layer_id, kind, name: layer.name ?? null,
      detail: layer.kind === "connector" ? layer.variant_label ?? layer.pinout_name ?? null : null, x, width });
    const mid = x + width / 2;
    if (kind === "connector") {
      connector = { layerId: layer.layer_id, cx: mid, bodyRevisionId: plan.stack?.body_revision_id ?? null, name: layer.name ?? null };
      const list = [...layer.terminals].sort(byLabel);
      rows(list.length, center).forEach((y, i) => terminal(planned, list[i]!, mid, y, 10, "middle"));
    } else if (kind === "board") {
      const sides = boardSides(layer, plan.stack);
      const connectorX = mid - stockward * (width / 2 - 20);
      const cableX = mid + stockward * (width / 2 - 20);
      if (sides.single) rows(sides.cable.length, center).forEach((y, i) => terminal(planned, sides.cable[i]!, cableX, y, 7, "cable"));
      else {
        // Order connector-side pads by the contact they land on, then cable-side pads by their path partner.
        const joinedTo = new Map<string, string>();
        for (const join of plan.stack?.joins ?? []) {
          if (join.a.layer_id === layer.layer_id) joinedTo.set(join.a.terminal_id, join.b.terminal_id);
          if (join.b.layer_id === layer.layer_id) joinedTo.set(join.b.terminal_id, join.a.terminal_id);
        }
        const connectorSide = [...sides.connector].sort((a, b) => (contactOrder.get(joinedTo.get(a.terminal_id) ?? "") ?? Infinity) - (contactOrder.get(joinedTo.get(b.terminal_id) ?? "") ?? Infinity) || byLabel(a, b));
        const ys = rows(connectorSide.length, center);
        const padY = new Map(connectorSide.map((t, i) => [t.terminal_id, ys[i]!]));
        connectorSide.forEach((t, i) => terminal(planned, t, connectorX, ys[i]!, 7, "connector"));
        const partner = new Map<string, string>();
        for (const path of layer.paths ?? []) { partner.set(path.from_terminal, path.to_terminal); partner.set(path.to_terminal, path.from_terminal); }
        const cableSide = [...sides.cable].sort((a, b) => (padY.get(partner.get(a.terminal_id) ?? "") ?? Infinity) - (padY.get(partner.get(b.terminal_id) ?? "") ?? Infinity) || byLabel(a, b));
        rows(cableSide.length, center).forEach((y, i) => terminal(planned, cableSide[i]!, cableX, y, 7, "cable"));
      }
    } else if (kind === "inline") {
      const list = layer.parts ?? [];
      rows(list.length, center).forEach((y, i) => {
        const part = list[i]!;
        const leads = layer.terminals.filter((t) => t.part === part.local_id || t.terminal_id.startsWith(`${part.local_id}.`));
        const keys: string[] = [];
        for (const lead of leads) {
          // Lead 1 is where a conductor lands (stock side); lead 2 joins the connector side.
          const stockSide = lead.terminal_id.endsWith(".1");
          keys.push(terminal(planned, lead, mid + stockward * (stockSide ? 1 : -1) * (width / 2 - 8), y, 5, stockSide ? "cable" : "connector").key);
        }
        const component = (part as { component?: { kind?: string } }).component?.kind ?? "unknown";
        parts.push({ key: partKey(ep, layer.layer_id, part.local_id), endpointId: ep, layerId: layer.layer_id, name: part.name, summary: part.summary, component, x: mid, y, leads: keys });
      });
    } else if (kind === "shell") {
      for (const t of layer.terminals) terminal(planned, t, mid, center, 6, "middle");
    } else {
      const list = [...layer.terminals].sort(byLabel);
      rows(list.length, center).forEach((y, i) => terminal(planned, list[i]!, mid + stockward * (width / 2 - 10), y, 6, "cable"));
    }
    x += width + GAP;
  }
  const at = new Map(terminals.map((t) => [t.key, t]));
  const link = (a: DrawnTerminal, b: DrawnTerminal) => {
    const from = anchor(a, b.x);
    const to = anchor(b, a.x);
    return from.x <= to.x ? curve(from, to) : curve(to, from);
  };
  const traces: DrawnTrace[] = [];
  const joins: DrawnJoin[] = [];
  for (const { layer } of plan.stack ? plan.layers : []) {
    for (const path of layer.paths ?? []) {
      const a = at.get(termKey(ep, layer.layer_id, path.from_terminal));
      const b = at.get(termKey(ep, layer.layer_id, path.to_terminal));
      if (!a || !b) continue;
      traces.push({ key: traceKey(ep, layer.layer_id, path.local_id), endpointId: ep, from: a.key, to: b.key, via: path.via, summary: path.summary,
        status: path.via === "copper" || path.via === "component" ? "declared" : "unknown", d: link(a, b), mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } });
    }
  }
  for (const join of plan.stack?.joins ?? []) {
    const a = at.get(termKey(ep, join.a.layer_id, join.a.terminal_id));
    const b = at.get(termKey(ep, join.b.layer_id, join.b.terminal_id));
    if (!a || !b) continue;
    joins.push({ key: `j:${ep}/${join.local_id}`, endpointId: ep, a: a.key, b: b.key, kind: join.kind, status: join.status, basis: join.basis, d: link(a, b) });
  }
  return { endpointId: ep, index: plan.index, label: plan.label, side, x0, x1: x0 + plan.width, resolved: !!plan.stack, columns, terminals, parts, traces, joins, connector };
}

/** The whole drawing: End A stack, the stock with every conductive element, End B stack. */
export function layoutDrawing(input: DrawingInput): Drawing {
  const { cable } = input;
  const index = indexCheck(input.check);
  const plans = cable.endpoints.slice(0, 2).map((_, i) => planEnd(cable, i, input.stacks[i]));
  const rowCount = Math.max(6, ...plans.map((p) => p.rows));
  const faceTop = TOP + 6;
  const bodyTop = faceTop + FACE + 34;
  const bodyHeight = (rowCount + 1) * PITCH;
  const center = bodyTop + bodyHeight / 2;
  const left = plans[0];
  const right = plans[1];
  const x0 = MARGIN + (left?.width ?? WIDTHS.unknown);
  const jacketX0 = x0 + FAN;
  const jacketX1 = jacketX0 + STOCK;
  const x1 = jacketX1 + FAN;
  const width = x1 + (right?.width ?? WIDTHS.unknown) + MARGIN;
  const ends: DrawnEnd[] = [];
  if (left) ends.push(layoutEnd(left, MARGIN, center, index));
  if (right) ends.push(layoutEnd(right, x1, center, index));
  const terminals = new Map(ends.flatMap((e) => e.terminals.map((t) => [t.key, t] as const)));

  // Stock elements: from the stock when readable, else the cable's own rows; landings outside the stock stay listed.
  const fromStock = input.stock ? conductiveElements(input.stock.structure) : (input.conductors ?? []).map((c) => ({
    path: c.element_path, kind: (c.kind as ConductiveKind), label: c.label, display: c.label || c.element_path,
    look: null as Appearance | null, inStock: true,
  }));
  const known = new Set(fromStock.map((e) => e.path));
  const stray = [...new Set(cable.assignments.map((a) => a.element_path).filter((p) => !known.has(p)))]
    .map((path) => ({ path, kind: "conductor" as ConductiveKind, label: path, display: `${path} (not in this stock)`, look: null as Appearance | null, inStock: false }));
  const elements = [...fromStock, ...stray];

  const landing = (endpointIndex: number, path: string): DrawnTerminal | null => {
    const endpoint = cable.endpoints[endpointIndex];
    const a = endpoint && cable.assignments.find((x) => x.endpoint_id === endpoint.local_id && x.element_path === path);
    return a ? terminals.get(termKey(a.endpoint_id, a.layer_id, a.terminal_id)) ?? null : null;
  };
  const order = elements.map((element, i) => ({ element, i, a: landing(0, element.path) }))
    .sort((p, q) => (p.a?.y ?? Infinity) - (q.a?.y ?? Infinity) || p.i - q.i);
  const n = order.length;
  const jacketHeight = Math.min(Math.max(n * 7 + 16, 34), bodyHeight * 0.72);
  const gap = n > 1 ? Math.min(7, Math.max(2.5, (jacketHeight - 12) / (n - 1))) : 0;
  const lanes = Array.from({ length: n }, (_, i) => center + (i - (n - 1) / 2) * gap);

  const wires: DrawnWire[] = order.map(({ element }, i) => {
    const lane = lanes[i]!;
    const a = landing(0, element.path);
    const b = landing(1, element.path);
    const open: Point[] = [];
    const startA = a ? anchor(a, jacketX0) : { x: jacketX0 - 26, y: lane };
    if (!a) open.push(startA);
    const endB = b ? anchor(b, jacketX1) : { x: jacketX1 + 26, y: lane };
    if (!b) open.push(endB);
    const d = `${curve(startA, { x: jacketX0, y: lane })}L${r(jacketX1)} ${r(lane)}${curve({ x: jacketX1, y: lane }, endB).replace(/^M[^C]*/, "")}`;
    const key = wireKey(element.path);
    const rowIds = index.rowsOf.get(key) ?? [];
    const rowSignal = rowIds.map((id) => index.rows.get(id)?.signal).find(Boolean) ?? null;
    return {
      key, path: element.path, kind: element.kind, label: element.label, display: element.display, look: element.look, inStock: element.inStock,
      lane, d, a: a ? startA : null, b: b ? endB : null, aTerminal: a?.key ?? null, bTerminal: b?.key ?? null, open,
      status: index.statusOf.get(key) ?? null, rows: rowIds,
      signal: (rowSignal as SignalRef | null) ?? a?.signal ?? b?.signal ?? null,
    };
  });
  const laneOf = new Map(wires.map((w) => [w.path, w.lane]));

  // Proposed landings that differ from the current declaration, dashed from the stock end to the proposed terminal.
  const changes = new Map((input.proposal?.diff ?? []).map((d) => [`${d.endpoint_id}\u0000${d.element_path}`, d.change]));
  const proposals: DrawnProposal[] = [];
  for (const row of input.proposal?.rows ?? []) {
    if (row.status !== "proposed") continue;
    for (const a of row.assignments) {
      const change = changes.get(`${a.endpoint_id}\u0000${a.element_path}`) ?? "added";
      if (change === "same") continue;
      const t = terminals.get(termKey(a.endpoint_id, a.layer_id, a.terminal_id));
      const lane = laneOf.get(a.element_path);
      if (!t || lane === undefined) continue;
      const left = cable.endpoints[0]?.local_id === a.endpoint_id;
      const from = { x: left ? jacketX0 : jacketX1, y: lane };
      const to = anchor(t, from.x);
      proposals.push({ key: proposedKey(row.row_id), rowId: row.row_id, path: a.element_path, endpointId: a.endpoint_id, terminal: t.key, terminalLabel: a.terminal_label, change, d: left ? curve(to, from) : curve(from, to) });
    }
  }
  const height = bodyTop + bodyHeight + 46;
  return {
    width, height, bodyTop, bodyHeight, faceTop, ends, extraEnds: Math.max(0, cable.endpoints.length - 2), wires, proposals, terminals,
    stock: {
      x0, x1, jacketX0, jacketX1, cy: center, height: jacketHeight, breakX: (jacketX0 + jacketX1) / 2, dimY: bodyTop + bodyHeight + 24,
      callout: { x: jacketX0 + STOCK * 0.28, y: faceTop + FACE / 2, r: FACE / 2 - 2 }, jacket: jacketLook(input.stock),
    },
  };
}

/** "Board · Demo board r1" header text for a drawn column. */
export function columnTitle(column: DrawnColumn): string {
  if (column.kind === "unknown") return "End stack not resolved";
  return LAYER_LABELS[column.kind];
}

/** Every landing of one element at one end, from the declaration. */
export function landingOf(cable: Cable, endpointId: string, path: string): Assignment | undefined {
  return cable.assignments.find((a) => a.endpoint_id === endpointId && a.element_path === path);
}

/**
 * The cable with one element's landing at one end replaced (or removed with `target` null).
 * The note is kept from the previous landing, else the given note, else the default.
 */
export function assignLanding(cable: Cable, endpointId: string, path: string, target: { layer_id: string; terminal_id: string } | null, note?: string): Cable {
  const others = cable.assignments.filter((a) => !(a.endpoint_id === endpointId && a.element_path === path));
  if (!target) return { ...cable, assignments: others };
  const previous = landingOf(cable, endpointId, path);
  return { ...cable, assignments: [...others, { endpoint_id: endpointId, element_path: path, ...target, basis: previous?.basis ?? (note?.trim() || DEFAULT_NOTE) }] };
}
export const DEFAULT_NOTE = "Declared in the cable editor";
