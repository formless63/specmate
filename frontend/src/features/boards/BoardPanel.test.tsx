import { MantineProvider } from "@mantine/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { PermissionsProvider } from "../../lib/permissions";
import { BoardEditor, BoardInspector, KicadProposal } from "./BoardPanel";
import { emptyBoard, terminalId, type Board, type BoardInspection, type BoardProposal } from "./api";

beforeEach(() => { vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} }); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
async function select(label: string, option: string | RegExp) {
  const field = await screen.findByRole("combobox", { name: label });
  fireEvent.focus(field); fireEvent.keyDown(field, { key: "ArrowDown" });
  fireEvent.click(await within(screen.getByRole("listbox", { name: label, hidden: true })).findByText(option));
}
function wrap(children: React.ReactNode, permissions = ["workspace.read", "item.create", "design.edit", "design.freeze"]) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <MantineProvider><QueryClientProvider client={client}><PermissionsProvider permissions={permissions}>{children}</PermissionsProvider></QueryClientProvider></MantineProvider>;
}

const ADAPTER: Board = {
  ...emptyBoard(), review: "reviewed", review_basis: "Synthetic",
  terminals: [
    { terminal_id: "din-1", label: "1", group: "Connector side", kind: "connector_contact", side: "both", native_pad_ids: [], note: null },
    { terminal_id: "cs", label: "CS", group: "Cable side", kind: "solder_pad", side: "top", native_pad_ids: [], note: null },
    { terminal_id: "v5", label: "5V", group: "Cable side", kind: "solder_pad", side: "top", native_pad_ids: [], note: null },
  ],
  paths: [{ local_id: "path-cs", from_terminal: "cs", to_terminal: "din-1", via: "component", component: { kind: "resistor", value: "470R", reference: "R1", resistance_ohm: "470", capacitance_f: null }, switch: null, provenance: "declared", basis: "Synthetic" }],
};
const INSPECTION: BoardInspection = { revision_id: "board-r1", interface: ADAPTER, board: {
  origin: "black_box", derived_from: null, review: "reviewed", continuity: "not_evaluated",
  connectors: [{ local_id: "plug", body_revision_id: "plug-r1", correspondence: [{ terminal_id: "din-1", contact_id: "1" }], review: "unreviewed", basis: null, body_name: "10-pin plug", body_revision_number: 1, mating_role: "plug", status: "unknown", contacts_without_terminal: [] }],
  terminals: [
    { ...ADAPTER.terminals[0]!, landings: [{ connector_id: "plug", body_name: "10-pin plug", contact_id: "1", number: "1", label: "1", status: "unknown" }], path_ids: ["path-cs"], connection: "declared" },
    { ...ADAPTER.terminals[1]!, landings: [], path_ids: ["path-cs"], connection: "declared" },
    { ...ADAPTER.terminals[2]!, landings: [], path_ids: [], connection: "unknown" },
  ],
  paths: [{ ...ADAPTER.paths[0]!, from_label: "CS", to_label: "1", summary: "R1 470R resistor", evidence: "declared" }],
} };

test("a frozen board shows pads, unknown connections and follows the series resistor", async () => {
  const fetch = vi.fn(async (url: string) => new Response(JSON.stringify(url.includes("board-trace")
    ? { status: "modeled_series_resistance", reason: "single_declared_model_path_only", series_resistance_ohm: "470", limited: false, paths: [{ terminal_ids: ["cs", "din-1"], terminal_labels: ["CS", "1"], status: "modeled_path", reasons: [], steps: [] }] }
    : INSPECTION)));
  vi.stubGlobal("fetch", fetch);
  render(wrap(<BoardInspector revisionId="board-r1" />));
  const row = (label: string) => screen.getAllByText(label).find((el) => el.classList.contains("sb-board-label"))!.closest("tr") as HTMLElement;
  expect(await screen.findByText("R1 470R resistor")).toBeTruthy();
  expect(within(row("5V")).getByText("Connection unknown")).toBeTruthy();
  // An unreviewed landing is shown as unknown, never as an established contact.
  expect(within(row("1")).getByText("unreviewed, unknown")).toBeTruthy();
  await select("From pad", "CS · Cable side");
  await select("To pad", "1 · Connector side");
  await select("Question", "Series resistance");
  fireEvent.click(screen.getByRole("button", { name: "Follow" }));
  expect(await screen.findByText("Series resistance 470 ohm (declared values)")).toBeTruthy();
  const traced = fetch.mock.calls.map(([url]) => url).find((url) => url.includes("board-trace"))!;
  expect(traced).toContain("from_terminal_id=cs");
  expect(traced).toContain("copper_assumption=ideal_zero_resistance");
  expect(traced).toContain("query=resistance");
});

let latest: Board | null = null;
function Harness() {
  const [value, setValue] = useState<Board>(emptyBoard);
  latest = value;
  return <BoardEditor value={value} onChange={setValue} definitions={[]} />;
}

