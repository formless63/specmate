import { MantineProvider } from "@mantine/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { InventoryPanel } from "./InventoryPanel";
import type { Account, Command, Detail, WorkBatch, WorkDetail } from "./api";

const account: Account = {
  account_id: "stock-1", project_id: "project-1", lot_id: "lot-1", lot_label: "Material batch",
  revision_id: "material-revision", definition_id: "material-definition", location_id: "shelf-1", location_name: "Shelf",
  dimension: "length", unit: "m", quantity_status: "known", physical_quantity: "10", reserved_quantity: "7", available_quantity: "3",
  state: "stock-before", assertion_source: "Intake", assertion_status: "declared",
};
const batch: WorkBatch = {
  work_batch_id: "work-1", project_id: "project-1", definition_id: "target-definition", revision_id: "target-revision",
  kind: "batch", label: "Assembly job", planned_units: null, reported_completed_units: 0, progress: "none_reported", state: "work-before",
  actual_unit_tracking: "separate_records", physical_qualification: false,
};

beforeEach(() => { vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} }); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(<MantineProvider><QueryClientProvider client={client}><InventoryPanel projectId="project-1" /></QueryClientProvider></MantineProvider>);
}
function server(fail = false) {
  const calls: Command[] = [];
  let current = { ...account };
  let work = { ...batch };
  let reservations: Detail["reservations"] = [{ reservation_id: "reserved-1", amount: "700", unit: "cm", purpose: "Assembly material", consumed_quantity: "0", remaining_quantity: "7", status: "active", release: null }];
  let entries: Detail["entries"] = [];
  const completions: WorkDetail["completions"] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, options?: RequestInit) => {
    if (options?.method === "POST") {
      const envelope = JSON.parse(String(options.body)); calls.push(envelope);
      if (fail) return new Response(JSON.stringify({ error: { message: "Work state changed." } }), { status: 409 });
      if (envelope.operation === "inventory.create_work_batch") work = { ...work, label: envelope.payload.label };
      if (envelope.operation === "inventory.record_work_completion") {
        work = { ...work, state: "work-completed", reported_completed_units: 2, progress: "partial" };
        completions.push({ completion_id: "completion-1", units_completed: 2, reason: envelope.payload.reason, assertion_source: envelope.payload.assertion_source, assertion_status: "declared", created_at: "2026-01-01T00:00:00Z" });
      }
      if (envelope.operation === "inventory.consume") {
        current = { ...current, state: "stock-used", physical_quantity: "6", reserved_quantity: "0", available_quantity: "6" };
        work = { ...work, state: "work-used" };
        reservations = [{ ...reservations[0]!, consumed_quantity: "4", remaining_quantity: "0", status: "released", release: { reason: "Unused allocation" } }];
        entries = [{ entry_id: "consumption-1", kind: "consumption", amount: "400", unit: "cm", after: "6", reason: envelope.payload.reason, assertion_source: envelope.payload.assertion_source, assertion_status: envelope.payload.assertion_status, created_at: "2026-01-01T00:00:00Z", reservation_id: "reserved-1", work_batch_id: "work-1", consumption_origin_id: null, returnable_quantity: "4" }];
      }
      if (envelope.operation === "inventory.return_unused") {
        current = { ...current, state: "stock-returned", physical_quantity: "6.5", available_quantity: "6.5" };
        work = { ...work, state: "work-returned" };
        entries = [{ ...entries[0]!, entry_id: "return-1", kind: "return", amount: "50", after: "6.5", consumption_origin_id: "consumption-1", returnable_quantity: null }, { ...entries[0]!, returnable_quantity: "3.5" }];
      }
      return new Response(JSON.stringify({ result: { account: current, work_batch: work } }), { status: 200 });
    }
    let body: unknown;
    if (url.includes("catalog/definitions/")) body = { definition_id: "target-definition", name: "Target", kind: "assembly", revisions: [{ revision_id: "target-revision", number: 1 }], drafts: [] };
    else if (url.includes("/definitions")) body = [{ definition_id: "target-definition", name: "Target", kind: "assembly" }];
    else if (url.includes("physical-units/work-batches/")) body = { work_batch: work, linked_unit_count: 1, units: [{ unit_id: "unit-1", serial: "UNIT-1" }] };
    else if (url.includes("work-batches/")) body = { work_batch: work, usage: entries, completions };
    else if (url.includes("accounts/")) body = { account: current, reservations, entries };
    else body = { accounts: [current], locations: [], lots: [], work_batches: [work] };
    return new Response(JSON.stringify(body), { status: 200 });
  }));
  return calls;
}

test("registers work using a selected exact revision and keeps the unknown plan explicit", async () => {
  const calls = server(); mount();
  await screen.findByRole("option", { name: "Target" });
  fireEvent.change(screen.getByLabelText("Work target definition"), { target: { value: "target-definition" } });
  await screen.findByText("Target · r1");
  fireEvent.change(screen.getByLabelText("Work target exact revision"), { target: { value: "target-revision" } });
  fireEvent.change(screen.getByLabelText("Work label"), { target: { value: "Partial assembly" } });
  fireEvent.click(screen.getByText("Register planned work"));
  await waitFor(() => expect(calls).toHaveLength(1));
  expect(calls[0]).toMatchObject({ operation: "inventory.create_work_batch", payload: { revision_id: "target-revision", label: "Partial assembly", kind: "batch", planned_units: null } });
  expect(calls[0]?.idempotency_key).toBeTruthy();
  expect(await screen.findByText(/Partial assembly · batch · reported 0 \/ Unknown planned count/)).toBeTruthy();
  expect(screen.getByText(/Actual subjects can be linked to this plan/)).toBeTruthy();
});

