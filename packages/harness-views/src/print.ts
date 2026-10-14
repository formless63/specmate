// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Full-scale and scaled print output of the formboard with explicit page rules.
 *
 * What is claimed, and what is not:
 *  - Only the LENGTH axis is to scale, and only for sections with a recorded planned cut length.
 *    Bar thickness, row spacing and text are drawing aids at a fixed physical size and are
 *    never a measurement. Sections without a recorded length are drawn at a placeholder length
 *    that is labelled as not to scale.
 *  - "1:1" is stated only when the effective scale is exactly 1 and at least one length is recorded.
 *    A fit-to-page or ratio plan states its true reduced ratio and says it is not full size.
 *  - The printed calibration ruler is the check. The user may enter the length measured on a first
 *    print; the plan then pre-compensates the printer's scaling and every page states the factor.
 *    Without a measurement the plan says the scale is uncalibrated.
 *  - Large boards are tiled with a stated overlap; every page names its position and neighbours.
 *
 * Pure and deterministic: no clock, no DOM, no external resources. Output coordinates are millimetres.
 */
import { renderFormboardBody } from './formboard';
import type { Formboard } from './formboard';

export type PaperId = 'a4' | 'a3' | 'letter' | 'tabloid';
export const PAPERS: Readonly<Record<PaperId, { label: string; widthMm: number; heightMm: number }>> = {
  a4: { label: 'A4 (210 x 297 mm)', widthMm: 210, heightMm: 297 },
  a3: { label: 'A3 (297 x 420 mm)', widthMm: 297, heightMm: 420 },
  letter: { label: 'US Letter (215.9 x 279.4 mm)', widthMm: 215.9, heightMm: 279.4 },
  tabloid: { label: 'US Tabloid (279.4 x 431.8 mm)', widthMm: 279.4, heightMm: 431.8 },
};
/** Printed calibration ruler length before correction. */
export const RULER_MM = 100;
/** Height reserved at the bottom of every page for the ruler and the page statement. */
export const FOOTER_MM = 22;
export const MAX_PAGES = 64;
export const MIN_SAFE_MARGIN_MM = 5;

export type ScaleMode = 'actual' | 'fit' | 'ratio';
export interface PrintSettings {
  paper: PaperId; orientation: 'portrait' | 'landscape';
  marginMm: number; overlapMm: number;
  mode: ScaleMode;
  /** For mode 'ratio': the n of 1:n (reduction only, n >= 1). */
  ratioDenominator: number;
  /** Length the user measured on the printed 100 mm ruler of an earlier print; null = not calibrated. */
  measuredRulerMm: number | null;
}
export const DEFAULT_PRINT_SETTINGS: PrintSettings = { paper: 'a4', orientation: 'landscape', marginMm: 10, overlapMm: 10, mode: 'actual', ratioDenominator: 2, measuredRulerMm: null };

export interface PrintWarning { code: string; severity: 'info' | 'warn' | 'error'; text: string }
export interface PrintPage { index: number; row: number; col: number; txMm: number; tyMm: number }
export interface ReferenceSpan { sectionId: string; recordedMm: number; paperMm: number }
export interface PrintPlan {
  ok: boolean;
  settings: PrintSettings;
  pageWidthMm: number; pageHeightMm: number; windowWidthMm: number; windowHeightMm: number;
  /** Nominal scale before calibration (paper length per recorded length). */
  scale: number;
  calibration: { measuredMm: number | null; factor: number };
  /** True only for an exact 1:1 plan with at least one recorded length. */
  fullScaleClaim: boolean;
  scaleLabel: string;
  rows: number; cols: number; pages: PrintPage[];
  contentWidthMm: number; contentHeightMm: number;
  references: ReferenceSpan[];
  warnings: PrintWarning[];
  /** Board content, in board units, with its viewport. */
  body: { defs: string; parts: string[]; view: { x: number; y: number; w: number; h: number } } | null;
  title: string;
}

export const esc = (t: string): string => t.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
export const n = (v: number): string => String(Math.round(v * 1000) / 1000);

export function pageSize(settings: Pick<PrintSettings, 'paper' | 'orientation'>): { w: number; h: number } {
  const p = PAPERS[settings.paper];
  return settings.orientation === 'landscape' ? { w: p.heightMm, h: p.widthMm } : { w: p.widthMm, h: p.heightMm };
}