test("pads are typed by label and a path through a resistor keeps its exact value", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response("[]")));
  render(wrap(<Harness />));
  for (const [label, group] of [["CS", "Cable side"], ["1", "Connector side"]] as const) {
    fireEvent.change(screen.getByLabelText("New pad label"), { target: { value: label } });
    fireEvent.change(screen.getByLabelText("Group"), { target: { value: group } });
    fireEvent.click(screen.getByRole("button", { name: "Add pad" }));
  }
  expect(latest?.terminals.map((t) => [t.terminal_id, t.label, t.group])).toEqual([["cs", "CS", "Cable side"], ["1", "1", "Connector side"]]);
  fireEvent.click(screen.getByRole("button", { name: "Add path" }));
  await select("How path CS to 1 is joined", "Through a component");
  await select("Component kind on path CS to 1", "resistor");
  fireEvent.change(screen.getByLabelText("Written value on path CS to 1"), { target: { value: "470R" } });
  fireEvent.change(screen.getByLabelText("Resistance in ohm on path CS to 1 (blank = unknown)"), { target: { value: "470" } });
  fireEvent.change(screen.getByLabelText("Basis of path CS to 1"), { target: { value: "Board drawing" } });
  expect(latest?.paths).toEqual([{ local_id: "path-1", from_terminal: "cs", to_terminal: "1", via: "component", component: { kind: "resistor", value: "470R", reference: null, resistance_ohm: "470", capacitance_f: null }, switch: null, provenance: "declared", basis: "Board drawing" }]);
  // Removing a pad removes the paths that name it; nothing dangles.
  fireEvent.click(screen.getByRole("button", { name: "Remove pad CS" }));
  expect(latest?.paths).toEqual([]);
  expect(terminalId("CS", ["cs"])).toBe("cs-2");
});

test("a KiCad proposal lists components and only fills the new board when used", async () => {
  const proposal: BoardProposal = {
    status: "proposed", review: "required", population_revision_id: "pop-r1", population_name: "Two-net board", population_revision_number: 1,
    components: [{ component_id: "j1", reference: "J1", value: "connector", footprint: "x", pad_count: 1, port_association: false, selected: true }, { component_id: "r1", reference: "R1", value: "100", footprint: "x", pad_count: 2, port_association: false, selected: false }],
    unmapped_passages: [], limitations: ["Native net membership is reported, not proven routed copper."],
    board: { ...emptyBoard(), origin: "kicad_derived", derived_from: { population_revision_id: "pop-r1", interpretation_id: "i", interpretation_sha256: "0".repeat(64) },
      terminals: [{ terminal_id: "j1-1", label: "left", group: "J1", kind: "solder_pad", side: "top", native_pad_ids: ["p1"], note: "Pad J1.1" }, { terminal_id: "j2-1", label: "right", group: "J2", kind: "solder_pad", side: "top", native_pad_ids: ["p2"], note: "Pad J2.1" }],
      paths: [{ local_id: "passage-1", from_terminal: "j1-1", to_terminal: "j2-1", via: "component", component: { kind: "resistor", value: "100", reference: "R1", resistance_ohm: "100.0", capacitance_f: null }, switch: null, provenance: "native_component_passage", basis: "Proposed" }] },
  };
  const fetch = vi.fn(async (url: string) => new Response(JSON.stringify(url.includes("boards/propose") ? proposal
    : { definition_id: "pop", name: "Two-net board", kind: "pcb_population", drafts: [], revisions: [{ revision_id: "pop-r1", number: 1 }] })));
  vi.stubGlobal("fetch", fetch);
  const onUse = vi.fn();
  render(wrap(<KicadProposal definitions={[{ definition_id: "pop", name: "Two-net board", kind: "pcb_population" }]} onUse={onUse} />));
  await select("PCB population", "Two-net board");
  await select("Population revision", /r1|1/);
  expect(await screen.findByText("R1 100 resistor")).toBeTruthy();
  expect(screen.getByText("review required")).toBeTruthy();
  fireEvent.click(screen.getByLabelText("R1 · 100 · 2 pads"));
  await screen.findByText("R1 100 resistor");
  expect(fetch.mock.calls.map(([url]) => url).some((url) => url.includes("component_id=j1&component_id=r1"))).toBe(true);
  expect(onUse).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Use proposal in the new board" }));
  expect(onUse).toHaveBeenCalledWith(proposal.board, "Two-net board board");
});

const CARRYING: BoardInspection = { ...INSPECTION, interface: { ...ADAPTER, carried_connectors: [{ local_id: "plug", body_revision_id: "plug-r1", correspondence: [{ terminal_id: "din-1", contact_id: "1" }], review: "unreviewed", basis: null }] } };

