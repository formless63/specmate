import { MantineProvider } from "@mantine/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { BomPanel } from "../bom/BomPanel";
import { CableEditor } from "../cables/CablePanel";
import { initialCable } from "../cables/api";
import { WireStockPanel } from "../wire-stock/WireStockPanel";
import { stockPresets } from "../wire-stock/presets";
import { PREFILL_TARGETS } from "./usePreferenceDefaults";

const effective = {
  preferred_suppliers: { value: ["Acme Supply"], source: "workspace" },
  wire_colours: { value: ["red", "black"], source: "user" },
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
    if (url.includes("/api/v0/workspace/projects")) return new Response(JSON.stringify({ workspace_id: "ws", role: "admin", permissions: [], results: [], total: 0, next_after: null }));
    if (url.includes("/api/v0/preferences")) return new Response(JSON.stringify({ workspace_id: "ws", kind: "preference", engineering_fact: false, note: "", workspace: { values: {}, state_token: "w" }, user: { values: {}, state_token: "u" }, effective }));
    return new Response("[]");
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const wrap = (children: React.ReactNode) => <MantineProvider><QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{children}</QueryClientProvider></MantineProvider>;
const stockFacts = () => structuredClone(stockPresets.coax!.facts);

test("wire stock: new element colour and size system are pre-filled, marked and clearable", async () => {
  render(wrap(<WireStockPanel />));
  expect(await screen.findByLabelText("Clear conductor size system preference")).toBeTruthy();
  expect((screen.getByRole("combobox", { name: "Conductor size system" }) as HTMLInputElement).value).toBe("AWG");
  fireEvent.click(screen.getByRole("button", { name: "Add element to stock" }));
  const colour = screen.getByLabelText(/^stock\.conductor-[a-f0-9-]+ color$/) as HTMLInputElement;
  expect(colour.value).toBe("red");
  expect(screen.getAllByText("from preference").length).toBe(2);
  fireEvent.click(screen.getByLabelText(/^Clear stock\.conductor-[a-f0-9-]+ colour preference$/));
  expect(colour.value).toBe("");
  fireEvent.click(screen.getByLabelText("Clear conductor size system preference"));
  expect((screen.getByRole("combobox", { name: "Conductor size system" }) as HTMLInputElement).value).toBe("");
  expect(screen.queryByText("from preference")).toBeNull();
});

test("editing a pre-filled value removes its mark", async () => {
  render(wrap(<WireStockPanel />));
  await screen.findByLabelText("Clear conductor size system preference");
  fireEvent.click(screen.getByRole("button", { name: "Add element to stock" }));
  const colour = screen.getByLabelText(/^stock\.conductor-[a-f0-9-]+ color$/);
  fireEvent.change(colour, { target: { value: "blue" } });
  expect(screen.queryByLabelText(/^Clear stock\.conductor-[a-f0-9-]+ colour preference$/)).toBeNull();
});

test("a preference never fills an engineering fact, rating or dimension", async () => {
  render(wrap(<WireStockPanel />));
  await screen.findByLabelText("Clear conductor size system preference");
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
  expect(Object.keys(PREFILL_TARGETS).sort()).toEqual(Object.keys(effective).sort());
  for (const target of Object.values(PREFILL_TARGETS)) expect(target).not.toMatch(/fact|rating|limit|voltage|current|impedance|tolerance|dimension|diameter/i);
});

test("BOM: supplier shortlist is pre-filled, marked, clearable and not saved with the plan", async () => {
  render(wrap(<BomPanel projectId="p" />));
  expect(await screen.findByLabelText("Clear supplier shortlist preference")).toBeTruthy();
  expect(screen.getByText("Acme Supply")).toBeTruthy();
  fireEvent.click(screen.getByLabelText("Clear supplier shortlist preference"));
  expect(screen.queryByText("Acme Supply")).toBeNull();
  expect(screen.queryByText("from preference")).toBeNull();
});

test("cables: connector family filter narrows body choices by name, is marked and clearable", async () => {
  const definitions = [{ definition_id: "a", name: "Alpha-6 body", kind: "connector_body" }, { definition_id: "b", name: "Beta body", kind: "connector_body" }] as never;
  const cable = { ...initialCable(), endpoints: [{ local_id: "a", label: null, body_revision_id: "", pinout_revision_id: "" }] };
  render(wrap(<CableEditor value={cable} onChange={() => {}} definitions={definitions} />));
  expect(await screen.findByLabelText("Clear connector family filter preference")).toBeTruthy();
  const open = () => { const input = screen.getByRole("combobox", { name: "Endpoint 1 body definition" }); fireEvent.focus(input); fireEvent.keyDown(input, { key: "ArrowDown" }); return screen.getByRole("listbox", { name: "Endpoint 1 body definition", hidden: true }); };
  const list = open();
  expect(within(list).queryByText("Alpha-6 body")).toBeTruthy();
  expect(within(list).queryByText("Beta body")).toBeNull();
  fireEvent.click(screen.getByLabelText("Clear connector family filter preference"));
  await waitFor(() => expect(within(open()).queryByText("Beta body")).toBeTruthy());
});
