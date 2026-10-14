import { MantineProvider } from "@mantine/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { PhysicalUnitsPanel } from "./PhysicalUnitsPanel";
import { PermissionsProvider } from "../../lib/permissions";

beforeEach(() => { vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} }); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(<MantineProvider><QueryClientProvider client={client}><PhysicalUnitsPanel workspaceId="ws-1" /></QueryClientProvider></MantineProvider>);
}

test("registers one actual unit without reporting plan completion or qualification", async () => {
  const calls: { operation: string; payload: Record<string, unknown> }[] = [];
  let units: object[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, options?: RequestInit) => {
    if (options?.method === "POST") {
      const envelope = JSON.parse(String(options.body));
      calls.push(envelope);
      units = [{ unit_id: "unit-1", workspace_id: "ws-1", revision_id: "revision-1", serial: envelope.payload.serial,
        origin: "assembled", lot_id: "lot-1", variant_id: null, assertion_source: "Traveler", assertion_status: "observed",
        work_batch_id: null, physical_qualification: false }];
      return new Response(JSON.stringify({ result: units[0] }), { status: 200 });
    }
    let body: unknown;
    if (url.includes("/definitions/")) body = { revisions: [{ revision_id: "revision-1", number: 1 }] };
    else if (url.includes("/definitions")) body = [{ definition_id: "definition-1", name: "Synthetic assembly" }];
    else if (url.includes("catalog/revisions/")) body = { lots: [{ lot_id: "lot-1", label: "Actual lot", variant_id: null }], variants: [] };
    else if (url.includes("physical-units/workspaces/")) body = { units };
    else body = { work_batches: [] };
    return new Response(JSON.stringify(body), { status: 200 });
  }));
  mount();
  await screen.findByRole("option", { name: "Synthetic assembly" });
  fireEvent.change(screen.getByLabelText("Definition"), { target: { value: "definition-1" } });
  await screen.findByRole("option", { name: "Revision 1" });
  fireEvent.change(screen.getByLabelText("Exact frozen revision"), { target: { value: "revision-1" } });
  fireEvent.change(screen.getByLabelText("Unit serial"), { target: { value: "UNIT-1" } });
  await screen.findByRole("option", { name: "Actual lot" });
  fireEvent.change(screen.getByLabelText("Actual physical lot (optional)"), { target: { value: "lot-1" } });
  fireEvent.change(screen.getByLabelText("Assertion source"), { target: { value: "Traveler" } });
  fireEvent.change(screen.getByLabelText("Assertion status"), { target: { value: "observed" } });
  fireEvent.click(screen.getByText("Register unit"));
  await waitFor(() => expect(calls).toHaveLength(1));
  expect(calls[0]).toMatchObject({ operation: "physical_units.register", payload: {
    revision_id: "revision-1", serial: "UNIT-1", lot_id: "lot-1", assertion_status: "observed",
  } });
  expect(await screen.findByText(/UNIT-1 · assembled/)).toBeTruthy();
  expect(screen.getAllByText('revision-1', { selector: 'code' }).length).toBeGreaterThan(0);
  expect(screen.getByText(/Neither record reports completion, changes stock, or qualifies the unit/)).toBeTruthy();
});

test("links an actual unit to exact planned work without changing reported completion", async () => {
  const calls: { operation: string; expected_state: string; payload: Record<string, unknown> }[] = [];
  let linked = false;
  const work = { work_batch_id: "work-1", workspace_id: "ws-1", project_id: null, revision_id: "revision-1",
    definition_id: "definition-1", kind: "batch", label: "Planned six", planned_units: 6,
    reported_completed_units: 0, progress: "none_reported", state: "work-before",
    actual_unit_tracking: "separate_records", physical_qualification: false };
  const unit = { unit_id: "unit-1", workspace_id: "ws-1", revision_id: "revision-1",
    serial: "UNIT-1", origin: "assembled", lot_id: null, variant_id: null,
    assertion_source: "Traveler", assertion_status: "declared", work_batch_id: null,
    physical_qualification: false };
  vi.stubGlobal("fetch", vi.fn(async (url: string, options?: RequestInit) => {
    if (options?.method === "POST") {
      const envelope = JSON.parse(String(options.body)); calls.push(envelope); linked = true;
      return new Response(JSON.stringify({ result: { unit: { ...unit, work_batch_id: "work-1" } } }), { status: 200 });
    }
    let body: unknown;
    if (url.includes("physical-units/work-batches/")) body = { work_batch: work, linked_unit_count: 0, units: [] };
    else if (url.includes("physical-units/units/")) body = { unit, work_link: null, usage: [] };
    else if (url.includes("physical-units/workspaces/")) body = { units: [{ ...unit, work_batch_id: linked ? "work-1" : null }] };
    else if (url.includes("inventory/workspaces/")) body = { work_batches: [work] };
    else if (url.includes("/definitions")) body = [];
    else body = {};
    return new Response(JSON.stringify(body), { status: 200 });
  }));
  mount();
  fireEvent.click(await screen.findByText("Inspect"));
  fireEvent.change(screen.getByLabelText("Exact planned work"), { target: { value: "work-1" } });
  expect(await screen.findByText(/Planned 6; reported complete 0; actual linked units 0/)).toBeTruthy();
  fireEvent.change(screen.getByLabelText("Work link assertion source"), { target: { value: "Traveler" } });
  fireEvent.click(screen.getByText("Link actual unit to planned work"));
  await waitFor(() => expect(calls).toHaveLength(1));
  expect(calls[0]).toMatchObject({ operation: "physical_units.link_work", expected_state: "work-before",
    payload: { unit_id: "unit-1", work_batch_id: "work-1", assertion_source: "Traveler" } });
  expect(await screen.findByText(/Linked planned work: work-1/)).toBeTruthy();
});

test.each([
  ["read-only", ["project.read"], true],
  ["reservation only", ["project.read", "inventory.reserve"], true],
  ["inventory manager", ["project.read", "inventory.manage"], false],
] as const)("%s permissions gate unit registration", async (_name, permissions, off) => {
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    let body: unknown;
    if (url.includes("/definitions/")) body = { revisions: [{ revision_id: "revision-1", number: 1 }] };
    else if (url.includes("/definitions")) body = [{ definition_id: "definition-1", name: "Synthetic assembly" }];
    else if (url.includes("catalog/revisions/")) body = { lots: [], variants: [] };
    else if (url.includes("physical-units/workspaces/")) body = { units: [] };
    else body = { work_batches: [] };
    return new Response(JSON.stringify(body), { status: 200 });
  }));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(<MantineProvider><QueryClientProvider client={client}><PermissionsProvider permissions={[...permissions]}><PhysicalUnitsPanel workspaceId="ws-1" /></PermissionsProvider></QueryClientProvider></MantineProvider>);
  await screen.findByRole("option", { name: "Synthetic assembly" });
  fireEvent.change(screen.getByLabelText("Definition"), { target: { value: "definition-1" } });
  await screen.findByRole("option", { name: "Revision 1" });
  fireEvent.change(screen.getByLabelText("Exact frozen revision"), { target: { value: "revision-1" } });
  fireEvent.change(screen.getByLabelText("Unit serial"), { target: { value: "UNIT-1" } });
  fireEvent.change(screen.getByLabelText("Assertion source"), { target: { value: "Traveler" } });
  const register = screen.getByRole("button", { name: "Register unit" }) as HTMLButtonElement;
  expect(register.disabled).toBe(off);
  expect(register.title).toBe(off ? "Read-only access: requires Inventory management" : "");
  expect(screen.queryAllByRole("note").length > 0).toBe(off);
});
