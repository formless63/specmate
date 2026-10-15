// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Printable labels for a frozen harness at a declared physical size: one label per physical
 * stock section (stock and planned cut length) and one per recorded physical end. Text is
 * placed in a monospace face at a physical point size that is searched downward until the
 * lines fit; a label whose text cannot fit at the minimum size is NOT drawn (and is reported),
 * never silently cut off. The same calibration, page and ruler rules as the formboard apply.
 * Labels carry only recorded facts: an unrecorded length reads "length not recorded".
 */
import { RULER_MM, calibrationFactor, esc, footerSvg, calibrationLine, FOOTER_MM, n, pageSize, wrapText, MAX_PAGES, MIN_SAFE_MARGIN_MM } from './print';
import type { PaperId, PrintWarning } from './print';
import { parseDecimal } from './model';
import type { HarnessView, StockMap } from './model';

export interface LabelSpec { id: string; kind: 'section' | 'end'; lines: string[] }

export function harnessLabels(harness: HarnessView, stocks: StockMap, title: string): LabelSpec[] {
  const out: LabelSpec[] = [];
  const segments = new Map(harness.segments.map(s => [s.local_id, s]));
  for (const s of harness.sections) {
    const stock = stocks[s.stock_revision_id]?.name ?? s.stock_revision_id;
    const known = parseDecimal(s.planned_cut_length_mm) !== null;
    out.push({ id: `section:${s.local_id}`, kind: 'section', lines: [`${title}`, `Section ${s.local_id}`, stock, known ? `Cut ${s.planned_cut_length_mm} mm` : 'Cut length not recorded'] });
    for (const pe of s.physical_ends ?? []) {
      const ends = [...new Set(pe.segment_ends.filter(e => segments.get(e.segment_id)?.section_id === s.local_id).map(e => e.end.toUpperCase()))];
      const ep = harness.endpoints.find(e => e.local_id === pe.endpoint_id);
      out.push({ id: `end:${s.local_id}:${pe.local_id}`, kind: 'end', lines: [`${title}`, `${s.local_id} end ${ends.length > 0 ? ends.join('/') : '(end not recorded)'}`, pe.label ?? pe.local_id, ep ? `Endpoint ${ep.label ?? ep.local_id}` : 'Endpoint not recorded'] });
    }
  }
  return out;
}

export interface LabelSheetSettings {
  paper: PaperId; orientation: 'portrait' | 'landscape'; marginMm: number;
  labelWidthMm: number; labelHeightMm: number; gapMm: number; copies: number;
  /** Largest and smallest text size searched, in mm of em height. */
  maxFontMm: number; minFontMm: number;
  measuredRulerMm: number | null;
}
export const DEFAULT_LABEL_SETTINGS: LabelSheetSettings = { paper: 'a4', orientation: 'portrait', marginMm: 10, labelWidthMm: 50, labelHeightMm: 20, gapMm: 2, copies: 1, maxFontMm: 3.2, minFontMm: 1.8, measuredRulerMm: null };

export interface PlacedLabel { id: string; kind: 'section' | 'end'; copy: number; page: number; x: number; y: number; fontMm: number; lines: string[] }
export interface LabelSheetPlan {
  ok: boolean; settings: LabelSheetSettings; pageWidthMm: number; pageHeightMm: number;
  cols: number; rows: number; perPage: number; pageCount: number;
  labels: PlacedLabel[]; unfit: string[]; warnings: PrintWarning[];
  calibration: { measuredMm: number | null; factor: number };
  title: string;
}
const PAD_MM = 1.2;
const CHAR_EM = 0.62;
const LINE_EM = 1.2;

/** Largest font whose wrapped lines fit the label, or null. Lines are wrapped on words; an over-long word does not fit. */
export function fitLabelText(lines: string[], widthMm: number, heightMm: number, maxFont: number, minFont: number): { fontMm: number; lines: string[] } | null {
  for (let f = maxFont; f >= minFont - 1e-9; f = Math.round((f - 0.1) * 100) / 100) {
    const chars = Math.floor((widthMm - 2 * PAD_MM) / (f * CHAR_EM));
    if (chars < 1) continue;
    if (lines.some(l => l.split(/\s+/).some(w => w.length > chars))) continue;
    const wrapped = lines.flatMap(l => wrapText(l, chars));
    if (wrapped.length * f * LINE_EM <= heightMm - 2 * PAD_MM + 1e-9) return { fontMm: f, lines: wrapped };
  }
  return null;
}

