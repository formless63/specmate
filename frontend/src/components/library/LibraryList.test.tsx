import { MantineProvider } from "@mantine/core";
import { createMemoryHistory } from "@tanstack/react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { PermissionsProvider } from "../../lib/permissions";
import { NavigationProvider, useNavigation } from "../../features/navigation";
import { ProbeProvider } from "../../features/probe";
import { project, record, ROLE_PERMISSIONS } from "../../test/workspaceServer";
import type { LibraryTableRecord } from "../../features/library-gallery/table-api";
import { LibraryList, TYPED_LIBRARY_VIEWS } from "./LibraryList";

const summary = { basis: "latest_frozen" as const, revision_id: "rev-a", draft_id: null, draft_version: null, numbers: [], fields: [{ key: "family", label: "Family", value: "Round", unit: null }], flags: [] };
const a: LibraryTableRecord = { ...record("a", "Synthetic A", { kind: "connector_body", latest_revision: 1 }), summary };
const b: LibraryTableRecord = { ...record("b", "Synthetic B", { kind: "connector_body", latest_revision: 2 }), summary: { ...summary, revision_id: "rev-b", numbers: [{ manufacturer: "Synthetic", value: "SP-2", basis: "manufacturer_variant" }], fields: [{ key: "family", label: "Family", value: null, unit: null }] } };
const pinout: LibraryTableRecord = { ...record("p", "Synthetic pinout", { kind: "pinout", latest_revision: null }), summary: { ...summary, basis: "newest_draft", revision_id: null, draft_id: "draft-p", draft_version: 3 } };

beforeEach(() => { localStorage.setItem("specmate.library.layout", "table"); vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} }); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

function show({ role = "editor", path = "/library/connectors?layout=table", rows = [a, b, pinout], paged = false } = {}) {
  const history = createMemoryHistory({ initialEntries: [path] });
  const editor = { reveal: vi.fn() };
  const fetchMock = vi.fn(async (url: string) => {
    const parsed = new URL(url, "http://test");
    if (parsed.pathname === "/api/v0/operations") return new Response(JSON.stringify({ result: { previews: [] } }));
    const after = parsed.searchParams.get("after");
    const filtered = rows.filter(row => parsed.searchParams.getAll("kinds").includes(row.kind!));
    return new Response(JSON.stringify({ workspace_id: "w", family: "definition", project_id: parsed.searchParams.get("project_id"), results: paged ? after ? filtered.slice(1) : filtered.slice(0, 1) : filtered, next_after: paged && !after ? "next" : null }));
  });
  vi.stubGlobal("fetch", fetchMock);
  const cache = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  function View() {
    const nav = useNavigation()!;
    if (!TYPED_LIBRARY_VIEWS[nav.location.lens]) return <span>Tool destination</span>;
    return <ProbeProvider probe={nav.location.probe} onProbe={probe => nav.navigate({ probe })}><LibraryList toolId={nav.location.lens} projectFilterId={nav.location.project} projects={[project("bench", "Synthetic bench")]} principalKey="owner" onOpenInProject={vi.fn()} editor={editor} /></ProbeProvider>;
  }
  render(<MantineProvider env="test"><QueryClientProvider client={cache}><PermissionsProvider permissions={ROLE_PERMISSIONS[role]}><NavigationProvider history={history}><View /></NavigationProvider></PermissionsProvider></QueryClientProvider></MantineProvider>);
  return { history, editor, fetchMock, cache };
}

test("typed table uses exact manufacturer numbers and explicit unknowns", async () => {
  show();
  const table = await screen.findByRole("table");
  expect(await within(table).findByText("Synthetic A")).toBeTruthy();
  expect(within(table).getByRole("columnheader", { name: "PN" })).toBeTruthy();
  expect(within(table).getByRole("columnheader", { name: "Family" })).toBeTruthy();
  for (const value of ["Unassigned", "SP-2", "Unknown", "Frozen r2"]) expect(within(table).getByText(value)).toBeTruthy();
  expect(within(table).getAllByText("Not evaluated")).toHaveLength(2);
});

test("Pinouts and device ports are visible and New pinout requests the intended editor", async () => {
  const { history, editor, fetchMock } = show();
  fireEvent.click(screen.getByRole("button", { name: /^Pinouts$/ }));
  expect(await screen.findByRole("heading", { name: "Pinouts" })).toBeTruthy();
  expect(history.location.href).toContain("kind=pinout");
  await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining("kinds=pinout"), expect.anything()));
  expect(await screen.findByText("Saved draft v3")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "New pinout" }));
  expect(editor.reveal).toHaveBeenLastCalledWith(true, "pinout");
  fireEvent.click(screen.getByRole("button", { name: /^Device ports$/ }));
  expect(history.location.href).toContain("tool=ports");
  expect(screen.getByRole("button", { name: "Saved end stacks" })).toBeTruthy();
});

