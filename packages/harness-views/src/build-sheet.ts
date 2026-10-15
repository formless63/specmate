// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Bench build sheet derived from a frozen harness: one stage per page (kit and cut, each end,
 * assembly, test). Stage structure and the rules that the sheet is deterministic, self-contained
 * (no external resources, no clock) and prints cleanly follow cab-stu's build sheet (MIT, formless63).
 * Its workshop standard work, part numbering and artwork are not carried over: stages with no
 * recorded data say so instead of printing a default procedure.
 */
import { appearanceOf } from '../../section-layout/src';
import type { Appearance } from '../../section-layout/src';
import { sumDecimals } from './model';
import { endpointPins } from './model';
import type { End, EndInfoMap, HarnessTerminal, HarnessView, StockMap } from './model';

/** `labels` maps exact revision IDs to display names such as `Power harness r4`; unlabelled IDs print as given. */
/** `ends` carries each endpoint's resolved stack (terminal labels, typed signals, parts); without it, terminals print by ID and signals as unknown. */
export interface BuildSheetInput { title: string; revisionId: string; harness: HarnessView; stocks: StockMap; quantity: number; labels?: Record<string, string>; ends?: EndInfoMap }
export interface CutRow {
  sectionId: string; stockRevisionId: string; stockName: string; lengthMm: string | null; basis: string | null;
  segments: string[]; look: Appearance; totalMm: string | null;
}
export interface Landing {
  number: number; layerId: string; terminalId: string; target: string; signal: string; parts: string;
  elementPath: string; elementLabel: string; elementLook: Appearance | null;
  segment: string; segmentEnd: End; jointId: string; basis: string;
}
export interface EndPage { endpointId: string; label: string; stackName: string | null; pins: string[]; landings: Landing[]; physicalEnds: string[] }
export interface JointRow { jointId: string; kind: string; members: string; basis: string }
export interface BreakoutRow { breakoutId: string; trunk: string; legs: string; fates: number }
export interface BuildSheetModel {
  title: string; revisionId: string; quantity: number; review: string; labels: Record<string, string>;
  cuts: CutRow[]; totalCutMm: string | null; totalCutAllMm: string | null; pieceCount: number;
  ends: EndPage[]; otherJoints: JointRow[]; breakouts: BreakoutRow[];
  assembly: { recorded: false; note: string }; test: { recorded: false; note: string };
  notes: string[];
}

const natural = (a: string, b: string): number => a.localeCompare(b, 'en', { numeric: true });
const terminalText = (t: HarnessTerminal): string => t.kind === 'segment' ? `${t.segment_id} / ${t.end.toUpperCase()} / ${t.element_path}` : `${t.endpoint_id} / ${t.layer_id} / ${t.terminal_id}`;
const LAYER_ORDER = ['board', 'inline', 'connector', 'shell'];