export function planLabelSheet(labels: LabelSpec[], title: string, input: Partial<LabelSheetSettings> = {}): LabelSheetPlan {
  const s: LabelSheetSettings = { ...DEFAULT_LABEL_SETTINGS, ...input };
  const { w: pageW, h: pageH } = pageSize(s);
  const warnings: PrintWarning[] = [];
  const err = (code: string, text: string) => warnings.push({ code, severity: 'error', text });
  const cal = calibrationFactor(s.measuredRulerMm);
  if (cal.error) err('calibration-invalid', cal.error);
  if (cal.warning) warnings.push({ code: 'calibration-printer-scaling', severity: 'warn', text: cal.warning });
  const c = cal.factor;
  const positive = (v: number) => Number.isFinite(v) && v > 0;
  if (![s.labelWidthMm, s.labelHeightMm].every(positive)) err('label-size-invalid', 'The label width and height must be positive.');
  if (!(Number.isFinite(s.gapMm) && s.gapMm >= 0) || !(Number.isFinite(s.marginMm) && s.marginMm >= 0)) err('gap-invalid', 'The label gap and page margin must be zero or more.');
  if (!(Number.isInteger(s.copies) && s.copies >= 1 && s.copies <= 50)) err('copies-invalid', 'Copies must be a whole number from 1 to 50.');
  if (!(s.minFontMm > 0 && s.maxFontMm >= s.minFontMm)) err('font-invalid', 'The text size range is invalid.');
  if (s.minFontMm > 0 && s.minFontMm < 1.5) warnings.push({ code: 'font-small', severity: 'warn', text: 'Text under 1.5 mm is hard to read on most printers.' });
  if (s.marginMm < MIN_SAFE_MARGIN_MM && s.marginMm >= 0) warnings.push({ code: 'margin-unprintable', severity: 'warn', text: `A margin below ${MIN_SAFE_MARGIN_MM} mm is outside the printable area of most printers; edge labels may be clipped.` });
  const winW = pageW - 2 * s.marginMm, winH = pageH - 2 * s.marginMm - FOOTER_MM;
  const lw = s.labelWidthMm * c, lh = s.labelHeightMm * c, gap = s.gapMm * c;
  let cols = 0, rows = 0;
  if (warnings.every(w => w.severity !== 'error')) {
    if (winW < RULER_MM * c + 10) err('page-too-small', 'The printable width is too small for the calibration ruler.');
    cols = Math.floor((winW + gap) / (lw + gap) + 1e-9); rows = Math.floor((winH + gap) / (lh + gap) + 1e-9);
    if (cols < 1 || rows < 1) err('label-too-large', `A ${n(s.labelWidthMm)} x ${n(s.labelHeightMm)} mm label does not fit the printable area of ${n(winW / c)} x ${n(winH / c)} mm.`);
  }
  const placed: PlacedLabel[] = []; const unfit: string[] = [];
  let pageCount = 0;
  if (warnings.every(w => w.severity !== 'error')) {
    const perPage = cols * rows;
    const fits = labels.map(l => ({ l, fit: fitLabelText(l.lines, s.labelWidthMm, s.labelHeightMm, s.maxFontMm, s.minFontMm) }));
    for (const f of fits) if (!f.fit) unfit.push(f.l.id);
    if (unfit.length > 0) warnings.push({ code: 'text-does-not-fit', severity: 'warn', text: `${unfit.length} label${unfit.length === 1 ? '' : 's'} not drawn because the text does not fit ${n(s.labelWidthMm)} x ${n(s.labelHeightMm)} mm at ${n(s.minFontMm)} mm or larger: ${unfit.join(', ')}. Use a larger label.` });
    const drawn = fits.filter((f): f is { l: LabelSpec; fit: { fontMm: number; lines: string[] } } => f.fit !== null);
    let slot = 0;
    for (let copy = 1; copy <= s.copies; copy += 1) for (const d of drawn) {
      const page = Math.floor(slot / perPage), inPage = slot % perPage;
      placed.push({ id: d.l.id, kind: d.l.kind, copy, page, x: s.marginMm + (inPage % cols) * (lw + gap), y: s.marginMm + Math.floor(inPage / cols) * (lh + gap), fontMm: d.fit.fontMm, lines: d.fit.lines });
      slot += 1;
    }
    pageCount = Math.ceil(slot / perPage);
    if (pageCount > MAX_PAGES) err('too-many-pages', `This sheet needs ${pageCount} pages (limit ${MAX_PAGES}).`);
    if (slot === 0) warnings.push({ code: 'no-labels', severity: 'warn', text: 'There are no labels to print.' });
  }
  if (cal.error === null && s.measuredRulerMm === null) warnings.push({ code: 'uncalibrated', severity: 'warn', text: 'Not calibrated: label sizes hold only if the printer honors the page size. Measure the 100 mm ruler on a first print and enter it.' });
  const ok = warnings.every(w => w.severity !== 'error');
  return { ok, settings: s, pageWidthMm: pageW, pageHeightMm: pageH, cols: ok ? cols : 0, rows: ok ? rows : 0, perPage: ok ? cols * rows : 0, pageCount: ok ? pageCount : 0, labels: ok ? placed : [], unfit, warnings, calibration: { measuredMm: s.measuredRulerMm, factor: c }, title };
}

