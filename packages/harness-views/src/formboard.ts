// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Formboard drawing of a harness: every physical stock section as a bar at one
 * length scale, drawn in its jacket's recorded colour, joined where breakouts join
 * them. Behaviour reference: the drawing-sheet views of cab-stu (MIT, formless63);
 * the layout is written for Specmate's section/segment/breakout records and contains
 * none of that sheet's workshop format, artwork or fonts.
 *
 * Honesty rules: a section with no planned cut length is drawn with a placeholder
 * length, dashed, and labelled "length unknown". Legs that share their trunk's section
 * have no recorded length and are drawn as dashed stubs. Position on the board implies
 * nothing about routing, electrical connection or fit.
 */
import { appearanceOf, edgeColor } from '../../section-layout/src';
import type { Appearance } from '../../section-layout/src';
import { parseDecimal } from './model';
import type { End, HarnessView, StockMap } from './model';

export interface FormboardEndLabel { end: End; x: number; y: number; dir: 1 | -1; labels: string[] }
export interface FormboardBar {
  sectionId: string; stockRevisionId: string; stockName: string;
  x0: number; x1: number; y: number; thickness: number;
  lengthText: string; lengthKnown: boolean; outerMm: number | null;
  startEnd: End; look: Appearance; segments: string[]; ends: FormboardEndLabel[];
}
export interface FormboardJunction { breakoutId: string; x: number; y: number; legCount: number }
export interface FormboardLink { breakoutId: string; x1: number; y1: number; x2: number; y2: number }
export interface FormboardStub { breakoutId: string; sectionId: string; x: number; y: number; dir: 1 | -1; labels: string[] }
export interface Formboard {
  bars: FormboardBar[]; junctions: FormboardJunction[]; links: FormboardLink[]; stubs: FormboardStub[];
  bounds: { minX: number; maxX: number; minY: number; maxY: number };
  fontSize: number; rowHeight: number; notes: string[];
}

const other = (end: End): End => end === 'a' ? 'b' : 'a';