/** Pre-compensation for a measured ruler. Invalid measurements are errors, never silently ignored. */
export function calibrationFactor(measuredMm: number | null): { factor: number; error: string | null; warning: string | null } {
  if (measuredMm === null) return { factor: 1, error: null, warning: null };
  if (!Number.isFinite(measuredMm) || measuredMm < 80 || measuredMm > 120) return { factor: 1, error: `A measured ruler of ${measuredMm} mm is not plausible (expected 80 to 120 mm for a 100 mm ruler); check that the print used Actual size and measure again.`, warning: null };
  const factor = RULER_MM / measuredMm;
  const off = Math.abs(measuredMm - RULER_MM) / RULER_MM;
  return { factor, error: null, warning: off > 0.01 ? `The printer scaled the ruler by ${n((measuredMm / RULER_MM - 1) * 100)}%. Prefer disabling "fit"/"shrink to printable area" in the print dialog; the compensation is applied but should be re-measured.` : null };
}

const sigFloor = (v: number, digits = 4): number => { const p = 10 ** (digits - 1 - Math.floor(Math.log10(v))); return Math.floor(v * p) / p; };

/** Nominal and effective scale text for a plan. */
function scaleText(scale: number): string {
  if (scale === 1) return '1:1';
  const inv = 1 / scale;
  return `1:${n(Math.round(inv * 100) / 100)}`;
}

