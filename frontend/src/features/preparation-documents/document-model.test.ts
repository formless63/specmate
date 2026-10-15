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
  const printed = sheetHtml(sheet);
  expect(printed).toContain("Frozen revision · r1 · exact-r1");
  expect(printed.match(/exact-r1/g)).toHaveLength(1);
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

test("real-shaped reviewed end instructions and nonempty BOM print readable treatments, exact nullable dimensions and required quantities", () => {
  const input = sections();
  input.end_preparation = [{ address: at, section_id: null, profile_revision_id: "exact-profile-r2", projection: {
    mapping_review: "reviewed", mapping_basis: "Deliberate a to supply mapping", actual_bonds: "not_evaluated",
    ends: [{ profile_end: "a", endpoint: { local_id: "supply", label: "Supply" }, review: "reviewed", instructions: [
      { instruction: { local_id: "strip-jacket", kind: "layer_strip", element_path: "stock.jacket", treatment: "strip_back", length: { nominal_mm: "12.50", minus_mm: "0", plus_mm: "0.25", datum: "from_stock_cut_end", basis: "Reviewed dimension" }, basis: "Expose the declared section", source: { kind: "citation", citation: "Synthetic practice sheet A" } }, status: "reviewed_intent", unresolved: [], bond_created: false },
      { instruction: { local_id: "shield-bond", kind: "bond_expectation", element_path: "stock.shield", treatment: "bond", target: { kind: "endpoint_contact", body_revision_id: "exact-body-r1", contact_id: "shell/端子" }, basis: "Authored expectation" }, status: "reviewed_intent", unresolved: [], bond_created: false },
    ], missing_instructions: [{ element_path: "stock.drain", kind: "drain_treatment", status: "unknown" }] }],
  } }];
  input.terminations[0]!.rows = [{ ...((input.terminations[0]!.rows as object[])[0]), part_notes: ["Declared resistor 470 Ω", "Series part, continuity not evaluated"] }];
  input.procurement = { purpose: "procurement", status: "partial", rows: [
    { address: { path: ["supply"] }, revision_id: "exact-part-r1", name: "Synthetic connector", quantity: { amount: 2, unit: "ea", status: "known" }, required_quantity: { amount: 3, unit: "ea", status: "known" }, basis: "Two installed and one declared spare" },
    { address: { path: ["cable"] }, revision_id: "exact-stock-r2", name: "Synthetic wire", required_quantity: { amount: null, unit: "mm", status: "unknown" }, basis: "Length remains unknown" },
  ] };
  const sheet = frozenSheet("Synthetic cable", "exact-root-r1", input);
  const end = sheet.tables.find(table => table.name === "End preparation")!;
  expect(end.rows).toHaveLength(3); expect(end.rows[0]?.slice(9, 13)).toEqual(["12.50", "0", "0.25", "from stock cut end"]);
  expect(end.rows[1]?.[16]).toBe("exact-body-r1/shell/端子"); expect(end.rows[2]?.[13]).toBe("unknown");
  expect(sheet.tables.find(table => table.name === "BOM")?.rows).toEqual([
    ["supply", "Synthetic connector", "exact-part-r1", 3, "ea", "known", "Two installed and one declared spare"],
    ["cable", "Synthetic wire", "exact-stock-r2", null, "mm", "unknown", "Length remains unknown"],
  ]);
  const html = sheetHtml(sheet);
  expect(html).toContain("strip back · 12.50 mm (−0/+0.25 mm)"); expect(html).toContain("Synthetic practice sheet A");
  expect(html).toContain("Declared resistor 470 Ω; Series part, continuity not evaluated");
  expect(html).not.toContain('{"'); expect(html).not.toContain('["'); expect(html).toContain("not evaluated");
});
