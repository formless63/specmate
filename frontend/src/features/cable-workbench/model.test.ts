import { expect, test } from "vitest";
import { boardEnd, cable, check, inlineEnd, row, stock } from "./fixtures";
import { geometryByKey } from "../../../../packages/connector-art/src";
import { workshopChips, ohms } from "./chips";
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

test("a connector with a known face lands contacts on its drawn pins; others sit below the face", () => {
  const din = geometryByKey("mini-din-10", "male")!;
  const scart = geometryByKey("scart", "male")!;
  const d = draw({ faces: [din, scart] });
  const face = d.ends[1]!.connector!.face!;
  expect(face.geometry.key).toBe(scart.key);
  const one = d.terminals.get(termKey("b", "connector", "1"))!;
  expect(one.onFace).toBe(true);
  expect(one.x).toBeGreaterThan(face.x);
  expect(one.x).toBeLessThan(face.x + face.width);
  expect(one.y).toBeGreaterThan(face.y);
  expect(one.y).toBeLessThan(face.y + face.height);
  // The wire lands on the drawn pin.
  const center = d.wires.find((w) => w.path === "stock.core-1.center")!;
  expect(center.b!.y).toBeCloseTo(one.y, 5);
  // The face is wider than tall for SCART and the column takes the face's width.
  expect(face.width).toBeGreaterThan(face.height);
  expect(d.ends[1]!.columns.find((c) => c.kind === "connector")!.width).toBe(face.width + 12);
  // A contact the face has no position for is drawn below the face, not guessed onto it.
  const a = boardEnd();
  a.layers[1]!.terminals.push({ terminal_id: "aux", label: "aux", kind: "contact", reaches: [] });
  const withAux = layoutDrawing({ cable: cable(), stacks: [a, inlineEnd()], stock: stock(), faces: [din, scart] });
  const aux = withAux.terminals.get(termKey("a", "connector", "aux"))!;
  const dinFace = withAux.ends[0]!.connector!.face!;
  expect(aux.onFace).toBeFalsy();
  expect(aux.y).toBeGreaterThan(dinFace.y + dinFace.height);
  // A 21-position face keeps the end short: no row per contact.
  expect(d.bodyHeight).toBeLessThan(21 * 15);
});

test("path chips read in workshop language with raw paths in titles", () => {
  const d = draw();
  const chips = workshopChips([
    { kind: "port_pin", label: "Out 1 · Video" },
    { kind: "contact", label: "connector 1", ref: { endpoint_id: "a", layer_id: "connector", terminal_id: "1" } },
    { kind: "board_path", label: "R1 75R resistor", status: "declared" },
    { kind: "board", label: "board V", ref: { endpoint_id: "a", layer_id: "board", terminal_id: "v" } },
    { kind: "termination", label: "termination", status: "declared" },
    { kind: "conductor", label: "stock.core-1.center at end a", ref: { endpoint_id: "a", element_path: "stock.core-1.center" } },
    { kind: "conductor", label: "Center", status: "declared", ref: { element_path: "stock.core-1.center" } },
    { kind: "conductor", label: "stock.core-1.center at end b", ref: { endpoint_id: "b", element_path: "stock.core-1.center" } },
    { kind: "inline", label: "inline R2 · 1", ref: { endpoint_id: "b", layer_id: "inline", terminal_id: "r2.1" } },
  ] as never, d);
  expect(chips.map((c) => c.text)).toEqual(["Out 1 · Video", "Pin 1 · Video", "R1 75 Ω", "Board pad V", "landed", "Coax 1 center (red)", "R2 lead 1"]);
  expect(chips[5]!.title).toBe("stock.core-1.center");
  expect(ohms("4k7R")).toBe("4k7R");
  expect(ohms("2.2kR")).toBe("2.2 kΩ");
});

test('compound board paths retain internal graph dots and every component edge', () => {
  const stack = boardEnd(); const layer = stack.layers.find(l => l.kind === 'board')!;
  layer.internal_nodes = [{ node_id: 'between', label: 'Between parts', basis: 'Declared series path' }];
  layer.paths = [
    { local_id: 'c', from_terminal: 'v', to_terminal: 'between', via: 'component', summary: 'C1 100 nF capacitor' },
    { local_id: 'r', from_terminal: 'between', to_terminal: 'din-1', via: 'component', summary: 'R1 2k2 resistor' },
  ];
  const d = draw({ stacks: [stack, inlineEnd()] });
  const internal = d.terminals.get(termKey('a', 'board', 'between'))!;
  expect(internal.kind).toBe('internal_graph_node');
  expect(d.ends[0]!.traces.map(t => t.summary)).toEqual(['C1 100 nF capacitor', 'R1 2k2 resistor']);
  expect(layer.terminals.some(t => t.terminal_id === 'between')).toBe(false);
});