export function planFormboardPrint(board: Formboard, title: string, input: Partial<PrintSettings> = {}): PrintPlan {
  const settings: PrintSettings = { ...DEFAULT_PRINT_SETTINGS, ...input };
  const { w: pageW, h: pageH } = pageSize(settings);
  const warnings: PrintWarning[] = [];
  const fail = (code: string, text: string) => warnings.push({ code, severity: 'error', text });
  const winW = pageW - 2 * settings.marginMm, winH = pageH - 2 * settings.marginMm - FOOTER_MM;
  const cal = calibrationFactor(settings.measuredRulerMm);
  if (cal.error) fail('calibration-invalid', cal.error);
  if (cal.warning) warnings.push({ code: 'calibration-printer-scaling', severity: 'warn', text: cal.warning });
  if (!(settings.marginMm >= 0) || !Number.isFinite(settings.marginMm) || settings.marginMm * 2 >= Math.min(pageW, pageH)) fail('margin-invalid', 'The margin must be zero or more and leave a printable area.');
  else if (settings.marginMm < MIN_SAFE_MARGIN_MM) warnings.push({ code: 'margin-unprintable', severity: 'warn', text: `A margin below ${MIN_SAFE_MARGIN_MM} mm is outside the printable area of most printers; edges and registration marks may be clipped.` });
  if (settings.mode === 'ratio' && !(Number.isFinite(settings.ratioDenominator) && settings.ratioDenominator >= 1 && settings.ratioDenominator <= 1000)) fail('ratio-invalid', 'The scale must be a reduction of 1:1 to 1:1000.');
  if (winW < RULER_MM * cal.factor + 10 || winH < 40) fail('page-too-small', 'The printable area is too small for the calibration ruler and a drawing; choose a larger page or smaller margins.');
  const overlapOk = Number.isFinite(settings.overlapMm) && settings.overlapMm >= 0 && settings.overlapMm * 2 < Math.min(winW, winH);
  if (!overlapOk) fail('overlap-invalid', 'The tile overlap must be zero or more and under half of the printable area.');

  const body = renderFormboardBody(board, title, { scaleBar: false, idPrefix: 'pr' });
  const view = body.view;
  const known = board.bars.filter(b => b.lengthKnown);
  const unknown = board.bars.length - known.length;
  const factor = cal.factor;

  let scale = 1;
  if (settings.mode === 'ratio' && warnings.every(w => w.code !== 'ratio-invalid')) scale = 1 / settings.ratioDenominator;
  if (settings.mode === 'fit' && winW > 0 && winH > 0) scale = Math.min(1, sigFloor(Math.min(winW / (view.w * factor), winH / (view.h * factor))));
  const k = scale * factor;
  const contentW = view.w * k, contentH = view.h * k;

  let cols = 1, rows = 1;
  if (overlapOk && warnings.every(w => w.severity !== 'error')) {
    const o = settings.overlapMm;
    cols = contentW <= winW + 1e-9 ? 1 : Math.ceil((contentW - o) / (winW - o) - 1e-9);
    rows = contentH <= winH + 1e-9 ? 1 : Math.ceil((contentH - o) / (winH - o) - 1e-9);
    if (cols * rows > MAX_PAGES) fail('too-many-pages', `This plan needs ${cols * rows} pages (limit ${MAX_PAGES}). Use a larger page, fit to one page or a reduced ratio.`);
  }
  if (settings.mode === 'fit' && scale < 1) warnings.push({ code: 'reduced-fit', severity: 'warn', text: `Fitted to one page at ${scaleText(scale)}: this is NOT full size. Printed lengths are ${n(scale * 100)}% of the recorded lengths; do not build to this print.` });
  if (settings.mode === 'ratio' && scale < 1) warnings.push({ code: 'reduced-ratio', severity: 'warn', text: `Reduced scale ${scaleText(scale)}: this is NOT full size. Printed lengths are ${n(scale * 100)}% of the recorded lengths.` });
  if (settings.mode === 'ratio' && settings.ratioDenominator === 1) warnings.push({ code: 'ratio-is-actual', severity: 'info', text: 'A ratio of 1:1 is the same as actual size.' });
  if (settings.mode === 'fit' && scale === 1) warnings.push({ code: 'fit-is-actual', severity: 'info', text: 'The board fits one page at full size.' });
  if (cols * rows > 1 && warnings.every(w => w.severity !== 'error')) warnings.push({ code: 'tiled', severity: 'warn', text: `Tiled across ${rows} x ${cols} = ${rows * cols} pages with ${n(settings.overlapMm)} mm overlap. Align the overlap marks of neighbouring pages; trimming or taping error accumulates along a long board, so check the finished span against the ruler or a tape measure.` });
  if (cal.error === null && settings.measuredRulerMm === null) warnings.push({ code: 'uncalibrated', severity: 'warn', text: 'Not calibrated: the scale holds only if the printer honours the page size. Print this once, measure the 100 mm ruler, and enter the measured length to calibrate.' });
  if (known.length === 0) warnings.push({ code: 'no-known-length', severity: 'warn', text: 'No section has a recorded planned cut length, so nothing on this print is a measurable length; no scale is claimed.' });
  if (unknown > 0) warnings.push({ code: 'unknown-length', severity: 'warn', text: `${unknown} section${unknown === 1 ? ' is' : 's are'} drawn at a placeholder length, dashed and labelled "length unknown"; that length is not to scale.` });
  if (board.stubs.length > 0) warnings.push({ code: 'stub-length-not-recorded', severity: 'info', text: 'Legs that share their trunk section have no recorded length and are drawn as dashed stubs.' });
  warnings.push({ code: 'not-to-scale-across', severity: 'info', text: 'Only the length axis is to scale. Bar thickness, row spacing and text size are drawing aids, not measurements, and placement implies no routing, bonding or fit.' });
  for (const note of board.notes) warnings.push({ code: 'layout-note', severity: 'warn', text: note });

  const ok = warnings.every(w => w.severity !== 'error');
  const fullScaleClaim = ok && scale === 1 && known.length > 0;
  const pages: PrintPage[] = [];
  if (ok) for (let r = 0; r < rows; r += 1) for (let c = 0; c < cols; c += 1) pages.push({ index: r * cols + c, row: r, col: c, txMm: c * (winW - settings.overlapMm), tyMm: r * (winH - settings.overlapMm) });
  const references: ReferenceSpan[] = known.map(b => ({ sectionId: b.sectionId, recordedMm: b.x1 - b.x0, paperMm: (b.x1 - b.x0) * k }));
  return {
    ok, settings, pageWidthMm: pageW, pageHeightMm: pageH, windowWidthMm: winW, windowHeightMm: winH, scale,
    calibration: { measuredMm: settings.measuredRulerMm, factor }, fullScaleClaim, scaleLabel: known.length === 0 ? 'no scale (no recorded lengths)' : scaleText(scale),
    rows: ok ? rows : 0, cols: ok ? cols : 0, pages, contentWidthMm: contentW, contentHeightMm: contentH, references, warnings, body: ok ? body : null, title,
  };
}

