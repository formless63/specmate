import { MantineProvider } from "@mantine/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { RunnerPanel } from "./RunnerPanel";
import type { WorkspaceStatus } from "./status";

beforeEach(() => vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} }));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const status: WorkspaceStatus = {
  workspace_id: "w1", evaluated_at: "2026-01-01T12:00:00Z", can_execute: false,
  work: { mode: "running", accepting_new_work: true, reason: "", state_token: "v1" },
  queue: { states: {}, pending: 0, active: 0, oldest_pending_seconds: null }, dispatch: { undelivered: 0, oldest_undelivered_seconds: null },
  runner: { state: "enrolled_liveness_unknown", credentials_usable: 1, stages_holding_lease: 0, stages_lease_expired: 0 },
  tools: [], storage: { state: "not_evaluated", code: null, sampled: 0 }, workflow_engine: { state: "not_evaluated" }, builds: [], findings: [],
  tool_catalog: { gated: true, tools: [{ id: "synthetic", title: "Synthetic tool", state: "available", enabled: true, platforms: ["linux/amd64"], download_bytes: null, approved_recipe_ids: ["synthetic-check"], image_state: "not_checked" }] },
};
function mount(active = true) {
  const cache = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const element = (enabled: boolean) => <MantineProvider><QueryClientProvider client={cache}><RunnerPanel workspaceId="w1" principalKey="viewer:w1" active={enabled} /></QueryClientProvider></MantineProvider>;
  const view = render(element(active)); return { cache, activate: () => view.rerender(element(true)) };
}
test("enabled tool and approved recipe do not imply execution permission, image readiness or observed liveness", async () => {
  const fetcher = vi.fn(async (_path: string) => new Response(JSON.stringify(status), { status: 200 })); vi.stubGlobal("fetch", fetcher);
  mount();
  await screen.findByRole("heading", { name: "Synthetic tool" });
  expect(screen.getByText("Your execution permission: not granted")).toBeTruthy();
  expect(screen.getByText("Runner enrolled, liveness unknown")).toBeTruthy();
  expect(screen.getByText("Image: not checked")).toBeTruthy();
  expect(screen.getByText("Download:").textContent).toContain("download size unknown");
  expect(screen.queryByRole("button", { name: /execute|build|install|enable/i })).toBeNull();
  expect(fetcher.mock.calls.every(call => String(call[0]).includes("/diagnostics/"))).toBe(true);
});
test("current denied refetch withdraws cached capability and runner metadata", async () => {
  let denied = false;
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(denied ? { error: { message: "Access withdrawn" } } : status), { status: denied ? 403 : 200 })));
  const { cache } = mount(); await screen.findByRole("heading", { name: "Synthetic tool" });
  denied = true; await act(async () => { await cache.invalidateQueries({ queryKey: ["jobs-runner"] }); });
  await screen.findByRole("alert"); expect(screen.queryByRole("heading", { name: "Synthetic tool" })).toBeNull();
  expect(screen.queryByText("Your execution permission: not granted")).toBeNull();
  expect(screen.getByText(/not evaluated until this read succeeds/)).toBeTruthy();
});
test("unvisited inactive Runner does not read until opened", async () => {
  const fetcher = vi.fn(async (_path: string) => new Response(JSON.stringify(status), { status: 200 })); vi.stubGlobal("fetch", fetcher);
  const { activate } = mount(false); expect(fetcher).not.toHaveBeenCalled(); activate();
  await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
});