export function buildSheetModel(input: BuildSheetInput): BuildSheetModel {
  const { harness, stocks } = input;
  const quantity = Number.isInteger(input.quantity) && input.quantity >= 1 ? input.quantity : 1;
  const segments = new Map(harness.segments.map(s => [s.local_id, s]));
  const sections = new Map(harness.sections.map(s => [s.local_id, s]));
  const jacketLook = (revisionId: string): Appearance => {
    const outer = stocks[revisionId]?.section.features.filter(f => f.shape.type === 'ring')
      .sort((a, b) => (b.shape.type === 'ring' ? b.shape.rOuter : 0) - (a.shape.type === 'ring' ? a.shape.rOuter : 0))[0];
    return outer ? appearanceOf(outer) : appearanceOf({ kind: 'jacket', color: null, material: null });
  };
  const cuts: CutRow[] = harness.sections.map(s => ({
    sectionId: s.local_id, stockRevisionId: s.stock_revision_id, stockName: stocks[s.stock_revision_id]?.name ?? s.stock_revision_id,
    lengthMm: s.planned_cut_length_mm, basis: s.cut_basis, segments: harness.segments.filter(g => g.section_id === s.local_id).map(g => g.local_id),
    look: jacketLook(s.stock_revision_id), totalMm: sumDecimals([s.planned_cut_length_mm], quantity),
  }));
  const lengths = harness.sections.map(s => s.planned_cut_length_mm);
  const notes: string[] = [];
  if (cuts.some(c => c.lengthMm === null)) notes.push('At least one section has no planned cut length, so totals are unknown.');
  for (const s of harness.sections) if (!stocks[s.stock_revision_id]) notes.push(`Stock ${s.stock_revision_id} could not be read; its element names and colours are unknown.`);

  const lookFor = (segmentId: string, path: string): { label: string; look: Appearance | null } => {
    const seg = segments.get(segmentId);
    const stock = seg ? stocks[sections.get(seg.section_id)?.stock_revision_id ?? ''] : undefined;
    const row = stock?.section.rows.find(r => r.path === path);
    const feature = stock?.section.features.find(f => f.path === path);
    return { label: row?.label ?? 'Not found in the exact stock', look: feature ? appearanceOf(feature) : row ? appearanceOf({ kind: row.kind, color: row.color, material: row.material, construction: row.construction ?? null }) : null };
  };
  const ends: EndPage[] = harness.endpoints.map(ep => {
    const info = input.ends?.[ep.local_id];
    const landings: Omit<Landing, 'number'>[] = [];
    for (const joint of harness.joints) {
      if (joint.kind !== 'termination') continue;
      const mine = joint.members.filter((m): m is Extract<HarnessTerminal, { kind: 'endpoint' }> => m.kind === 'endpoint' && m.endpoint_id === ep.local_id);
      const wires = joint.members.filter((m): m is Extract<HarnessTerminal, { kind: 'segment' }> => m.kind === 'segment');
      for (const m of mine) for (const w of wires) {
        const found = lookFor(w.segment_id, w.element_path);
        const t = info?.terminals[`${m.layer_id}/${m.terminal_id}`];
        const signal = !t ? 'Signal unknown (end stack not resolved)'
          : t.signals.length === 0 ? 'Signal unknown (reaches no connector contact)'
          : t.signals.map(x => `${x.label}: ${x.name ? `${x.name} (${(x.type ?? 'unknown').replace(/_/g, ' ')})` : 'signal unknown'}${x.status === 'unknown' ? ', path unknown' : ''}`).join('; ');
        landings.push({ layerId: m.layer_id, terminalId: m.terminal_id, target: t ? `${t.layerKind} ${t.label}` : `${m.layer_id} ${m.terminal_id}`, signal, parts: t ? t.parts.join('; ') || 'None declared' : 'Unknown', elementPath: w.element_path, elementLabel: found.label, elementLook: found.look, segment: w.segment_id, segmentEnd: w.end, jointId: joint.local_id, basis: joint.basis });
      }
    }
    const layerRank = (id: string): number => { const kind = ep.stack?.layers.find(l => l.layer_id === id)?.kind; return kind ? LAYER_ORDER.indexOf(kind) : -1; };
    landings.sort((a, b) => layerRank(a.layerId) - layerRank(b.layerId) || natural(a.layerId, b.layerId) || natural(a.terminalId, b.terminalId) || natural(a.elementPath, b.elementPath));
    const physicalEnds = harness.sections.flatMap(s => (s.physical_ends ?? []).filter(p => p.endpoint_id === ep.local_id)
      .map(p => `${p.label ?? p.local_id} (section ${s.local_id}${p.review === 'reviewed' ? ', reviewed' : ', unreviewed'})`));
    return { endpointId: ep.local_id, label: ep.label ?? ep.local_id, stackName: info?.name ?? null, pins: endpointPins(ep),
      landings: landings.map((l, i) => ({ ...l, number: i + 1 })), physicalEnds };
  });
  const otherJoints: JointRow[] = harness.joints.filter(j => j.kind !== 'termination').map(j => ({ jointId: j.local_id, kind: j.kind, members: j.members.map(terminalText).join(' ↔ '), basis: j.basis }));
  const breakouts: BreakoutRow[] = harness.breakouts.map(b => ({ breakoutId: b.local_id, trunk: `${b.trunk.segment_id} / ${b.trunk.end.toUpperCase()}`, legs: b.legs.map(l => `${l.segment_id} / ${l.end.toUpperCase()}`).join(', '), fates: b.fates.length }));
  return {
    title: input.title, revisionId: input.revisionId, quantity, labels: input.labels ?? {}, review: harness.review ? `${harness.review}${harness.review_basis ? `: ${harness.review_basis}` : ''}` : 'unknown',
    cuts, totalCutMm: sumDecimals(lengths, 1), totalCutAllMm: sumDecimals(lengths, quantity), pieceCount: harness.sections.length * quantity,
    ends, otherJoints, breakouts,
    assembly: { recorded: false, note: 'No assembly steps (shells, hardware, strain relief) are recorded in this harness revision. Follow the workshop procedure; none is assumed here.' },
    test: { recorded: false, note: 'No test intent is attached to this view. Continuity and isolation expectations come from a reviewed cable test plan, which is separate from the harness record.' },
    notes,
  };
}

