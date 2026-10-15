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
export type Sheet = { name: string; state: string; unreleased: boolean; identity: string; inputsSha256?: string; tables: Table[]; labels: Label[]; notices: string[]; titleBlock?: Record<string, string | number | null> };
export const record = (value: unknown): RecordValue => value !== null && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : {};
export const records = (value: unknown): RecordValue[] => Array.isArray(value) ? value.map(record) : [];
export const cell = (value: unknown): Cell => value == null || value === "" ? null : typeof value === "number" || typeof value === "string" ? value : null;
export const text = (value: unknown): string => String(cell(value) ?? "unknown");
const path = (value: unknown): string => Array.isArray(value) ? value.map(String).join("/") || "standalone" : "unknown";
const context = (row: RecordValue) => path(record(row.address).path);
const terminal = (value: unknown) => { const t = record(value); return `${text(t.endpoint_id)} · ${text(t.contact_id ?? t.element_path)}`; };
const table = (name: string, headers: string[], rows: Cell[][]): Table => ({ name, headers, rows });
const signals = (value: unknown) => records(value).map(contact => {
  const signal = record(contact.signal);
  return `${text(contact.label)}: ${text(signal.name)}${contact.status === "declared" ? "" : " (path unknown)"}`;
}).join("; ") || "unknown";
const words = (value: unknown) => text(value).replaceAll("_", " ");
const notes = (value: unknown): Cell => Array.isArray(value) ? value.map(text).join("; ") || "none declared" : cell(value);
const member = (value: unknown): string => {
  const item = record(value);
  return item.segment_id ? `${text(item.segment_id)}/${text(item.end)} · ${text(item.element_path)}` : `${text(item.endpoint_id)}/${text(item.layer_id)}/${text(item.terminal_id ?? item.contact_id)}`;
};
function preparationRows(groups: RecordValue[]): Cell[][] {
  const rows: Cell[][] = [];
  for (const group of groups) {
    const projection = record(group.projection), ends = records(projection.ends);
    const prefix = [context(group), cell(group.section_id), cell(group.profile_revision_id)];
    if (!ends.length) rows.push([...prefix, null, null, null, null, null, null, null, null, null, null, cell(group.status ?? projection.status), cell(group.message ?? projection.message) ?? notes(projection.unresolved), null, null]);
    for (const end of ends) {
      const endpoint = record(end.endpoint), physical = record(end.physical_end);
      const where = text(physical.local_id ?? endpoint.local_id);
      for (const row of [...records(end.instructions), ...records(end.missing_instructions).map(instruction => ({ instruction, status: "unknown", unresolved: ["No instruction declared"] }))]) {
        const instruction = record(row.instruction), length = record(instruction.length), source = record(instruction.source), target = record(instruction.target);
        const citation = source.kind === "citation" ? cell(source.citation) : source.kind === "source_file" ? `${text(source.bundle_revision_id)}/${text(source.path)} · ${text(source.locator)} · SHA-256 ${text(source.sha256)} · rights ${text(source.rights)}` : null;
        rows.push([...prefix, cell(end.profile_end), where, cell(instruction.local_id), cell(instruction.element_path), words(instruction.kind), words(instruction.treatment),
          cell(length.nominal_mm), cell(length.minus_mm), cell(length.plus_mm), words(length.datum), words(row.status), notes(row.unresolved),
          [cell(instruction.basis), citation].filter(Boolean).join(" · ") || null,
          target.element_path ? text(target.element_path) : target.contact_id ? `${text(target.body_revision_id)}/${text(target.contact_id)}` : null]);
      }
    }
  }
  return rows;
}

