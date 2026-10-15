/** Synthetic workbench fixtures: a two-coax stock, a board end and an inline-part end (test use only). */
import type { StockSpecification } from "../../../../packages/section-layout/src";
import type { Cable } from "../cables/api";
import type { ResolvedStack, ResolvedTerminal } from "../end-assemblies/api";
import type { CheckRow, Dimension, IntentCheck } from "../intent-check/api";

const signal = (key: string, name: string, type: "analog_video" | "ground_return" | "control") => ({ signal_set_revision_id: "set", key, name, type, set_name: "Synthetic set", set_revision_number: 1 });
export const VIDEO = signal("video", "Video", "analog_video");
export const GROUND = signal("ground", "Video ground", "ground_return");

const coax = (n: number, color: string) => ({
  id: `core-${n}`, label: `Core ${n}`, kind: "group", role: "coax", arrangement: "concentric", pitch_mm: null, direction: "cw", material: null, color: null, source: null, x_mm: 0, y_mm: 0,
  children: [
    { id: "center", label: "Center", kind: "conductor", outer_diameter_mm: 0.3, inner_diameter_mm: 0, color, material: "copper", source: null, construction: "solid", area_mm2: null, x_mm: 0, y_mm: 0 },
    { id: "screen", label: "Screen", kind: "shield", outer_diameter_mm: 1.2, inner_diameter_mm: 1.0, color: null, material: "copper", source: null, construction: "braid", area_mm2: null, x_mm: 0, y_mm: 0 },
  ],
});
export const stock = (): StockSpecification => ({
  schema_version: "1", construction: "bundle", viewed_from: "a", facts: {},
  structure: { id: "stock", label: "Synthetic two-coax", kind: "group", role: "stock", arrangement: "ring", pitch_mm: 2, direction: "cw", material: null, color: null, source: null, x_mm: 0, y_mm: 0,
    children: [coax(1, "#d62728"), coax(2, "#1f5fbf"),
      { id: "jacket", label: "Jacket", kind: "jacket", outer_diameter_mm: 4, inner_diameter_mm: 3.4, color: "#222222", material: "PVC", source: null, construction: null, area_mm2: null, x_mm: 0, y_mm: 0 }] },
} as unknown as StockSpecification);

const term = (terminal_id: string, label: string, extra: Partial<ResolvedTerminal> = {}): ResolvedTerminal => ({ terminal_id, label, kind: "contact", reaches: [], ...extra });

/** End A: a board whose cable-side pads V/G reach connector contacts 1 and 2; a shell. */
export const boardEnd = (): ResolvedStack => ({
  layers: [
    { layer_id: "board", kind: "board", name: "Synthetic board r1", carried_connector_id: "plug", carried_status: "reviewed",
      terminals: [term("din-1", "1", { kind: "connector_contact", group: "Connector side" }), term("din-2", "2", { kind: "connector_contact", group: "Connector side" }),
        term("v", "V", { kind: "solder_pad", group: "Cable side", reaches: [{ contact_id: "1", label: "1", signal: VIDEO, status: "declared", via: ["copper", "landing"] }] }),
        term("g", "G", { kind: "solder_pad", group: "Cable side", reaches: [{ contact_id: "2", label: "2", signal: GROUND, status: "declared", via: ["copper", "landing"] }] })],
      paths: [{ local_id: "path-v", from_terminal: "v", to_terminal: "din-1", via: "component", summary: "R1 75R resistor" }, { local_id: "path-g", from_terminal: "g", to_terminal: "din-2", via: "copper", summary: "Straight copper" }] },
    { layer_id: "connector", kind: "connector", name: "Synthetic plug r1", variant_label: "Synthetic out", terminals: [term("1", "1", { signal: VIDEO, signal_status: "declared" }), term("2", "2", { signal: GROUND, signal_status: "declared" }), term("shell", "shell Shell", { kind: "shell" })] },
    { layer_id: "shell", kind: "shell", name: "Synthetic shell r1", terminals: [term("body", "Shell body", { kind: "shell" })] },
  ],
  joins: [
    { local_id: "carried:din-1", a: { layer_id: "board", terminal_id: "din-1", label: "1" }, b: { layer_id: "connector", terminal_id: "1", label: "1" }, kind: "carried", basis: "Synthetic", origin: "board_carried_connector", status: "reviewed" },
    { local_id: "carried:din-2", a: { layer_id: "board", terminal_id: "din-2", label: "2" }, b: { layer_id: "connector", terminal_id: "2", label: "2" }, kind: "carried", basis: "Synthetic", origin: "board_carried_connector", status: "reviewed" },
  ],
  connector_layer_id: "connector", body_revision_id: "plug-body", pinout_revision_id: "plug-pinout", evaluation: [], continuity: "not_evaluated",
});