/* ------------------------------------------------------------------ standalone HTML */
const esc = (t: string): string => t.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const swatch = (look: Appearance | null): string => look === null ? '' : look.fillSource === 'unknown'
  ? `<span class="cs-sw cs-sw-unknown" title="colour unknown"></span>` : `<span class="cs-sw" style="background:${look.base}" title="${esc(look.colorLabel)}"></span>`;
const CSS = `@layer cs{.cs-root{font:13px/1.4 system-ui,sans-serif;color:#14181d;background:#fff}.cs-root h1{font-size:20px;margin:0 0 4px}.cs-root h2{font-size:16px;margin:0 0 8px;border-bottom:1px solid #98a2ac}.cs-page{padding:16px;page-break-after:always;break-after:page}.cs-page:last-child{page-break-after:auto;break-after:auto}.cs-root table{border-collapse:collapse;width:100%;margin:8px 0}.cs-root th,.cs-root td{border:1px solid #98a2ac;padding:3px 6px;text-align:left;vertical-align:top}.cs-root th{background:#f3f5f7}.cs-sw{display:inline-block;width:12px;height:12px;border:1px solid #14181d;border-radius:50%;vertical-align:middle;margin-right:5px}.cs-sw-unknown{background:repeating-linear-gradient(45deg,#d9dde2 0 3px,#5f6870 3px 4px)}.cs-note{color:#5b6570}.cs-warn{color:#a8410f}.cs-fig svg{max-width:100%;height:auto}@page{size:A4 landscape;margin:12mm}}`;

