import { MantineProvider } from "@mantine/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { App } from "../../App";
import { project, reply, workspaceServer } from "../../test/workspaceServer";

vi.mock("../cables/CablePanel", () => ({ CablePanel: ({ projectId }: { projectId: string | null }) => {
  const [text, setText] = useState("");
  return <><input aria-label="Unsaved cable buffer" value={text} onChange={event => setText(event.currentTarget.value)} /><output aria-label="Editor project">{projectId ?? "none"}</output></>;
} }));
beforeEach(() => { localStorage.clear(); vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} }); Element.prototype.scrollIntoView = vi.fn(); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
vi.mock("../releases/ReleasesPanel", () => ({ ReleasesPanel: ({ initialReleaseId }: { initialReleaseId: string | null }) => <output aria-label="Opened release">{initialReleaseId}</output> }));
vi.mock("../inventory/InventoryPanel", () => ({ InventoryPanel: ({ initialWorkId }: { initialWorkId: string | null }) => <output aria-label="Opened work">{initialWorkId}</output> }));
function start(references: import("./api").ResolvedReference[] = []) {
  const server = workspaceServer({ projects: [project("a", "Project A"), project("b", "Project B")], details: { b: { references } } }, (path, init) => {
    if (path.startsWith("/api/v0/workspace/designs?")) return reply({ results: [], next_after: null });
    if (path.startsWith("/api/v0/knowledge/")) return reply({ items: [], has_more: false });
    if (path === "/api/v0/access/workspace") return reply({ role: "editor" });
    if (path === "/api/v0/operations" && JSON.parse(String(init?.body)).operation === "release.list") return reply({ result: { releases: [], total: 0 } });
    return undefined;
  });
  window.history.replaceState(null, "", "/designs/new?kind=cable");
  const cache = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<MantineProvider env="test"><QueryClientProvider client={cache}><App /></QueryClientProvider></MantineProvider>);
  return { ...server, cache };
}
function rail(name: string) { fireEvent.click(within(screen.getByRole("navigation", { name: "Workspace" })).getByRole("button", { name })); }
async function returnToCable() {
  rail("Designs");
  fireEvent.click(await screen.findByRole("button", { name: "New design" }));
  fireEvent.click(await screen.findByRole("menuitem", { name: "Cable", hidden: true }));
  fireEvent.click(await screen.findByRole("button", { name: "Keep existing form" }));
}

test("project list filters and project pages retain an unsaved library-only cable editor", async () => {
  const { cache, fetchMock } = start();
  const buffer = await screen.findByLabelText("Unsaved cable buffer"); fireEvent.change(buffer, { target: { value: "Uncommitted work" } });
  cache.setQueryData(["workspace-private"], "retained");
  rail("Designs");
  fireEvent.click(await screen.findByRole("combobox", { name: "Project filter" }));
  fireEvent.click(await screen.findByRole("option", { name: "Project A", hidden: true }));
  await waitFor(() => expect(window.location.search).toContain("project=a"));
  await waitFor(() => expect(fetchMock.mock.calls.some(([url]) => String(url).includes("/workspace/designs?") && String(url).includes("project_id=a"))).toBe(true));
  await returnToCable();
  expect((screen.getByLabelText("Unsaved cable buffer") as HTMLInputElement).value).toBe("Uncommitted work");
  expect(screen.getByLabelText("Editor project").textContent).toBe("none");
  expect(cache.getQueryData(["workspace-private"])).toBe("retained");
  rail("Projects"); fireEvent.click(await screen.findByRole("button", { name: "Open Project B" }));
  await screen.findByRole("heading", { name: "Project B" });
  expect(window.location.pathname).toBe("/projects/b");
  await returnToCable();
  expect((screen.getByLabelText("Unsaved cable buffer") as HTMLInputElement).value).toBe("Uncommitted work");
  expect(screen.getByLabelText("Editor project").textContent).toBe("none");
  expect(cache.getQueryData(["workspace-private"])).toBe("retained");
  fireEvent.click(screen.getByRole("button", { name: /^Account menu/ }));fireEvent.click(await screen.findByRole("menuitem", { name: "Sign out" }));
  await screen.findByRole("heading", { name: "Sign in" });
  expect(screen.queryByLabelText("Unsaved cable buffer")).toBeNull();expect(cache.getQueryData(["workspace-private"])).toBeUndefined();
});


test.each([
  ["revision", "revision-id", "definition-id", "cable", "/designs/definition-id@1", null],
  ["release", "release-id", null, "release", "/products/releases?release=release-id", "Opened release"],
  ["work_batch", "batch-id", null, "batch", "/make/inventory?work_batch=batch-id", "Opened work"],
] as const)("a project %s reference opens its actual target and preserves exact identity", async (kind, targetId, definitionId, itemKind, expected, output) => {
  const reference: import("./api").ResolvedReference = { reference_id: "ref", kind, target_id: targetId, pin: kind === "revision" ? "exact" : "floating", role: "uses", note: "", added_by: "synthetic-user", added_at: "2026-01-01T00:00:00Z", removed: false, removed_at: null, removal_reason: "", label: "Referenced target", item_kind: itemKind, definition_id: definitionId, revision: kind === "revision" ? 1 : null, latest_revision: kind === "revision" ? 3 : null };
  const { fetchMock } = start([reference]);await screen.findByLabelText("Unsaved cable buffer");rail("Projects");fireEvent.click(await screen.findByRole("button", { name: "Open Project B" }));
  fireEvent.click(await screen.findByRole("button", { name: "Open Referenced target" }));
  await waitFor(() => expect(window.location.pathname + window.location.search).toBe(expected));
  if (output) { expect(await screen.findByLabelText(output)).toHaveProperty("textContent", targetId);expect(fetchMock.mock.calls.some(([url]) => String(url) === `/api/v0/workspace/library/${targetId}`)).toBe(false); }
});
