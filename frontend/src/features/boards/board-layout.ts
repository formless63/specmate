import type { Board, BoardPath, BoardTerminal } from "./api";

/** Vertical distance between pads in one group column. */
export const PITCH = 30;
export const PAD_W = 26;
export const PAD_H = 14;
const LABEL_ROOM = 92;
const TOP = 72;
const LANE_GAP = 9;
const GLYPH_ROOM = 96;
const CHAMFER = 6;

export type Point = [number, number];
export type DrawnPad = BoardTerminal & { x: number; y: number; column: number; anchor: "start" | "end" | "middle"; landed: string | null };
export type DrawnPath = BoardPath & { d: string; points: Point[]; glyph: { x: number; y: number; vertical: boolean } | null; fromPad: DrawnPad; toPad: DrawnPad };
export type DrawnColumn = { name: string; x: number };
export type DrawnConnector = { name: string; side: "left" | "right"; x: number; y: number; w: number; h: number; leads: { padId: string; contact: string; y: number; padX: number }[] };
export type BoardLayout = { width: number; height: number; outline: { x: number; y: number; w: number; h: number }; columns: DrawnColumn[]; pads: DrawnPad[]; paths: DrawnPath[]; connector: DrawnConnector | null };

const UNGROUPED = "Ungrouped";

function polyline(points: Point[]): string {
  return points.map(([x, y], i) => `${i ? "L" : "M"}${Math.round(x * 10) / 10} ${Math.round(y * 10) / 10}`).join(" ");
}

/** A horizontal run, a 45-degree chamfered jog on the lane, then a horizontal run: copper as drawn on a board. */
function jog(x1: number, y1: number, lane: number, x2: number, y2: number): Point[] {
  if (Math.abs(y2 - y1) < 0.5) return [[x1, y1], [x2, y2]];
  const s = Math.sign(y2 - y1);
  const c = Math.min(CHAMFER, Math.abs(y2 - y1) / 2);
  const dir = Math.sign(x2 - x1) || 1;
  return [[x1, y1], [lane - dir * c, y1], [lane, y1 + s * c], [lane, y2 - s * c], [lane + dir * c, y2], [x2, y2]];
}

/**
 * Lays a board out as a drawing: one pad column per group (in order of first use), declared
 * paths as straight copper with chamfered jogs on their own lanes, a part glyph on the run into
 * the destination pad, and the carried connector beside the column holding most of its landings.
 * The outline is a placeholder box sized to the pads: the board's real shape is not declared here.
 */
