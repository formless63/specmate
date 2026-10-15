// SPDX-License-Identifier: AGPL-3.0-only
/** Presentation over authorized document sections. No connectivity or quantity solver. */
import type { Cell, Table } from "./table";

export type RecordValue = Record<string, unknown>;
export type DocumentSections = {
  revision_specifications: RecordValue[]; specifications: RecordValue[];
  schematic: RecordValue[]; cut_preparation: RecordValue[]; end_preparation: RecordValue[];
  terminations: RecordValue[]; test_intent: RecordValue[]; procurement: unknown; issues: RecordValue[];
};
export type Label = { id: string; context: string; at: string; text: string };
export type Sheet = { name: string; state: string; unreleased: boolean; identity: string; tables: Table[]; labels: Label[]; notices: string[]; titleBlock?: Record<string, string | number | null> };
export const record = (value: unknown): RecordValue => value !== null && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : {};
export const records = (value: unknown): RecordValue[] => Array.isArray(value) ? value.map(record) : [];
export const cell = (value: unknown): Cell => value == null || value === "" ? null : typeof value === "number" ? value : typeof value === "string" ? value : JSON.stringify(value);
export const text = (value: unknown): string => String(cell(value) ?? "unknown");
const path = (value: unknown): string => Array.isArray(value) ? value.map(String).join("/") || "standalone" : "unknown";
const context = (row: RecordValue) => path(record(row.address).path);
const terminal = (value: unknown) => { const t = record(value); return `${text(t.endpoint_id)} · ${text(t.contact_id ?? t.element_path)}`; };
const table = (name: string, headers: string[], rows: Cell[][]): Table => ({ name, headers, rows });
const signals = (value: unknown) => records(value).map(contact => {
  const signal = record(contact.signal);
  return `${text(contact.label)}: ${text(signal.name)}${contact.status === "declared" ? "" : " (path unknown)"}`;
}).join("; ") || "unknown";

/** Maps exact backend rows without inventing test pairs, cuts, practices or BOM demands. */
export function frozenSheet(name: string, revision: string, sections: DocumentSections): Sheet {
  const landingRows: Cell[][] = [], labelRows: Label[] = [], pairs: Cell[][] = [];
  for (const group of sections.terminations) {
    for (const row of records(group.rows)) landingRows.push([
      landingRows.length + 1, context(group), cell(row.endpoint_label), cell(row.endpoint_id), cell(row.stock_end),
      cell(row.element_label ?? row.element_path), cell(row.element_path), cell(row.layer_id),
      `${text(row.target_label)} · ${text(records(group.assignments).find(a => a.endpoint_id === row.endpoint_id && a.element_path === row.element_path && a.layer_id === row.layer_id)?.terminal_id)}`,
      signals(row.contacts), cell(row.part_notes), cell(row.basis), "declared",
    ]);
    for (const row of records(group.unassigned)) landingRows.push([
      landingRows.length + 1, context(group), cell(row.endpoint_id), cell(row.endpoint_id), null,
      cell(row.element_path), cell(row.element_path), null, "unassigned", null, null, null, "unassigned",
    ]);
    for (const row of records(group.relationships)) landingRows.push([
      landingRows.length + 1, context(group), null, null, null, null, null, null, cell(row), null, null, null, "declared relationship",
    ]);
  }
  for (const group of sections.test_intent) {
    const plan = record(record(group.declarations).test_plan);
    for (const row of records(plan.pairs)) pairs.push([
      context(group), cell(row.local_id), terminal(row.first), terminal(row.second), cell(row.intent),
      cell(row.signal), cell(row.expected_resistance_ohm), "authored expectation · physical test not performed",
    ]);
    records(plan.labels).forEach((row, index) => labelRows.push({
      id: `${context(group)}/${index + 1}`, context: context(group),
      at: row.terminal ? terminal(row.terminal) : row.endpoint_id ? `end ${text(row.endpoint_id)}` : "whole cable",
      text: text(row.text),
    }));
  }
  const bom = record(sections.procurement);
  const tables = [
    table("Landings", ["No.", "Context", "End", "End ID", "Stock end", "Conductor", "Element path", "Layer ID", "Target", "Signal", "Parts", "Basis", "Status"], landingRows),
    table("Cuts", ["Context", "Section", "Row kind", "Conductor", "Declared mm", "Suggested mm", "Design pieces", "Workshop pieces", "Design total mm", "Workshop total mm", "Basis"], sections.cut_preparation.map(row => [context(row), cell(row.section_id), cell(row.row_kind), cell(row.element_path), cell(row.length_mm), cell(row.cut_mm), cell(row.design_piece_count), cell(row.workshop_piece_count), cell(row.design_total_mm), cell(row.workshop_total_mm), cell(row.cut_basis ?? row.basis)])),
    table("End preparation", ["Context", "Section", "Exact profile", "Status", "Instructions"], sections.end_preparation.map(row => [context(row), cell(row.section_id), cell(row.profile_revision_id), cell(row.status ?? record(row.projection).status), cell(row.projection ?? row.message)])),
    table("Continuity expectations", ["Context", "Pair", "First terminal", "Second terminal", "Expect", "Signal", "Resistance ohm", "Meaning"], pairs),
    table("BOM", ["Context", "Item", "Exact revision", "Quantity", "Unit", "Status", "Basis"], records(bom.rows).map(row => [path(record(row.address).path), cell(row.name), cell(row.revision_id), cell(record(row.required_quantity ?? row.quantity).amount), cell(record(row.required_quantity ?? row.quantity).unit), cell(record(row.required_quantity ?? row.quantity).status), cell(row.basis ?? row.reason)])),
    table("Labels", ["Label ID", "Context", "At", "Text"], labelRows.map(row => [row.id, row.context, row.at, row.text])),
  ];
  return {
    name, state: `Exact frozen ${revision}`, unreleased: false, identity: revision, tables, labels: labelRows,
    notices: ["Declared topology and authored expectations; physical continuity, fit and physical qualification are not evaluated.",
      ...sections.issues.map(row => `${path(row.path)} · ${text(row.message)}`),
      ...(!pairs.length ? ["No authored test pairs are bound. Continuity expectations remain unknown."] : []),
      ...(!Object.keys(bom).length ? ["No exact BOM plan is bound. Procurement quantities remain unknown."] : [])],
  };
}

