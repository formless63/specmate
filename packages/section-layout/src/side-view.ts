// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Side (elevation) view of a stock: the cable lies along the drawing's x axis and every
 * element is a band of its real outer diameter at its real section height.
 *
 * - `cutaway`: each enclosed element is stepped out of the one around it so every layer can
 *   be seen and named. The axial steps are a display arrangement, carry no dimension and are
 *   labeled illustrative.
 * - `prepared`: each end is drawn from end preparation instructions. A strip-back, removal or
 *   trim whose length is measured from the stock cut end sets where the element stops;
 *   retaining keeps it to the cut end. Anything else is unknown and drawn hatched across the
 *   whole end window, never as a guessed length.
 *
 * Re-implemented from the behavior of cab-stu `packages/docs/src/drawing/cutaway.ts` and
 * `packages/docs/src/bench/figures.ts` (strip figure), commit
 * 6bbf79655deb572df9f11490ca38e4f739ce71fb (MIT, formless63); no code, art, font, marking or
 * color table is copied. See NOTICE. Display only: no fit, bond or qualification is implied.
 */
import { appearanceOf, edgeColor, mixHex } from './appearance';
import type { Appearance } from './appearance';
import { segmentsIntersect } from './callouts';
import type { Section, SectionFeature } from './model';

export type SideMode = 'cutaway' | 'prepared';
export type SideEnd = 'a' | 'b';

/** Structural subset of an end preparation profile; amounts may be decimal strings. */
export interface PrepDimension {
  nominal_mm: string | number | null;
  minus_mm?: string | number | null;
  plus_mm?: string | number | null;
  datum: string;
}
export interface PrepInstruction { kind: string; element_path: string; treatment: string; length?: PrepDimension | null }
export interface PrepEnd { instructions: readonly PrepInstruction[] }
export interface PrepProfile { a: PrepEnd; b: PrepEnd }

export type Extent =
  | { status: 'known'; cutbackMm: number; minusMm: number | null; plusMm: number | null; basis: string; illustrative: boolean }
  | { status: 'unknown'; reason: string };

export interface SideBand {
  path: string;
  kind: SectionFeature['kind'];
  tag: string;
  label: string;
  look: Appearance;
  /** Section height of the element's center and its half height, mm. */
  y: number;
  half: number;
  /** Inner half height (bore) for rings; 0 for solids and webs. */
  innerHalf: number;
  /** Painter key: nearer and enclosing elements are drawn later. */
  depth: number;
  a: Extent;
  b: Extent;
  notes: string[];
}

export interface SideView {
  mode: SideMode;
  bands: SideBand[];
  /** Rows with no drawable section geometry (unknown diameter, position or web size). */
  notDrawn: { path: string; tag: string; reason: string }[];
  /** Axial window drawn at each end, mm; the length between them is omitted (break). */
  windows: Record<SideEnd, number>;
  gapMm: number;
  minY: number;
  maxY: number;
  /** Outer size used to scale annotation; null when nothing could be drawn. */
  sizeMm: number | null;
}

const REMOVAL = new Set(['strip_back', 'remove', 'trim']);
const RETAIN = new Set(['retain', 'retain_shield']);
const AXIAL = new Set(['layer_strip', 'drain_treatment', 'shield_lead']);
const words = (text: string): string => text.replace(/_/g, ' ');

function amount(value: string | number | null | undefined): number | null | 'invalid' {
  if (value === null || value === undefined || value === '') return null;
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 'invalid';
}

