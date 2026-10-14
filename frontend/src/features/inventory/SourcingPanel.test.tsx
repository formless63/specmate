import { MantineProvider } from "@mantine/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { SourcingPanel } from "./SourcingPanel";
import { PermissionsProvider } from "../../lib/permissions";
import type { SourcingReport } from "./sourcing";

const report: SourcingReport = {
  revision_id: "rev-bom", kind: "bom_plan", purpose: "procurement", as_of: "2026-10-14", max_age_days: null,
  rows: [{
    revision_id: "rev-board", name: "Synthetic board",
    required: { status: "known", amount: "2", unit: "ea" }, net_required: { status: "known", amount: "2", unit: "ea" },
    stock: { status: "none_recorded", available: { status: "unknown", amount: null, unit: "ea" }, available_is_lower_bound: false, observed_at: null, issues: [] },
    shortfall: { status: "unknown", amount: null, unit: "ea", reason: "stock_none_recorded", at_most: "2", at_least: null },
    offers: [{ offer_id: "o1", revision_id: "rev-board", supplier: "Synthetic Supply", supplier_ref: "", source: "quote", review_basis: "checked", reviewed_by: { id: 1, username: "owner" }, offered_on: "2026-10-01", valid_until: null, price: null, availability: "unknown", lead_time_days: null, substitution: null, freshness: "unknown", age_days: 13, estimated_cost: { status: "unknown", reason: "price_unknown" }, counts_toward_need: true }],
    substitutes: [], offer_status: "no_usable_price",
  }],
  unresolved: [], limitations: ["No live prices are fetched."],
  cost: { status: "unknown", rows_needing_purchase: 0, rows_priced: 0, rows_without_price: 0, rows_shortfall_unknown: 1, totals: [] },
  offers_after_as_of: 0, superseded_offers_hidden: 0,
};

beforeEach(() => { vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} }); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

function fake() {
  const posts: { operation: string; payload: Record<string, unknown> }[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, options?: RequestInit) => {
    if (options?.method === "POST") { posts.push(JSON.parse(String(options.body))); return new Response(JSON.stringify({ result: {} }), { status: 200 }); }
    if (url.includes("catalog/definitions/")) return new Response(JSON.stringify({ definition_id: "d", name: "Plan", kind: "bom_plan", revisions: [{ revision_id: url.includes("d-part") ? "rev-board" : "rev-bom", number: 1 }], drafts: [] }), { status: 200 });
    if (url.includes("/definitions")) return new Response(JSON.stringify([{ definition_id: "d-bom", name: "Plan", kind: "bom_plan" }, { definition_id: "d-part", name: "Board", kind: "part" }]), { status: 200 });
    if (url.includes("sourcing/revisions/")) return new Response(JSON.stringify(report), { status: 200 });
    return new Response("[]", { status: 200 });
  }));
  return posts;
}

function mount(permissions: string[]) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(<MantineProvider><QueryClientProvider client={client}><PermissionsProvider permissions={permissions}><SourcingPanel workspaceId="ws-1" /></PermissionsProvider></QueryClientProvider></MantineProvider>);
}

test("shows unknown stock, shortfall, price and freshness as unknown, never zero", async () => {
  fake(); mount(["workspace.read"]);
  await waitFor(() => expect(screen.getByLabelText("Plan definition").querySelectorAll("option").length).toBeGreaterThan(1));
  fireEvent.change(screen.getByLabelText("Plan definition"), { target: { value: "d-bom" } });
  await waitFor(() => expect(screen.getByLabelText("Plan exact revision").querySelectorAll("option").length).toBeGreaterThan(1));
  fireEvent.change(screen.getByLabelText("Plan exact revision"), { target: { value: "rev-bom" } });
  expect(await screen.findByText("Synthetic board")).toBeTruthy();
  expect(screen.getAllByText(/unknown/).length).toBeGreaterThan(2);
  expect(screen.getByText(/no stock account recorded/)).toBeTruthy();
  expect(screen.getByText(/at most 2/)).toBeTruthy();
  expect(screen.getByText(/price_unknown|cost \(price_unknown\)/)).toBeTruthy();
  expect(screen.queryByText(/^0 /)).toBeNull();
});

test("recording an offer needs only the required fields and sends optional price as null", async () => {
  const posts = fake(); mount(["workspace.read", "item.create"]);
  await waitFor(() => expect(screen.getByLabelText("Offered item definition").querySelectorAll("option").length).toBeGreaterThan(2));
  fireEvent.change(screen.getByLabelText("Offered item definition"), { target: { value: "d-part" } });
  await waitFor(() => expect(screen.getByLabelText("Offered item exact revision").querySelectorAll("option").length).toBeGreaterThan(1));
  fireEvent.change(screen.getByLabelText("Offered item exact revision"), { target: { value: "rev-board" } });
  fireEvent.change(screen.getByLabelText("Supplier"), { target: { value: "Synthetic Supply" } });
  fireEvent.change(screen.getByLabelText("Offer source (quote, page, email)"), { target: { value: "quote" } });
  fireEvent.change(screen.getByLabelText("Review basis"), { target: { value: "checked" } });
  fireEvent.change(screen.getByLabelText("Offered on (YYYY-MM-DD)"), { target: { value: "2026-10-01" } });
  fireEvent.click(screen.getByText("Record offer"));
  await waitFor(() => expect(posts).toHaveLength(1));
  expect(posts[0]).toMatchObject({ operation: "sourcing.record_offer", payload: { workspace_id: "ws-1", revision_id: "rev-board", price: null, availability: "unknown" } });
});

test("read-only members can inspect but not record offers", async () => {
  fake(); mount(["workspace.read"]);
  const button = (await screen.findByText("Record offer")).closest("button")!;
  expect(button.hasAttribute("disabled") || button.getAttribute("aria-disabled") === "true").toBe(true);
  expect(screen.getByText(/Recording supplier offers is unavailable/)).toBeTruthy();
});