test("the frozen drawing: placeholder outline, unknown pads marked, and Follow a path lights the traced copper", async () => {
  const fetch = vi.fn(async (url: string) => new Response(JSON.stringify(url.includes("board-trace")
    ? { status: "modeled_series_resistance", reason: "single_declared_model_path_only", series_resistance_ohm: "470", limited: false, paths: [{ terminal_ids: ["cs", "din-1"], terminal_labels: ["CS", "1"], status: "modeled_path", reasons: [], steps: [] }] }
    : CARRYING)));
  vi.stubGlobal("fetch", fetch);
  render(wrap(<BoardInspector revisionId="board-r1" />));
  const drawing = await screen.findByRole("group", { name: "Board drawing" });
  // The board's shape is not declared: the outline is a labeled placeholder, never a guessed shape.
  expect(within(drawing).getByText("OUTLINE NOT DECLARED · PLACEHOLDER")).toBeTruthy();
  expect(drawing.querySelector("[data-placeholder='true']")).toBeTruthy();
  expect(within(drawing).getByRole("button", { name: "Pad 5V, Cable side" }).getAttribute("data-unconnected")).toBe("true");
  expect(within(drawing).getByText("R1 470R")).toBeTruthy();
  expect(within(drawing).getByRole("img", { name: "Carried connector 10-pin plug" })).toBeTruthy();
  const path = within(drawing).getByRole("button", { name: "Path CS to 1, R1 470R resistor" });
  fireEvent.click(path);
  expect((screen.getByRole("combobox", { name: "From pad" }) as HTMLInputElement).value).toBe("CS · Cable side");
  expect((screen.getByRole("combobox", { name: "To pad" }) as HTMLInputElement).value).toBe("1 · Connector side");
  fireEvent.click(screen.getByRole("button", { name: "Follow" }));
  const result = await screen.findByRole("status", { name: "Path result" });
  expect(within(result).getByText("declared model")).toBeTruthy();
  expect(within(result).getByText("CS → 1")).toBeTruthy();
  await waitFor(() => expect(path.getAttribute("data-traced")).toBe("true"));
  expect(path.querySelector(".bv-follow")).toBeTruthy();
});

let edited: Board | null = null;
function DrawingHarness({ start }: { start: Board }) {
  const [value, setValue] = useState<Board>(start);
  edited = value;
  return <BoardEditor value={value} onChange={setValue} definitions={[]} title="Adapter" />;
}

test("click two pads to declare copper, then make it a series resistor in the inspector", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response("[]")));
  const start: Board = { ...emptyBoard(), terminals: ADAPTER.terminals.slice(0, 2) };
  render(wrap(<DrawingHarness start={start} />));
  const drawing = screen.getByRole("group", { name: "Adapter drawing" });
  fireEvent.click(within(drawing).getByRole("button", { name: "Pad CS, Cable side" }));
  expect(screen.getByRole("status").textContent).toContain("Drawing a path from pad CS");
  fireEvent.click(within(drawing).getByRole("button", { name: "Pad 1, Connector side" }));
  expect(edited?.paths).toEqual([{ local_id: "path-1", from_terminal: "cs", to_terminal: "din-1", via: "copper", component: null, switch: null, provenance: "declared", basis: "" }]);
  const inspector = screen.getByRole("complementary", { name: "Board inspector" });
  expect(within(inspector).getByRole("heading", { name: "CS to 1" })).toBeTruthy();
  await select("Path kind", "Through a component");
  await select("Part kind", "resistor");
  fireEvent.change(within(inspector).getByLabelText("Reference"), { target: { value: "R1" } });
  fireEvent.change(within(inspector).getByLabelText("Resistance in ohm (blank = unknown)"), { target: { value: "470" } });
  fireEvent.change(within(inspector).getByLabelText("Path basis"), { target: { value: "Board drawing" } });
  expect(edited?.paths[0]).toMatchObject({ via: "component", component: { kind: "resistor", reference: "R1", resistance_ohm: "470" }, basis: "Board drawing" });
  // The part is drawn on its copper with what is known; the exact value stands in for a missing written one.
  expect(within(drawing).getByText("R1 470")).toBeTruthy();
});

test("a viewer inspects pads on the drawing but cannot draw paths", () => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response("[]")));
  const start: Board = { ...emptyBoard(), terminals: ADAPTER.terminals.slice(0, 2) };
  render(wrap(<DrawingHarness start={start} />, ["workspace.read"]));
  const drawing = screen.getByRole("group", { name: "Adapter drawing" });
  fireEvent.click(within(drawing).getByRole("button", { name: "Pad CS, Cable side" }));
  fireEvent.click(within(drawing).getByRole("button", { name: "Pad 1, Connector side" }));
  expect(edited?.paths).toEqual([]);
  expect(within(screen.getByRole("complementary", { name: "Board inspector" })).getByRole("heading", { name: "Pad 1" })).toBeTruthy();
});