/** Where one instruction leaves its element at the end it belongs to. */
export function instructionExtent(instruction: PrepInstruction): Extent {
  const treatment = instruction.treatment;
  if (RETAIN.has(treatment)) return { status: 'known', cutbackMm: 0, minusMm: null, plusMm: null, basis: 'retained to the stock cut end', illustrative: false };
  if (treatment === 'unknown') return { status: 'unknown', reason: 'treatment unknown' };
  if (!REMOVAL.has(treatment)) return { status: 'unknown', reason: `${words(treatment)} does not fix where the element ends` };
  const length = instruction.length ?? null;
  const nominal = amount(length?.nominal_mm);
  if (nominal === null) return { status: 'unknown', reason: `${words(treatment)} length unknown` };
  if (nominal === 'invalid') return { status: 'unknown', reason: `${words(treatment)} length is not a valid dimension` };
  if (length!.datum !== 'from_stock_cut_end') {
    return { status: 'unknown', reason: `${words(treatment)} ${nominal} mm is measured ${length!.datum === 'along_finished_lead' ? 'along the finished lead' : 'from an unknown datum'}, which does not place it on the cable axis` };
  }
  const minus = amount(length!.minus_mm), plus = amount(length!.plus_mm);
  return { status: 'known', cutbackMm: nominal, minusMm: typeof minus === 'number' ? minus : null, plusMm: typeof plus === 'number' ? plus : null,
    basis: `${words(treatment)} ${nominal} mm from the stock cut end`, illustrative: false };
}

/** The extent of one element at one end: its most specific axial instructions, layer strip first. */
export function elementExtent(end: PrepEnd, path: string): { extent: Extent; notes: string[] } {
  const applies = end.instructions.filter(i => AXIAL.has(i.kind) && (i.element_path === path || path.startsWith(`${i.element_path}.`)));
  if (applies.length === 0) return { extent: { status: 'unknown', reason: 'no preparation instruction' }, notes: [] };
  const specific = Math.max(...applies.map(i => i.element_path.length));
  const chosen = applies.filter(i => i.element_path.length === specific);
  const strip = chosen.find(i => i.kind === 'layer_strip');
  const notes = chosen.filter(i => i !== strip && !RETAIN.has(i.treatment) && i.treatment !== 'unknown')
    .map(i => `${words(i.kind)}: ${words(i.treatment)} (not drawn beyond the element)`);
  if (strip) {
    const extent = instructionExtent(strip);
    if (extent.status === 'known' || chosen.length === 1) return { extent, notes };
  }
  const extents = chosen.map(instructionExtent);
  const known = extents.filter((e): e is Extract<Extent, { status: 'known' }> => e.status === 'known');
  if (known.length === 0) return { extent: extents[0]!, notes };
  if (new Set(known.map(e => e.cutbackMm)).size > 1) return { extent: { status: 'unknown', reason: 'instructions disagree on where the element ends' }, notes };
  return { extent: known[0]!, notes };
}

const ringOf = (f: SectionFeature) => f.shape.type === 'ring' ? f.shape : null;

/** Number of known rings that wholly enclose a feature (the same test the 3D occlusion uses). */
function enclosures(feature: SectionFeature, all: readonly SectionFeature[]): number {
  const half = feature.shape.type === 'ring' ? feature.shape.rOuter : Math.hypot(feature.shape.width, feature.shape.height) / 2;
  return all.filter(cover => {
    const ring = ringOf(cover);
    if (cover === feature || !ring || ring.rOuter <= half) return false;
    return ring.rInner + 1e-9 >= Math.hypot(cover.x - feature.x, cover.y - feature.y) + half;
  }).length;
}

export type SideViewOptions = { mode: 'cutaway' } | { mode: 'prepared'; preparation: PrepProfile };

