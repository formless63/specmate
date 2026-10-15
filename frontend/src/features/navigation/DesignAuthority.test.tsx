import { MantineProvider } from "@mantine/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { App } from "../../App";
import { record, reply, workspaceServer } from "../../test/workspaceServer";
import type { DesignRow } from "../designs/api";

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  window.history.replaceState(null, "", "/designs");
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

test("a denied Designs refetch refreshes membership and clears the workspace and its metadata", async () => {
  let denied = false;
  const row: DesignRow = { ...record("c1", "Synthetic retained lead", { kind: "cable", used_in_total: 1, used_in: [{ reference_id: "ref1", project_id: "p1", project_name: "Synthetic referenced project", archived: false, pin: "floating", revision: null, role: "used" }] }), design: {
    basis: "newest_draft", revision_id: null, revision: null, draft_id: "d1", review: "unreviewed",
    from: { label: null, basis: "unknown", revision_id: null }, to: { label: null, basis: "unknown", revision_id: null }, stocks: [], boards: [], checks: "not_evaluated",
  } };
  const { state } = workspaceServer({}, path => path.startsWith("/api/v0/workspace/designs?")
    ? denied ? reply({ error: { message: "Not found." } }, 404) : reply({ workspace_id: "w1", family: "definition", project_id: null, results: [row], next_after: null }) : undefined);
  const cache = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<MantineProvider><QueryClientProvider client={cache}><App /></QueryClientProvider></MantineProvider>);
  fireEvent.click(await screen.findByRole("row", { name: "Synthetic retained lead, Cable" }));
  expect(await screen.findByRole("dialog")).toBeTruthy();
  expect(screen.getByText("Synthetic referenced project")).toBeTruthy();
  denied = true; state.role = null;
  await cache.invalidateQueries({ queryKey: ["workspace", "designs"] });
  await screen.findByRole("heading", { name: "No workspace access" });
  expect(screen.queryByText("Synthetic retained lead")).toBeNull();
  expect(screen.queryByText("Synthetic referenced project")).toBeNull();
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(screen.queryByRole("navigation", { name: "Workspace" })).toBeNull();
  await waitFor(() => expect(cache.getQueryCache().findAll({ queryKey: ["workspace", "designs"] })).toHaveLength(0));
});
