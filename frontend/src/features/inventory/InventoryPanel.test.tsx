import { MantineProvider } from "@mantine/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { InventoryPanel } from "./InventoryPanel";
import type { Account, Command, Detail } from "./api";
import { PermissionsProvider } from "../../lib/permissions";

const account: Account = {
  account_id: "account-1", workspace_id: "ws-1", lot_id: "lot-1", lot_label: "Synthetic batch",
  revision_id: "revision-1", definition_id: "definition-1", location_id: "location-1", location_name: "Shelf A",
  dimension: "count", unit: "ea", quantity_status: "known", physical_quantity: "10",
  reserved_quantity: "0", available_quantity: "10", state: "stock-v1", assertion_source: "Synthetic receipt", assertion_status: "declared",
};

beforeEach(() => { vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} }); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

function renderPanel(projectId = "project-1") {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(<MantineProvider><QueryClientProvider client={client}><InventoryPanel workspaceId={projectId} /></QueryClientProvider></MantineProvider>);
}

function fakeServer(initial = account, fail = false) {
  const calls: Command[] = [];
  let current = initial;
  let reservations: Detail["reservations"] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, options?: RequestInit) => {
    if (options?.method === "POST") {
      const envelope = JSON.parse(String(options.body)); calls.push(envelope);
      if (fail) return new Response(JSON.stringify({ error: { message: "Missing permission inventory.reserve." } }), { status: 403 });
      if (envelope.operation === "inventory.reserve") {
        current = { ...current, reserved_quantity: "7", available_quantity: "3", state: "stock-v2" };
        reservations = [{ reservation_id: "reservation-1", amount: "7", unit: "ea", purpose: "Prepare assembly", status: "active", release: null }];
      } else if (envelope.operation === "inventory.release") {
        current = { ...current, reserved_quantity: "0", available_quantity: "10", state: "stock-v3" };
        reservations = [{ ...reservations[0]!, status: "released", release: { reason: "Released from inventory workspace" } }];
      }
      return new Response(JSON.stringify({ result: { account: current } }), { status: 200 });
    }
    if (url.includes("/definitions")) return new Response("[]", { status: 200 });
    const body = url.includes("/accounts/") ? { account: current, reservations, entries: [{ entry_id: "entry-1", kind: "opening", amount: "10", unit: "ea", after: "10", reason: "Receipt", assertion_source: "Synthetic receipt", assertion_status: "declared", created_at: "2026-01-01T00:00:00Z" }] } : { accounts: [current], locations: [{ location_id: "location-1", name: "Shelf A" }], lots: [{ lot_id: "lot-1", label: "Synthetic batch" }] };
    return new Response(JSON.stringify(body), { status: 200 });
  }));
  return calls;
}

test("reserves and releases from the scoped operation path with current state and no consumption", async () => {
  const calls = fakeServer(); renderPanel();
  fireEvent.click(await screen.findByText("Manage Synthetic batch"));
  fireEvent.change(await screen.findByLabelText("Stock operation"), { target: { value: "reserve" } });
  fireEvent.change(screen.getByLabelText("Operation quantity"), { target: { value: "7" } });
  fireEvent.change(screen.getByLabelText("Reservation purpose"), { target: { value: "Prepare assembly" } });
  fireEvent.click(screen.getByText("Apply stock operation"));
  fireEvent.click(await screen.findByText("Release reservation"));
  await waitFor(() => expect(calls).toHaveLength(2));
  expect(calls[0]).toMatchObject({ operation: "inventory.reserve", expected_state: "stock-v1", payload: { account_id: "account-1", quantity: { amount: "7", unit: "ea" }, purpose: "Prepare assembly" } });
  expect(calls[1]).toMatchObject({ operation: "inventory.release", expected_state: "stock-v2", payload: { reservation_id: "reservation-1" } });
  expect(calls[0]?.idempotency_key).toBeTruthy();
  expect(calls.some((item) => item.operation.includes("consume"))).toBe(false);
  expect(await screen.findByText(/Prepare assembly · released/)).toBeTruthy();
});

test("unknown balance stays visibly unknown and cannot be reserved", async () => {
  const calls = fakeServer({ ...account, quantity_status: "unknown", physical_quantity: null, available_quantity: null }); renderPanel();
  fireEvent.click(await screen.findByText("Manage Synthetic batch"));
  fireEvent.change(await screen.findByLabelText("Stock operation"), { target: { value: "reserve" } });
  fireEvent.change(screen.getByLabelText("Operation quantity"), { target: { value: "1" } });
  fireEvent.change(screen.getByLabelText("Reservation purpose"), { target: { value: "Prepare assembly" } });
  expect((screen.getByRole("button", { name: "Apply stock operation" }) as HTMLButtonElement).disabled).toBe(true);
  expect(screen.getAllByText("Unknown ea")).toHaveLength(2);
  expect(calls).toHaveLength(0);
});

test("opening stock uses chosen lot/location and explicit unknown quantity", async () => {
  const calls = fakeServer(); renderPanel();
  await screen.findByText("Manage Synthetic batch");
  fireEvent.change(screen.getByLabelText("Physical lot"), { target: { value: "lot-1" } });
  fireEvent.change(screen.getByLabelText("Stock location"), { target: { value: "location-1" } });
  fireEvent.change(screen.getByLabelText("Opening reason"), { target: { value: "Inventory intake" } });
  fireEvent.change(screen.getByLabelText("Opening assertion source"), { target: { value: "Synthetic intake record" } });
  fireEvent.click(screen.getByText("Open account"));
  await waitFor(() => expect(calls).toHaveLength(1));
  expect(calls[0]).toMatchObject({ operation: "inventory.open_stock", payload: { lot_id: "lot-1", location_id: "location-1", dimension: "count", quantity: null, assertion_source: "Synthetic intake record", assertion_status: "declared" } });
});

