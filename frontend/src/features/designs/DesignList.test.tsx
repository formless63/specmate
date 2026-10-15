import { MantineProvider } from "@mantine/core";
import { createMemoryHistory } from "@tanstack/react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { PermissionsProvider } from "../../lib/permissions";
import { record, reply } from "../../test/workspaceServer";
import { NavigationProvider } from "../navigation";
import { DesignList } from "./DesignList";
import type { DesignRow } from "./api";

const row: DesignRow = { ...record("c1", "Bench lead", { kind: "cable", latest_revision: 2 }), design: {
  basis: "latest_frozen", revision_id: "r2", revision: 2, draft_id: null, review: "reviewed",
  from: { label: "Input", basis: "intent_port", revision_id: "port1" },
  to: { label: "End B", basis: "endpoint_label", revision_id: null },
  stocks: [{ definition_id: "s1", revision_id: "sr1", revision: 1, label: "Pair stock" }], boards: [], checks: "not_evaluated",
} };

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal("fetch", vi.fn((path: string, init?: RequestInit) => {
    if (String(path).startsWith("/api/v0/workspace/designs?")) return Promise.resolve(reply({ workspace_id: "w1", family: "definition", project_id: null, results: [row], next_after: null }));
    const operation = init?.body && JSON.parse(String(init.body)).operation;
    if (operation === "library.previews") return Promise.resolve(reply({ result: { previews: [] } }));
    throw new Error(`Unexpected request ${path}`);
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

function show(at = "/designs", editable = true) {
  const history = createMemoryHistory({ initialEntries: [at] });
  const open = vi.fn(); const create = vi.fn(); const accessLost = vi.fn();
  const cache = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<MantineProvider><QueryClientProvider client={cache}><NavigationProvider history={history}>
    <PermissionsProvider permissions={editable ? ["workspace.read", "item.create"] : ["workspace.read"]}>
      <DesignList principalKey="member" projectId={null} projects={[]} onOpen={open} onCreate={create} onAccessLost={accessLost} />
    </PermissionsProvider></NavigationProvider></QueryClientProvider></MantineProvider>);
  return { history, open, create, cache, accessLost };
}

test("a design name and Enter open the record; review is never presented as passing checks", async () => {
  const { open } = show();
  fireEvent.click(await screen.findByRole("button", { name: "Bench lead" }));
  expect(open).toHaveBeenCalledWith(row);
  const design = screen.getByRole("row", { name: "Bench lead, Cable" });
  fireEvent.keyDown(design, { key: "Enter" });
  expect(open).toHaveBeenCalledTimes(2);
  expect(within(design).getByText("Review recorded")).toBeTruthy();
  expect(within(design).getByText("Checks not evaluated here")).toBeTruthy();
  expect(within(design).getByText("end label")).toBeTruthy();
  expect(screen.queryByText(/^pass$/i)).toBeNull();
});

test("URL filters are sent to the server and removing a chip persists in history", async () => {
  const { history } = show("/designs?from=Input&stock=Pair&kind=cable");
  await screen.findByRole("button", { name: "Bench lead" });
  const firstUrl = new URL(String(vi.mocked(fetch).mock.calls[0]![0]), "http://test.invalid");
  expect(firstUrl.searchParams.get("from")).toBe("Input");
  expect(firstUrl.searchParams.get("stock")).toBe("Pair");
  expect(firstUrl.searchParams.get("kind")).toBe("cable");
  fireEvent.click(screen.getByRole("button", { name: "Remove Stock filter" }));
  expect(history.location.search).not.toContain("stock=");
  expect(history.location.search).toContain("from=Input");
  await waitFor(() => expect(vi.mocked(fetch).mock.calls.filter(([path]) => String(path).startsWith("/api/v0/workspace/designs?")).length).toBe(2));
});

test("viewer can inspect a selected row and open it but cannot create", async () => {
  const { open, create } = show("/designs", false);
  const button = screen.getByRole("button", { name: "New design" }) as HTMLButtonElement;
  expect(button.disabled).toBe(true);
  fireEvent.click(button);
  expect(create).not.toHaveBeenCalled();
  fireEvent.click(await screen.findByRole("row", { name: "Bench lead, Cable" }));
  const drawer = await screen.findByRole("dialog");
  expect(within(drawer).getByText("Pair stock · r1")).toBeTruthy();
  expect(within(drawer).getByText("Not declared")).toBeTruthy();
  fireEvent.click(within(drawer).getByRole("button", { name: "Open design" }));
  expect(open).toHaveBeenCalledWith(row);
});

test("new design offers each existing design kind without creating anything on selection of the menu", async () => {
  const { create } = show();
  await screen.findByRole("button", { name: "Bench lead" });
  fireEvent.click(screen.getByRole("button", { name: "New design" }));
  expect(create).not.toHaveBeenCalled();
  fireEvent.click(await screen.findByRole("menuitem", { name: "Harness" }));
  expect(create).toHaveBeenCalledWith("harness");
});


test.each([401, 403, 404])("a denied %s refetch withdraws retained rows and the selected drawer", async (status) => {
  const { cache, accessLost } = show();
  fireEvent.click(await screen.findByRole("row", { name: "Bench lead, Cable" }));
  expect(await screen.findByRole("dialog")).toBeTruthy();
  expect(screen.getByText("Pair stock · r1")).toBeTruthy();
  const original = vi.mocked(fetch).getMockImplementation()!;
  vi.mocked(fetch).mockImplementation((input, init) => String(input).startsWith("/api/v0/workspace/designs?")
    ? Promise.resolve(reply({ error: { message: "Designs unavailable." } }, status)) : original(input, init));
  await cache.invalidateQueries({ queryKey: ["workspace", "designs"] });
  await waitFor(() => expect(accessLost).toHaveBeenCalledTimes(1));
  expect(screen.queryByRole("row", { name: "Bench lead, Cable" })).toBeNull();
  expect(screen.queryByText("Bench lead")).toBeNull();
  expect(screen.queryByText(/Pair stock/)).toBeNull();
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
});

test("a transient server failure keeps retained content without claiming an authority loss", async () => {
  const { cache, accessLost } = show();
  fireEvent.click(await screen.findByRole("row", { name: "Bench lead, Cable" }));
  expect(await screen.findByRole("dialog")).toBeTruthy();
  const original = vi.mocked(fetch).getMockImplementation()!;
  vi.mocked(fetch).mockImplementation((input, init) => String(input).startsWith("/api/v0/workspace/designs?")
    ? Promise.resolve(reply({ error: { message: "Temporary server failure." } }, 500)) : original(input, init));
  await cache.invalidateQueries({ queryKey: ["workspace", "designs"] });
  expect(await screen.findByRole("alert")).toBeTruthy();
  expect(screen.getByRole("row", { name: "Bench lead, Cable" })).toBeTruthy();
  expect(screen.getByRole("dialog")).toBeTruthy();
  expect(accessLost).not.toHaveBeenCalled();
});