/** The statement printed on every page: what the scale is and how to check it. */
export function scaleStatement(plan: Pick<PrintPlan, 'fullScaleClaim' | 'scale' | 'scaleLabel' | 'calibration'>): string[] {
  const lines: string[] = [];
  if (plan.fullScaleClaim) lines.push(`Declared scale ${plan.scaleLabel} on the length axis. Print at Actual size / 100%, never "fit to page".`);
  else if (plan.scale < 1) lines.push(`Scale ${plan.scaleLabel}: NOT full size.`);
  else lines.push(`${plan.scaleLabel}. No full-size claim.`);
  lines.push(calibrationLine(plan.calibration));
  return lines;
}
export function calibrationLine(cal: { measuredMm: number | null; factor: number }): string {
  return cal.measuredMm === null ? 'Uncalibrated: the ruler must measure 100.0 mm; if not, measure it and enter it.' : `Calibrated: measured ${n(cal.measuredMm)} mm, correction x${n(Math.round(cal.factor * 10000) / 10000)}. The ruler must measure 100.0 mm.`;
}

/** Greedy wrap at a character budget; never drops words. */
export function wrapText(text: string, maxChars: number): string[] {
  const out: string[] = []; let line = '';
  for (const word of text.split(/\s+/).filter(Boolean)) {
    if (line && (line + ' ' + word).length > maxChars) { out.push(line); line = word; } else line = line ? `${line} ${word}` : word;
  }
  if (line) out.push(line);
  return out;
}
const FOOTER_FONT_MM = 2.3;

/** Ruler and statement in the page footer. Paper coordinates in mm. */
export function footerSvg(plan: { calibration: { measuredMm: number | null; factor: number }; pageWidthMm: number; pageHeightMm: number; settings: { marginMm: number } }, statement: string[], extra: string[]): string {
  const m = plan.settings.marginMm, top = plan.pageHeightMm - m - FOOTER_MM, y = top + 4, c = plan.calibration.factor;
  const len = RULER_MM * c;
  let ticks = '';
  for (let i = 0; i <= 10; i += 1) ticks += `<path d="M${n(m + i * 10 * c)} ${n(y)}v${i % 5 === 0 ? 3 : 1.8}" />`;
  const chars = Math.max(20, Math.floor((plan.pageWidthMm - 2 * m) / (FOOTER_FONT_MM * 0.62)));
  const lines = [...statement, ...extra].flatMap(t => wrapText(t, chars));
  return `<g data-footer="true" stroke="#000" stroke-width="0.25" fill="none"><path d="M${n(m)} ${n(y)}h${n(len)}" />${ticks}</g>`
    + `<g font-family="monospace" font-size="${FOOTER_FONT_MM}" fill="#000"><text x="${n(m)}" y="${n(y + 6)}">0</text><text x="${n(m + 50 * c)}" y="${n(y + 6)}" text-anchor="middle">50</text><text x="${n(m + len)}" y="${n(y + 6)}" text-anchor="middle">100 mm ruler</text>`
    + lines.map((t, i) => `<text x="${n(m)}" y="${n(y + 10 + i * 2.6)}">${esc(t)}</text>`).join('') + '</g>';
}

const cross = (x: number, y: number): string => `<path d="M${n(x - 2)} ${n(y)}h4M${n(x)} ${n(y - 2)}v4" />`;

