import { expect, test } from "vitest";
import { drawingSvg, frozenSheet, labelsSvg, sheetHtml, type DocumentSections } from "../../../../packages/docs/src/model";
import { labelLbx, labelsLbx } from "../../../../packages/docs/src/lbx";
import { workingSheet } from "./working-sheet";
import { cable, boardEnd, inlineEnd, stock } from "../cable-workbench/fixtures";

const at = { path: ["repeat-2", "cable"], revision_id: "exact-r1" };
export const sections = (): DocumentSections => ({
  revision_specifications: [], specifications: [], schematic: [],
  cut_preparation: [{ address: at, row_kind: "declared_physical_piece", section_id: null, length_mm: null, design_piece_count: 2, workshop_piece_count: null, design_total_mm: null, workshop_total_mm: null, basis: "Unassessed workshop boundary" }],
  end_preparation: [{ address: at, status: "unknown", message: "No practice bound" }],
  terminations: [{ address: at, assignments: [{ endpoint_id: "A", element_path: "stock.中心", layer_id: "plug", terminal_id: "端子/β:07 🎛" }], rows: [{ endpoint_id: "A", endpoint_label: "Supply", stock_end: "unknown", element_path: "stock.中心", element_label: "Core <&>", layer_id: "plug", target_label: "Pin 7", contacts: [{ label: "7", signal: { name: "Signal α" }, status: "declared" }], basis: "Authored landing" }], unassigned: [{ endpoint_id: "B", element_path: "stock.中心" }] }],
  test_intent: [{ address: at, declarations: { test_plan: { pairs: [{ local_id: "pair-1", first: { endpoint_id: "A", contact_id: "端子/β:07 🎛" }, second: { endpoint_id: "B", element_path: "stock.中心" }, intent: "continuity", expected_resistance_ohm: 0 }], labels: [{ text: '=SUM(1,2) <script>alert("x")</script> 🎛', endpoint_id: "A" }] } } }],
  procurement: null, issues: [{ path: at.path, message: "Quantity remains unknown" }],
});

test("frozen mapper preserves independent declared rows, exact terminal IDs, zero and unknowns without inventing tests or quantities", () => {
  const input = sections(), sheet = frozenSheet("Synthetic cable", "r1 · exact-r1", input);
  expect(sheet.tables[0]?.rows).toHaveLength(2);
  expect(sheet.tables[0]?.rows[0]).toContain("Pin 7 · 端子/β:07 🎛");
  expect(sheet.tables[0]?.rows[1]).toContain("unassigned");
  expect(sheet.tables[1]?.rows[0]).toEqual(["repeat-2/cable", null, "declared_physical_piece", null, null, null, 2, null, null, null, "Unassessed workshop boundary"]);
  expect(sheet.tables[3]?.rows[0]?.[6]).toBe(0);
  expect(sheet.tables[4]?.rows).toHaveLength(0);
  input.test_intent = [{ address: at, status: "unknown" }];
  expect(frozenSheet("Synthetic", "r1", input).tables[3]?.rows).toEqual([]);
  expect(sheet.unreleased).toBe(false);
});

test("print and label outputs escape authored content, preserve Unicode, contain white paper and do not execute scripts", () => {
  const sheet = frozenSheet("Cable <&>", "r1", sections());
  sheet.titleBlock = { organization: "Studio <A>", source_settings_version: 4 };
  for (const output of [sheetHtml(sheet), labelsSvg(sheet.labels), drawingSvg(sheet)]) {
    const parsed = new DOMParser().parseFromString(output, output.startsWith("<svg") ? "image/svg+xml" : "text/html");
    expect(parsed.querySelector("parsererror,script,iframe,object")).toBeNull();
    expect(output).not.toContain('<script>alert("x")</script>');
    expect(output).toContain("#111");
  }
  expect(sheetHtml(sheet)).toContain("color-scheme:light;background:#fff;color:#111");
  expect(sheetHtml(sheet)).toContain("端子/β:07 🎛");
  expect(labelsSvg(sheet.labels)).toContain("&lt;script&gt;");
  expect(sheetHtml(sheet)).toContain("Studio &lt;A&gt;");
  const bytes = labelLbx(sheet.labels[0]!);
  const payload = new TextDecoder().decode(bytes);
  expect(payload).toContain("label.xml"); expect(payload).toContain("prop.xml");
  expect(payload).toContain("&lt;script&gt;"); expect(payload).toContain("🎛");
  expect(labelLbx(sheet.labels[0]!)).toEqual(bytes);
  expect(labelsLbx(sheet.labels).length).toBeGreaterThan(bytes.length);
});

test("working sheet follows unsaved landings and retains UNRELEASED without adopting frozen checks, authored test pairs or manufacturing practices", () => {
  const input = { cable: cable(), stock: stock(), stacks: [boardEnd(), inlineEnd()] };
  const before = workingSheet("Synthetic", "definition", input, true);
  const moved = structuredClone(input); moved.cable.assignments[0]!.terminal_id = "missing/端子";
  const after = workingSheet("Synthetic", "definition", moved, true);
  expect(after.tables[0]?.rows).not.toEqual(before.tables[0]?.rows);
  expect(after.tables[0]?.rows.some(row => row.includes("unresolved"))).toBe(true);
  expect(after.tables[3]?.rows).toEqual([]); expect(after.tables[4]?.rows).toEqual([]);
  expect(after.tables[1]?.rows[0]?.slice(5, 10)).toEqual([null, null, null, null, null]);
  expect(sheetHtml(after)).toContain('class="unreleased">UNRELEASED');
  expect(drawingSvg(after)).toContain("UNRELEASED");
});
