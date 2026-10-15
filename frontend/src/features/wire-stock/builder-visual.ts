/**
 * Pure helpers for the visual stock builder: computed meters, deterministic fit fixes,
 * the jacket-edge handle math and the shapes drawn over the section for fit findings.
 * Placement and fit stay in packages/section-layout; nothing here re-derives them.
 * A value that depends on an unknown input is null, never zero.
 */
import { fitMm } from '../../../../packages/section-layout/src';
import type { FitFinding, FitReport, Section, SectionFeature, StockSpecification } from '../../../../packages/section-layout/src';
import { drainPlacement, hasJacket, hasWeb, layup, multiUnit } from './builder';
import type { BuilderSpec, Known, Layup } from './builder';

const r4 = (v: number): number => Number(v.toFixed(4));
const radiusOf = (f: SectionFeature): number => f.shape.type === 'ring' ? f.shape.rOuter : Math.hypot(f.shape.width, f.shape.height) / 2;

export interface Derived { lay: Layup | null; drain: ReturnType<typeof drainPlacement> | null; bore: Known; pitch: Known }
/** Lay-up, drain and screen/content bore for a spec, from the same builder rules that generate the tree. */
export function derivedLayup(spec: BuilderSpec): Derived {
  const t = spec.template, ins = spec.insulation.od_mm;
  const pairs = t === 'pairs', mc = t === 'multicoax';
  const count = pairs ? spec.cores.length / 2 : spec.cores.length;
  const unit = mc ? multiUnit(spec) : pairs && count > 1 ? (ins === null ? null : 2 * ins) : ins;
  const lay = mc ? layup(unit, spec.multi.looks.length + spec.cores.length) : t === 'round' || pairs ? (pairs && count === 1 ? layup(ins, 2) : layup(unit, count)) : null;
  const drain = lay && spec.drain ? drainPlacement(lay, spec.drain_diameter_mm) : null;
  const bore = lay ? (drain ? (drain.boreRadius === null ? null : 2 * drain.boreRadius) : (lay.outerRadius === null ? null : 2 * lay.outerRadius)) : (t === 'coax' ? ins : null);
  return { lay, drain, bore, pitch: hasWeb(t) ? spec.spacing_mm ?? ins : null };
}

export const jacketPath = (stock: StockSpecification): string => `${stock.structure.id}.jacket`;

/** Diameter of the circle (about the axis) enclosing everything inside the jacket; null when any layer is unknown. */
export function contentDiameter(stock: StockSpecification, section: Section): Known {
  if (section.unknown.length > 0) return null;
  const inner = section.features.filter(f => f.path !== jacketPath(stock));
  if (inner.length === 0) return null;
  return r4(2 * Math.max(...inner.map(f => Math.hypot(f.x, f.y) + radiusOf(f))));
}

export interface StockMeters {
  ringDiameter: Known; layupDiameter: Known; contentDiameter: Known;
  jacketBore: Known; jacketOd: Known; wall: Known;
  /** Smallest jacket OD that clears the content at the entered wall; with an unknown wall, the content itself. */
  minJacketOd: Known; wallKnown: boolean; fillPercent: Known;
}
export function stockMeters(spec: BuilderSpec, stock: StockSpecification, section: Section): StockMeters {
  const { lay } = derivedLayup(spec);
  const content = hasJacket(spec.template) ? contentDiameter(stock, section) : null;
  const jacket = stock.structure.children.find(c => c.id === 'jacket');
  const round = jacket && jacket.kind !== 'group' && jacket.kind !== 'web' ? jacket : null;
  const bore = round?.inner_diameter_mm ?? null;
  const wall = spec.jacket.wall_mm;
  return {
    ringDiameter: lay && lay.arrangement === 'ring' ? lay.pitch : null,
    layupDiameter: lay && lay.outerRadius !== null ? r4(2 * lay.outerRadius) : null,
    contentDiameter: content, jacketBore: bore, jacketOd: round?.outer_diameter_mm ?? null, wall,
    minJacketOd: content === null ? null : r4(content + 2 * (wall ?? 0)), wallKnown: wall !== null,
    fillPercent: content === null || bore === null || bore <= 0 ? null : Math.round(content / bore * 1000) / 10,
  };
}

