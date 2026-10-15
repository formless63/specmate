import { MantineProvider } from "@mantine/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { PermissionsProvider } from "../../lib/permissions";
import { ExternalObservations } from "./ExternalObservations";
import { IntegrationsPanel } from "./IntegrationsPanel";

beforeEach(() => { vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} }); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const integration = { integration_id: "i1", workspace_id: "w", name: "Synthetic ERP", adapter: "file", ownership: { supplier_offer: "external" }, columns: {}, enabled: true, state: "s1", updated_by: { username: "owner" }, updated_at: "2026-10-14T00:00:00Z" };
const importResult = { run_id: "r1", field: "supplier_offer", file_sha256: "x", row_count: 2, accepted_count: 1, rejected_count: 1, rejections: [{ row: 2, reason: "identifier: ambiguous" }], duplicate_of_earlier_run: false, actor: { username: "owner" }, created_at: "2026-10-14T00:00:00Z" };

function fake(observations: unknown[] = []) {
  const posts: { operation: string; payload: Record<string, unknown> }[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, options?: RequestInit) => {
    if (options?.method === "POST") {
      const body = JSON.parse(String(options.body)); posts.push(body);
      return new Response(JSON.stringify({ result: body.operation === "integration.import" ? importResult : {} }), { status: 200 });
    }
    if (url.includes("/definitions")) return new Response("[]", { status: 200 });
    if (url.includes("/observations")) return new Response(JSON.stringify({ label: "External observations (not reviewed)", observations }), { status: 200 });
    if (url.includes("/history")) return new Response(JSON.stringify({ runs: [], exports: [] }), { status: 200 });
    return new Response(JSON.stringify({ integrations: [integration] }), { status: 200 });
  }));
  return posts;
}

function mount(permissions: string[], node = <IntegrationsPanel workspaceId="w" />) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<MantineProvider><QueryClientProvider client={client}><PermissionsProvider permissions={permissions}>{node}</PermissionsProvider></QueryClientProvider></MantineProvider>);
}

test("a non-admin sees configuration read-only and import shows per-row rejections", async () => {
  const posts = fake(); mount(["workspace.read", "item.create"]);
  await screen.findByText("Field ownership");
  expect((screen.getByLabelText("Integration name") as HTMLInputElement).readOnly).toBe(true);
  expect((screen.getByRole("button", { name: "Save integration" }) as HTMLButtonElement).disabled).toBe(true);
  expect(screen.getByText(/Only workspace admins configure/)).toBeTruthy();
  fireEvent.change(screen.getByLabelText("File content"), { target: { value: "a,b\n1,2" } });
  fireEvent.click(screen.getByRole("button", { name: "Import as observations" }));
  expect(await screen.findByText(/1 of 2 rows recorded as observations; 1 rejected/)).toBeTruthy();
  expect(screen.getByText("identifier: ambiguous")).toBeTruthy();
  expect(posts[0]?.operation).toBe("integration.import");
  expect(screen.getByText(/Exporting needs inventory management/)).toBeTruthy();
});

test("an admin saves the declared ownership with the current state token", async () => {
  const posts = fake(); mount(["workspace.read", "workspace.admin", "item.create"]);
  await screen.findByText("Field ownership");
  fireEvent.click(screen.getByRole("button", { name: "Save integration" }));
  await waitFor(() => expect(posts.some((p) => p.operation === "integration.update")).toBe(true));
  const post = posts.find((p) => p.operation === "integration.update") as unknown as { payload: Record<string, unknown>; expected_state: string };
  expect(post.expected_state).toBe("s1");
  expect(post.payload.ownership).toEqual({ supplier_offer: "external" });
});

const observation = { observation_id: "o1", kind: "supplier_offer", observed_on: "2026-10-01", valid_until: null, supplier: "Synthetic Supply", external_ref: "", price: null, availability: "unknown", lead_time_days: null, promoted_offer_id: null, attribution: { integration: "Synthetic ERP", file_sha256: "x", imported_by: { username: "owner" }, row_number: 3 } };

test("observations are labeled unreviewed, unknown price stays unknown, and promotion needs a basis", async () => {
  const posts = fake([observation]);
  mount(["workspace.read", "item.create"], <ExternalObservations workspaceId="w" revisionId="r" name="Board" />);
  expect(await screen.findByText(/External observations \(not reviewed\): Board/)).toBeTruthy();
  expect(screen.getByText(/Synthetic ERP, row 3, imported by owner/)).toBeTruthy();
  const button = screen.getByRole("button", { name: "Promote Synthetic Supply" }) as HTMLButtonElement;
  expect(button.disabled).toBe(true);
  fireEvent.change(screen.getByLabelText("Review basis for Synthetic Supply"), { target: { value: "Checked quote" } });
  fireEvent.click(button);
  await waitFor(() => expect(posts[0]?.operation).toBe("integration.promote_observation"));
  expect(posts[0]?.payload).toEqual({ observation_id: "o1", review_basis: "Checked quote" });
});

test("a viewer cannot promote", async () => {
  fake([observation]);
  mount(["workspace.read"], <ExternalObservations workspaceId="w" revisionId="r" name="Board" />);
  expect(await screen.findByText(/promotion needs contributor access/)).toBeTruthy();
  expect(screen.queryByRole("button", { name: /Promote/ })).toBeNull();
});

test("export needs offers a plan picker, not a pasted id", async () => {
  const posts: { operation: string; payload: Record<string, unknown> }[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, options?: RequestInit) => {
    if (options?.method === "POST") { posts.push(JSON.parse(String(options.body))); return new Response(JSON.stringify({ result: { content: "a", file_format: "csv", export_id: "e", row_count: 1, unresolved: [] } }), { status: 200 }); }
    if (url.includes("catalog/definitions/")) return new Response(JSON.stringify({ definition_id: "d-bom", name: "Plan", kind: "bom_plan", revisions: [{ revision_id: "rev-bom", number: 1 }], drafts: [] }), { status: 200 });
    if (url.includes("/definitions")) return new Response(JSON.stringify([{ definition_id: "d-bom", name: "Plan", kind: "bom_plan" }, { definition_id: "d-p", name: "Part", kind: "part" }]), { status: 200 });
    if (url.includes("/history")) return new Response(JSON.stringify({ runs: [], exports: [] }), { status: 200 });
    return new Response(JSON.stringify({ integrations: [integration] }), { status: 200 });
  }));
  vi.stubGlobal("URL", Object.assign(URL, { createObjectURL: () => "blob:x", revokeObjectURL: () => {} }));
  mount(["workspace.read", "inventory.manage", "item.create"]);
  await waitFor(() => expect(screen.getByLabelText("Plan definition").querySelectorAll("option").length).toBe(2));
  fireEvent.change(screen.getByLabelText("Plan definition"), { target: { value: "d-bom" } });
  await waitFor(() => expect(screen.getByLabelText("Plan exact revision").querySelectorAll("option").length).toBeGreaterThan(1));
  fireEvent.change(screen.getByLabelText("Plan exact revision"), { target: { value: "rev-bom" } });
  fireEvent.click(screen.getByRole("button", { name: "Export needs" }));
  await waitFor(() => expect(posts.find((p) => p.operation === "integration.export_needs")?.payload.revision_id).toBe("rev-bom"));
});