/** End B: an inline resistor joined to contact 3, and the connector. */
export const inlineEnd = (): ResolvedStack => ({
  layers: [
    { layer_id: "connector", kind: "connector", name: "Synthetic socket r1", terminals: [term("1", "1", { signal: VIDEO, signal_status: "declared" }), term("2", "2", { signal: GROUND, signal_status: "declared" }), term("3", "3")] },
    { layer_id: "inline", kind: "inline", name: "R2", parts: [{ local_id: "r2", name: "R2", summary: "R2 180R resistor" }],
      terminals: [term("r2.1", "R2 · 1", { kind: "component_lead", part: "r2" }), term("r2.2", "R2 · 2", { kind: "component_lead", part: "r2" })] },
  ],
  joins: [{ local_id: "r2-3", a: { layer_id: "inline", terminal_id: "r2.2", label: "R2 · 2" }, b: { layer_id: "connector", terminal_id: "3", label: "3" }, kind: "solder", basis: "Synthetic", origin: "declared", status: "declared" }],
  connector_layer_id: "connector", body_revision_id: "socket-body", pinout_revision_id: "socket-pinout", evaluation: [], continuity: "not_evaluated",
});

const land = (endpoint_id: string, element_path: string, layer_id: string, terminal_id: string) => ({ endpoint_id, element_path, layer_id, terminal_id, basis: "Synthetic table" });
export const cable = (): Cable => ({
  schema_version: "0.2", stock_revision_id: "stock-rev", intent_revision_id: null, review: "unreviewed", review_basis: null,
  lengths: { route: { amount_mm: null, basis: "unknown", explanation: null }, finished: { declaration: { amount_mm: "1500", basis: "human_declaration", explanation: "Synthetic" }, model: null }, stock_cut: { declaration: { amount_mm: null, basis: "unknown", explanation: null }, model: null }, conductor_cuts: [] },
  endpoints: [
    { local_id: "a", label: "Source end", stock_end: "a", end_assembly_revision_id: "end-a", stack: null },
    { local_id: "b", label: "Sink end", stock_end: "b", end_assembly_revision_id: "end-b", stack: null },
  ],
  assignments: [
    land("a", "stock.core-1.center", "board", "v"), land("b", "stock.core-1.center", "connector", "1"),
    land("a", "stock.core-1.screen", "board", "g"), land("b", "stock.core-1.screen", "connector", "2"),
    land("a", "stock.core-2.screen", "board", "g"),
  ],
});

const dim = (status: Dimension["status"], reason = "Synthetic reason"): Dimension => ({ status, reason, evidence: [] });
const dims = (status: Dimension["status"]) => ({ connection: dim(status), signal_match: dim(status), conductor: dim("pass"), level: dim("not_evaluated"), required_parts: dim("not_evaluated"),
  return: dim("pass"), isolation: dim(status), shield: dim("not_evaluated"), convention: dim("pass", "Follows the stock convention."), mating: dim("pass") });
export const row = (row_id: string, outcome: CheckRow["outcome"], refs: object[], sig = VIDEO): CheckRow => ({
  row_id, requirement: "required", from_label: `1 · ${sig.name}`, to_labels: [`1 · ${sig.name}`], signal: sig, outcome, dimensions: dims(outcome === "fail" ? "fail" : "pass"),
  path: refs.map((ref, i) => ({ kind: "contact", label: `step ${i}`, ref } as never)), reached: [],
});
export const check = (rows: CheckRow[]): IntentCheck => ({
  algorithm_version: "cable_intent_check/0.1", cable_revision_id: null, draft_id: "draft", intent_revision_id: "intent", intent_name: "Synthetic intent", intent_number: 1,
  ends: { from: { endpoint_id: "a", label: "Source end", intent_end: "Out", mating: dim("pass") }, to: { endpoint_id: "b", label: "Sink end", intent_end: "In", mating: dim("pass") } },
  rows, cable: { isolation: dim("pass"), shield: dim("not_evaluated") }, counts: {}, continuity: "not_evaluated", physical_qualification: "not_evaluated",
});