// --- deterministic fixes ------------------------------------------------------------

export interface FitFix { id: 'jacket-od' | 'jacket-wall'; label: string; detail: string; apply: (spec: BuilderSpec) => BuilderSpec }
const up = (v: number): number => Math.ceil(v * 100 - 1e-9) / 100;
const down = (v: number): number => Math.floor(v * 100 + 1e-9) / 100;

/** Fixes that follow from the numbers alone. Nothing is offered when an input is unknown. */
export function fitFixes(spec: BuilderSpec, stock: StockSpecification, section: Section, report: FitReport): FitFix[] {
  if (!hasJacket(spec.template)) return [];
  const jacket = jacketPath(stock);
  const failing = report.findings.some(f => f.status === 'fail' && f.paths[1] === jacket);
  if (!failing) return [];
  const content = contentDiameter(stock, section), { od_mm: od, wall_mm: wall } = spec.jacket;
  const fixes: FitFix[] = [];
  if (content !== null && wall !== null) {
    const next = up(content + 2 * wall);
    fixes.push({ id: 'jacket-od', label: 'Set jacket OD to fit', detail: `${next} mm = content ${r4(content)} mm + 2 × wall ${wall} mm`,
      apply: s => ({ ...s, jacket: { ...s.jacket, od_mm: next } }) });
  }
  if (content !== null && od !== null && od > content) {
    const next = down((od - content) / 2);
    if (next > 0) fixes.push({ id: 'jacket-wall', label: 'Thin jacket wall to fit', detail: `${next} mm = (OD ${od} mm − content ${r4(content)} mm) / 2`,
      apply: s => ({ ...s, jacket: { ...s.jacket, wall_mm: next } }) });
  }
  return fixes;
}

// --- jacket-edge handle -------------------------------------------------------------

export const OD_STEP_MM = 0.05;
/** Jacket OD from a pointer position in section millimeters (origin at the cable axis), snapped to the step. */
export function odFromPoint(x: number, y: number, minMm: number, step = OD_STEP_MM): number {
  const snapped = Math.round(2 * Math.hypot(x, y) / step) * step;
  return r4(Math.max(minMm, snapped));
}
export const nudgeOd = (od: number, direction: 1 | -1, minMm: number, step = OD_STEP_MM): number => r4(Math.max(minMm, od + direction * step));

export interface ViewBox { x: number; y: number; w: number; h: number }
export function parseViewBox(svg: string): ViewBox | null {
  const m = /viewBox="([-\d.eE+]+) ([-\d.eE+]+) ([-\d.eE+]+) ([-\d.eE+]+)"/.exec(svg);
  return m ? { x: Number(m[1]), y: Number(m[2]), w: Number(m[3]), h: Number(m[4]) } : null;
}
/** Client pixels to section millimeters for an SVG scaled with "meet" and centered in its box. */
export function clientToMm(box: { left: number; top: number; width: number; height: number }, vb: ViewBox, clientX: number, clientY: number): { x: number; y: number } {
  const scale = Math.min(box.width / vb.w, box.height / vb.h);
  const offX = (box.width - vb.w * scale) / 2, offY = (box.height - vb.h * scale) / 2;
  return { x: vb.x + (clientX - box.left - offX) / scale, y: vb.y + (clientY - box.top - offY) / scale };
}

// --- fit findings drawn on the section ----------------------------------------------