export function formboardLayout(harness: HarnessView, stocks: StockMap): Formboard {
  const notes: string[] = [];
  const segments = new Map(harness.segments.map(s => [s.local_id, s]));
  const known = harness.sections.map(s => parseDecimal(s.planned_cut_length_mm)).map(p => p === null ? null : Number(p.units) / 10 ** p.scale);
  const maxKnown = Math.max(0, ...known.filter((v): v is number => v !== null && v > 0));
  const placeholder = maxKnown > 0 ? maxKnown * 0.12 : 100;
  const rowH = Math.max((maxKnown || 100) * 0.09, 12);
  const fontSize = rowH * 0.26;
  const outerOf = (id: string): number | null => {
    const s = stocks[id]?.section;
    return s?.widthMm != null && s.heightMm != null ? Math.max(s.widthMm, s.heightMm) : null;
  };
  const maxOd = Math.max(0, ...harness.sections.map(s => outerOf(s.stock_revision_id) ?? 0));

  type Edge = { breakoutId: string; fromSec: string; fromEnd: End; toSec: string; toEnd: End };
  const edges: Edge[] = [];
  const stubs: { breakoutId: string; sectionId: string; end: End; label: string }[] = [];
  for (const b of harness.breakouts) {
    const trunkSection = segments.get(b.trunk.segment_id)?.section_id;
    if (!trunkSection) { notes.push(`${b.local_id}: trunk segment ${b.trunk.segment_id} is not in the harness`); continue; }
    for (const leg of b.legs) {
      const seg = segments.get(leg.segment_id);
      if (!seg) { notes.push(`${b.local_id}: leg segment ${leg.segment_id} is not in the harness`); continue; }
      if (seg.section_id === trunkSection) stubs.push({ breakoutId: b.local_id, sectionId: trunkSection, end: b.trunk.end, label: seg.label ?? seg.local_id });
      else edges.push({ breakoutId: b.local_id, fromSec: trunkSection, fromEnd: b.trunk.end, toSec: seg.section_id, toEnd: leg.end });
    }
  }
  const sections = new Map(harness.sections.map((s, i) => [s.local_id, { s, mm: known[i] ?? null }]));
  const incoming = new Set(edges.map(e => e.toSec));
  const bars: FormboardBar[] = []; const links: FormboardLink[] = []; const junctions: FormboardJunction[] = []; const stubOut: FormboardStub[] = [];
  const done = new Set<string>(); let nextRow = 0;

  const endLabels = (sectionId: string): Map<End, string[]> => {
    const result = new Map<End, string[]>();
    const sec = sections.get(sectionId)!.s;
    for (const phys of sec.physical_ends ?? []) {
      const ep = harness.endpoints.find(e => e.local_id === phys.endpoint_id);
      const text = `${phys.label ?? phys.local_id}${ep ? ` → endpoint ${ep.label ?? ep.local_id}` : ''}`;
      for (const se of phys.segment_ends) if (segments.get(se.segment_id)?.section_id === sectionId) result.set(se.end, [...(result.get(se.end) ?? []), text]);
    }
    return result;
  };

  const place = (id: string, startX: number, dir: 1 | -1, startEnd: End, row: number): void => {
    if (done.has(id)) return;
    done.add(id);
    const { s, mm } = sections.get(id)!;
    const stock = stocks[s.stock_revision_id];
    const length = mm !== null && mm > 0 ? mm : placeholder;
    const endX = startX + dir * length, y = row * rowH;
    const od = outerOf(s.stock_revision_id);
    const thickness = rowH * 0.22 * (od !== null && maxOd > 0 ? Math.max(0.45, od / maxOd) : 0.7);
    const outer = stock?.section.features.filter(f => f.shape.type === 'ring').sort((a, b) => (b.shape.type === 'ring' ? b.shape.rOuter : 0) - (a.shape.type === 'ring' ? a.shape.rOuter : 0))[0];
    const look = outer ? appearanceOf(outer) : appearanceOf({ kind: 'jacket', color: null, material: null });
    const labels = endLabels(id);
    bars.push({ sectionId: id, stockRevisionId: s.stock_revision_id, stockName: stock?.name ?? s.stock_revision_id, x0: Math.min(startX, endX), x1: Math.max(startX, endX), y, thickness,
      lengthText: mm !== null && mm > 0 ? `${s.planned_cut_length_mm} mm` : 'length unknown', lengthKnown: mm !== null && mm > 0, outerMm: od, startEnd, look,
      segments: harness.segments.filter(g => g.section_id === id).map(g => g.local_id),
      ends: [{ end: startEnd, x: startX, y, dir: (-dir) as 1 | -1, labels: labels.get(startEnd) ?? [] },
        { end: other(startEnd), x: endX, y, dir, labels: labels.get(other(startEnd)) ?? [] }] });
    const out = edges.filter(e => e.fromSec === id);
    const byBreakout = new Map<string, Edge[]>();
    for (const e of out) byBreakout.set(e.breakoutId, [...(byBreakout.get(e.breakoutId) ?? []), e]);
    out.forEach((e, index) => {
      if (done.has(e.toSec) || !sections.has(e.toSec)) return;
      const atFar = e.fromEnd !== startEnd;
      const jx = atFar ? endX : startX;
      const childDir = (atFar ? dir : -dir) as 1 | -1;
      // The first child continues on this row only from the far end, where nothing else lies.
      place(e.toSec, jx, childDir, e.toEnd, atFar && index === 0 ? row : nextRow++);
      const placed = bars.find(bar => bar.sectionId === e.toSec);
      if (placed && placed.y !== y) links.push({ breakoutId: e.breakoutId, x1: jx, y1: y, x2: jx, y2: placed.y });
    });
    for (const [breakoutId, list] of byBreakout) {
      const jx = list[0]!.fromEnd === startEnd ? startX : endX;
      junctions.push({ breakoutId, x: jx, y, legCount: list.length });
    }
    stubs.filter(t => t.sectionId === id).forEach((t, i, all) => {
      const jx = t.end === startEnd ? startX : endX;
      const away = (t.end === startEnd ? -dir : dir) as 1 | -1;
      stubOut.push({ breakoutId: t.breakoutId, sectionId: id, x: jx, y: y + (i + 1 - (all.length + 1) / 2 + 0.5) * rowH * 0.28 + rowH * 0.35, dir: away, labels: [t.label] });
    });
  };

  for (const { s } of sections.values()) {
    if (incoming.has(s.local_id) || done.has(s.local_id)) continue;
    place(s.local_id, 0, 1, 'a', nextRow++);
  }
  const unplacedIds: string[] = [];
  for (const { s } of sections.values()) {
    if (done.has(s.local_id)) continue;
    // A cycle with no entry: start it at its first section, and say so.
    place(s.local_id, 0, 1, 'a', nextRow++);
    unplacedIds.push(s.local_id);
  }
  if (unplacedIds.length > 0) notes.push(`Sections ${unplacedIds.join(', ')} are joined in a loop of breakouts; the board starts the loop at its first section.`);
  const xs = [...bars.flatMap(b => [b.x0, b.x1]), ...stubOut.map(s => s.x + s.dir * rowH * 0.8)];
  const ys = bars.map(b => b.y);
  const bounds = { minX: Math.min(0, ...xs), maxX: Math.max(1, ...xs), minY: Math.min(0, ...ys) - rowH * 0.6, maxY: Math.max(0, ...ys) + rowH * 0.9 };
  return { bars, junctions, links, stubs: stubOut, bounds, fontSize, rowHeight: rowH, notes };
}

