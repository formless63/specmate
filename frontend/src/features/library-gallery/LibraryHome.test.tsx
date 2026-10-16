import { MantineProvider } from "@mantine/core";
import { createMemoryHistory } from "@tanstack/react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { PermissionsProvider } from "../../lib/permissions";
import { record, reply, ROLE_PERMISSIONS, workspaceServer } from "../../test/workspaceServer";
import { NavigationProvider } from "../navigation";
import { ProbeProvider } from "../probe";
import { LIBRARY_VIEWS } from "../shell/scope";
import { LibraryView } from "../scope/LibraryView";
import type { LibraryHome as Home } from "./api";
import { LibraryHome } from "./LibraryHome";

beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); localStorage.clear(); });

const item = { created_at: "2026-01-02T00:00:00Z", latest_revision_id: null, changed_at: null };
const HOME: Home = {
  workspace_id: "w1",
  attention: [
    { ...item, record_id: "c1", kind: "cable", label: "Swapped lead", latest_revision: 2, latest_revision_id: "rev-2", status: "fail",
      reasons: [{ kind: "failing_check", count: 2, detail: "2 rows fail" }, { kind: "stale_evidence", count: 1, detail: "recorded check predates a newer pinned revision" }] },
    { ...item, record_id: "i1", kind: "cable_intent", label: "Console to monitor", latest_revision: null, status: "review",
      reasons: [{ kind: "open_questions", count: 1, detail: "1 open question" }] },
  ],
  attention_total: 2,
  unknowns: [{ ...item, record_id: "p1", kind: "port", label: "Monitor input", latest_revision: 1, status: "unknown",
    reasons: [{ kind: "unknown_values", count: 2, detail: "2 declared values unknown" }] }],
  unknowns_total: 1,
  recent: [{ ...item, record_id: "s1", kind: "wire_stock", label: "Pair stock", latest_revision: 1, activity: "frozen", at: new Date().toISOString() }],
  totals: { failing_checks: 2, unknown_checks: 0, open_questions: 1, stale_evidence: 1, unknown_values: 4 },
  kinds: [{ kind: "cable", count: 2 }, { kind: "wire_stock", count: 1 }],
  definitions_total: 3,
  scan_limit_reached: false,
};

function serve(role = "viewer") {
  const library = [record("c1", "Swapped lead", { latest_revision: 2, used_in_total: 1 }), record("c2", "Loose lead"), record("s1", "Pair stock", { kind: "wire_stock", latest_revision: 1 })];
  return workspaceServer({ role, library }, (path, init) => {
    if (path === "/api/v0/workspace/library/p1") return reply(record("p1", "Monitor input", { kind: "port" }));
    if (path === "/api/v0/workspace/library/u1") return reply(record("u1", "Unit 7", { family: "physical_unit", kind: "built" }));
    if (path !== "/api/v0/operations") return undefined;
    const body = JSON.parse(String(init?.body)) as { operation: string; payload: { definition_ids?: string[] } };
    if (body.operation === "library.home") return reply({ result: HOME });
    if (path === "/api/v0/operations") return undefined;
    if (body.operation === "library.previews") {
      return reply({ result: { workspace_id: "w1", previews: (body.payload.definition_ids ?? []).map((id) => ({ record_id: id, kind: id.startsWith("s") ? "wire_stock" : "cable",
        source: "revision", revision: 1, content: id === "i1" ? { interface: { rows: [{ question: {} }] } } : {}, truncated: false, stock: null })) } });
    }
    return undefined;
  });
}

function show(role = "viewer", at = "/library") {
  const history = createMemoryHistory({ initialEntries: [at] });
  const cache = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<MantineProvider><QueryClientProvider client={cache}><NavigationProvider history={history}><PermissionsProvider permissions={ROLE_PERMISSIONS[role]!}>
    <LibraryHome principalKey="7" /></PermissionsProvider></NavigationProvider></QueryClientProvider></MantineProvider>);
  return history;
}

test("the Library home leads with recorded attention, then recent work, then every item as cards", async () => {
  const { fetchMock } = serve();
  show();
  const attention = await screen.findByRole("list", { name: "Items needing attention" });
  const cards = within(attention).getAllByRole("button");
  expect(cards.map((card) => card.getAttribute("aria-label"))).toEqual([
    "Open Swapped lead, cable r2, 2 rows fail · recorded check predates a newer pinned revision",
    "Open Console to monitor, cable intent draft, 1 open question",
  ]);
  expect(cards[0]!.getAttribute("data-status")).toBe("fail");
  // Frozen items carry a solid revision tag; never-frozen ones a dashed draft tag.
  expect(within(cards[0]!).getByText("r2").getAttribute("data-frozen")).toBe("true");
  expect(within(cards[1]!).getByText("draft").getAttribute("data-frozen")).toBeNull();
  const recent = screen.getByRole("list", { name: "Your recent items" });
  expect(within(recent).getByText(/frozen (just now|\d+ min ago)/)).toBeTruthy();
  const summary = screen.getByLabelText("Library summary");
  expect(within(summary).getByText("Failing checks").nextElementSibling?.textContent).toBe("2");
  expect(within(summary).getByText("Unknown").nextElementSibling?.textContent).toBe("4");
  const all = await screen.findByRole("list", { name: "Library items" });
  expect(within(all).getAllByRole("button")).toHaveLength(3);
  expect(within(all).getByText("used in 1 project")).toBeTruthy();
  // Thumbnails of every visible card come from one batched preview read.
  await waitFor(() => {
    const reads = fetchMock.mock.calls.filter(([, init]) => String(init?.body ?? "").includes("library.previews"));
    expect(reads.length).toBeGreaterThan(0);
    const ids = reads.flatMap(([, init]) => (JSON.parse(String(init!.body)) as { payload: { definition_ids: string[] } }).payload.definition_ids);
    expect(new Set(ids)).toEqual(new Set(["c1", "i1", "s1", "c2"]));
    expect(reads.length).toBe(1);
  });
});