export interface Circle { cx: number; cy: number; r: number }
export interface OverlayShapes {
  /** Dashed red bore of an enclosing layer that something does not fit in. */
  bores: (Circle & { path: string })[];
  /** Offending element or unit, ringed. */
  rings: (Circle & { path: string })[];
  /** Offender area outside the bore (or the overlap lens), to be hatched. */
  bands: { offender: Circle; bore: Circle | null; path: string }[];
  notes: { x: number; y: number; text: string; path: string }[];
}
function extentOf(section: Section, path: string): Circle | null {
  const inside = section.features.filter(f => f.path === path || f.path.startsWith(`${path}.`));
  if (inside.length === 0) return null;
  if (inside.length === 1) { const f = inside[0]!; return { cx: f.x, cy: f.y, r: radiusOf(f) }; }
  const minX = Math.min(...inside.map(f => f.x - radiusOf(f))), maxX = Math.max(...inside.map(f => f.x + radiusOf(f)));
  const minY = Math.min(...inside.map(f => f.y - radiusOf(f))), maxY = Math.max(...inside.map(f => f.y + radiusOf(f)));
  const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
  return { cx, cy, r: Math.max(...inside.map(f => Math.hypot(f.x - cx, f.y - cy) + radiusOf(f))) };
}
const boreOf = (section: Section, path: string): Circle | null => {
  const f = section.features.find(item => item.path === path);
  return f && f.shape.type === 'ring' ? { cx: f.x, cy: f.y, r: f.shape.rInner } : null;
};

/** Geometry for failing findings only. Unknown (not evaluated) checks are never drawn as failures. */
export function fitOverlay(section: Section, report: FitReport): OverlayShapes {
  const out: OverlayShapes = { bores: [], rings: [], bands: [], notes: [] };
  const seen = new Set<string>();
  const once = (kind: string, path: string) => { const key = `${kind}|${path}`; if (seen.has(key)) return false; seen.add(key); return true; };
  // One hatched band and one callout per enclosing layer (its worst offender), so a single mistake reads as one mark.
  const worst = new Map<string, FitFinding>();
  for (const f of report.findings as FitFinding[]) {
    if (f.status !== 'fail') continue;
    const key = f.code === 'overlap' ? f.paths.join('|') : f.paths[1];
    const held = worst.get(key);
    if (!held || (f.excess_mm ?? 0) > (held.excess_mm ?? 0)) worst.set(key, f);
  }
  for (const f of report.findings as FitFinding[]) {
    if (f.status !== 'fail') continue;
    const [first, second] = f.paths;
    const offender = extentOf(section, first);
    if (!offender) continue;
    const enclosing = f.code === 'overlap' ? null : boreOf(section, second);
    if (enclosing && once('bore', second)) out.bores.push({ ...enclosing, path: second });
    if (once('ring', first)) out.rings.push({ ...offender, path: first });
    if (f.code === 'overlap') {
      const other = extentOf(section, second);
      if (other && once('ring', second)) out.rings.push({ ...other, path: second });
    }
    if (worst.get(f.code === 'overlap' ? f.paths.join('|') : second) !== f) continue;
    out.bands.push({ offender, bore: enclosing, path: first });
    const text = f.excess_mm === null ? '' : `+${fitMm(f.excess_mm)} mm`;
    if (text) out.notes.push({ x: offender.cx + offender.r * 0.72, y: offender.cy - offender.r * 0.72, text, path: first });
  }
  return out;
}

/** Tight view box around the section, with room on the right for the jacket handle label. */
export function frameSection(section: Section, extraRadius = 0): ViewBox {
  const b = section.bounds;
  const r = Math.max(extraRadius, b ? Math.max(Math.abs(b.minX), Math.abs(b.maxX), Math.abs(b.minY), Math.abs(b.maxY)) : 2);
  const minX = b ? Math.min(b.minX, -r) : -r, maxX = b ? Math.max(b.maxX, r) : r, minY = b ? Math.min(b.minY, -r) : -r, maxY = b ? Math.max(b.maxY, r) : r;
  const span = Math.max(maxX - minX, maxY - minY, 1), pad = span * 0.4;
  return { x: minX - pad, y: minY - pad, w: maxX - minX + 2 * pad + span * 0.45, h: maxY - minY + 2 * pad };
}
export const withViewBox = (svg: string, vb: ViewBox): string => svg.replace(/viewBox="[^"]*"/, `viewBox="${vb.x} ${vb.y} ${vb.w} ${vb.h}"`);
