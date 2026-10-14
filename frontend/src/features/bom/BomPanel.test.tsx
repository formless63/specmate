import { MantineProvider } from "@mantine/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { BomInspector, BomPanel } from "./BomPanel";
import { blankPlan } from "./api";
import { PermissionsProvider } from "../../lib/permissions";

beforeEach(() => { vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} }); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
async function choose(name: string, option: string) {
  const input = screen.getByRole("combobox", { name });
  fireEvent.focus(input); fireEvent.keyDown(input, { key: "ArrowDown" });
  fireEvent.click(await within(screen.getByRole("listbox", { name, hidden: true })).findByText(option));
}
function wrap(children: React.ReactNode) {
  return <MantineProvider><QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{children}</QueryClientProvider></MantineProvider>;
}

test("purpose switch preserves exact occurrence, unknown quantity and bought boundary explanation", async () => {
  const urls: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    urls.push(url);
    return new Response(JSON.stringify({ revision_id: "plan-rev", bom: { assembly_revision_id: "assembly-rev" }, status: "unknown", rows: [{ address: { snapshot_id: "root", path: ["left", "board"] }, revision_id: "board-rev", name: "Synthetic board", quantity: { status: "unknown", amount: null, unit: "ea" }, reason: "buy_boundary", basis: "Explicit choice", need_id: null }], boundaries: [{ address: { path: ["left", "board"] }, decision: "buy" }], unresolved: [{ address: { path: ["left", "board"] }, reason: "quantity_unknown", need_id: null }], excluded_needs: [{ need_id: "wipe", reason: "ancestor_buy" }], limitations: ["Counts only"] }), { status: 200 });
  }));
  render(wrap(<BomInspector revisionId="plan-rev" />));
  expect(await screen.findByText("unknown ea")).toBeTruthy();
  expect(screen.getByText("board-rev")).toBeTruthy();
  expect(screen.getByText("Boundary: left / board · buy")).toBeTruthy();
  expect(screen.getByText("Excluded process need: wipe · ancestor_buy")).toBeTruthy();
  await choose("BOM purpose", "Assembly contents");
  await waitFor(() => expect(urls.some(u => u.endsWith("purpose=assembly_contents"))).toBe(true));
});

test("revoked frozen read exposes no retained occurrence rows", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: { message: "BOM plan unavailable." } }), { status: 404 })));
  render(wrap(<BomInspector revisionId="restricted" />));
  expect(await screen.findByText("BOM plan unavailable.")).toBeTruthy();
  expect(screen.queryByRole("table")).toBeNull();
});

test("new plan chooses exact root and sends explicit unknown count and root buy policy", async () => {
  const commands: Record<string, unknown>[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, options?: RequestInit) => {
    if (options?.method === "POST") {
      commands.push(JSON.parse(String(options.body)));
      return new Response(JSON.stringify({ error: { message: "Captured command" } }), { status: 409 });
    }
    const body = url.includes("catalog/definitions/") ? { revisions: [{ revision_id: "root-rev", number: 1 }], drafts: [] }
      : url.includes("assemblies/snapshots/") ? { occurrences: [] }
      : url.includes("revisions/root-rev") ? { snapshot_id: "root-snapshot" }
      : [{ definition_id: "assembly", name: "Synthetic assembly", kind: "assembly" }];
    return new Response(JSON.stringify(body), { status: 200 });
  }));
  render(wrap(<BomPanel projectId="project" />));
  fireEvent.change(screen.getByLabelText("BOM plan name"), { target: { value: "Boundary plan" } });
  await waitFor(() => expect(screen.getByRole("combobox", { name: "Root assembly definition" })).toBeTruthy());
  await choose("Root assembly definition", "Synthetic assembly (assembly)");
  await choose("Root assembly exact revision", "Revision 1");
  await screen.findByRole("combobox", { name: "Decision for Root assembly" });
  await choose("Decision for Root assembly", "buy");
  fireEvent.change(screen.getByLabelText("Decision basis for Root assembly"), { target: { value: "Bought populated assembly" } });
  fireEvent.click(screen.getByText("Create BOM draft"));
  await screen.findByText("Captured command");
  expect(commands[0]).toMatchObject({ operation: "bom.create", payload: { bom: { assembly_revision_id: "root-rev", quantity: { status: "unknown", amount: null }, policies: [{ path: [], revision_id: "root-rev", decision: "buy", basis: "Bought populated assembly" }], needs: [] } } });
});

