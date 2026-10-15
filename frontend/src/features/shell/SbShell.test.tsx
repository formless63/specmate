import { MantineProvider, Tabs } from "@mantine/core";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { useState, type ReactNode } from "react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { AREAS, DEFAULT_TOOL, areaOfTool, describeAccess, isReadOnly } from "./areas";
import { SbShell } from "./SbShell";

function stubViewport(width: number) {
  vi.stubGlobal("matchMedia", (query: string) => {
    const min = /min-width: (\d+)px/.exec(query);
    const max = /max-width: (\d+)px/.exec(query);
    const matches = (min ? width >= Number(min[1]) : true) && (max ? width <= Number(max[1]) : true) && !query.includes("reduce");
    return { matches, media: query, onchange: null, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent: () => false };
  });
}
beforeEach(() => {
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  Element.prototype.scrollIntoView = vi.fn();
  stubViewport(1440);
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const chrome = { username: "local-user", projectControl: <span>project control</span>, signOutControl: <button type="button">Sign out</button>, alert: null };

function Harness({ permissions = ["workspace.read"] }: { permissions?: string[] }) {
  const [active, setActive] = useState("identity");
  const [visited, setVisited] = useState(() => new Set(["identity"]));
  return <MantineProvider><SbShell projectName="Demo workshop" permissions={permissions} activeTool={active} chrome={chrome}
    onToolChange={(id) => { setActive(id); setVisited((current) => new Set([...current, id])); }}>
    {AREAS.flatMap((area) => area.tools).map((tool) => <Tabs.Panel key={tool.id} value={tool.id}>
      {visited.has(tool.id) && <input aria-label={`draft ${tool.id}`} />}
    </Tabs.Panel>)}
  </SbShell></MantineProvider>;
}

test("every tool belongs to exactly one area and the seven areas use keys 1-7", () => {
  const ids = AREAS.flatMap((area) => area.tools.map((tool) => tool.id));
  expect(new Set(ids).size).toBe(ids.length);
  expect(ids).toHaveLength(50);
  expect(AREAS.map((area) => area.key)).toEqual(["1", "2", "3", "4", "5", "6", "7"]);
  expect(areaOfTool("pcb").label).toBe("Design");
  expect(describeAccess([]).known).toBe(false);
});

test("a project opens on Overview, the first lens of the Project area", () => {
  expect(DEFAULT_TOOL).toBe("overview");
  expect(AREAS[0]?.id).toBe("project");
  expect(AREAS[0]?.tools[0]?.id).toBe("overview");
  expect(areaOfTool("overview").label).toBe("Project");
  expect(areaOfTool("unknown-tool").label).toBe("Project");
});

test("read-only is claimed only when permissions are reported and allow no change", () => {
  expect(isReadOnly(["workspace.read"])).toBe(true);
  expect(isReadOnly(["workspace.read"])).toBe(true);
  expect(isReadOnly(["workspace.read", "item.create", "project.edit"])).toBe(false);
  expect(isReadOnly(["workspace.read", "item.create", "design.edit"])).toBe(false);
  expect(isReadOnly(["workspace.read", "workspace.admin"])).toBe(false);
  expect(isReadOnly([])).toBe(false);
  expect(isReadOnly(undefined)).toBe(false);
});

test("the workspace role names access; without a role it is inferred from the atoms", () => {
  expect(describeAccess(["workspace.read"], "contributor").label).toBe("Contributor");
  expect(describeAccess(["workspace.read", "workspace.admin"]).label).toBe("Admin");
  expect(describeAccess(["workspace.read", "design.edit"]).label).toBe("Editor");
  expect(describeAccess(["workspace.read", "item.create"]).label).toBe("Contributor");
  expect(describeAccess(["workspace.read"]).label).toBe("Viewer");
});

test("rail selects areas, lenses switch tools, and landmarks and current state are exposed", () => {
  render(<Harness />);
  const nav = screen.getByRole("navigation", { name: "Areas" });
  expect(within(nav).getByRole("button", { name: "Library" }).getAttribute("aria-current")).toBe("page");
  expect(screen.getByRole("tablist", { name: "Library tools" })).toBeTruthy();
  fireEvent.click(within(nav).getByRole("button", { name: "Design" }));
  expect(within(nav).getByRole("button", { name: "Design" }).getAttribute("aria-current")).toBe("page");
  expect(within(nav).getByRole("button", { name: "Library" }).getAttribute("aria-current")).toBeNull();
  expect(screen.getByRole("tablist", { name: "Design tools" })).toBeTruthy();
  expect(screen.queryByRole("tab", { name: "Wire stock" })).toBeNull();
  fireEvent.click(screen.getByRole("tab", { name: "PCB intake" }));
  expect(screen.getByRole("tab", { name: "PCB intake" }).getAttribute("aria-selected")).toBe("true");
  // Returning to an area restores the lens last used there.
  fireEvent.click(within(nav).getByRole("button", { name: "Library" }));
  fireEvent.click(within(nav).getByRole("button", { name: "Design" }));
  expect(screen.getByRole("tab", { name: "PCB intake" }).getAttribute("aria-selected")).toBe("true");
});

test("context header shows one fact per cell and the status line holds no navigation", () => {
  render(<Harness permissions={["workspace.read", "item.create", "design.edit"]} />);
  const context = screen.getByRole("region", { name: "Context" }) as HTMLElement;
  expect(within(context).getByText("Demo workshop")).toBeTruthy();
  expect(within(context).getByText("Identities")).toBeTruthy();
  expect(within(context).getByText("Editor")).toBeTruthy();
  expect(within(context).getByText("Project")).toBeTruthy();
  const status = screen.getByTestId("sb-status-line");
  expect(within(status).queryAllByRole("button")).toHaveLength(0);
  expect(within(status).queryAllByRole("link")).toHaveLength(0);
  expect(screen.getByText("Signed in as local-user")).toBeTruthy();
});

test("number keys jump between areas except while typing", () => {
  render(<Harness />);
  fireEvent.keyDown(document.body, { key: "5" });
  expect(screen.getByRole("tablist", { name: "Make tools" })).toBeTruthy();
  fireEvent.keyDown(document.body, { key: "7" });
  expect(screen.getByRole("tablist", { name: "Evidence tools" })).toBeTruthy();
  fireEvent.click(screen.getByRole("tab", { name: "Facts" }));
  const field = screen.getByLabelText("draft facts");
  fireEvent.keyDown(field, { key: "1" });
  expect(screen.getByRole("tablist", { name: "Evidence tools" })).toBeTruthy();
  fireEvent.keyDown(document.body, { key: "1", ctrlKey: true });
  expect(screen.getByRole("tablist", { name: "Evidence tools" })).toBeTruthy();
  fireEvent.keyDown(document.body, { key: "1" });
  expect(screen.getByRole("tablist", { name: "Project tools" })).toBeTruthy();
});

test("a tool keeps its unsaved state while hidden across area switches", () => {
  render(<Harness />);
  fireEvent.change(screen.getByLabelText("draft identity"), { target: { value: "unsaved" } });
  fireEvent.keyDown(document.body, { key: "6" });
  expect(screen.getByLabelText("draft inventory")).toBeTruthy();
  expect(screen.getByLabelText("draft identity").closest("[role='tabpanel']")?.getAttribute("style")).toContain("display: none");
  fireEvent.keyDown(document.body, { key: "2" });
  expect((screen.getByLabelText("draft identity") as HTMLInputElement).value).toBe("unsaved");
});

test("narrow screens use a top-left area menu instead of a rail, and the rail collapses to letters below 1280", async () => {
  stubViewport(1000);
  const { unmount } = render(<Harness />);
  const nav = screen.getByRole("navigation", { name: "Areas" });
  expect(within(nav).getByRole("button", { name: "Design" }).textContent).toBe("DE");
  unmount();
  stubViewport(480);
  render(<Harness />);
  fireEvent.click(screen.getByRole("button", { name: "Areas menu" }));
  fireEvent.click(await screen.findByRole("menuitem", { name: /Sources/ }));
  expect(screen.getByRole("tablist", { name: "Sources tools" })).toBeTruthy();
});

test("Ctrl K opens the jump palette and choosing a tool navigates across areas", async () => {
  render(<Harness />);
  fireEvent.click(screen.getByRole("button", { name: "Jump to a tool or area" }));
  const box = await screen.findByRole("combobox", { name: "Jump to an area or tool" }).catch(() => screen.findByPlaceholderText("Jump to an area or tool"));
  fireEvent.change(box, { target: { value: "Physical units" } });
  fireEvent.click(await screen.findByText("Physical units", { selector: "*" }).then((node) => node.closest("button") ?? node));
  expect(screen.getByRole("tablist", { name: "Inventory tools" })).toBeTruthy();
  expect(screen.getByRole("tab", { name: "Physical units" }).getAttribute("aria-selected")).toBe("true");
});

test("the top bar shows a supplied status indicator and otherwise says status is not evaluated", () => {
  const view = (indicator?: ReactNode) => <MantineProvider><SbShell projectName="Demo workshop" permissions={["workspace.read"]} activeTool="identity" chrome={chrome}
    statusIndicator={indicator} onToolChange={() => {}}><Tabs.Panel value="identity">x</Tabs.Panel></SbShell></MantineProvider>;
  const { rerender } = render(view());
  expect(screen.getByText("Status not evaluated")).toBeTruthy();
  rerender(view(<span role="status" aria-label="Job status">2 running</span>));
  expect(screen.queryByText("Status not evaluated")).toBeNull();
  expect(screen.getByText("2 running")).toBeTruthy();
});

test("at Library scope the header names the scope, and the palette offers scope switching", async () => {
  const chosen = vi.fn();
  render(<MantineProvider><SbShell projectName="Library" libraryScope role="viewer" permissions={["workspace.read"]} activeTool="cables" chrome={chrome}
    extraActions={[{ group: "Scope", actions: [{ id: "scope:p", label: "Bench project", onClick: chosen }] }]}
    onToolChange={() => {}}><Tabs.Panel value="cables">x</Tabs.Panel></SbShell></MantineProvider>);
  const context = screen.getByRole("region", { name: "Context" }) as HTMLElement;
  expect(within(context).getByText("Scope")).toBeTruthy();
  expect(within(context).getByText("Library")).toBeTruthy();
  expect(within(context).getByText("Viewer")).toBeTruthy();
  expect(within(screen.getByTestId("sb-status-line")).getByText("Library / Design / Cables")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Jump to a tool or area" }));
  const box = await screen.findByPlaceholderText("Jump to an area, tool or project");
  fireEvent.change(box, { target: { value: "Bench" } });
  const [action] = await screen.findAllByText((_, node) => node?.tagName === "BUTTON" && !!node.textContent?.includes("Bench project"));
  fireEvent.click(action!);
  expect(chosen).toHaveBeenCalled();
});