test("search and page continuation are server requests and back restores search", async () => {
  const { history, fetchMock } = show({ paged: true });
  expect(await screen.findByText("Synthetic A")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Load more" }));
  expect(await screen.findByText("Synthetic B")).toBeTruthy();
  expect(fetchMock.mock.calls.some(([url]) => url.includes("after=next"))).toBe(true);
  fireEvent.change(screen.getByRole("textbox", { name: "Search Library" }), { target: { value: "SP-2" } });
  await waitFor(() => expect(history.location.href).toContain("q=SP-2"));
  expect(fetchMock.mock.calls.some(([url]) => url.includes("query=SP-2"))).toBe(true);
  history.push("/library/connectors?layout=table&q=Round");
  await waitFor(() => expect((screen.getByRole("textbox", { name: "Search Library" }) as HTMLInputElement).value).toBe("Round"));
  history.back();
  await waitFor(() => expect((screen.getByRole("textbox", { name: "Search Library" }) as HTMLInputElement).value).toBe("SP-2"));
});

test("compare captures exact saved states and excludes unsaved edits", async () => {
  const { cache } = show();
  fireEvent.click(await screen.findByRole("checkbox", { name: "Compare Synthetic A" }));
  expect((screen.getByRole("button", { name: "Compare 1/2" }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole("checkbox", { name: "Compare Synthetic B" }));
  await cache.invalidateQueries({ queryKey: ["workspace", "library"] });
  fireEvent.click(screen.getByRole("button", { name: "Compare 2/2" }));
  const dialog = screen.getByRole("dialog", { name: "Compare saved states" });
  expect(within(dialog).getByText("rev-a")).toBeTruthy();
  expect(within(dialog).getByText("rev-b")).toBeTruthy();
  expect(within(dialog).getByText(/Unsaved editor changes are excluded/)).toBeTruthy();
  expect(within(dialog).getByText("Unknown")).toBeTruthy();
});

test("viewer can browse and compare without New or import and row opens typed path", async () => {
  const { history, editor } = show({ role: "viewer" });
  fireEvent.click(await screen.findByRole("button", { name: "Synthetic A" }));
  expect(history.location.href).toContain("/library/connectors/a");
  expect(editor.reveal).toHaveBeenCalledWith(false);
  expect(screen.queryByRole("button", { name: /^New / })).toBeNull();
  expect(screen.queryByRole("button", { name: /^Import$/ })).toBeNull();
  expect(screen.getByRole("checkbox", { name: "Compare Synthetic A" })).toBeTruthy();
});

test("Import launches existing tools without advertising a general CSV importer", async () => {
  const { history } = show();
  fireEvent.click(screen.getByRole("button", { name: /^Import$/ }));
  expect(screen.getByRole("menuitem", { name: "KiCad board intake…" })).toBeTruthy();
  expect(screen.getByRole("menuitem", { name: "Adopt catalog pack…" })).toBeTruthy();
  expect(screen.queryByRole("menuitem", { name: /CSV/i })).toBeNull();
  fireEvent.click(screen.getByRole("menuitem", { name: "Register source files…" }));
  expect(history.location.href).toContain("tool=sources");
});

test("comparison cannot mix definition kinds", async () => {
  const part = { ...a, kind: "part" };
  const material = { ...b, kind: "material" };
  show({ path: "/library/parts?layout=table", rows: [part, material] });
  fireEvent.click(await screen.findByRole("checkbox", { name: "Compare Synthetic A" }));
  expect((screen.getByRole("checkbox", { name: "Compare Synthetic B" }) as HTMLInputElement).disabled).toBe(true);
  expect((screen.getByRole("button", { name: "Compare 1/2" }) as HTMLButtonElement).disabled).toBe(true);
});

test("a failed authority refresh withdraws retained rows, selected details and comparison", async () => {
  const { cache, fetchMock } = show();
  fireEvent.click(await screen.findByRole("checkbox", { name: "Compare Synthetic A" }));
  fireEvent.click(screen.getByRole("checkbox", { name: "Compare Synthetic B" }));
  fireEvent.click(screen.getByRole("button", { name: "Synthetic A" }));
  fireEvent.click(screen.getByRole("button", { name: "Compare 2/2" }));
  expect(screen.getByRole("dialog", { name: "Compare saved states" })).toBeTruthy();
  fetchMock.mockResolvedValue(new Response(JSON.stringify({ error: { message: "Access denied" } }), { status: 403 }));
  await cache.invalidateQueries({ queryKey: ["workspace", "library"] });
  expect(await screen.findByText("Access denied")).toBeTruthy();
  expect(screen.queryByRole("dialog", { name: "Compare saved states" })).toBeNull();
  expect(screen.queryByText("Synthetic A")).toBeNull();
  expect(screen.queryByText("SP-2")).toBeNull();
  expect(screen.queryByRole("region", { name: /Selected/ })).toBeNull();
  expect(screen.getByRole("textbox", { name: "Search Library" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Refresh" })).toBeTruthy();
});
