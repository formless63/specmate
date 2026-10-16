import { MantineProvider } from "@mantine/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { BomPanel } from "../bom/BomPanel";
import { CableEditor } from "../cables/CablePanel";
import { initialCable } from "../cables/api";
import { connectorStack } from "../end-assemblies/api";
import { NewStockRecord } from "../../test/stock-record";
import { stockPresets } from "../wire-stock/presets";
import { PREFILL_TARGETS } from "./usePreferenceDefaults";

const effective = {
  preferred_suppliers: { value: ["Acme Supply"], source: "workspace" },
  wire_colors: { value: ["red", "black"], source: "user" },
  connector_families: { value: ["Alpha"], source: "workspace" },
  default_length_unit: { value: "m", source: "workspace" },
  default_wire_gauge_system: { value: "awg", source: "user" },
};
const posts: { operation: string; payload: Record<string, any> }[] = [];
beforeEach(() => {
  posts.length = 0;
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal("fetch", vi.fn(async (url: string, options?: RequestInit) => {
    if (options?.method === "POST") {
      const body = JSON.parse(String(options.body)); posts.push(body);
      return new Response(JSON.stringify({ result: { name: "Saved", definition_id: "d", draft_id: "dr", state: "s1", content: { stock: body.payload.stock } } }));
    }
    if (url.includes("catalog/definitions")) return new Response(JSON.stringify({ name: "Synthetic assembly", drafts: [], revisions: [{ revision_id: "asm-rev", number: 1 }] }));
    if (url.includes("workspace/definitions")) return new Response(JSON.stringify([{ definition_id: "asm", name: "Synthetic assembly", kind: "assembly" }]));
    if (url.includes("assemblies/snapshots")) return new Response(JSON.stringify({ occurrences: [] }));
    if (url.includes("revisions/asm-rev")) return new Response(JSON.stringify({ snapshot_id: "snap" }));
    if (url.includes("/api/v0/preferences")) return new Response(JSON.stringify({ workspace_id: "ws", kind: "preference", engineering_fact: false, note: "", workspace: { values: {}, state_token: "w" }, user: { values: {}, state_token: "u" }, effective }));
    return new Response("[]");
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const wrap = (children: React.ReactNode) => <MantineProvider><QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{children}</QueryClientProvider></MantineProvider>;
const stockFacts = () => structuredClone(stockPresets.coax!.facts);

test("wire stock: new element color and size system are pre-filled, marked and clearable", async () => {
  render(wrap(<NewStockRecord stock={structuredClone(stockPresets.coax!)} />));
  await waitFor(() => expect(fetch).toHaveBeenCalledWith(expect.stringContaining("/api/v0/preferences"), expect.anything()));
  await new Promise(resolve => setTimeout(resolve, 50));
  fireEvent.click(screen.getByRole("tab", { name: "More" }));
  fireEvent.click(screen.getByText("Advanced · exact specification tree"));
  await screen.findByRole("button", { name: "Add element to stock" });
  fireEvent.click(screen.getByRole("button", { name: "Add element to stock" }));
  const color = screen.getByLabelText(/^stock\.conductor-[a-f0-9-]+ color$/) as HTMLInputElement;
  expect(color.value).toBe("red");
  expect(screen.getAllByText("from preference").length).toBe(1);
  fireEvent.click(screen.getByLabelText(/^Clear stock\.conductor-[a-f0-9-]+ color preference$/));
  expect(color.value).toBe("");
  expect(screen.queryByText("from preference")).toBeNull();
});

test("editing a pre-filled value removes its mark", async () => {
  render(wrap(<NewStockRecord stock={structuredClone(stockPresets.coax!)} />));
  await waitFor(() => expect(fetch).toHaveBeenCalledWith(expect.stringContaining("/api/v0/preferences"), expect.anything()));
  await new Promise(resolve => setTimeout(resolve, 50));
  fireEvent.click(screen.getByRole("tab", { name: "More" }));
  fireEvent.click(screen.getByText("Advanced · exact specification tree"));
  await screen.findByRole("button", { name: "Add element to stock" });
  fireEvent.click(screen.getByRole("button", { name: "Add element to stock" }));
  const color = screen.getByLabelText(/^stock\.conductor-[a-f0-9-]+ color$/);
  fireEvent.change(color, { target: { value: "blue" } });
  expect(screen.queryByLabelText(/^Clear stock\.conductor-[a-f0-9-]+ color preference$/)).toBeNull();
});

test("a preference never fills an engineering fact, rating or dimension", async () => {
  render(wrap(<NewStockRecord stock={structuredClone(stockPresets.coax!)} />));
  await waitFor(() => expect(fetch).toHaveBeenCalledWith(expect.stringContaining("/api/v0/preferences"), expect.anything()));
  await new Promise(resolve => setTimeout(resolve, 50));
  fireEvent.click(screen.getByRole("tab", { name: "More" }));
  fireEvent.click(screen.getByText("Advanced · exact specification tree"));
  await screen.findByRole("button", { name: "Add element to stock" });
  fireEvent.click(screen.getByRole("button", { name: "Add element to stock" }));
  fireEvent.click(screen.getByRole("button", { name: "Save stock" }));
  await screen.findByText(/^Saved /);
  const saved = posts.find(post => post.operation === "wire_stock.create")!.payload.stock;
  // Facts are untouched by every preference value.
  expect(saved.facts).toEqual(stockFacts());
  const added = saved.structure.children.at(-1);
  expect(added.color).toBe("red");
  for (const key of ["outer_diameter_mm", "inner_diameter_mm", "area_mm2", "construction", "material", "source"]) expect(added[key]).toBeNull();
  // Only naming/convention targets exist; none is a fact or rating field.
  expect(Object.keys(PREFILL_TARGETS).sort()).toEqual(["connector_families", "default_length_unit", "wire_colors"]);
  for (const target of Object.values(PREFILL_TARGETS)) expect(target).not.toMatch(/fact|rating|limit|voltage|current|impedance|tolerance|dimension|diameter/i);
});

test("BOM: need quantity unit is pre-filled from the length unit, marked, clearable, amount stays unknown", async () => {
  render(wrap(<BomPanel projectId="p" workspaceId="ws" />));
  await waitFor(() => expect(fetch).toHaveBeenCalledWith(expect.stringContaining("/api/v0/preferences"), expect.anything()));
  const pick = async (name: string, option: string) => {
    const input = await screen.findByRole("combobox", { name });
    fireEvent.focus(input); fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.click(await within(screen.getByRole("listbox", { name, hidden: true })).findByText(option));
  };
  await pick("Root assembly definition", "Synthetic assembly (assembly)");
  await waitFor(() => expect(screen.getByRole("combobox", { name: "Root assembly exact revision" })).toBeTruthy());
  await pick("Root assembly exact revision", "Synthetic assembly · r1");
  const unit = await screen.findByRole("combobox", { name: "Need net demand per root assembly unit" }) as HTMLInputElement;
  await waitFor(() => expect(unit.value).toBe("m"));
  expect((screen.getByLabelText("Need net demand per root assembly") as HTMLInputElement).value).toBe("");
  fireEvent.click(screen.getByLabelText("Clear need quantity unit preference"));
  await waitFor(() => expect(unit.value).toBe("ea"));
  expect(screen.queryByText("from preference")).toBeNull();
});

test("cables: connector family filter narrows body choices by name, is marked and clearable", async () => {
  const definitions = [{ definition_id: "a", name: "Alpha-6 body", kind: "connector_body" }, { definition_id: "b", name: "Beta body", kind: "connector_body" }] as never;
  const cable = { ...initialCable(), endpoints: initialCable().endpoints.slice(0, 1).map(endpoint => ({ ...endpoint, stack: connectorStack() })) };
  render(wrap(<CableEditor workspaceId="ws" value={cable} onChange={() => {}} definitions={definitions} />));
  expect(await screen.findByLabelText("Clear connector family filter preference")).toBeTruthy();
  const open = () => { const input = screen.getByRole("combobox", { name: "Endpoint 1 body definition" }); fireEvent.focus(input); fireEvent.keyDown(input, { key: "ArrowDown" }); return document.querySelector<HTMLElement>(`[role="listbox"][aria-labelledby="${document.querySelector(`label[for="${input.id}"]`)?.id}"]`)!; };
  const list = open();
  expect(within(list).queryByText("Alpha-6 body")).toBeTruthy();
  expect(within(list).queryByText("Beta body")).toBeNull();
  fireEvent.click(screen.getByLabelText("Clear connector family filter preference"));
  await waitFor(() => expect(within(open()).queryByText("Beta body")).toBeTruthy());
});