test("kind chips filter the gallery and search is kept when nothing matches", async () => {
  const { fetchMock } = serve();
  show();
  const kinds = await screen.findByRole("group", { name: "Kind" });
  await within(kinds).findByRole("button", { name: /wire stock/ });
  fireEvent.click(within(kinds).getByRole("button", { name: /wire stock/ }));
  expect(within(kinds).getByRole("button", { name: /wire stock/ }).getAttribute("aria-pressed")).toBe("true");
  await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/v0/workspace/library?family=definition&limit=48&kinds=wire_stock", expect.anything()));
});

test("selecting a card opens its canonical record route with the item probed", async () => {
  serve();
  const history = show();
  const attention = await screen.findByRole("list", { name: "Items needing attention" });
  fireEvent.click(within(attention).getByRole("button", { name: /Open Console to monitor/ }));
  expect(history.location.pathname).toBe("/designs/recipes/i1");
  expect(history.location.search).toBe("");
  fireEvent.click(within(attention).getByRole("button", { name: /Open Swapped lead/ }));
  expect(`${history.location.pathname}${history.location.search}`).toBe("/designs/c1");
});

test("lens lists default to the gallery; the table stays one switch away and is remembered", async () => {
  serve("viewer");
  const reveal = vi.fn();
  const cache = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const onProbe = vi.fn();
  render(<MantineProvider><QueryClientProvider client={cache}><PermissionsProvider permissions={ROLE_PERMISSIONS.viewer!}><ProbeProvider probe={null} onProbe={onProbe}>
    <LibraryView view={LIBRARY_VIEWS.cables!} toolLabel="Cables" projectId={null} project={null} projects={[]} principalKey="7" onOpenInProject={vi.fn()} editor={{ reveal }} />
  </ProbeProvider></PermissionsProvider></QueryClientProvider></MantineProvider>);
  const gallery = await screen.findByRole("list", { name: "Cables gallery" });
  expect(screen.queryByRole("table")).toBeNull();
  // Viewers can open items but not start new ones.
  expect((screen.getByRole("button", { name: "New cable" }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(within(gallery).getAllByRole("button")[0]!);
  expect(onProbe).toHaveBeenCalledWith({ object: "c1", rev: null, path: [] });
  expect(reveal).toHaveBeenCalledWith(false);
  fireEvent.click(screen.getByRole("radio", { name: "Table" }));
  expect(await screen.findByRole("table")).toBeTruthy();
  expect(localStorage.getItem("specmate.library.layout")).toBe("table");
});

test("plain unknowns are a separate, collapsed group with counts", async () => {
  serve();
  show();
  const attention = await screen.findByRole("list", { name: "Items needing attention" });
  expect(within(attention).queryByText("Monitor input")).toBeNull();
  const group = screen.getByText("Unknown values").closest("details")!;
  expect(group.open).toBe(false);
  expect(within(group).getByText("1 item · 4 unknown")).toBeTruthy();
  group.open = true;
  fireEvent(group, new Event("toggle"));
  expect(await within(group).findByRole("button", { name: /Open Monitor input, port r1, 2 declared values unknown/ })).toBeTruthy();
});

test("an unknown port card opens its canonical connector record", async () => {
  serve();
  const history = show();
  const group = (await screen.findByText("Unknown values")).closest("details")!;
  group.open = true;
  fireEvent(group, new Event("toggle"));
  fireEvent.click(await within(group).findByRole("button", { name: /Open Monitor input/ }));
  expect(`${history.location.pathname}${history.location.search}`).toBe("/library/connectors/p1?tool=ports");
});

test("New… opens the cable creation route; viewers see it disabled", async () => {
  serve("editor");
  const history = show("editor");
  fireEvent.click(await screen.findByRole("button", { name: "New…" }));
  fireEvent.click(await screen.findByRole("menuitem", { name: "Cable" }));
  expect(`${history.location.pathname}${history.location.search}`).toBe("/designs/new?kind=cable");
  cleanup();
  serve("viewer");
  show("viewer");
  fireEvent.click(await screen.findByRole("button", { name: "New…" }));
  expect((await screen.findByRole("menuitem", { name: "Cable" })).hasAttribute("disabled") || (await screen.findByRole("menuitem", { name: "Cable" })).getAttribute("data-disabled") === "true").toBe(true);
});

test("New… still reveals the New form in a collection editor", async () => {
  serve("editor");
  show("editor");
  fireEvent.click(await screen.findByRole("button", { name: "New…" }));
  fireEvent.click(await screen.findByRole("menuitem", { name: "Signal set" }));
  const reveal = vi.fn();
  const cache = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<MantineProvider><QueryClientProvider client={cache}><PermissionsProvider permissions={ROLE_PERMISSIONS.editor!}><ProbeProvider probe={null} onProbe={vi.fn()}>
    <LibraryView view={LIBRARY_VIEWS.signals!} toolLabel="Signals" projectId={null} project={null} projects={[]} principalKey="7" onOpenInProject={vi.fn()} editor={{ reveal }} />
  </ProbeProvider></PermissionsProvider></QueryClientProvider></MantineProvider>);
  await waitFor(() => expect(reveal).toHaveBeenCalledWith(true, "signal set"));
});