export function sideViewLayout(section: Section, options: SideViewOptions): SideView {
  const features = section.features;
  const size = section.bounds ? Math.max(section.bounds.maxY - section.bounds.minY, section.bounds.maxX - section.bounds.minX) : null;
  const unit = Math.max(size ?? 1, 0.5);
  const run = Math.max(unit * 1.6, 3);
  const depths = new Map(features.map(f => [f.path, enclosures(f, features)]));
  const deepest = Math.max(0, ...depths.values());
  const step = Math.max(unit * 0.7, 1);
  const bands: SideBand[] = features.map(f => {
    const row = section.rows.find(r => r.path === f.path);
    const half = f.shape.type === 'ring' ? f.shape.rOuter : f.shape.height / 2;
    let a: Extent, b: Extent; const notes: string[] = [];
    if (options.mode === 'cutaway') {
      const cut = (deepest - depths.get(f.path)!) * step;
      a = b = { status: 'known', cutbackMm: cut, minusMm: null, plusMm: null, basis: 'illustrative cutaway step', illustrative: true };
    } else {
      const atA = elementExtent(options.preparation.a, f.path), atB = elementExtent(options.preparation.b, f.path);
      a = atA.extent; b = atB.extent;
      notes.push(...atA.notes.map(t => `End A ${t}`), ...atB.notes.map(t => `End B ${t}`));
    }
    return { path: f.path, kind: f.kind, tag: row?.tag ?? '', label: row?.label ?? f.path, look: appearanceOf(f), y: f.y, half,
      innerHalf: f.shape.type === 'ring' ? f.shape.rInner : 0,
      depth: f.x + (f.shape.type === 'ring' ? f.shape.rOuter : f.shape.width / 2), a, b, notes };
  }).sort((p, q) => p.depth - q.depth || p.half - q.half);
  const drawn = new Set(features.map(f => f.path));
  const notDrawn = section.rows.filter(r => !drawn.has(r.path)).map(r => ({ path: r.path, tag: r.tag,
    reason: section.unknown.find(u => u.startsWith(`${r.path}:`))?.slice(r.path.length + 2) ?? 'section geometry unknown' }));
  const window = (end: SideEnd): number => Math.max(0, ...bands.map(band => {
    const e = band[end];
    return e.status === 'known' ? e.cutbackMm + (e.plusMm ?? 0) : 0;
  })) + run;
  const minY = bands.length ? Math.min(...bands.map(b => b.y - b.half)) : -1;
  const maxY = bands.length ? Math.max(...bands.map(b => b.y + b.half)) : 1;
  return { mode: options.mode, bands, notDrawn, windows: { a: window('a'), b: window('b') }, gapMm: Math.max(unit * 1.4, 2), minY, maxY, sizeMm: size };
}

/* ---- Callouts ---- */

/** Tag callout size relative to the drawing's annotation unit. */
export const CALLOUT_SCALE = 1;
export interface SideCallout {
  path: string;
  tag: string;
  /** Leader start on the element, drawing coordinates. */
  anchor: { x: number; y: number };
  /** Leader end under the label: label center x on the row above end A, and the leader's top. */
  label: { x: number; y: number };
  /** True when the element is wholly covered by a nearer one in this view: the leader points at where it lies. */
  occluded: boolean;
}

/** Baseline of the tag label row above the cable. */
export const sideLabelBaseline = (view: SideView, fs: number): number => view.minY - fs * 1.4;

/** Spread sorted preferred positions so neighbors are at least `gap` apart, starting no lower than `lo`. */
function spread(pref: number[], gap: number, lo: number, hi: number): number[] {
  const out = pref.map(v => Math.max(v, lo));
  for (let i = 1; i < out.length; i += 1) out[i] = Math.max(out[i]!, out[i - 1]! + gap);
  // Pull back from the right edge as far as the left edge allows; any remainder overflows right.
  const over = out.length ? out[out.length - 1]! - hi : 0;
  if (over > 0) {
    for (let i = out.length - 1; i >= 0; i -= 1) out[i] = Math.min(out[i]!, i === out.length - 1 ? hi : out[i + 1]! - gap);
    const under = lo - out[0]!;
    if (under > 0) for (let i = 0; i < out.length; i += 1) out[i] = out[i]! + under;
  }
  return out;
}

/**
 * End A tag callouts: labels in one row above the cable, ordered along the cable by where each
 * element can be seen (ties in tag order) and at least a label width apart; each leader starts on
 * the element's own visible band, straight below its label where it can, so leaders never cross.
 * Pure and deterministic.
 */