export function renderBuildSheetHtml(model: BuildSheetModel, options: { formboardSvg?: string } = {}): string {
  const cell = (t: string): string => `<td>${esc(t)}</td>`;
  const head = (...cols: string[]): string => `<thead><tr>${cols.map(c => `<th>${esc(c)}</th>`).join('')}</tr></thead>`;
  const lab = (id: string): string => model.labels[id] ?? id;
  const header = (stage: string): string => `<header><h1>${esc(model.title)}</h1><p class="cs-note">Revision ${esc(lab(model.revisionId))} · quantity ${model.quantity} · review ${esc(model.review)}</p><h2>${esc(stage)}</h2></header>`;
  const pages: string[] = [];
  pages.push(`<section class="cs-page" data-stage="kit">${header('1. Kit and cut')}`
    + (options.formboardSvg ? `<div class="cs-fig">${options.formboardSvg}</div>` : '')
    + `<table>${head('Section', 'Stock', 'Planned cut (mm)', 'Cut basis', 'Spans', `Total for ${model.quantity} (mm)`)}<tbody>`
    + model.cuts.map(c => `<tr>${cell(c.sectionId)}<td>${swatch(c.look)}${esc(c.stockName)}</td>${cell(c.lengthMm ?? 'Unknown')}${cell(c.basis ?? 'Unknown')}${cell(c.segments.join(', ') || 'None')}${cell(c.totalMm ?? 'Unknown')}</tr>`).join('')
    + `</tbody></table><p>Planned stock pieces: ${model.pieceCount}. Planned cut total: ${esc(model.totalCutMm ?? 'Unknown')} mm per harness, ${esc(model.totalCutAllMm ?? 'Unknown')} mm for ${model.quantity}.</p>`
    + model.notes.map(n => `<p class="cs-warn">${esc(n)}</p>`).join('') + '</section>');
  for (const [i, end] of model.ends.entries()) {
    pages.push(`<section class="cs-page" data-stage="end" data-endpoint="${esc(end.endpointId)}">${header(`${i + 2}. End: ${end.label}`)}`
      + `<p class="cs-note">${end.stackName ? `${esc(end.stackName)} · ` : ''}${end.pins.map(id => esc(lab(id))).join(' · ') || 'No pinned parts'}${end.physicalEnds.length ? ` · ${esc(end.physicalEnds.join('; '))}` : ' · no physical end declared'}</p>`
      + (end.landings.length === 0 ? '<p>No terminations are declared for this endpoint.</p>'
        : `<table>${head('#', 'Lands on', 'Pin and signal', 'Parts', 'Conductor', 'Span / end', 'Joint', 'Basis')}<tbody>${end.landings.map(l =>
          `<tr>${cell(String(l.number))}${cell(l.target)}${cell(l.signal)}${cell(l.parts)}<td>${swatch(l.elementLook)}${esc(l.elementPath)} <span class="cs-note">${esc(l.elementLabel)}</span></td>${cell(`${l.segment} / ${l.segmentEnd.toUpperCase()}`)}${cell(l.jointId)}${cell(l.basis)}</tr>`).join('')}</tbody></table>`)
      + '<p class="cs-note">Rows are ordered from the wire outward, then by terminal. It is not a recorded soldering or crimping order. Signals are declared pin meanings, not measured continuity.</p></section>');
  }
  const base = model.ends.length + 2;
  pages.push(`<section class="cs-page" data-stage="assembly">${header(`${base}. Assembly`)}<p>${esc(model.assembly.note)}</p>`
    + (model.otherJoints.length ? `<table>${head('Joint', 'Kind', 'Members', 'Basis')}<tbody>${model.otherJoints.map(j => `<tr>${cell(j.jointId)}${cell(j.kind)}${cell(j.members)}${cell(j.basis)}</tr>`).join('')}</tbody></table>` : '')
    + (model.breakouts.length ? `<table>${head('Breakout', 'Trunk', 'Legs', 'Fates recorded')}<tbody>${model.breakouts.map(b => `<tr>${cell(b.breakoutId)}${cell(b.trunk)}${cell(b.legs)}${cell(String(b.fates))}</tr>`).join('')}</tbody></table>` : '') + '</section>');
  pages.push(`<section class="cs-page" data-stage="test">${header(`${base + 1}. Test`)}<p>${esc(model.test.note)}</p><p class="cs-note">A sheet printed from this view is not a qualification record.</p></section>`);
  const pinned = [...new Set([model.revisionId, ...model.ends.flatMap(e => e.pins), ...model.cuts.map(c => c.stockRevisionId)])].filter(id => model.labels[id]);
  if (pinned.length) pages.push(`<section class="cs-page" data-stage="pins">${header(`${base + 2}. Exact pins`)}<p class="cs-note">Names above identify these exact frozen revisions.</p><table>${head('Name', 'Exact revision ID')}<tbody>${pinned.map(id => `<tr>${cell(model.labels[id]!)}${cell(id)}</tr>`).join('')}</tbody></table></section>`);
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(model.title)} build sheet</title><style>${CSS}</style></head><body><div class="cs-root">${pages.join('')}</div></body></html>`;
}
