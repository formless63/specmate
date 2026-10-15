import { MantineProvider, Tabs } from "@mantine/core";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { AREAS, DEFAULT_TOOL, areaOfTool, describeAccess, isReadOnly, LIBRARY_TABS } from "./areas";
import { SbShell } from "./SbShell";

function stubViewport(width: number) {
  vi.stubGlobal("matchMedia", (query: string) => {
    const min = /min-width: (\d+)px/.exec(query); const max = /max-width: (\d+)px/.exec(query);
    return { matches: (min ? width >= Number(min[1]) : true) && (max ? width <= Number(max[1]) : true) && !query.includes("reduce"), media: query, onchange: null, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent: () => false };
  });
}
beforeEach(() => { vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} }); Element.prototype.scrollIntoView = vi.fn(); stubViewport(1440); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const chrome = { username: "local-user", projectControl: <span>project control</span>, signOutControl: <button type="button">Sign out</button>, alert: null };
function Harness() {
  const [active, setActive] = useState("identity"); const [visited, setVisited] = useState(() => new Set(["identity"]));
  return <MantineProvider><SbShell projectName="Demo workshop" permissions={["workspace.read"]} activeTool={active} chrome={chrome}
    onToolChange={id => { setActive(id); setVisited(current => new Set([...current, id])); }}>
    {AREAS.flatMap(area => area.tools).map(tool => <Tabs.Panel key={tool.id} value={tool.id}>{visited.has(tool.id) && <input aria-label={`draft ${tool.id}`} />}</Tabs.Panel>)}
  </SbShell></MantineProvider>;
}

test("the fixed nine-entry rail owns every tool exactly once", () => {
  expect(AREAS.map(area => area.label)).toEqual(["Designs", "Library", "Make", "Jobs", "History", "Products & releases", "Projects", "Extensions", "Settings"]);
  expect(AREAS.map(area => area.key)).toEqual(["1", "2", "3", "4", "5", "6", "7", "8", "9"]);
  const ids = AREAS.flatMap(area => area.tools.map(tool => tool.id)); expect(new Set(ids).size).toBe(ids.length);
  expect(DEFAULT_TOOL).toBe("designs"); expect(areaOfTool("pcb").id).toBe("library");
});
test("Library has its fixed typed tabs and remaining tools use Advanced", async () => {
  render(<Harness />);
  expect(within(screen.getByRole("navigation", { name: "Workspace" })).getAllByRole("button")).toHaveLength(9);
  expect(screen.getAllByRole("tab").map(tab => tab.textContent)).toEqual(["Home", "Connectors", "Boards", "Wire stocks", "Parts", "Shells & hardware", "Kits", "Vocabulary"]);
  expect(LIBRARY_TABS).toHaveLength(7);
  fireEvent.click(screen.getByRole("button", { name: "Library advanced tools" }));
  fireEvent.click(await screen.findByRole("menuitem", { name: "Copper graph" }));
  expect(screen.getByLabelText("draft copper")).toBeTruthy();
  expect(screen.queryByRole("tab", { name: "Copper graph" })).toBeNull();
});
test("the top bar uses breadcrumb and account controls without a context strip", () => {
  render(<Harness />);
  expect(screen.getByRole("navigation", { name: "Breadcrumb" }).textContent).toBe("Library/Parts");
  expect(screen.queryByRole("region", { name: "Context" })).toBeNull();
  expect(screen.getByRole("button", { name: "Sign out" })).toBeTruthy();
  const footer = screen.getByTestId("sb-status-line"); expect(within(footer).queryAllByRole("button")).toHaveLength(0); expect(within(footer).queryAllByRole("link")).toHaveLength(0);
  expect(screen.getByText("Status not evaluated")).toBeTruthy();
});
test("a tool keeps unsaved edits across rail navigation and no old area tabs appear", () => {
  render(<Harness />); fireEvent.change(screen.getByLabelText("draft identity"), { target: { value: "unsaved" } });
  fireEvent.keyDown(document.body, { key: "3" }); expect(screen.getByLabelText("draft inventory")).toBeTruthy();
  expect(screen.getByLabelText("draft identity").closest("[role='tabpanel']")?.getAttribute("style")).toContain("display: none");
  fireEvent.keyDown(document.body, { key: "2" }); fireEvent.click(screen.getByRole("tab", { name: "Parts" }));
  expect((screen.getByLabelText("draft identity") as HTMLInputElement).value).toBe("unsaved");
  fireEvent.keyDown(screen.getByLabelText("draft identity"), { key: "9" }); expect(screen.getByRole("tablist", { name: "Library sections" })).toBeTruthy();
});
test("portrait phone navigation reaches all nine sections from the top edge", async () => {
  stubViewport(390); render(<Harness />);
  expect(screen.queryByRole("navigation", { name: "Workspace" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Workspace navigation" }));
  const sections = await screen.findAllByRole("menuitem");
  expect(sections).toHaveLength(9);
  expect(sections[8]!.textContent).toContain("Settings");
  fireEvent.click(sections[8]!);
  expect(screen.getByRole("tablist", { name: "Settings sections" })).toBeTruthy();
});
test("read-only and unreported access retain their distinct meanings", () => {
  expect(isReadOnly(["workspace.read"])).toBe(true); expect(isReadOnly([])).toBe(false); expect(isReadOnly(undefined)).toBe(false);
  expect(isReadOnly(["workspace.read", "item.create"])).toBe(false);
  expect(describeAccess([]).known).toBe(false); expect(describeAccess(["workspace.read"]).label).toBe("Viewer");
});