export function sideCallouts(view: SideView, fs: number): SideCallout[] {
  const wa = view.windows.a;
  const rect = (band: SideBand) => ({ x0: band.a.status === 'known' ? band.a.cutbackMm : 0, x1: wa, y0: band.y - band.half, y1: band.y + band.half });
  const rects = view.bands.map(rect);
  // Painter order: a later band covers an earlier one where they overlap.
  const covers = (i: number, x: number, y: number): number => rects.filter((r, j) => j > i && x > r.x0 && x < r.x1 && y > r.y0 && y < r.y1).length;
  const samplesX = 48, samplesY = 12;
  type Seen = { x: number; y: number };
  const tagOrder = (a: string, b: string): number => a.localeCompare(b, undefined, { numeric: true });
  const runs = view.bands.map((band, i) => ({ band, i, r: rects[i]! })).filter(({ band, r }) => band.tag && r.x1 - r.x0 > 1e-9).map(({ band, i, r }) => {
    const step = (r.x1 - r.x0) / samplesX;
    const xs = Array.from({ length: samplesX }, (_, k) => r.x0 + step * (k + 0.5));
    // Top to bottom: the first visible sample at each station is the band's edge nearest the labels.
    let seen: Seen[] = [];
    for (const x of xs) for (let m = 0; m < samplesY; m += 1) {
      const y = r.y0 + (r.y1 - r.y0) * (m + 0.5) / samplesY;
      if (covers(i, x, y) === 0) { seen.push({ x, y }); break; }
    }
    // A wholly covered element is pointed at where the fewest layers lie over its center line.
    const occluded = seen.length === 0;
    if (occluded) {
      const depth = xs.map(x => covers(i, x, band.y));
      const least = Math.min(...depth);
      seen = xs.filter((_, k) => depth[k] === least).map(x => ({ x, y: band.y }));
    }
    // Preferred label position: the middle of the widest run of stations where it can be pointed at.
    let best: [number, number] = [seen[0]!.x, seen[0]!.x], start = seen[0]!.x;
    for (let k = 1; k <= seen.length; k += 1) {
      const prev = seen[k - 1]!.x, cur = seen[k]?.x;
      if (cur === undefined || cur - prev > step * 1.5) {
        if (prev - start > best[1] - best[0]) best = [start, prev];
        if (cur !== undefined) start = cur;
      }
    }
    return { band, r, seen, occluded, pref: (best[0] + best[1]) / 2 };
  });
  const chars = Math.max(1, ...runs.map(it => it.band.tag.length));
  const gap = fs * Math.max(1.6, 0.62 * CALLOUT_SCALE * chars + 0.9);
  // Elements that can be pointed at in about the same place are labeled in tag order.
  const items = runs.sort((p, q) => Math.round(p.pref / (gap * 2)) - Math.round(q.pref / (gap * 2)) || tagOrder(p.band.tag, q.band.tag) || p.pref - q.pref);
  const slots = spread(items.map(it => it.pref), gap, fs * 0.6, wa - fs * 0.6);
  const anchorAt = (it: typeof items[number], x: number): { anchor: Seen; occluded: boolean } => {
    let best = it.seen[0]!;
    for (const p of it.seen) if (Math.abs(p.x - x) < Math.abs(best.x - x) - 1e-12) best = p;
    return { anchor: best, occluded: it.occluded };
  };
  const assign = items.map((_, k) => k);
  const top = sideLabelBaseline(view, fs) + fs * 0.3;
  const place = (): SideCallout[] => slots.map((x, k) => {
    const it = items[assign[k]!]!;
    const { anchor, occluded } = anchorAt(it, x);
    return { path: it.band.path, tag: it.band.tag, anchor, label: { x, y: top }, occluded };
  });
  // Safety net: swapping two crossing leaders' labels shortens their total length, so this terminates.
  let placed = place();
  for (let guard = 0; guard < items.length * items.length * 4; guard += 1) {
    let hit: [number, number] | null = null;
    for (let a = 0; a < placed.length && !hit; a += 1) for (let b = a + 1; b < placed.length; b += 1) {
      const p = placed[a]!, q = placed[b]!;
      if (segmentsIntersect(p.anchor, p.label, q.anchor, q.label)) { hit = [a, b]; break; }
    }
    if (!hit) break;
    [assign[hit[0]], assign[hit[1]]] = [assign[hit[1]]!, assign[hit[0]]!];
    placed = place();
  }
  return placed;
}

/* ---- SVG ---- */