export function renderLabelPageSvg(plan: LabelSheetPlan, page: number): string {
  if (!plan.ok) throw new Error('A plan with errors has no pages.');
  const s = plan.settings, c = plan.calibration.factor;
  const lw = s.labelWidthMm * c, lh = s.labelHeightMm * c;
  const cells = plan.labels.filter(l => l.page === page).map(l => {
    const f = l.fontMm * c;
    const text = l.lines.map((t, i) => `<text x="${n(l.x + PAD_MM * c)}" y="${n(l.y + PAD_MM * c + f * (0.9 + i * LINE_EM))}" font-size="${n(f)}"${i === 0 ? ' fill-opacity="0.7"' : ''}${i === 1 ? ' font-weight="700"' : ''}>${esc(t)}</text>`).join('');
    return `<g data-label="${esc(l.id)}" data-copy="${l.copy}"><rect x="${n(l.x)}" y="${n(l.y)}" width="${n(lw)}" height="${n(lh)}" rx="${n(0.8 * c)}" fill="none" stroke="#000" stroke-width="0.2"/>${text}</g>`;
  }).join('');
  const extra = [`${plan.title.length > 60 ? `${plan.title.slice(0, 57)}...` : plan.title} labels · page ${page + 1} of ${plan.pageCount} · ${n(s.labelWidthMm)} x ${n(s.labelHeightMm)} mm each, outline is the label edge.`];
  const footer = footerSvg({ ...plan, settings: { marginMm: s.marginMm } }, ['Labels at declared size. Print at Actual size / 100%, never "fit to page".', calibrationLine(plan.calibration)], extra);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${n(plan.pageWidthMm)}mm" height="${n(plan.pageHeightMm)}mm" viewBox="0 0 ${n(plan.pageWidthMm)} ${n(plan.pageHeightMm)}" data-page="${page + 1}" role="img" aria-label="${esc(plan.title)} label page ${page + 1} of ${plan.pageCount}" style="font-family:monospace"><g font-family="monospace" fill="#000">${cells}</g>${footer}</svg>`;
}

export function renderLabelHtml(plan: LabelSheetPlan): string {
  if (!plan.ok) throw new Error('A plan with errors has no document.');
  const css = `@page{size:${n(plan.pageWidthMm)}mm ${n(plan.pageHeightMm)}mm;margin:0}html,body{margin:0;padding:0;background:#fff}.page{width:${n(plan.pageWidthMm)}mm;height:${n(plan.pageHeightMm)}mm;overflow:hidden;break-after:page;page-break-after:always}.page svg{display:block}.page:last-child{break-after:auto;page-break-after:auto}`;
  const pages = Array.from({ length: plan.pageCount }, (_, i) => `<div class="page">${renderLabelPageSvg(plan, i)}</div>`).join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${esc(plan.title)} - labels</title><style>${css}</style></head><body data-labels="${plan.labels.length}">${pages}</body></html>`;
}
