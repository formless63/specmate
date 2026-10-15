import { MantineProvider } from "@mantine/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { App } from "../../App";
import { project, record, reply, workspaceServer } from "../../test/workspaceServer";

beforeEach(() => { localStorage.setItem("specmate.library.layout", "table"); vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} }); Element.prototype.scrollIntoView = vi.fn(); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const board = record("b1", "Main board", { kind: "board", latest_revision: 2, latest_revision_id: "r2" });
const population = record("pop1", "Main board population", { kind: "pcb_population" });
function serve() {
  return workspaceServer({ projects: [project("p1", "Bench")], library: [board, population] }, path => {
    const url = new URL(path, "http://test"); const match = /^\/api\/v0\/workspace\/library\/([^/]+)$/.exec(url.pathname);
    if (!match) return undefined;
    const found = [board, population].find(row => row.record_id === decodeURIComponent(match[1]!));
    return found ? reply(found) : reply({ error: { message: "Item not found." } }, 404);
  });
}
function start(href: string) {
  window.history.replaceState(null, "", href);
  const cache = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<MantineProvider><QueryClientProvider client={cache}><App /></QueryClientProvider></MantineProvider>);
}
const here = () => `${window.location.pathname}${window.location.search}`;
const at = (href: string) => waitFor(() => expect(here()).toBe(href));
const selection = () => screen.findByRole("region", { name: "Selection" });

test("an old exact board link moves to Boards with the revision and path intact", async () => {
  const { fetchMock } = serve(); start("/design/b1@2/~/J1/3?lens=pcb");
  const inspector = await selection(); expect(await within(inspector).findByText("Main board")).toBeTruthy();
  expect(within(inspector).getByText("r2 exact")).toBeTruthy(); expect(within(inspector).getByText("J1 / 3")).toBeTruthy();
  expect(screen.getByRole("tab", { name: "Boards" }).getAttribute("aria-selected")).toBe("true");
  expect(screen.getByRole("button", { name: "Library" }).getAttribute("aria-current")).toBe("page");
  expect(await screen.findByRole("heading", { name: "Boards in the library" })).toBeTruthy();
  const row = screen.getByRole("button", { name: "Hide uses of Main board" }).closest("tr")!; expect(row.getAttribute("data-probe")).toBe("selected");
  const listed = fetchMock.mock.calls.map(([path]) => String(path)).find(path => path.startsWith("/api/v0/workspace/library?"))!;
  expect(new URL(listed, "http://test").searchParams.getAll("kinds")).toEqual(["board", "pcb_population"]);
  await at("/library/boards/b1@2/~/J1/3");
});

test("selection and rail changes remain browser history entries", async () => {
  serve(); start("/design?lens=pcb");
  fireEvent.click(await screen.findByRole("button", { name: "Show uses of Main board" })); await at("/library/boards/b1");
  expect(await within(await selection()).findByText("Main board")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "History" })); await at("/history");
  expect(await screen.findByText(/Workspace change history is not available yet/)).toBeTruthy();
  expect(screen.queryByRole("region", { name: "Selection" })).toBeNull();
  window.history.back(); await at("/library/boards/b1"); expect(await within(await selection()).findByText("Main board")).toBeTruthy();
  window.history.back(); await at("/library/boards");
  await waitFor(() => expect(screen.queryByRole("region", { name: "Selection" })).toBeNull());
  window.history.forward(); expect(await within(await selection()).findByText("Main board")).toBeTruthy();
});

test("unreadable and malformed targets render access-lost without naming them", async () => {
  const { fetchMock } = serve(); start("/inventory/hidden-item@4");
  const lost = await screen.findByRole("alert"); await within(lost).findByText("Selection not available"); expect(lost.textContent).not.toMatch(/hidden-item|r4/);
  expect(fetchMock.mock.calls.some(([path]) => String(path) === "/api/v0/workspace/library/hidden-item")).toBe(true);
  fireEvent.click(within(lost).getByRole("button", { name: "Clear selection" })); await at("/make/inventory"); cleanup();
  start("/inventory/not%20an%20id"); expect(await within(await screen.findByRole("alert")).findByText("Selection not available")).toBeTruthy();
});

test("an unavailable project falls back without exposing its identity", async () => {
  serve(); start("/project?project=p-elsewhere");
  expect(await screen.findByText("The project in this link is not available. You are in the Library.")).toBeTruthy(); expect(document.body.textContent).not.toContain("p-elsewhere"); await at("/projects");
});

test("project pages recover project context and sign-out clears the address", async () => {
  serve(); start("/project?project=p1");
  await screen.findByRole("heading", { name: "Bench" }); await at("/projects/p1");
  fireEvent.click(screen.getByRole("button", { name: /^Account menu/ }));
  fireEvent.click(await screen.findByRole("menuitem", { name: "Sign out" })); await at("/designs");
});


test.each([
  ["p2", "port", "definition", "/library/connectors/p2@3/~/pins/4?tool=ports", "@3/~/pins/4"],
  ["u1", null, "physical_unit", "/make/units/u1", ""],
  ["src1", null, "source_bundle", "/library/src1?tool=sources", ""],
])("a legacy Library item %s resolves its kind through current workspace authority", async (id, kind, family, expected, suffix) => {
  workspaceServer({}, path => path === `/api/v0/workspace/library/${id}` ? reply(record(id, "Synthetic record", { kind, family: family as "definition" | "physical_unit" | "source_bundle" })) : undefined);
  start(`/library/${id}${suffix}?lens=library-home`);
  await at(expected);
  expect(await within(await selection()).findByText("Synthetic record")).toBeTruthy();
});