const esc = (text: string): string => text.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const n = (value: number): string => String(Math.round(value * 1000) / 1000);
const hash = (text: string): string => {
  let h = 5381;
  for (let i = 0; i < text.length; i += 1) h = ((h << 5) + h + text.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
};
/** Theme tokens with fallbacks so an exported SVG still reads outside the application. */
const TOKEN = { review: 'var(--sb-review, #e2b714)', hatch: 'var(--sb-hatch, #85858d)', accent: 'var(--sb-accent, #3fd4f0)', muted: 'var(--sb-text-tertiary, #85858d)' };

export function formatExtent(extent: Extent): string {
  if (extent.status === 'unknown') return `Unknown: ${extent.reason}`;
  if (extent.illustrative) return 'Illustrative step (not a dimension)';
  if (extent.cutbackMm === 0) return 'To the stock cut end';
  const tol = extent.minusMm === null && extent.plusMm === null ? '' :
    ` (−${extent.minusMm ?? '?'} / +${extent.plusMm ?? '?'})`;
  return `Stops ${extent.cutbackMm} mm from the cut end${tol}`;
}

/** Axial texture tile: lay lines along the cable rather than the cut-face pattern. */
function sideTexture(id: string, look: Appearance, half: number): string {
  const t = Math.max(half * 0.55, 0.05);
  const dark = mixHex(look.base, '#000000', 0.45), light = mixHex(look.base, '#ffffff', 0.5);
  const sw = n(t * 0.12);
  const tile = (body: string, w = t, h = t): string => `<pattern id="${id}" patternUnits="userSpaceOnUse" width="${n(w)}" height="${n(h)}">${body}</pattern>`;
  switch (look.texture) {
    case 'strands':
      return tile(`<path d="M0 ${n(t)}L${n(t)} 0" stroke="${dark}" stroke-width="${sw}" stroke-opacity="0.7"/><path d="M${n(t * 0.25)} ${n(t)}L${n(t * 1.25)} 0" stroke="${light}" stroke-width="${n(t * 0.08)}" stroke-opacity="0.6"/>`);
    case 'braid':
      return tile(`<path d="M0 ${n(t)}L${n(t)} 0M0 0L${n(t)} ${n(t)}" stroke="${dark}" stroke-width="${sw}"/><path d="M0 ${n(t / 2)}L${n(t / 2)} 0M${n(t / 2)} ${n(t)}L${n(t)} ${n(t / 2)}" stroke="${light}" stroke-width="${n(t * 0.06)}" stroke-opacity="0.7"/>`);
    case 'spiral':
      return tile(`<path d="M0 ${n(t)}L${n(t)} 0" stroke="${dark}" stroke-width="${sw}"/><path d="M${n(-t / 2)} ${n(t / 2)}L${n(t / 2)} ${n(-t / 2)}M${n(t / 2)} ${n(t * 1.5)}L${n(t * 1.5)} ${n(t / 2)}" stroke="${light}" stroke-width="${n(t * 0.07)}"/>`);
    case 'tape':
    case 'foil':
      return tile(`<path d="M0 ${n(t * 2)}L${n(t * 1.2)} 0" stroke="${dark}" stroke-width="${n(t * 0.05)}" stroke-opacity="0.55"/><path d="M${n(t * 0.3)} ${n(t * 2)}L${n(t * 1.5)} 0" stroke="${light}" stroke-width="${n(t * 0.3)}" stroke-opacity="0.35"/>`, t * 1.2, t * 2);
    case 'foam':
      return tile(`<circle cx="${n(t * 0.3)}" cy="${n(t * 0.3)}" r="${n(t * 0.14)}" fill="${dark}" fill-opacity="0.25"/><circle cx="${n(t * 0.75)}" cy="${n(t * 0.7)}" r="${n(t * 0.1)}" fill="${light}" fill-opacity="0.45"/>`);
    case 'fiber':
      return tile(`<path d="M0 ${n(t * 0.3)}H${n(t)}M0 ${n(t * 0.8)}H${n(t)}" stroke="${dark}" stroke-width="${n(t * 0.05)}" stroke-opacity="0.45"/>`);
    case 'unknown':
      return tile(`<path d="M0 ${n(t)}L${n(t)} 0" style="stroke:${TOKEN.hatch}" stroke-width="${sw}"/>`);
    default:
      return '';
  }
}

/** Cylinder shading: highlight above the axis, shade below (objectBoundingBox, vertical). */
function shadeDefs(prefix: string): string {
  const stops = (list: [number, string, number][]): string => list.map(([o, c, a]) => `<stop offset="${o}" stop-color="${c}" stop-opacity="${a}"/>`).join('');
  return `<linearGradient id="${prefix}-cyl" x1="0" y1="0" x2="0" y2="1">${stops([[0, '#000000', 0.3], [0.22, '#ffffff', 0.32], [0.4, '#ffffff', 0.06], [0.8, '#000000', 0.18], [1, '#000000', 0.42]])}</linearGradient>`
    + `<linearGradient id="${prefix}-metal" x1="0" y1="0" x2="0" y2="1">${stops([[0, '#000000', 0.35], [0.25, '#ffffff', 0.6], [0.4, '#ffffff', 0.1], [0.62, '#000000', 0.2], [0.78, '#ffffff', 0.22], [1, '#000000', 0.5]])}</linearGradient>`
    + `<pattern id="${prefix}-unknown" patternUnits="userSpaceOnUse" width="0.6" height="0.6" patternTransform="rotate(45)"><rect width="0.18" height="0.6" style="fill:${TOKEN.review}" fill-opacity="0.75"/></pattern>`;
}

/** Annotation unit (font size, mm of drawing) for a side view: scales with the drawn length. */
export function sideAnnotationUnit(view: SideView): number {
  const total = view.windows.a + view.gapMm + view.windows.b;
  return Math.max(Math.min(total / 48, (view.maxY - view.minY) * 0.5), 0.25);
}

export interface SideSvgOptions { selected?: string | null; idPrefix?: string }

export function renderSideViewSvg(view: SideView, title: string, options: SideSvgOptions = {}): string {
  const { a: wa, b: wb } = view.windows;
  const total = wa + view.gapMm + wb;
  const fs = sideAnnotationUnit(view);
  const prefix = options.idPrefix ?? `sv${hash(`${title}|${view.mode}|${view.bands.map(b => `${b.path}${b.y}${b.half}${JSON.stringify(b.a)}${JSON.stringify(b.b)}`).join(',')}`)}`;
  const defs: string[] = [shadeDefs(prefix)];
  const parts: string[] = [];
  /** Screen span of a band at one end: [from, to] in drawing x. */
  const span = (end: SideEnd, extent: Extent): [number, number] => {
    const cut = extent.status === 'known' ? extent.cutbackMm : 0;
    return end === 'a' ? [cut, wa] : [wa + view.gapMm, total - cut];
  };
  view.bands.forEach((band, index) => {
    const look = band.look;
    const texId = `${prefix}-t${index}`;
    const texture = sideTexture(texId, look, band.half);
    if (texture) defs.push(texture);
    const metal = look.finish === 'metal' || look.finish === 'foil';
    const top = band.y - band.half, h = band.half * 2;
    const edge = edgeColor(look.base);
    for (const end of ['a', 'b'] as const) {
      const extent = band[end];
      const [x0, x1] = span(end, extent);
      if (x1 - x0 <= 1e-9) continue;
      const rect = (fill: string, extra = ''): string => `<rect x="${n(x0)}" y="${n(top)}" width="${n(x1 - x0)}" height="${n(h)}" ${fill}${extra}/>`;
      const body = [rect(`fill="${look.base}"`)];
      if (texture) body.push(rect(`fill="url(#${texId})"`));
      if (look.stripe) body.push(`<rect data-stripe="true" x="${n(x0)}" y="${n(band.y - band.half * 0.18)}" width="${n(x1 - x0)}" height="${n(band.half * 0.36)}" fill="${look.stripe}"/>`);
      body.push(rect(`fill="url(#${prefix}-${metal ? 'metal' : 'cyl'})"`));
      body.push(`<path d="M${n(x0)} ${n(top)}H${n(x1)}M${n(x0)} ${n(top + h)}H${n(x1)}" stroke="${edge}" stroke-width="${n(fs * 0.05)}" fill="none"/>`);
      const known = extent.status === 'known';
      if (known) {
        // The cut face as a shallow ellipse: an annulus for a tube, a disk for a solid.
        const cx = end === 'a' ? x0 : x1, rx = Math.min(band.half * 0.22, (x1 - x0) / 2);
        const face = mixHex(look.base, '#000000', 0.22);
        const ellipse = (ry: number, w: number): string => `M${n(cx - w)} ${n(band.y)}a${n(w)} ${n(ry)} 0 1 0 ${n(2 * w)} 0a${n(w)} ${n(ry)} 0 1 0 ${n(-2 * w)} 0`;
        const bore = band.innerHalf > 0 ? ellipse(band.innerHalf, rx * band.innerHalf / band.half) : '';
        body.push(`<path data-cut-face="${end}" d="${ellipse(band.half, rx)}${bore}" fill="${face}" fill-rule="evenodd" stroke="${edge}" stroke-width="${n(fs * 0.04)}"/>`);
      } else {
        body.push(rect(`fill="url(#${prefix}-unknown)"`));
        body.push(rect('fill="none"', ` style="stroke:${TOKEN.review}" stroke-width="${n(fs * 0.08)}" stroke-dasharray="${n(fs * 0.4)} ${n(fs * 0.25)}"`));
      }
      parts.push(`<g data-element="${esc(band.path)}" data-end="${end}" data-extent="${extent.status}" data-kind="${band.kind}" data-fill-source="${look.fillSource}" data-texture="${look.texture}"${known ? '' : ' fill-opacity="0.55"'} class="sb-side-band">${body.join('')}</g>`);
    }
  });
  // Selection: a reticle outline only; the engineering fill never changes.
  const chosen = view.bands.find(b => b.path === options.selected);
  if (chosen) for (const end of ['a', 'b'] as const) {
    const [x0, x1] = span(end, chosen[end]);
    if (x1 - x0 > 1e-9) parts.push(`<rect data-selected="true" x="${n(x0)}" y="${n(chosen.y - chosen.half - fs * 0.12)}" width="${n(x1 - x0)}" height="${n(chosen.half * 2 + fs * 0.24)}" fill="none" style="stroke:${TOKEN.accent}" stroke-width="${n(fs * 0.1)}" stroke-dasharray="${n(fs * 0.5)} ${n(fs * 0.25)}"/>`);
  }
  // Break: the length between the windows is omitted.
  const zig = (x: number): string => {
    const k = (view.maxY - view.minY) / 6;
    return `M${n(x)} ${n(view.minY - fs * 0.4)}` + Array.from({ length: 6 }, (_, i) => `L${n(x + (i % 2 === 0 ? fs * 0.35 : -fs * 0.35))} ${n(view.minY + k * (i + 0.5))}`).join('') + `L${n(x)} ${n(view.maxY + fs * 0.4)}`;
  };
  if (view.bands.length) {
    parts.push(`<g data-break="true" fill="none" stroke="currentColor" stroke-width="${n(fs * 0.07)}"><path d="${zig(wa + view.gapMm * 0.25)}"/><path d="${zig(wa + view.gapMm * 0.75)}"/><path d="M${n(wa)} ${n(view.minY)}H${n(wa + view.gapMm)}M${n(wa)} ${n(view.maxY)}H${n(wa + view.gapMm)}" style="stroke:${TOKEN.muted}" stroke-dasharray="${n(fs * 0.3)} ${n(fs * 0.3)}"/></g>`);
  }
  // End labels and tag callouts (end A, above the cable).
  const labelY = sideLabelBaseline(view, fs);
  parts.push(`<text x="0" y="${n(labelY - fs * 1.5)}" font-size="${n(fs)}" fill="currentColor" font-weight="600">END A</text><text x="${n(total)}" y="${n(labelY - fs * 1.5)}" font-size="${n(fs)}" fill="currentColor" font-weight="600" text-anchor="end">END B</text>`);
  for (const c of sideCallouts(view, fs)) {
    parts.push(`<g data-callout="${esc(c.path)}"${c.occluded ? ' data-occluded="true"' : ''}><path d="M${n(c.anchor.x)} ${n(c.anchor.y)}L${n(c.label.x)} ${n(c.label.y)}" stroke="currentColor" stroke-width="${n(fs * 0.06)}" fill="none"/>`
      + `<circle cx="${n(c.anchor.x)}" cy="${n(c.anchor.y)}" r="${n(fs * 0.13)}" ${c.occluded ? `fill="none" stroke="currentColor" stroke-width="${n(fs * 0.05)}"` : 'fill="currentColor"'}/>`
      + `<text x="${n(c.label.x)}" y="${n(labelY)}" font-size="${n(fs * CALLOUT_SCALE)}" font-weight="600" fill="currentColor" text-anchor="middle">${esc(c.tag)}</text></g>`);
  }
  // Prepared mode: dimension lines from each cut end; unknowns listed in the review color.
  let rowY = view.maxY + fs * 1.6;
  const notes: string[] = [];
  if (view.mode === 'prepared') for (const end of ['a', 'b'] as const) {
    const known = view.bands.filter(b => b[end].status === 'known' && (b[end] as { cutbackMm: number }).cutbackMm > 0);
    const byLength = new Map<number, SideBand[]>();
    for (const b of known) {
      const c = (b[end] as { cutbackMm: number }).cutbackMm;
      byLength.set(c, [...(byLength.get(c) ?? []), b]);
    }
    let level = 0;
    for (const [length, members] of [...byLength.entries()].sort((p, q) => p[0] - q[0])) {
      const y = rowY + level * fs * 1.5;
      const [x0, x1] = end === 'a' ? [0, length] : [total - length, total];
      const e = members[0]![end] as Extract<Extent, { status: 'known' }>;
      const tol = e.minusMm === null && e.plusMm === null ? '' : ` −${e.minusMm ?? '?'}/+${e.plusMm ?? '?'}`;
      const tick = fs * 0.35;
      parts.push(`<g data-dimension="${end}" data-length="${length}"><path d="M${n(x0)} ${n(y - tick)}V${n(y + tick)}M${n(x1)} ${n(y - tick)}V${n(y + tick)}M${n(x0)} ${n(y)}H${n(x1)}" stroke="currentColor" stroke-width="${n(fs * 0.05)}" fill="none"/><text x="${n(end === 'a' ? x0 + fs * 0.2 : x1 - fs * 0.2)}" y="${n(y - fs * 0.25)}" font-size="${n(fs * 0.75)}" fill="currentColor" text-anchor="${end === 'a' ? 'start' : 'end'}">${n(length)}${esc(tol)} mm · ${esc(members.map(m => m.tag).join(','))}</text></g>`);
      level += 1;
    }
    rowY += Math.max(level, 0) * fs * 1.5;
    const unknown = view.bands.filter(b => b[end].status === 'unknown');
    if (unknown.length) notes.push(`End ${end.toUpperCase()} extent unknown: ${unknown.map(b => b.tag || b.path).join(', ')}`);
  }
  if (view.notDrawn.length) notes.push(`Not drawn, section geometry unknown: ${view.notDrawn.map(r => r.tag || r.path).join(', ')}`);
  notes.forEach((text, i) => parts.push(`<text data-unknown-note="true" x="0" y="${n(rowY + fs * (0.8 + i * 1.2))}" font-size="${n(fs * 0.75)}" style="fill:${TOKEN.review}">${esc(text)}</text>`));
  const modeText = view.mode === 'cutaway' ? 'ILLUSTRATIVE CUTAWAY · AXIAL STEPS ARE NOT DIMENSIONS' : 'PREPARED ENDS · MM FROM EACH STOCK CUT END';
  const bottom = rowY + fs * (1.2 + notes.length * 1.2) + fs;
  parts.push(`<text x="${n(total / 2)}" y="${n(bottom - fs * 0.2)}" font-size="${n(fs * 0.7)}" style="fill:${TOKEN.muted}" text-anchor="middle">${modeText} · LENGTH BETWEEN ENDS OMITTED</text>`);
  const pad = fs;
  const minY = labelY - fs * 2.8;
  const description = `${view.mode === 'cutaway' ? 'Illustrative cutaway; axial steps are a display arrangement.' : 'Prepared ends from end preparation instructions.'} ${view.bands.length} drawn elements.`
    + (notes.length ? ` ${notes.join('. ')}.` : '');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${n(-pad)} ${n(minY)} ${n(total + 2 * pad)} ${n(bottom + pad - minY)}" role="img" aria-label="${esc(title)}" data-view="side" data-mode="${view.mode}"><title>${esc(title)}</title><desc>${esc(description)}</desc><defs>${defs.join('')}</defs>${parts.join('')}</svg>`;
}