test("permission failures display honestly and retry preserves original request identity", async () => {
  const calls = fakeServer(account, true); renderPanel();
  fireEvent.click(await screen.findByText("Manage Synthetic batch"));
  fireEvent.change(await screen.findByLabelText("Stock operation"), { target: { value: "reserve" } });
  fireEvent.change(screen.getByLabelText("Operation quantity"), { target: { value: "7" } });
  fireEvent.change(screen.getByLabelText("Reservation purpose"), { target: { value: "Prepare assembly" } });
  fireEvent.click(screen.getByText("Apply stock operation"));
  await screen.findByText("Missing permission inventory.reserve.");
  fireEvent.click(screen.getByText("Retry same request"));
  await waitFor(() => expect(calls).toHaveLength(2));
  expect(calls[1]).toEqual(calls[0]);
  expect(screen.queryByText("Inventory operation completed.")).toBeNull();
});

function renderAs(permissions: string[]) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(<MantineProvider><QueryClientProvider client={client}><PermissionsProvider permissions={permissions}><InventoryPanel workspaceId="ws-1" /></PermissionsProvider></QueryClientProvider></MantineProvider>);
}
const control = (name: string) => screen.getByRole("button", { name }) as HTMLButtonElement;

test("read-only permissions disable every ledger-writing inventory control with a reason", async () => {
  fakeServer(); renderAs(["workspace.read"]);
  fireEvent.click(await screen.findByText("Manage Synthetic batch"));
  fireEvent.change(await screen.findByLabelText("Stock operation"), { target: { value: "receive" } });
  fireEvent.change(screen.getByLabelText("Operation quantity"), { target: { value: "2" } });
  fireEvent.change(screen.getByLabelText("Operation reason"), { target: { value: "Receipt" } });
  fireEvent.change(screen.getByLabelText("Assertion source"), { target: { value: "Count" } });
  for (const name of ["Create location", "Open account", "Apply stock operation", "Register planned work", "Apply material usage"]) {
    expect(control(name).disabled).toBe(true);
    expect(control(name).title).toBe("Read-only access: requires Inventory management");
  }
  fireEvent.change(screen.getByLabelText("Stock operation"), { target: { value: "reserve" } });
  fireEvent.change(screen.getByLabelText("Reservation purpose"), { target: { value: "Prepare assembly" } });
  expect(control("Apply stock operation").disabled).toBe(true);
  expect(control("Apply stock operation").title).toBe("Read-only access: requires Inventory reservation");
  expect(screen.queryAllByRole("note").length).toBeGreaterThan(0);
});

test("reservation-only access can reserve but not receive or open accounts", async () => {
  fakeServer(); renderAs(["workspace.read", "inventory.reserve"]);
  fireEvent.click(await screen.findByText("Manage Synthetic batch"));
  fireEvent.change(await screen.findByLabelText("Stock operation"), { target: { value: "reserve" } });
  fireEvent.change(screen.getByLabelText("Operation quantity"), { target: { value: "2" } });
  fireEvent.change(screen.getByLabelText("Reservation purpose"), { target: { value: "Prepare assembly" } });
  expect(control("Apply stock operation").disabled).toBe(false);
  fireEvent.change(screen.getByLabelText("Stock operation"), { target: { value: "receive" } });
  fireEvent.change(screen.getByLabelText("Operation reason"), { target: { value: "Receipt" } });
  fireEvent.change(screen.getByLabelText("Assertion source"), { target: { value: "Count" } });
  expect(control("Apply stock operation").disabled).toBe(true);
  expect(control("Create location").disabled).toBe(true);
});

test("inventory managers keep every control enabled, including reservation", async () => {
  fakeServer(); renderAs(["workspace.read", "inventory.manage"]);
  fireEvent.click(await screen.findByText("Manage Synthetic batch"));
  fireEvent.change(await screen.findByLabelText("Stock operation"), { target: { value: "reserve" } });
  fireEvent.change(screen.getByLabelText("Operation quantity"), { target: { value: "2" } });
  fireEvent.change(screen.getByLabelText("Reservation purpose"), { target: { value: "Prepare assembly" } });
  expect(control("Apply stock operation").disabled).toBe(false);
  fireEvent.change(screen.getByLabelText("New location name"), { target: { value: "Shelf B" } });
  expect(control("Create location").disabled).toBe(false);
  expect(screen.queryAllByRole("note")).toHaveLength(0);
});

test("files a reservation under the current project as context and filters work by it on request", async () => {
  const calls = fakeServer();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(<MantineProvider><QueryClientProvider client={client}><InventoryPanel workspaceId="ws-1" projectId="project-1" /></QueryClientProvider></MantineProvider>);
  fireEvent.click(await screen.findByText("Manage Synthetic batch"));
  fireEvent.change(await screen.findByLabelText("Stock operation"), { target: { value: "reserve" } });
  fireEvent.change(screen.getByLabelText("Operation quantity"), { target: { value: "2" } });
  fireEvent.change(screen.getByLabelText("Reservation purpose"), { target: { value: "Project build" } });
  fireEvent.click(screen.getByText("Apply stock operation"));
  await waitFor(() => expect(calls).toHaveLength(1));
  expect(calls[0]).toMatchObject({ operation: "inventory.reserve", payload: { purpose: "Project build", project_id: "project-1" } });
  fireEvent.click(screen.getByLabelText("Only work filed under this project"));
  await waitFor(() => expect((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.some(([url]) => String(url).includes("inventory/workspaces/ws-1?offset=0&limit=50&project_id=project-1"))).toBe(true));
});
