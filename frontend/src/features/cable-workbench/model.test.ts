import { expect, test } from "vitest";
import { boardEnd, cable, check, inlineEnd, row, stock } from "./fixtures";
import { assignLanding, indexCheck, layoutDrawing, splitTermKey, termKey, wireKey } from "./model";
import { physicalGraph, relatedKeys } from "./relations";

const draw = (extra: Partial<Parameters<typeof layoutDrawing>[0]> = {}) => layoutDrawing({ cable: cable(), stacks: [boardEnd(), inlineEnd()], stock: stock(), ...extra });

test("ends read outward from the stock: End A shell leftmost, End B shell rightmost", () => {
  const d = draw();
  const [a, b] = d.ends;
  expect(a!.columns.map((c) => c.kind)).toEqual(["shell", "connector", "board"]);
  expect(b!.columns.map((c) => c.kind)).toEqual(["inline", "connector"]);
  expect(a!.x1).toBeLessThan(d.stock.jacketX0);
  expect(b!.x0).toBeGreaterThan(d.stock.jacketX1);
  // The board's connector-side pads face the connector; cable-side pads face the stock.
  const pad = (id: string) => d.terminals.get(termKey("a", "board", id))!;
  expect(pad("din-1").x).toBeLessThan(pad("v").x);
  expect(pad("din-1").side).toBe("connector");
  expect(pad("v").side).toBe("cable");
  // An inline part's lead 1 (where a conductor lands) faces the stock at End B.
  const lead = (id: string) => d.terminals.get(termKey("b", "inline", id))!;
  expect(lead("r2.1").x).toBeLessThan(lead("r2.2").x);
});

test("each element runs from its End A landing to its End B landing; an unlanded end stays open", () => {
  const d = draw();
  const center = d.wires.find((w) => w.path === "stock.core-1.center")!;
  const v = d.terminals.get(termKey("a", "board", "v"))!;
  const one = d.terminals.get(termKey("b", "connector", "1"))!;
  expect(center.a).toEqual({ x: v.x + v.halfWidth, y: v.y });
  expect(center.b).toEqual({ x: one.x - one.halfWidth, y: one.y });
  expect(center.d.startsWith(`M${center.a!.x} ${center.a!.y}`)).toBe(true);
  expect(center.open).toHaveLength(0);
  const loose = d.wires.find((w) => w.path === "stock.core-2.screen")!;
  expect(loose.b).toBeNull();
  expect(loose.open).toHaveLength(1);
  const unlanded = d.wires.find((w) => w.path === "stock.core-2.center")!;
  expect(unlanded.open).toHaveLength(2);
  // Colors come from the stock: the coax center's recorded color, never a guess.
  expect(center.look?.base.toLowerCase()).toBe("#d62728");
  expect(d.wires.find((w) => w.path === "stock.core-1.screen")!.kind).toBe("shield");
  // Lanes follow End A landing order, so landed wires do not cross inside the jacket.
  const landed = d.wires.filter((w) => w.a);
  expect([...landed].sort((p, q) => p.lane - q.lane).map((w) => w.path)).toEqual([...landed].sort((p, q) => p.a!.y - q.a!.y || 0).map((w) => w.path));
});

test("a single-connector-layer cable and an unresolved end still draw every landing", () => {
  const old = { layers: [inlineEnd().layers[0]!], joins: [], connector_layer_id: "connector", body_revision_id: null, pinout_revision_id: null, evaluation: [], continuity: "not_evaluated" as const };
  const d = layoutDrawing({ cable: cable(), stacks: [undefined, old], conductors: [{ element_path: "stock.core-1.center", kind: "conductor", label: "Center" }] });
  expect(d.ends[0]!.columns.map((c) => c.kind)).toEqual(["unknown"]);
  expect(d.ends[1]!.columns.map((c) => c.kind)).toEqual(["connector"]);
  const center = d.wires.find((w) => w.path === "stock.core-1.center")!;
  expect(center.aTerminal).toBe(termKey("a", "board", "v"));
  expect(center.look).toBeNull();
  // Landings on elements outside the known rows are drawn and say so.
  expect(d.wires.find((w) => w.path === "stock.core-1.screen")!.inStock).toBe(false);
});