test("exact dimensional occurrence demand and additive waste remain strings in command", async () => {
  const commands: Record<string, unknown>[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, options?: RequestInit) => {
    if (options?.method === "POST") {
      commands.push(JSON.parse(String(options.body)));
      return new Response(JSON.stringify({ error: { message: "Captured dimensional command" } }), { status: 409 });
    }
    const body = url.includes("catalog/definitions/") ? { revisions: [{ revision_id: "root-rev", number: 1 }], drafts: [] }
      : url.includes("assemblies/snapshots/") ? { occurrences: [] }
      : url.includes("revisions/root-rev") ? { snapshot_id: "root-snapshot" }
      : [{ definition_id: "assembly", name: "Synthetic assembly", kind: "assembly" }];
    return new Response(JSON.stringify(body), { status: 200 });
  }));
  render(wrap(<BomPanel projectId="project" />));
  fireEvent.change(screen.getByLabelText("BOM plan name"), { target: { value: "Dimensional plan" } });
  await choose("Root assembly definition", "Synthetic assembly (assembly)");
  await choose("Root assembly exact revision", "Revision 1");
  fireEvent.click(await screen.findByLabelText("Declare material demand for Root assembly"));
  await choose("Root assembly net demand per root assembly unit", "mm");
  fireEvent.change(screen.getByLabelText("Root assembly net demand per root assembly"), { target: { value: "1234.5000" } });
  fireEvent.change(screen.getByLabelText("Root assembly demand basis"), { target: { value: "Reviewed synthetic declaration" } });
  fireEvent.click(screen.getByLabelText("Declare additive waste for Root assembly"));
  fireEvent.change(screen.getByLabelText("Root assembly additive waste per root assembly"), { target: { value: "0" } });
  fireEvent.change(screen.getByLabelText("Root assembly waste basis"), { target: { value: "Explicit zero allowance" } });
  fireEvent.click(screen.getByText("Create BOM draft"));
  await screen.findByText("Captured dimensional command");
  expect(commands[0]).toMatchObject({ payload: { bom: { occurrence_demands: [{ path: [], revision_id: "root-rev", quantity: { status: "known", amount: "1234.5000", unit: "mm" }, basis: "Reviewed synthetic declaration", waste: { quantity: { status: "known", amount: "0", unit: "mm" }, basis: "Explicit zero allowance" } }] } } });
});

test("frozen dimensional demand shows net, independent structural count and unknown gross", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ revision_id: "plan-rev", bom: { assembly_revision_id: "assembly-rev" }, status: "unknown", rows: [{ address: { snapshot_id: "root", path: ["wire"] }, revision_id: "wire-rev", name: "Synthetic stock", quantity: { status: "known", amount: "2.50", unit: "m" }, structural_quantity: { status: "known", amount: 2, unit: "ea" }, net_quantity: { status: "known", amount: "2.50", unit: "m" }, waste_quantity: { status: "unknown", amount: null, unit: "m" }, required_quantity: { status: "unknown", amount: null, unit: "m" }, waste_status: "not_evaluated", demand_basis: "Explicit synthetic length", waste_basis: null, reason: "buy_boundary", basis: "Buy", need_id: null }], boundaries: [], unresolved: [], excluded_needs: [], limitations: [] }), { status: 200 })));
  render(wrap(<BomInspector revisionId="plan-rev" />));
  expect(await screen.findByText("2.50 m")).toBeTruthy();
  expect(screen.getByText("Structural: 2 ea")).toBeTruthy();
  expect(screen.getByText("Net demand: 2.50 m")).toBeTruthy();
  expect(screen.getByText("Gross: unknown m")).toBeTruthy();
  expect(screen.getByText("Waste: unknown m")).toBeTruthy();
});

test.each([
  ["read-only", ["workspace.read"], true, true],
  ["editor", ["workspace.read", "item.create", "design.edit"], false, true],
  ["editor with freeze", ["workspace.read", "item.create", "design.edit", "design.freeze"], false, false],
] as const)("%s permissions gate BOM create, save and freeze", async (_name, permissions, saveOff, freezeOff) => {
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    const body = url.includes("bom/drafts/") ? { definition_id: "bom", draft_id: "d1", state: "v1", content: { bom: blankPlan() } }
      : url.includes("catalog/definitions/") ? { drafts: [{ draft_id: "d1", state: "v1" }], revisions: [] }
      : [{ definition_id: "bom", name: "Synthetic BOM", kind: "bom_plan" }];
    return new Response(JSON.stringify(body), { status: 200 });
  }));
  render(wrap(<PermissionsProvider permissions={[...permissions]}><BomPanel projectId="project" /></PermissionsProvider>));
  await waitFor(() => expect(screen.getByRole("combobox", { name: "Existing BOM plan" })).toBeTruthy());
  await choose("Existing BOM plan", "Synthetic BOM");
  await waitFor(() => expect(screen.getByRole("combobox", { name: "BOM draft" })).toBeTruthy());
  await choose("BOM draft", "d1 · v1");
  const save = await screen.findByRole("button", { name: "Save BOM draft" }) as HTMLButtonElement;
  const freeze = screen.getByRole("button", { name: "Freeze BOM revision" }) as HTMLButtonElement;
  expect(save.disabled).toBe(saveOff);
  expect(freeze.disabled).toBe(freezeOff);
  expect(save.title).toBe(saveOff ? "Read-only access: requires Edit" : "");
  expect(freeze.title).toBe(freezeOff ? "Read-only access: requires Freeze" : "");
  expect(screen.getByRole("button", { name: "Create BOM draft" }).hasAttribute("data-readonly-reason")).toBe(saveOff);
});
