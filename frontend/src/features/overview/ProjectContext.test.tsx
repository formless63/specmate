import { MantineProvider } from "@mantine/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { ProjectContext } from "./ProjectContext";
import { reply } from "../../test/workspaceServer";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
function show() {
  const cache = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const notes = vi.fn(); const lost = vi.fn();
  render(<MantineProvider env="test"><QueryClientProvider client={cache}><ProjectContext workspaceId="workspace" projectId="project" onOpenNotes={notes} onAccessLost={lost} /></QueryClientProvider></MantineProvider>);
  return { cache, notes, lost };
}
test("project context uses existing filtered reads, shows only recent decisions and preserves workspace membership semantics", async () => {
  const reads: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (path: string, init?: RequestInit) => {
    reads.push(path);
    if (path.includes("/knowledge/")) return reply({ items: [{ item_id: "d1", kind: "decision", current: { title: "Synthetic material choice", decision_status: "accepted" } }, { item_id: "n1", kind: "note", current: { title: "Ordinary note" } }], has_more: true });
    if (path === "/api/v0/operations") { expect(JSON.parse(String(init?.body))).toMatchObject({ operation: "release.list", payload: { workspace_id: "workspace", project_id: "project" } }); return reply({ result: { releases: [{ release_id: "r1", name: "Synthetic release", status: "clear" }], total: 1 } }); }
    return reply({ role: "viewer" });
  }));
  const { notes } = show();
  expect(await screen.findByText(/Synthetic material choice/)).toBeTruthy();expect(screen.queryByText("Ordinary note")).toBeNull();
  expect(await screen.findByText(/Synthetic release/)).toBeTruthy();expect(screen.getByText(/Projects have no separate membership/)).toBeTruthy();expect(screen.getByText(/Your workspace role: viewer/)).toBeTruthy();
  expect(reads).toContain("/api/v0/knowledge/workspaces/workspace/items?project_id=project&offset=0&limit=20");
  fireEvent.click(screen.getByRole("button", { name: "Notes & files" }));expect(notes).toHaveBeenCalledOnce();
});
test("an administrator can inspect the workspace roster and a later denied refetch withdraws retained context", async () => {
  let denied = false;
  vi.stubGlobal("fetch", vi.fn(async (path: string) => {
    if (denied) return reply({ error: { message: "Not found." } }, 404);
    if (path.includes("/knowledge/")) return reply({ items: [], has_more: false });
    if (path === "/api/v0/operations") return reply({ result: { releases: [], total: 0 } });
    return reply({ role: "admin", members: [{ username: "synthetic-member", role: "editor" }] });
  }));
  const { cache, lost } = show();expect(await screen.findByText("synthetic-member")).toBeTruthy();
  denied = true;await cache.invalidateQueries({ queryKey: ["project-context"] });
  await waitFor(() => expect(lost).toHaveBeenCalled());expect(within(screen.getByRole("region", { name: "Project members" })).queryByText("synthetic-member")).toBeNull();
});