test("reports partial completion independently from material consumption", async () => {
  const calls = server(); mount();
  fireEvent.click(await screen.findByText("Inspect work Assembly job"));
  fireEvent.change(await screen.findByLabelText("Additional reported completed units"), { target: { value: "2" } });
  fireEvent.change(screen.getByLabelText("Completion reason"), { target: { value: "Two assemblies completed" } });
  fireEvent.change(screen.getByLabelText("Completion assertion source"), { target: { value: "Work log" } });
  fireEvent.click(screen.getByText("Record partial completion"));
  await waitFor(() => expect(calls).toHaveLength(1));
  expect(calls[0]).toMatchObject({ operation: "inventory.record_work_completion", expected_state: "work-before", payload: { work_batch_id: "work-1", units_completed: 2, assertion_source: "Work log", assertion_status: "declared" } });
  expect(await screen.findByText(/reported 2 \/ Unknown planned count · partial/)).toBeTruthy();
  expect(calls.some((call) => call.operation === "inventory.consume")).toBe(false);
});

async function fillConsumption() {
  fireEvent.click(await screen.findByText("Manage Material batch"));
  fireEvent.change(await screen.findByLabelText("Reservation to consume"), { target: { value: "reserved-1" } });
  fireEvent.change(screen.getByLabelText("Material work target"), { target: { value: "work-1" } });
  await screen.findAllByText("target-revision", { selector: "code" });
  fireEvent.change(screen.getByLabelText("Material usage quantity"), { target: { value: "400" } });
  fireEvent.change(screen.getByLabelText("Material usage unit"), { target: { value: "cm" } });
  fireEvent.change(screen.getByLabelText("Unused reservation remainder"), { target: { value: "release" } });
  fireEvent.change(screen.getByLabelText("Material usage reason"), { target: { value: "Issued to assembly" } });
  fireEvent.change(screen.getByLabelText("Material assertion source"), { target: { value: "Synthetic work log" } });
  fireEvent.change(screen.getByLabelText("Material assertion status"), { target: { value: "observed" } });
  fireEvent.click(screen.getByText("Apply material usage"));
}

test("consumes with both state tokens and returns only against the exact original cause", async () => {
  const calls = server(); mount(); await fillConsumption();
  expect(calls[0]).toMatchObject({ operation: "inventory.consume", expected_state: "stock-before", payload: { reservation_id: "reserved-1", work_batch_id: "work-1", expected_work_state: "work-before", remainder: "release", quantity: { amount: "400", unit: "cm" }, assertion_status: "observed" } });
  await screen.findByText(/Assembly material · released/);
  fireEvent.change(screen.getByLabelText("Material usage operation"), { target: { value: "return_unused" } });
  fireEvent.change(await screen.findByLabelText("Original consumption"), { target: { value: "consumption-1" } });
  await waitFor(() => expect((screen.getByRole("button", { name: "Apply material usage" }) as HTMLButtonElement).disabled).toBe(false));
  fireEvent.change(screen.getByLabelText("Material usage quantity"), { target: { value: "50" } });
  fireEvent.click(screen.getByText("Apply material usage"));
  await waitFor(() => expect(calls).toHaveLength(2));
  expect(calls[1]).toMatchObject({ operation: "inventory.return_unused", expected_state: "stock-used", payload: { consumption_id: "consumption-1", expected_work_state: "work-used", quantity: { amount: "50", unit: "cm" } } });
  expect(await screen.findByText(/return of consumption-1/)).toBeTruthy();
  expect(screen.queryByText("Release reservation")).toBeNull();
});

test("failed consumption retry preserves target, state tokens, quantity and request identity", async () => {
  const calls = server(true); mount(); await fillConsumption();
  await screen.findByText("Work state changed.");
  fireEvent.click(screen.getByText("Retry same request"));
  await waitFor(() => expect(calls).toHaveLength(2));
  expect(calls[1]).toEqual(calls[0]);
  expect(screen.queryByText("Inventory operation completed.")).toBeNull();
});

test("attributes consumption to an explicitly selected linked unit", async () => {
  const calls = server(); mount();
  fireEvent.click(await screen.findByText("Manage Material batch"));
  fireEvent.change(await screen.findByLabelText("Reservation to consume"), { target: { value: "reserved-1" } });
  fireEvent.change(screen.getByLabelText("Material work target"), { target: { value: "work-1" } });
  await screen.findByRole("option", { name: "Unit UNIT-1" });
  fireEvent.change(screen.getByLabelText("Usage attribution"), { target: { value: "unit-1" } });
  fireEvent.change(screen.getByLabelText("Material usage quantity"), { target: { value: "1" } });
  fireEvent.change(screen.getByLabelText("Material usage reason"), { target: { value: "Used by one actual unit" } });
  fireEvent.change(screen.getByLabelText("Material assertion source"), { target: { value: "Synthetic traveler" } });
  fireEvent.click(screen.getByText("Apply material usage"));
  await waitFor(() => expect(calls).toHaveLength(1));
  expect(calls[0]).toMatchObject({ operation: "inventory.consume", payload: {
    physical_unit_id: "unit-1", work_batch_id: "work-1",
  } });
});