/** Maps exact backend rows without inventing test pairs, cuts, practices or BOM demands. */
export function frozenSheet(name: string, revision: string, sections: DocumentSections): Sheet {
  const landingRows: Cell[][] = [], labelRows: Label[] = [], pairs: Cell[][] = [];
  for (const group of sections.terminations) {
    for (const row of records(group.rows)) landingRows.push([
      landingRows.length + 1, context(group), cell(row.endpoint_label), cell(row.endpoint_id), cell(row.stock_end),
      cell(row.element_label ?? row.element_path), cell(row.element_path), cell(row.layer_id),
      `${text(row.target_label)} · ${text(records(group.assignments).find(a => a.endpoint_id === row.endpoint_id && a.element_path === row.element_path && a.layer_id === row.layer_id)?.terminal_id)}`,
      signals(row.contacts), notes(row.part_notes), cell(row.basis), "declared",
    ]);
    for (const row of records(group.unassigned)) landingRows.push([
      landingRows.length + 1, context(group), cell(row.endpoint_id), cell(row.endpoint_id), null,
      cell(row.element_path), cell(row.element_path), null, "unassigned", null, null, null, "unassigned",
    ]);
    for (const row of records(group.relationships)) landingRows.push([
      landingRows.length + 1, context(group), null, null, null, cell(row.id), cell(row.id), null,
      `Declared ${words(row.kind)}: ${records(row.members).map(member).join("; ") || "members unknown"}`, null, null, cell(row.basis), "declared relationship",
    ]);
  }
  for (const group of sections.test_intent) {
    const plan = record(record(group.declarations).test_plan);
    for (const row of records(plan.pairs)) pairs.push([
      context(group), cell(row.local_id), terminal(row.first), terminal(row.second), cell(row.intent),
      cell(row.signal), cell(row.expected_resistance_ohm), "authored expectation · physical test not performed",
    ]);
    records(plan.labels).forEach((row, index) => labelRows.push({
      id: `${context(group)}/${text(row.local_id ?? index + 1)}`, context: context(group),
      at: row.terminal ? terminal(row.terminal) : row.endpoint_id ? `end ${text(row.endpoint_id)}` : "whole cable",
      text: text(row.text),
    }));
  }
  const bom = record(sections.procurement);
  const tables = [
    table("Landings", ["No.", "Context", "End", "End ID", "Stock end", "Conductor", "Element path", "Layer ID", "Target", "Signal", "Parts", "Basis", "Status"], landingRows),
    table("Cuts", ["Context", "Section", "Row kind", "Conductor", "Declared mm", "Suggested mm", "Design pieces", "Workshop pieces", "Design total mm", "Workshop total mm", "Basis"], sections.cut_preparation.map(row => [context(row), cell(row.section_id), cell(row.row_kind), cell(row.element_path), cell(row.length_mm), cell(row.cut_mm), cell(row.design_piece_count), cell(row.workshop_piece_count), cell(row.design_total_mm), cell(row.workshop_total_mm), cell(row.cut_basis ?? row.basis)])),
    table("End preparation", ["Context", "Section", "Exact profile", "Profile end", "Physical end ID", "Instruction ID", "Feature", "Instruction", "Treatment", "Nominal mm", "Minus mm", "Plus mm", "Datum", "Status", "Unresolved", "Basis and source", "Expected bond target"], preparationRows(sections.end_preparation)),
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

/** Every downloaded row retains exact viewed provenance, including the working-state marker. */
export function exportTables(sheet: Sheet): Table[] {
  return sheet.tables.map(table => ({ ...table,
    headers: ["Design", "Viewed identity", "State", "Reviewed inputs SHA-256", ...table.headers],
    rows: table.rows.map(row => [sheet.name, sheet.identity, sheet.state, sheet.inputsSha256 ?? null, ...row]),
  }));
}

/** Authored text only, on an explicit 80 × 12 mm tape; no generated offsets or inferred labels. */
export function labelsSvg(labels: readonly Label[], sheet?: Sheet): string {
  if (labels.length > 1000) throw new Error("Label export exceeds 1000 authored labels.");
  const height = Math.max(12, labels.length * 14);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="80mm" height="${height}mm" viewBox="0 0 80 ${height}">${sheet ? `<metadata>${escapeXml(JSON.stringify({ design: sheet.name, identity: sheet.identity, state: sheet.state, inputs_sha256: sheet.inputsSha256 ?? null }))}</metadata>` : ""}<rect width="80" height="${height}" fill="white"/>${labels.map((label, index) => `<g data-label="${escapeXml(label.id)}"><rect x="0.2" y="${index * 14 + .2}" width="79.6" height="11.6" fill="none" stroke="#777" stroke-width=".2"/><text x="2" y="${index * 14 + 7}" fill="#111" font-family="sans-serif" font-size="3" textLength="76" lengthAdjust="spacingAndGlyphs">${escapeXml(label.text)}</text><title>${escapeXml(`${label.context} · ${label.at}`)}</title></g>`).join("")}</svg>`;
}

/** Standalone print file: escaped authored text, white paper, no scripts or external resources. */
export function sheetHtml(sheet: Sheet, selected: readonly Table[] = sheet.tables, image = ""): string {
  const shown = (value: Cell) => escapeXml(String(value ?? "unknown"));
  const captions: Record<string, string> = { organization: "Organization", designer: "Designer", rights_line: "Printed rights / confidentiality line", paper: "Paper", title_block: "Title block", label_qr_url: "Label QR address", source_settings_version: "Declared settings version" };
  const title = sheet.titleBlock ? `<section><h2>Document title block</h2>${Object.entries(sheet.titleBlock).map(([key, value]) => `<p>${escapeXml(captions[key] ?? key)}: ${shown(value)}</p>`).join("")}<p>Printed text does not grant distribution rights.</p></section>` : "";
  const printed = selected.map(t => t.name === "End preparation" && t.headers.length === 17 ? table(t.name,
    ["Context / end", "Feature / instruction", "Treatment / dimensions", "Review / unresolved", "Basis / source"],
    t.rows.map(r => [
      `${text(r[0])} · physical end ${text(r[4])} · profile end ${text(r[3])} · section ${text(r[1])} · profile ${text(r[2])}`,
      `${text(r[6])} · ${text(r[7])} · ${text(r[5])}`,
      `${text(r[8])} · ${text(r[9])} mm (−${text(r[10])}/+${text(r[11])} mm) · datum ${text(r[12])} · expected bond target ${text(r[16])}`,
      `${text(r[13])} · unresolved: ${text(r[14])}`, cell(r[15]),
    ])) : t.name === "Landings" && t.headers.length === 13 ? table(t.name,
      ["No.", "Context / end", "Conductor", "Lands on", "Pin and signal", "Parts", "Basis", "Status"],
      t.rows.map(r => [cell(r[0]), `${text(r[1])} · ${text(r[2])} (${text(r[3])}) · stock end ${text(r[4])}`, `${text(r[5])} · ${text(r[6])}`, `${text(r[7])} · ${text(r[8])}`, cell(r[9]), cell(r[10]), cell(r[11]), cell(r[12])])) : t);
  return `<!doctype html><html><head><meta charset="utf-8"><title>${escapeXml(sheet.name)}</title><style>html{color-scheme:light;background:#fff;color:#111}body{font:12px sans-serif;margin:12mm}table{border-collapse:collapse;width:100%;margin-bottom:1em;table-layout:fixed}th,td{border:1px solid #aaa;padding:4px;text-align:left;overflow-wrap:anywhere}h1{font-size:20px}.unreleased{position:fixed;top:40%;left:5%;transform:rotate(-30deg);font-size:70px;opacity:.16;pointer-events:none}thead{display:table-header-group}svg{width:100%;height:auto}@page{size:A4;margin:12mm}</style></head><body>${sheet.unreleased ? '<div class="unreleased">UNRELEASED</div>' : ""}<h1>${escapeXml(sheet.name)}</h1><p>${escapeXml(sheet.state)} · ${escapeXml(sheet.identity)}</p>${title}${image}${printed.map(t => `<h2>${escapeXml(t.name)}</h2>${t.rows.length ? `<table><thead><tr>${t.headers.map(h => `<th>${escapeXml(h)}</th>`).join("")}</tr></thead><tbody>${t.rows.map(row => `<tr>${row.map(v => `<td>${shown(v)}</td>`).join("")}</tr>`).join("")}</tbody></table>` : '<p>Unknown · no authored rows.</p>'}`).join("")}${sheet.notices.map(n => `<p>${escapeXml(n)}</p>`).join("")}</body></html>`;
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