export function layoutBoard(board: Board, connectorName?: string): BoardLayout {
  const groups: string[] = [];
  for (const t of board.terminals) { const g = t.group ?? UNGROUPED; if (!groups.includes(g)) groups.push(g); }
  const byId = new Map(board.terminals.map((t) => [t.terminal_id, t]));
  const colOf = (t: BoardTerminal) => groups.indexOf(t.group ?? UNGROUPED);
  const valid = board.paths.filter((p) => byId.has(p.from_terminal) && byId.has(p.to_terminal) && p.from_terminal !== p.to_terminal);
  // Lanes in the gutter right of each column: paths that leave the column rightward (or stay in it).
  const lanes = groups.map(() => 0);
  const laneOf = new Map<string, { gutter: number; index: number }>();
  const ordered = [...valid].sort((a, b) => board.terminals.indexOf(byId.get(a.from_terminal)!) - board.terminals.indexOf(byId.get(b.from_terminal)!));
  for (const p of ordered) {
    const ca = colOf(byId.get(p.from_terminal)!), cb = colOf(byId.get(p.to_terminal)!);
    const gutter = ca === cb ? (ca === groups.length - 1 && ca > 0 ? ca - 1 : ca) : Math.min(ca, cb);
    laneOf.set(p.local_id, { gutter, index: lanes[gutter]! });
    lanes[gutter]! += 1;
  }
  const gutterWidth = lanes.map((n) => Math.max(210, 20 + n * LANE_GAP + GLYPH_ROOM));
  const columns: DrawnColumn[] = [];
  let x = LABEL_ROOM + PAD_W;
  groups.forEach((name, i) => { columns.push({ name, x }); x += gutterWidth[i]!; });
  const rows = groups.map(() => 0);
  const landing = new Map<string, string>();
  const connector = board.carried_connectors[0];
  for (const c of connector?.correspondence ?? []) landing.set(c.terminal_id, c.contact_id);
  const pads: DrawnPad[] = board.terminals.map((t) => {
    const column = colOf(t);
    const row = rows[column]!++;
    const anchor = groups.length === 1 || column === 0 ? "start" : column === groups.length - 1 ? "end" : "middle";
    return { ...t, x: columns[column]!.x, y: TOP + row * PITCH, column, anchor, landed: landing.get(t.terminal_id) ?? null };
  });
  const padById = new Map(pads.map((p) => [p.terminal_id, p]));
  const paths: DrawnPath[] = valid.map((p) => {
    let a = padById.get(p.from_terminal)!, b = padById.get(p.to_terminal)!;
    const lane = laneOf.get(p.local_id)!;
    const gx = columns[lane.gutter]!.x + PAD_W / 2 + 18 + lane.index * LANE_GAP;
    let points: Point[];
    let glyph: DrawnPath["glyph"] = null;
    if (a.column === b.column) {
      const side = a.column === lane.gutter ? 1 : -1;
      const lx = side > 0 ? gx : columns[a.column]!.x - PAD_W / 2 - 18 - lane.index * LANE_GAP;
      const ex = a.x + side * PAD_W / 2;
      points = [[ex, a.y], [lx, a.y], [lx, b.y], [ex, b.y]];
      glyph = { x: lx, y: (a.y + b.y) / 2, vertical: true };
    } else {
      if (a.column > b.column) [a, b] = [b, a];
      const x1 = a.x + PAD_W / 2, x2 = b.x - PAD_W / 2;
      points = jog(x1, a.y, gx, x2, b.y);
      glyph = { x: x2 - GLYPH_ROOM / 2 + 4, y: b.y, vertical: false };
    }
    return { ...p, d: polyline(points), points, glyph: p.via === "component" || p.via === "switch" || p.via === "unknown" ? glyph : null, fromPad: padById.get(p.from_terminal)!, toPad: padById.get(p.to_terminal)! };
  });
  const maxRows = Math.max(1, ...rows);
  const left = LABEL_ROOM - 12;
  const right = columns.length ? columns[columns.length - 1]!.x + PAD_W / 2 + (groups.length > 1 ? LABEL_ROOM : 24) : left + 200;
  const outline = { x: left - 8, y: 14, w: Math.max(right - left + 16, 300), h: TOP + maxRows * PITCH + 8 };
  let drawnConnector: DrawnConnector | null = null;
  if (connector && connector.correspondence.length) {
    const counts = groups.map((_, i) => connector.correspondence.filter((c) => padById.get(c.terminal_id)?.column === i).length);
    const column = counts.indexOf(Math.max(...counts));
    const landed = pads.filter((p) => p.column === column && p.landed !== null);
    const side: "left" | "right" = column === groups.length - 1 && groups.length > 1 ? "right" : "left";
    const y0 = Math.min(...landed.map((p) => p.y)) - PITCH / 2, y1 = Math.max(...landed.map((p) => p.y)) + PITCH / 2;
    const w = 34;
    drawnConnector = { name: connectorName ?? "Carried connector", side, w, h: y1 - y0, y: y0, x: side === "left" ? outline.x - w - 26 : outline.x + outline.w + 26,
      leads: landed.map((p) => ({ padId: p.terminal_id, contact: p.landed!, y: p.y, padX: p.x + (side === "left" ? -PAD_W / 2 : PAD_W / 2) })) };
  }
  const shift = drawnConnector?.side === "left" ? drawnConnector.w + 34 : 0;
  const width = outline.x + outline.w + (drawnConnector?.side === "right" ? drawnConnector.w + 40 : 12) + shift;
  const height = Math.max(outline.y + outline.h + 20, (drawnConnector ? drawnConnector.y + drawnConnector.h + 8 : 0));
  if (shift) {
    const move = (pt: Point): Point => [pt[0] + shift, pt[1]];
    outline.x += shift;
    columns.forEach((c) => { c.x += shift; });
    pads.forEach((p) => { p.x += shift; });
    paths.forEach((p) => { p.points = p.points.map(move); p.d = polyline(p.points); if (p.glyph) p.glyph.x += shift; });
    drawnConnector!.x += shift;
    drawnConnector!.leads.forEach((l) => { l.padX += shift; });
  }
  return { width, height, outline, columns, pads, paths, connector: drawnConnector };
}

/** Pairs of terminals a trace result walked, for highlighting its paths. */
export function tracedPathIds(paths: BoardPath[], traced: string[][]): Set<string> {
  const hops = new Set<string>();
  for (const chain of traced) for (let i = 1; i < chain.length; i++) { hops.add(`${chain[i - 1]}>${chain[i]}`); hops.add(`${chain[i]}>${chain[i - 1]}`); }
  return new Set(paths.filter((p) => hops.has(`${p.from_terminal}>${p.to_terminal}`)).map((p) => p.local_id));
}