/** One page of a plan as an svg sized exactly in millimetres. */
export function renderPrintPageSvg(plan: PrintPlan, page: PrintPage): string {
  if (!plan.ok || !plan.body) throw new Error('A plan with errors has no pages.');
  const { settings: s, body } = plan;
  const m = s.marginMm, k = plan.scale * plan.calibration.factor;
  const clipId = `pr-clip-${page.row}-${page.col}`;
  const x0 = m, y0 = m, w = plan.windowWidthMm, h = plan.windowHeightMm;
  const tx = m - page.txMm - body.view.x * k, ty = m - page.tyMm - body.view.y * k;
  const marks: string[] = [];
  for (const [x, y] of [[x0, y0], [x0 + w, y0], [x0, y0 + h], [x0 + w, y0 + h]] as const) marks.push(cross(x, y));
  const o = s.overlapMm, hasRight = page.col < plan.cols - 1, hasLeft = page.col > 0, hasDown = page.row < plan.rows - 1, hasUp = page.row > 0;
  const band: string[] = [];
  const bandRect = (x: number, y: number, bw: number, bh: number, label: string, lx: number, ly: number) => band.push(`<rect x="${n(x)}" y="${n(y)}" width="${n(bw)}" height="${n(bh)}" fill="#000" fill-opacity="0.06" stroke="#000" stroke-width="0.2" stroke-dasharray="1.5 1"/><text x="${n(lx)}" y="${n(ly)}" font-size="2.2" text-anchor="middle" font-family="monospace" fill="#000">${esc(label)}</text>`);
  if (hasRight) bandRect(x0 + w - o, y0, o, h, `overlaps page ${page.row + 1},${page.col + 2}`, x0 + w - o / 2, y0 + 4);
  if (hasLeft) bandRect(x0, y0, o, h, `overlaps page ${page.row + 1},${page.col}`, x0 + o / 2, y0 + 4);
  if (hasDown) bandRect(x0, y0 + h - o, w, o, `overlaps page ${page.row + 2},${page.col + 1}`, x0 + w / 2, y0 + h - o / 2);
  if (hasUp) bandRect(x0, y0, w, o, `overlaps page ${page.row},${page.col + 1}`, x0 + w / 2, y0 + o / 2);
  const refs = plan.references.slice().sort((a, b) => b.recordedMm - a.recordedMm)[0];
  const extra = [
    `${plan.title.length > 60 ? `${plan.title.slice(0, 57)}...` : plan.title} · page ${page.index + 1} of ${plan.pages.length} (row ${page.row + 1}, column ${page.col + 1} of ${plan.rows} x ${plan.cols})`,
    refs ? `Reference span ${refs.sectionId}: ${n(refs.recordedMm)} mm recorded, ${n(Math.round(refs.paperMm * 100) / 100)} mm on paper.` : 'No recorded span to check.',
  ];
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${n(plan.pageWidthMm)}mm" height="${n(plan.pageHeightMm)}mm" viewBox="0 0 ${n(plan.pageWidthMm)} ${n(plan.pageHeightMm)}" data-page="${page.index + 1}" data-scale="${plan.scaleLabel}" role="img" aria-label="${esc(plan.title)} print page ${page.index + 1} of ${plan.pages.length}" style="font-family:monospace">`
    + `<defs><clipPath id="${clipId}"><rect x="${n(x0)}" y="${n(y0)}" width="${n(w)}" height="${n(h)}"/></clipPath>${body.defs}</defs>`
    + `<g clip-path="url(#${clipId})" color="#000"><g data-content="true" transform="translate(${n(tx)} ${n(ty)}) scale(${+k.toPrecision(9)})">${body.parts.join('')}</g></g>`
    + band.join('') + `<g stroke="#000" stroke-width="0.25" fill="none" data-registration="true">${marks.join('')}</g>`
    + footerSvg(plan, scaleStatement(plan), extra) + '</svg>';
}

/** Self-contained printable document: one exact-size page per sheet, no external resources. */
export function renderPrintHtml(plan: PrintPlan): string {
  if (!plan.ok) throw new Error('A plan with errors has no document.');
  const css = `@page{size:${n(plan.pageWidthMm)}mm ${n(plan.pageHeightMm)}mm;margin:0}html,body{margin:0;padding:0;background:#fff}.page{width:${n(plan.pageWidthMm)}mm;height:${n(plan.pageHeightMm)}mm;overflow:hidden;break-after:page;page-break-after:always}.page svg{display:block}.page:last-child{break-after:auto;page-break-after:auto}`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${esc(plan.title)} - print ${esc(plan.scaleLabel)}</title><style>${css}</style></head><body data-scale="${esc(plan.scaleLabel)}" data-full-scale="${plan.fullScaleClaim}">${plan.pages.map(p => `<div class="page">${renderPrintPageSvg(plan, p)}</div>`).join('')}</body></html>`;
}