export const escapeXml = (value: string): string => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Authored text only, on an explicit 80 × 12 mm tape; no generated offsets or inferred labels. */
export function labelsSvg(labels: readonly Label[]): string {
  if (labels.length > 1000) throw new Error("Label export exceeds 1000 authored labels.");
  const height = Math.max(12, labels.length * 14);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="80mm" height="${height}mm" viewBox="0 0 80 ${height}"><rect width="80" height="${height}" fill="white"/>${labels.map((label, index) => `<g data-label="${escapeXml(label.id)}"><rect x="0.2" y="${index * 14 + .2}" width="79.6" height="11.6" fill="none" stroke="#777" stroke-width=".2"/><text x="2" y="${index * 14 + 7}" fill="#111" font-family="sans-serif" font-size="3" textLength="76" lengthAdjust="spacingAndGlyphs">${escapeXml(label.text)}</text><title>${escapeXml(`${label.context} · ${label.at}`)}</title></g>`).join("")}</svg>`;
}

/** Standalone print file: escaped authored text, white paper, no scripts or external resources. */
export function sheetHtml(sheet: Sheet, selected: readonly Table[] = sheet.tables, image = ""): string {
  const shown = (value: Cell) => escapeXml(String(value ?? "unknown"));
  const title = sheet.titleBlock ? `<section><h2>Reviewed document title block</h2>${Object.entries(sheet.titleBlock).map(([key, value]) => `<p>${escapeXml(key)}: ${shown(value)}</p>`).join("")}<p>Printed text does not grant distribution rights.</p></section>` : "";
  return `<!doctype html><html><head><meta charset="utf-8"><title>${escapeXml(sheet.name)}</title><style>html{color-scheme:light;background:#fff;color:#111}body{font:12px sans-serif;margin:12mm}table{border-collapse:collapse;width:100%;margin-bottom:1em}th,td{border:1px solid #aaa;padding:4px;text-align:left;overflow-wrap:anywhere}h1{font-size:20px}.unreleased{position:fixed;top:40%;left:5%;transform:rotate(-30deg);font-size:70px;opacity:.16;pointer-events:none}thead{display:table-header-group}svg{width:100%;height:auto}@page{size:A4;margin:12mm}</style></head><body>${sheet.unreleased ? '<div class="unreleased">UNRELEASED</div>' : ""}<h1>${escapeXml(sheet.name)}</h1><p>${escapeXml(sheet.state)} · ${escapeXml(sheet.identity)}</p>${title}${image}${selected.map(t => `<h2>${escapeXml(t.name)}</h2>${t.rows.length ? `<table><thead><tr>${t.headers.map(h => `<th>${escapeXml(h)}</th>`).join("")}</tr></thead><tbody>${t.rows.map(row => `<tr>${row.map(v => `<td>${shown(v)}</td>`).join("")}</tr>`).join("")}</tbody></table>` : '<p>Unknown · no authored rows.</p>'}`).join("")}${sheet.notices.map(n => `<p>${escapeXml(n)}</p>`).join("")}</body></html>`;
}

/** Each line represents one authored landing only; adjacent marks do not establish continuity. */
export function drawingSvg(sheet: Sheet): string {
  const rows = sheet.tables.find(t => t.name === "Landings")?.rows ?? [];
  const height = 95 + Math.max(rows.length, 1) * 48;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1000 ${height}" role="img" aria-label="Declared landing drawing"><rect width="1000" height="${height}" fill="white"/><text x="20" y="30" fill="#111" font-family="sans-serif" font-size="18">${escapeXml(sheet.state)} · Declared landings</text><text x="20" y="55" fill="#111" font-family="sans-serif" font-size="14">No inferred continuity, scale or physical clearance.</text>${rows.map((row, index) => {
    const y = 80 + index * 48;
    const left = `${text(row[0])}. ${text(row[6])}`, right = `${text(row[3])} / ${text(row[7])} / ${text(row[8])}`;
    return `<g><title>${escapeXml(`${left} → ${right} · ${text(row[12])}`)}</title><rect x="20" y="${y - 15}" width="350" height="35" fill="#f5f5f5" stroke="#777"/><line x1="370" y1="${y}" x2="600" y2="${y}" stroke="#111" ${row[12] === "unassigned" ? 'stroke-dasharray="5 4"' : ""}/><rect x="600" y="${y - 15}" width="380" height="35" fill="#f5f5f5" stroke="#777"/><text x="28" y="${y + 5}" font-family="sans-serif" font-size="12" fill="#111">${escapeXml(left)}</text><text x="608" y="${y + 5}" font-family="sans-serif" font-size="12" fill="#111">${escapeXml(right)}</text></g>`;
  }).join("")}${!rows.length ? '<text x="20" y="85" fill="#111">No declared landing rows.</text>' : ""}${sheet.unreleased ? `<text x="100" y="${height / 2}" transform="rotate(-25 100 ${height / 2})" fill="#aaa" opacity=".45" font-family="sans-serif" font-size="90">UNRELEASED</text>` : ""}</svg>`;
}