test("check rows map to wires and terminals through chip refs; the worst outcome wins", () => {
  const rows = [
    row("video", "pass", [{ endpoint_id: "a", layer_id: "board", terminal_id: "v" }, { element_path: "stock.core-1.center" }, { endpoint_id: "b", layer_id: "connector", terminal_id: "1" }]),
    row("ground", "unknown", [{ endpoint_id: "a", layer_id: "board", terminal_id: "g" }, { element_path: "stock.core-1.screen" }, { element_path: "stock.core-2.screen" }]),
    row("ground-2", "fail", [{ element_path: "stock.core-2.screen" }]),
  ];
  const index = indexCheck(check(rows));
  expect(index.statusOf.get(wireKey("stock.core-1.center"))).toBe("pass");
  expect(index.statusOf.get(wireKey("stock.core-2.screen"))).toBe("fail");
  expect(index.statusOf.get(termKey("a", "board", "g"))).toBe("unknown");
  const d = draw({ check: check(rows) });
  expect(d.wires.find((w) => w.path === "stock.core-1.center")!.signal?.name).toBe("Video");
  expect(d.terminals.get(termKey("b", "connector", "1"))!.status).toBe("pass");
});

test("probe: a wire lights its whole declared net, the board path and its rows; the rest dims", () => {
  const rows = [row("video", "pass", [{ endpoint_id: "a", layer_id: "board", terminal_id: "v" }, { element_path: "stock.core-1.center" }])];
  const d = draw({ check: check(rows) });
  const graph = physicalGraph(d);
  const lit = relatedKeys(d, graph, indexCheck(check(rows)), wireKey("stock.core-1.center"))!;
  for (const key of [termKey("a", "board", "v"), termKey("a", "board", "din-1"), termKey("a", "connector", "1"), termKey("b", "connector", "1"), "p:a/board/path:path-v", "r:video"]) expect(lit.has(key)).toBe(true);
  expect(lit.has(wireKey("stock.core-1.screen"))).toBe(false);
  expect(lit.has(termKey("a", "connector", "2"))).toBe(false);
  // Two screens on one ground pad light each other.
  const ground = relatedKeys(d, graph, indexCheck(null), wireKey("stock.core-1.screen"))!;
  expect(ground.has(wireKey("stock.core-2.screen"))).toBe(true);
  // A row lights its path and the board path between two lit pads.
  const byRow = relatedKeys(d, graph, indexCheck(check([row("video", "pass", [{ endpoint_id: "a", layer_id: "board", terminal_id: "v" }, { endpoint_id: "a", layer_id: "board", terminal_id: "din-1" }])])), "r:video")!;
  expect(byRow.has("p:a/board/path:path-v")).toBe(true);
  expect(relatedKeys(d, graph, indexCheck(null), null)).toBeNull();
});

test("proposed landings that change the declaration are drawn; unchanged ones are not", () => {
  const assignment = (endpoint_id: string, element_path: string, layer_id: string, terminal_id: string) => ({ endpoint_id, element_path, layer_id, terminal_id, basis: "Proposed", terminal_label: `${layer_id} ${terminal_id}` });
  const proposal = {
    rows: [
      { row_id: "ground", requirement: "required", status: "proposed" as const, conductor: "stock.core-2.screen", reason: "Own return", questions: [], assignments: [assignment("b", "stock.core-2.screen", "connector", "2")] },
      { row_id: "video", requirement: "required", status: "proposed" as const, conductor: "stock.core-1.center", reason: null, questions: [], assignments: [assignment("b", "stock.core-1.center", "connector", "1")] },
    ],
    diff: [
      { endpoint_id: "b", element_path: "stock.core-2.screen", change: "added" as const, current: null, proposed: null },
      { endpoint_id: "b", element_path: "stock.core-1.center", change: "same" as const, current: null, proposed: null },
    ],
  };
  const d = draw({ proposal });
  expect(d.proposals.map((p) => p.rowId)).toEqual(["ground"]);
  const target = d.terminals.get(termKey("b", "connector", "2"))!;
  expect(d.proposals[0]!.d.endsWith(`${target.x - target.halfWidth} ${target.y}`)).toBe(true);
});

test("landing by direct manipulation replaces one end's target and keeps its note", () => {
  const before = cable();
  const after = assignLanding(before, "b", "stock.core-1.center", { layer_id: "inline", terminal_id: "r2.1" });
  expect(after.assignments.filter((a) => a.element_path === "stock.core-1.center")).toEqual([
    { endpoint_id: "a", element_path: "stock.core-1.center", layer_id: "board", terminal_id: "v", basis: "Synthetic table" },
    { endpoint_id: "b", element_path: "stock.core-1.center", layer_id: "inline", terminal_id: "r2.1", basis: "Synthetic table" },
  ]);
  expect(assignLanding(before, "a", "stock.core-2.center", { layer_id: "board", terminal_id: "v" }, "Bench note").assignments.at(-1)!.basis).toBe("Bench note");
  expect(assignLanding(before, "a", "stock.core-1.center", null).assignments.some((a) => a.endpoint_id === "a" && a.element_path === "stock.core-1.center")).toBe(false);
  expect(splitTermKey("t:b/inline/r2.1")).toEqual({ endpointId: "b", layerId: "inline", terminalId: "r2.1" });
});
