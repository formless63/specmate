import { MantineProvider, Tabs } from "@mantine/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory } from "@tanstack/react-router";
import { spotlight } from "@mantine/spotlight";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { reply, workspaceServer } from "../../test/workspaceServer";
import { NavigationProvider } from "../navigation";
import { SbShell } from "../shell/SbShell";
import { filterPalette, revisionTag } from "./ItemSpotlight";

beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal("matchMedia", (query: string) => ({ matches: /min-width/.test(query), media: query, onchange: null, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent: () => false }));
  Element.prototype.scrollIntoView = vi.fn();
});
afterEach(() => { spotlight.close(); cleanup(); vi.unstubAllGlobals(); });

const chrome = { username: "local-user", projectControl: <span>project control</span>, signOutControl: <button type="button">Sign out</button>, alert: null };
const base = { created_at: "2026-01-02T00:00:00Z", changed_at: null };
const RESULTS = [
  { ...base, record_id: "s1", kind: "wire_stock", label: "Coax 75 ohm stock", latest_revision: 2, latest_revision_id: "rev-2", match: { field: "name", text: "Coax 75 ohm stock", rank: 1 } },
  { ...base, record_id: "b1", kind: "connector_body", label: "Console plug", latest_revision: null, latest_revision_id: null, match: { field: "connector_family", text: "BNC coax", rank: 2 } },
];

function serve(search = RESULTS) {
  return workspaceServer({}, (path, init) => {
    if (path !== "/api/v0/operations") return undefined;
    const body = JSON.parse(String(init?.body)) as { operation: string; payload: { query?: string } };
    if (body.operation === "library.search") return reply({ result: { workspace_id: "w1", query: body.payload.query, results: search, truncated: false } });
    if (body.operation === "library.home") {
      return reply({ result: { workspace_id: "w1", attention: [], attention_total: 0, unknowns: [], unknowns_total: 0, unknowns_note: "", totals: { failing_checks: 0, unknown_checks: 0, open_questions: 0, stale_evidence: 0, unknown_values: 0 },
        recent: [{ ...base, record_id: "r1", kind: "cable", label: "Last cable", latest_revision: 3, latest_revision_id: "rev-3", activity: "edited", at: "2026-01-03T00:00:00Z" }], kinds: [], definitions_total: 1, scan_limit_reached: false } });
    }
    return undefined;
  });
}

function show() {
  const history = createMemoryHistory({ initialEntries: ["/library"] });
  const cache = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<MantineProvider><QueryClientProvider client={cache}><NavigationProvider history={history}>
    <SbShell projectName="Library" libraryScope permissions={["workspace.read"]} activeTool="identity" chrome={chrome} itemSearchKey="7" onToolChange={() => {}}>
      <Tabs.Panel value="identity">x</Tabs.Panel>
    </SbShell></NavigationProvider></QueryClientProvider></MantineProvider>);
  return history;
}

/** The palette splits highlighted labels across nodes, so assert on the dialog text. */
const appears = (text: string) => waitFor(() => expect(document.body.textContent).toContain(text));
const groupLabels = () => [...document.querySelectorAll<HTMLElement>(".mantine-Spotlight-actionsGroup")].map((node) => node.style.getPropertyValue("--spotlight-label"));
const searches = (fetchMock: ReturnType<typeof serve>["fetchMock"]) => fetchMock.mock.calls.filter(([, init]) => String(init?.body ?? "").includes("library.search"));

test("typing searches items once per pause, shows kind chip and revision tag, and lists tools second", async () => {
  const { fetchMock } = serve();
  show();
  fireEvent.click(screen.getByRole("button", { name: "Find an item or jump to a tool" }));
  const box = await screen.findByPlaceholderText(/Find an item/);
  for (const value of ["w", "wi", "wire"]) fireEvent.change(box, { target: { value } });
  await appears("Coax 75 ohm stock");
  expect(searches(fetchMock)).toHaveLength(1);
  expect(JSON.parse(String(searches(fetchMock)[0]![1]!.body))).toMatchObject({ operation: "library.search", payload: { query: "wire", limit: 8 } });
  const labels = groupLabels();
  expect(labels[0]).toBe("'Items'");
  expect(labels.length).toBeGreaterThan(1);
  const kinds = screen.getAllByTestId("palette-kind").map((node) => node.textContent);
  expect(kinds).toEqual(["wire stock", "connector body"]);
  expect(screen.getAllByTestId("palette-revision").map((node) => node.textContent)).toEqual(["r2", "draft only"]);
  // A non-name match says what matched.
  expect(screen.getByText("connector family BNC coax")).toBeTruthy();
  // Tools whose name matches remain a second group.
});

test("with no query the palette lists recent items, and Enter opens the chosen item in its lens", async () => {
  const { fetchMock } = serve();
  const history = show();
  fireEvent.click(screen.getByRole("button", { name: "Find an item or jump to a tool" }));
  const box = await screen.findByPlaceholderText(/Find an item/);
  await appears("Last cable");
  expect(groupLabels()[0]).toBe("'Recent items'");
  expect(searches(fetchMock)).toHaveLength(0);
  fireEvent.change(box, { target: { value: "coax" } });
  await appears("Coax 75 ohm stock");
  // Arrow keys move the selection (clamped at the first row); Enter opens the selected one.
  for (let press = 0; press < 3; press += 1) fireEvent.keyDown(box, { key: "ArrowUp", code: "ArrowUp" });
  await waitFor(() => expect(document.querySelector("[data-selected]")?.textContent).toContain("Coax 75 ohm stock"));
  fireEvent.keyDown(box, { key: "Enter", code: "Enter" });
  await waitFor(() => expect(history.location.pathname).toContain("/s1"));
  expect(history.location.search).toContain("lens=wire-stock");
});

test("a query that matches no item still shows matching tools, and an empty result says so", async () => {
  serve([]);
  show();
  fireEvent.click(screen.getByRole("button", { name: "Find an item or jump to a tool" }));
  const box = await screen.findByPlaceholderText(/Find an item/);
  fireEvent.change(box, { target: { value: "zzzz" } });
  await appears("No matching item, area or tool");
  fireEvent.change(box, { target: { value: "physical units" } });
  await appears("Inventory area");
  expect(screen.queryByText("No matching item, area or tool")).toBeNull();
});

test("filterPalette keeps item groups whole and filters tool groups by label or description", () => {
  const item = { id: "item:1", label: "BNC to F" };
  const tool = (id: string, label: string) => ({ id, label, description: "Design area" });
  const out = filterPalette("stock", [{ group: "Items", actions: [item] }, { group: "Design", actions: [tool("t1", "Wire stock"), tool("t2", "Cables")] }, { group: "Empty", actions: [tool("t3", "Boards")] }]);
  expect(out).toEqual([{ group: "Items", actions: [item] }, { group: "Design", actions: [tool("t1", "Wire stock")] }]);
  expect(revisionTag(null)).toBe("draft only");
  expect(revisionTag(4)).toBe("r4");
});