/* ------------------------------------------------------------------ rendering */
const esc = (t: string): string => t.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const n = (v: number): string => String(Math.round(v * 100) / 100);
const hash = (text: string): string => { let h = 5381; for (let i = 0; i < text.length; i += 1) h = ((h << 5) + h + text.charCodeAt(i)) | 0; return (h >>> 0).toString(36); };
const niceLength = (target: number): number => { const p = 10 ** Math.floor(Math.log10(target)); const m = target / p; return (m >= 5 ? 5 : m >= 2 ? 2 : 1) * p; };

/** On-screen size of a primary formboard label, in CSS pixels. */
const LABEL_PX = 13;

export interface FormboardSvgOptions { selected?: string | null; idPrefix?: string }
export function renderFormboardSvg(board: Formboard, title: string, options: FormboardSvgOptions = {}): string {
  const fs = board.fontSize;
  const pad = fs * 14;
  const { minX, maxX, minY, maxY } = board.bounds;
  const vx = minX - pad, vy = minY - fs * 1.5, vw = maxX - minX + 2 * pad, vh = maxY - minY + fs * 6;
  const id = options.idPrefix ?? `fb${hash(title + board.bars.map(b => b.sectionId + b.x0 + b.x1).join())}`;
  const defs = `<linearGradient id="${id}-tube" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff" stop-opacity="0.55"/><stop offset="0.35" stop-color="#fff" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity="0.4"/></linearGradient>`
    + `<pattern id="${id}-unk" patternUnits="userSpaceOnUse" width="${n(fs * 0.5)}" height="${n(fs * 0.5)}"><path d="M0 ${n(fs * 0.5)}L${n(fs * 0.5)} 0" stroke="#3d444b" stroke-width="${n(fs * 0.07)}"/></pattern>`;
  const parts: string[] = [];
  for (const l of board.links) parts.push(`<path data-link="${esc(l.breakoutId)}" d="M${n(l.x1)} ${n(l.y1)}V${n(l.y2)}" stroke="currentColor" stroke-width="${n(fs * 0.12)}" fill="none"/>`);
  for (const b of board.bars) {
    const h = b.thickness, y = b.y - h / 2, w = b.x1 - b.x0;
    const edge = edgeColor(b.look.base);
    const dash = b.lengthKnown ? '' : ` stroke-dasharray="${n(fs * 0.5)} ${n(fs * 0.3)}"`;
    const stripe = b.look.stripe ? `<rect x="${n(b.x0)}" y="${n(b.y - h * 0.12)}" width="${n(w)}" height="${n(h * 0.24)}" fill="${b.look.stripe}"/>` : '';
    const sel = options.selected === b.sectionId ? `<rect data-selected="true" x="${n(b.x0 - fs * 0.4)}" y="${n(y - fs * 0.4)}" width="${n(w + fs * 0.8)}" height="${n(h + fs * 0.8)}" fill="none" stroke="var(--sb-accent, #2f7df6)" stroke-width="${n(fs * 0.14)}" stroke-dasharray="${n(fs * 0.5)} ${n(fs * 0.25)}"/>` : '';
    parts.push(`<g data-section="${esc(b.sectionId)}" data-fill-source="${b.look.fillSource}" data-length-known="${b.lengthKnown}">`
      + `<rect x="${n(b.x0)}" y="${n(y)}" width="${n(w)}" height="${n(h)}" rx="${n(h * 0.45)}" fill="${b.look.base}"/>`
      + (b.look.fillSource === 'unknown' ? `<rect x="${n(b.x0)}" y="${n(y)}" width="${n(w)}" height="${n(h)}" rx="${n(h * 0.45)}" fill="url(#${id}-unk)"/>` : '')
      + stripe
      + `<rect x="${n(b.x0)}" y="${n(y)}" width="${n(w)}" height="${n(h)}" rx="${n(h * 0.45)}" fill="url(#${id}-tube)" stroke="${edge}" stroke-width="${n(fs * 0.1)}"${dash}/>`
      + sel
      + `<text x="${n((b.x0 + b.x1) / 2)}" y="${n(y - fs * 0.45)}" font-size="${n(fs)}" text-anchor="middle" fill="currentColor">${esc(b.sectionId)} · ${esc(b.lengthText)}</text>`
      + `<text x="${n((b.x0 + b.x1) / 2)}" y="${n(y + h + fs * 1.15)}" font-size="${n(fs * 0.85)}" text-anchor="middle" fill="currentColor" fill-opacity="0.75">${esc(b.stockName)}${b.outerMm !== null ? ` · Ø ${n(b.outerMm)} mm` : ''}</text>`);
    for (const e of b.ends) {
      parts.push(`<text x="${n(e.x + e.dir * fs * 0.4)}" y="${n(b.y + fs * 0.35)}" font-size="${n(fs)}" font-weight="600" text-anchor="${e.dir > 0 ? 'start' : 'end'}" fill="currentColor">${e.end.toUpperCase()}</text>`);
      e.labels.forEach((label, i) => parts.push(`<text data-end-label="${e.end}" x="${n(e.x + e.dir * fs * 1.7)}" y="${n(b.y + fs * 0.35 + i * fs * 1.1)}" font-size="${n(fs * 0.85)}" text-anchor="${e.dir > 0 ? 'start' : 'end'}" fill="currentColor">${esc(label)}</text>`));
    }
    parts.push('</g>');
  }
  for (const s of board.stubs) {
    const x2 = s.x + s.dir * board.rowHeight * 0.7;
    parts.push(`<g data-stub="${esc(s.breakoutId)}"><path d="M${n(s.x)} ${n(s.y)}L${n(x2)} ${n(s.y)}" stroke="currentColor" stroke-width="${n(fs * 0.14)}" stroke-dasharray="${n(fs * 0.35)} ${n(fs * 0.25)}" fill="none"/><text x="${n(x2 + s.dir * fs * 0.3)}" y="${n(s.y + fs * 0.32)}" font-size="${n(fs * 0.85)}" text-anchor="${s.dir > 0 ? 'start' : 'end'}" fill="currentColor">${esc(s.labels.join(', '))} (length not recorded)</text></g>`);
  }
  for (const j of board.junctions) parts.push(`<g data-junction="${esc(j.breakoutId)}"><circle cx="${n(j.x)}" cy="${n(j.y)}" r="${n(fs * 0.55)}" style="fill:var(--sb-surface-canvas,#fff);stroke:currentColor" stroke-width="${n(fs * 0.12)}"/><text x="${n(j.x)}" y="${n(j.y - fs * 0.9)}" font-size="${n(fs * 0.85)}" text-anchor="middle" fill="currentColor">${esc(j.breakoutId)}</text></g>`);
  const known = board.bars.filter(b => b.lengthKnown);
  if (known.length > 0) {
    const len = niceLength((maxX - minX) * 0.2);
    const sx = minX, sy = maxY + fs * 2.4;
    parts.push(`<g data-scale="${len}"><path d="M${n(sx)} ${n(sy)}H${n(sx + len)}M${n(sx)} ${n(sy - fs * 0.4)}V${n(sy + fs * 0.4)}M${n(sx + len)} ${n(sy - fs * 0.4)}V${n(sy + fs * 0.4)}" stroke="currentColor" stroke-width="${n(fs * 0.12)}" fill="none"/><text x="${n(sx + len / 2)}" y="${n(sy - fs * 0.7)}" font-size="${n(fs * 0.9)}" text-anchor="middle" fill="currentColor">${len} mm</text></g>`);
  }
  const desc = `Formboard of ${board.bars.length} stock section${board.bars.length === 1 ? '' : 's'}; ${known.length} at recorded cut length, ${board.bars.length - known.length} with unknown length drawn at a placeholder length. Thickness is exaggerated and proportional to outer diameter.`;
  // Labels have a fixed on-screen size (LABEL_PX), so the drawing's pixel width follows its content;
  // the host shrinks it only when it would overflow.
  const k = LABEL_PX / fs, pxW = Math.min(vw * k, 2400), pxH = pxW * (vh + fs * 3) / vw;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${n(vx)} ${n(vy)} ${n(vw)} ${n(vh + fs * 3)}" width="${n(pxW)}" height="${n(pxH)}" style="font-family:var(--sb-font-data,ui-monospace,monospace);max-width:100%;height:auto" role="img" aria-label="${esc(title)}"><title>${esc(title)}</title><desc>${esc(desc)}</desc><defs>${defs}</defs>${parts.join('')}</svg>`;
}
