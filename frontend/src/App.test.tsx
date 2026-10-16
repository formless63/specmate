import { MantineProvider } from "@mantine/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { generate, exampleCoax } from "./features/wire-stock/builder";
import { lazy } from "react";
import { TYPED_LIBRARY_VIEWS } from "./components/library/LibraryList";
import { App, ToolLoadingBoundary } from "./App";
import { AREAS, areaOfTool } from "./features/shell";
import { ROUTE_TOOLS } from "./features/shell/registry";
import { formatLocation, HOME } from "./features/navigation";
import { primaryTools } from "./features/shell/areas";
import { LIBRARY_VIEWS } from "./features/shell/scope";

beforeEach(() => {
  // These cases exercise the dense table layout; the gallery default has its own tests.
  localStorage.setItem("specmate.library.layout", "table");
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  Element.prototype.scrollIntoView = vi.fn();
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

test("a rejected deferred tool stays contained with explicit reload guidance", async () => {
  const errors = vi.spyOn(console, "error").mockImplementation(() => {});
  const Unavailable = lazy(() => Promise.reject(new Error("Synthetic module unavailable")));
  try {
    render(<MantineProvider env="test"><ToolLoadingBoundary><Unavailable /></ToolLoadingBoundary></MantineProvider>);
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.getByText(/unsaved edits will be lost/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Reload page" })).toBeTruthy();
    expect(screen.queryByText("Synthetic module unavailable")).toBeNull();
  } finally { errors.mockRestore(); }
});

function renderApp() {
  const cache = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<MantineProvider env="test"><QueryClientProvider client={cache}><App /></QueryClientProvider></MantineProvider>);
  return cache;
}

function reply(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status });
}

const ROLES: Record<string, string[]> = {
  viewer: ["workspace.read"],
  contributor: ["item.create", "project.edit", "source.register", "workspace.read"],
  editor: ["design.edit", "design.freeze", "inventory.reserve", "item.create", "project.edit", "source.register", "workspace.read"],
};

function server({ authenticated = false, denyInventory = false, role = "contributor" } = {}) {
  const projects = [{ project_id: "project-a", name: "Project A", purpose: "", archived: false, created_by: "local-user", references: [], dependents: {}, can_delete: true },
    { project_id: "project-b", name: "Project B", purpose: "", archived: false, created_by: "local-user", references: [], dependents: {}, can_delete: true }];
  const library = [{ record_id: "d1", family: "definition", kind: "cable", label: "Patch lead", detail: null, created_at: "2026-01-01T00:00:00Z", latest_revision: 1, latest_revision_id: "r1",
    changed_at: null, referenceable: true, referenced: null, used_in_total: 1, used_in: [{ reference_id: "ref1", project_id: "project-b", project_name: "Project B", archived: false, pin: "floating", revision: null, role: "uses" }] }];
  const fetchMock = vi.fn(async (path: string, options?: RequestInit) => {
    if (path === "/api/v0/session") return reply({ user: authenticated ? { id: "7", username: "local-user" } : null, owner_setup_required: false });
    if (path === "/api/v0/session/login") { authenticated = true; return reply({ result: {} }); }
    if (path === "/api/v0/session/logout") { authenticated = false; return reply({ result: {} }); }
    // Older panels still read the flat project list (kept by the server).
    if (path === "/api/v0/projects") return reply(projects.map((project) => ({ ...project, permissions: ROLES[role] })));
    if (path.startsWith("/api/v0/workspace/projects?")) return reply({ workspace_id: "w1", role, permissions: ROLES[role], results: projects, total: 2, next_after: null });
    if (path.startsWith("/api/v0/workspace/projects/")) {
      const id = path.split("/").pop()!.split("?")[0]!;
      return reply({ project_id: id, workspace_id: "w1", name: id, purpose: "", archived: false, archived_at: null, created_by: "local-user", state: `s-${id}`, permissions: ROLES[role], references: [], dependents: {}, can_delete: true });
    }
    if (path.startsWith("/api/v0/workspace/designs?")) {
      const projectId = new URL(path, "http://test").searchParams.get("project_id");
      return reply({ workspace_id: "w1", family: "definition", project_id: projectId,
        results: library.filter(row => !projectId || row.used_in.some(use => use.project_id === projectId)).map(row => ({ ...row,
          design: { basis: "latest_frozen", revision_id: "r1", revision: 1, draft_id: null, review: "unreviewed",
            from: { label: null, basis: "unknown", revision_id: null }, to: { label: null, basis: "unknown", revision_id: null }, stocks: [], boards: [], checks: "not_evaluated" } })), next_after: null });
    }
    if (path.startsWith("/api/v0/workspace/library/")) {
      const id = new URL(path, "http://test").pathname.split("/").pop();
      return reply(id === "s1" ? { ...library[0]!, record_id: "s1", kind: "wire_stock", label: "Bench stock" } : library[0]);
    }
    if (path.startsWith("/api/v0/catalog/where-used?")) return reply({ revision_id: "r1", results: [], next_after: null, project_references: [{ reference_id: "ref1", project_id: "project-b", project_name: "Project B", archived: false, relation: "project_reference_floating", role: "uses" }] });
    if (path.startsWith("/api/v0/workspace/library?") || path.startsWith("/api/v0/workspace/library-table?")) {
      const url = new URL(path, "http://test");
      const projectId = url.searchParams.get("project_id");
      const collection = [...library, { ...library[0]!, record_id: "s1", kind: "wire_stock", label: "Bench stock" }];
      const rows = collection.map((row) => ({ ...row, referenced: projectId ? row.used_in.some((use) => use.project_id === projectId) : null }))
        .filter((row) => url.searchParams.get("referenced_only") !== "true" || row.referenced);
      return reply({ workspace_id: "w1", family: url.searchParams.get("family"), project_id: projectId, results: rows.filter(row => url.searchParams.getAll("kinds").includes(row.kind)).map(row => ({ ...row, summary: { basis: "latest_frozen", revision_id: row.latest_revision_id, draft_id: null, draft_version: null, numbers: [], fields: [], flags: [] } })), next_after: null });
    }
    if (path.startsWith("/api/v0/workspace/history?")) return reply({ workspace_id: "w1", source: "retained", complete_audit: false, hint: "Retained changes only.", results: [], next_after: null, scan_limit_reached: false });
    if (path.startsWith("/api/v0/access/workspace")) return reply({ workspace_id: "w1", name: "Workspace", role, permissions: ROLES[role] });
    if (path === "/api/v0/access/account-policy") return reply({ can_create_local_accounts: false });
    if (path === "/api/v0/operations") {
      const envelope = JSON.parse(String(options?.body));
      if (envelope.operation === "products.lineup") return reply({ result: { results: [], next_after: null, as_of: "2026-01-01T00:00:00Z", basis: "latest_frozen_family_at_page_anchor_current_authority" } });
      if (envelope.operation === "workspace.settings.get") return reply({ result: { workspace_id: "w1", version: 0, state_token: "workspace-settings:w1:v0", values: { documents: {} } } });
      if (envelope.operation === "library.home") return reply({ result: { workspace_id: "w1", attention: [], attention_total: 0, unknowns: [], unknowns_total: 0, recent: [], totals: { failing_checks: 0, unknown_checks: 0, open_questions: 0, stale_evidence: 0, unknown_values: 0 }, kinds: [], definitions_total: 0, scan_limit_reached: false } });
      if (["collaboration.list", "collaboration.inbox"].includes(envelope.operation)) return reply({ result: { results: [], next_after: null } });
    }
    if (path.startsWith("/api/v0/discovery/capabilities?")) return reply({ instance: { version: "0", registry_sha256: "0".repeat(64) }, transports: {}, scope: { project_id: null, role, permissions: ROLES[role] }, capabilities: { native_execution: { status: "unavailable", reasons: [], approved_recipes: 0 } }, notes: [], operations: [] });
    if (path.startsWith("/api/v0/diagnostics/workspaces/")) return reply({ workspace_id: "p", evaluated_at: "2026-01-01T00:00:00Z", work: { mode: "running", accepting_new_work: true, reason: "", state_token: "work-v0" }, queue: { states: {}, pending: 0, active: 0, oldest_pending_seconds: null }, dispatch: { undelivered: 0, oldest_undelivered_seconds: null }, runner: { state: "not_enrolled", credentials_usable: 0, stages_holding_lease: 0, stages_lease_expired: 0 }, tools: [], storage: { state: "not_initialized", code: null, sampled: 0 }, workflow_engine: { state: "not_evaluated" }, builds: [], can_execute: false, findings: [] });
    if (path.startsWith("/api/v0/collaboration/inbox?") || path.startsWith("/api/v0/collaboration/reviews?")) return reply({ results: [], next_after: null });
    if (path.startsWith("/api/v0/catalog/definitions?")) return reply({ workspace_id: "workspace", project_id: null, results: [], next_after: null });
    if (path.startsWith("/api/v0/stocks?definition_id=s1")) return reply([{ definition_id: "s1", draft_id: "ds1", name: "Bench stock", state: "draft-v1", content: { stock: generate(exampleCoax()) } }]);
    if (path === "/api/v0/revisions/r1/snapshot") return reply({ content: { stock: generate(exampleCoax()) } });
    if (path.endsWith("/conventions")) return reply({ conventions: [] });
    if (path.startsWith("/api/v0/stocks")) return reply([]);
    if (path.endsWith("/definitions") || path.endsWith("/stocks") || path.endsWith("/intakes")) return reply([]);
    if (path.startsWith("/api/v0/preparation-documents/projects/") || path === "/api/v0/preparation-documents/workspace") return reply({ document_sets: [] });
    if (path.startsWith("/api/v0/knowledge/workspaces/")) return reply({ items: [], offset: 0, limit: 50, has_more: false });
    if (path.startsWith("/api/v0/inventory/workspaces/")) return denyInventory
      ? reply({ error: { message: "Project not found." } }, 404)
      : reply({ accounts: [], locations: [], lots: [] });
    throw new Error(`Unexpected request ${path} ${options?.method ?? "GET"}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

/** Choose a rail entry, then its fixed tab or existing tool in Advanced. */
async function openTool(label: string) {
  if (label === "Mechanical sources") return openTool("Shells & hardware");
  if (["Conductor conventions", "Workshop profiles", "Evidence kinds"].includes(label)) {
    await openTool("Vocabulary");
    fireEvent.click(await screen.findByRole("button", { name: label === "Conductor conventions" ? "Conventions" : label }));
    return;
  }
  const area = AREAS.find((item) => item.tools.some((tool) => tool.label === label));
  if (!area) {
    // Retired global controls are exercised through their retained canonical route.
    const tool = ROUTE_TOOLS.find(item => item.label === label);
    if (!tool) throw new Error(`Unknown route ${label}`);
    const href = formatLocation({ ...HOME, area: areaOfTool(tool.id).id, lens: tool.id });
    await act(async () => window.history.pushState(null, '', href));
    return;
  }
  const rail = screen.getByRole("button", { name: area.label });
  if (rail.getAttribute("aria-current") !== "page") fireEvent.click(rail);
  if (primaryTools(area).some(tool => tool.label === label)) fireEvent.click(await screen.findByRole("tab", { name: label }));
  else if (area.tools[0]?.label !== label) {
    const menu = screen.getByRole("button", { name: `${area.label} advanced tools` });
    if (menu.getAttribute("aria-expanded") !== "true") fireEvent.click(menu);
    fireEvent.click(await screen.findByRole("menuitem", { name: label }));
    await waitFor(() => expect(menu.getAttribute("aria-expanded")).toBe("false"));
  }
}

/** From the project list at Library scope, open a project the way a person does: choose its row. */
async function openProject(name: string) {
  fireEvent.click(screen.getByRole("button", { name: "Projects" }));
  fireEvent.click(await screen.findByRole("button", { name: `Open ${name}` }));
  await screen.findByRole("heading", { name: name === "Project A" ? "project-a" : name === "Project B" ? "project-b" : name });
}

/** Project navigation uses the explicit Projects list, never a global scope switch. */
async function selectProject(name: string) { await openProject(name); }

async function openAuthenticatedProjectTools() {
  server({ authenticated: true }); renderApp();
  await screen.findByRole("button", { name: "Account menu, signed in as local-user" });
  await openProject("Project A");
  await openTool("Parts");
  await screen.findByRole("heading", { name: "Parts" });
}

test("sign-in opens scoped project tools and lazily mounts stock, intake and inventory", async () => {
  const cryptoSource = globalThis.crypto;
  vi.stubGlobal("crypto", { getRandomValues: cryptoSource.getRandomValues.bind(cryptoSource) });
  const fetchMock = server(); renderApp();
  await screen.findByRole("heading", { name: "Sign in" });
  expect(screen.queryByRole("tablist")).toBeNull();
  fireEvent.change(screen.getByLabelText(/^Username/), { target: { value: "local-user" } });
  fireEvent.change(screen.getByLabelText(/^Password/), { target: { value: "synthetic-password" } });
  fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
  await screen.findByRole("button", { name: "Account menu, signed in as local-user" });
  // Sign-in lands on Designs at Library scope; engineering editors remain lazy.
  expect(screen.getByTestId("sb-top-bar")).toBeTruthy();
  expect(screen.getByRole("navigation", { name: "Workspace" })).toBeTruthy();
  expect(await screen.findByRole("region", { name: "Designs" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: /^Scope .*: switch$/ })).toBeNull();
  expect(screen.queryByText("Select or create a project to begin.")).toBeNull();
  await openProject("Project A");
  expect(screen.getByRole("tablist", { name: "Projects sections" })).toBeTruthy();
  expect(screen.getByRole("tab", { name: "Projects" }).getAttribute("aria-selected")).toBe("true");
  await openTool("Parts");
  await screen.findByRole("heading", { name: "Parts" });
  expect(screen.getByRole("tablist", { name: "Library sections" })).toBeTruthy();
  expect(fetchMock.mock.calls.some(([path]) => path.startsWith("/api/v0/workspace/library-table?") && new URL(path, "http://synthetic").searchParams.get("catalog_class") === "parts")).toBe(true);
  expect(fetchMock.mock.calls.some(([path]) => path === "/api/v0/catalog/definitions?limit=100")).toBe(false);
  expect(fetchMock.mock.calls.some(([path]) => path.includes("/stocks") || path.includes("/intakes") || path.includes("/inventory/"))).toBe(false);
  await openTool("Wire stocks");
  await screen.findByRole("heading", { name: "Wire stocks" });
  expect(screen.getByRole("button", { name: "New wire stock" })).toBeTruthy();
  expect(fetchMock.mock.calls.some(([path]) => path.startsWith("/api/v0/stocks"))).toBe(false);
  expect(screen.queryByRole("heading", { name: "Parts" })).toBeNull();
  await openTool("Boards");
  await screen.findByRole("heading", { name: "Boards" });
  expect(fetchMock.mock.calls.some(([path]) => path === "/api/v0/pcb/workspaces/w1/intakes")).toBe(false);
  fireEvent.click(screen.getByRole("button", { name: /^Import$/ }));
  fireEvent.click(await screen.findByRole("menuitem", { name: "KiCad board intake…" }));
  await screen.findByRole("heading", { name: "PCB intake" });
  await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/v0/pcb/workspaces/w1/intakes", expect.anything()));
  expect(screen.getByRole("button", { name: "Preserve sources" })).toBeTruthy();
  await openTool("Inventory");
  await screen.findByRole("heading", { name: "Inventory" });
  await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/v0/inventory/workspaces/w1?offset=0&limit=50", expect.anything()));
});

test("firmware and mechanical tools mount with scoped read controls", async () => {
  await openAuthenticatedProjectTools();
  await openTool("Board firmware");
  await screen.findByRole("heading", { name: "Firmware on repeated boards" });
  expect(screen.getByRole("button", { name: "Show occurrence firmware" })).toBeTruthy();
  await openTool("Mechanical sources");
  await screen.findByRole("heading", { name: "Shells & hardware" });
  expect(screen.getByRole("button", { name: "New enclosure or mechanical source" })).toBeTruthy();
  await openTool("Firmware impact");
  await screen.findByRole("heading", { name: "Firmware change and observation review" });
  expect(screen.getByRole("button", { name: "Show firmware impact" })).toBeTruthy();
});

test("retired Device pickers redirect to Designs and current Device sections mount with scoped controls", async () => {
  const fetchMock = server({ authenticated: true });
  const base = fetchMock.getMockImplementation()!;
  fetchMock.mockImplementation(async (path, options) => {
    if (path === '/api/v0/operations' && JSON.parse(String(options?.body)).operation === 'release.list') return reply({ result: { releases: [], next_after: null } });
    if (path === '/api/v0/mechanical-proposals/workspaces/w1/boards') return reply({ boards: [] });
    if (path === '/api/v0/mechanical-proposals/workspaces/w1/drafts') return reply({ drafts: [], truncated: false });
    return base(path, options);
  });
  renderApp();
  await screen.findByRole('button', { name: 'Account menu, signed in as local-user' });
  await openProject('Project A');
  for (const label of ['Shared scene', 'Connected views', 'Scene drawings']) {
    await openTool(label);
    expect(await screen.findByRole('heading', { name: 'Designs' })).toBeTruthy();
    expect(window.location.pathname).toBe('/designs');
    await waitFor(() => expect(new URLSearchParams(window.location.search).get('tool')).toBeNull());
  }
  await openTool('Devices');
  fireEvent.click(await screen.findByRole('button', { name: 'New design' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Prepare device' }));
  expect(await screen.findByRole('button', { name: 'Save device' })).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Capture saved assembly' }).hasAttribute('disabled')).toBe(true);
  expect(screen.getByText(/Save the declaration, then choose Capture saved assembly/)).toBeTruthy();
  fireEvent.click(screen.getByRole('tab', { name: 'Tree' }));
  expect(screen.getByRole('tab', { name: 'Tree' }).getAttribute('aria-selected')).toBe('true');
  fireEvent.click(screen.getByRole('tab', { name: 'Interfaces' }));
  expect(await screen.findByRole('button', { name: 'New interface mapping' })).toBeTruthy();
  fireEvent.click(screen.getByRole('tab', { name: 'Drawings' }));
  expect(await screen.findByRole('textbox', { name: 'Drawing frozen scene snapshot ID' })).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Inspect drawing scene' }).hasAttribute('disabled')).toBe(true);
  fireEvent.click(screen.getByRole('tab', { name: 'Enclosure' }));
  expect(await screen.findByRole('button', { name: 'Create proposal draft' })).toBeTruthy();
  const operations = fetchMock.mock.calls.filter(([path]) => path === '/api/v0/operations').map(([, options]) => JSON.parse(String(options?.body)).operation as string);
  expect(operations.filter(operation => !['library.previews', 'library.home', 'workspace.settings.get', 'collaboration.list', 'collaboration.inbox', 'release.list'].includes(operation))).toEqual([]);
});

test("interfaces and knowledge mount with scoped read controls", async () => {
  await openAuthenticatedProjectTools();
  await openTool("Connectors");
  await screen.findByRole("heading", { name: "Connector bodies" });
  expect(screen.queryByRole("button", { name: "New assessment" })).toBeNull();
  await openTool("Notes & files");
  fireEvent.click(await screen.findByRole("button", { name: "Open Notes & files in Project A" }));
  await screen.findByRole("heading", { name: "Notes, decisions and attachments" });
  // knowledge.create needs item.create, which contributors hold.
  expect(await screen.findByRole("button", { name: "Create knowledge item" })).toBeTruthy();
  await screen.findByRole("heading", { name: "Search notes and attachments" });
  await screen.findByRole("heading", { name: "Team changes" });
  expect(screen.queryByRole("button", { name: "Open team review" })).toBeNull();
});

test("project page navigation preserves workspace panel state; sign-out removes private tools", async () => {
  const fetchMock = server({ authenticated: true });
  const cache = renderApp();
  await screen.findByRole("button", { name: "Account menu, signed in as local-user" });
  await openProject("Project A");
  await openTool("Inventory");
  fireEvent.change(await screen.findByLabelText("New location name"), { target: { value: "Private shelf draft" } });
  await openTool("Parts");
  await openTool("Inventory");
  expect((screen.getByLabelText("New location name") as HTMLInputElement).value).toBe("Private shelf draft");
  cache.setQueryData(["private", "project-a"], "synthetic-private-data");
  const inventoryReads = () => fetchMock.mock.calls.filter(([path]) => path === "/api/v0/inventory/workspaces/w1?offset=0&limit=50").length;
  const readsBefore = inventoryReads();
  await selectProject("Project B");
  // Visiting another project is ordinary navigation; returning to the editor keeps unsaved work.
  await openTool("Inventory");
  expect(screen.getByRole("tab", { name: "Inventory" }).getAttribute("aria-selected")).toBe("true");
  expect(cache.getQueryData(["private", "project-a"])).toBe("synthetic-private-data");
  expect((await screen.findByLabelText("New location name") as HTMLInputElement).value).toBe("Private shelf draft");
  // Project navigation does not invalidate the shared workspace inventory.
  expect(inventoryReads()).toBe(readsBefore);
  fireEvent.click(screen.getByRole("button", { name: "Account menu, signed in as local-user" }));
  fireEvent.click(await screen.findByRole("menuitem", { name: "Sign out" }));
  await screen.findByRole("heading", { name: "Sign in" });
  expect(screen.queryByRole("tablist")).toBeNull();
  expect(screen.queryByLabelText("New location name")).toBeNull();
  expect(cache.getQueryData(["inventory", "w1", null, 0])).toBeUndefined();
});

test("PCB controls require explicit grants, and a denied read is visible", async () => {
  server({ authenticated: true, role: "viewer", denyInventory: true }); renderApp();
  await screen.findByRole("button", { name: "Account menu, signed in as local-user" });
  await openProject("Project A");
  await openTool("Boards");
  await screen.findByRole("heading", { name: "Boards" });
  expect(screen.queryByRole("button", { name: /^New board/ })).toBeNull();
  expect(screen.queryByRole("button", { name: /^Import$/ })).toBeNull();
  expect(screen.queryByRole("button", { name: "Preserve sources" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Request native extraction" })).toBeNull();
  await openTool("Inventory");
  expect(await screen.findByText("Project not found.")).toBeTruthy();
  expect(screen.queryByText("Inventory operation completed.")).toBeNull();
});

test("overview start points and open-work links open the owning tool through the shell", async () => {
  server({ authenticated: true }); renderApp();
  await screen.findByRole("button", { name: "Account menu, signed in as local-user" });
  await openProject("Project A");
  fireEvent.click(screen.getByRole("button", { name: "Start: Stock record" }));
  await screen.findByRole("heading", { name: "New wire stock" });
  expect(screen.getByLabelText("Stock name")).toBeTruthy();
  expect(screen.getByRole("tab", { name: "Wire stocks" }).getAttribute("aria-selected")).toBe("true");
  expect(screen.getByRole("tablist", { name: "Library sections" })).toBeTruthy();
  // The Overview keeps its place in the Project area and returns without losing the project.
  fireEvent.click(screen.getByRole("button", { name: "Projects" }));
  expect(screen.getByRole("tab", { name: "Projects" }).getAttribute("aria-selected")).toBe("true");
});

test.each([
  ["a viewer", "viewer", true],
  ["a contributor", "contributor", false],
])("workspace permissions reach tool panels: %s sees Save stock disabled: %s", async (_name, role, off) => {
  server({ authenticated: true, role }); renderApp();
  await screen.findByRole("button", { name: "Account menu, signed in as local-user" });
  await openProject("Project A");
  await openTool("Wire stocks");
  await screen.findByRole("heading", { name: "Wire stocks" });
  if (role === "viewer") {
    expect(screen.queryByRole("button", { name: "New wire stock" })).toBeNull();
    fireEvent.click(await screen.findByRole("button", { name: "Bench stock" }));
    fireEvent.click(await screen.findByRole("button", { name: "Draft" }));
    // The frozen frame stays mounted privately while the draft is reauthorized.
    await screen.findByRole("textbox", { name: "Stock name" });
  } else {
    fireEvent.click(screen.getByRole("button", { name: "New wire stock" }));
    fireEvent.change(await screen.findByLabelText("Stock name"), { target: { value: "New bench stock" } });
  }
  const save = screen.getByRole("button", { name: "Save stock" }) as HTMLButtonElement;
  expect(save.disabled).toBe(off);
  expect(save.title).toBe(off ? "Read-only access: requires Edit" : "");
  expect((screen.getByRole("button", { name: "Freeze saved stock" }) as HTMLButtonElement).disabled).toBe(true);
  await openTool("Inventory");
  await screen.findByRole("heading", { name: "Inventory" });
  expect((screen.getByRole("button", { name: "Create location" }) as HTMLButtonElement).title).toBe("Read-only access: requires Inventory management");
});

const libraryFamilies = [
  ["designs", ["cables", "harnesses", "assemblies", "end-assemblies", "configurations"]],
  ["electrical", ["signals", "ports", "conventions", "interfaces", "passive-passages", "pcb", "pcb-disagreement"]],
  ["parts and sources", ["identity", "wire-stock", "workshop-profiles", "occurrence-firmware", "mechanical-sources", "sources", "facts"]],
  ["making", ["bom", "material-accounting", "preparation", "end-preparation", "inventory", "physical-units"]],
] as const;

test.each(libraryFamilies)("Library %s editors mount without a project", async (_family, toolIds) => {
  server({ authenticated: true }); renderApp();
  await screen.findByRole("button", { name: "Account menu, signed in as local-user" });
  for (const toolId of toolIds) {
    const view = LIBRARY_VIEWS[toolId]!;
    const tool = ROUTE_TOOLS.find(item => item.id === toolId)!;
    if (["preparation", "end-preparation"].includes(toolId)) {
      const href = formatLocation({ ...HOME, area: "library", lens: toolId, filters: { status: "new" } });
      await act(async () => window.history.pushState(null, '', href));
      expect(await screen.findByRole("textbox", { name: toolId === "preparation" ? "Preparation profile name" : "End preparation profile name" })).toBeTruthy();
      expect(screen.getByRole("button", { name: "Save draft" })).toHaveProperty("disabled", true);
      expect(screen.queryByRole("region", { name: `${view.title} editor` })).toBeNull();
      continue;
    }
    if (toolId === "configurations") {
      for (const kind of ['option_set','configuration']) {
        await act(async () => window.history.pushState(null, '', `/designs?tool=configurations&kind=${kind}&status=new`));
        const label=kind==='option_set'?'Option set':'Configuration';
        expect(await screen.findByRole('textbox',{name:`${label} name`})).toBeTruthy();
        expect(screen.getByRole('button',{name:'Freeze saved draft'})).toHaveProperty('disabled',true);
        expect(screen.queryByRole('region',{name:`${view.title} editor`})).toBeNull();
      }
      continue;
    }
    if (toolId === "cables") {
      fireEvent.click(screen.getByRole("button", { name: "Designs" }));
      fireEvent.click(await screen.findByRole("button", { name: "New design" }));
      fireEvent.click(await screen.findByRole("button", { name: "Prepare cable" }));
      fireEvent.click(await screen.findByRole("button", { name: "Start blank cable" }));
    } else await openTool(tool.label);
    if (["assemblies", "harnesses"].includes(toolId)) {
      fireEvent.click(await screen.findByRole("button", { name: "New design" }));
      fireEvent.click(await screen.findByRole("button", { name: toolId === "harnesses" ? "Prepare harness" : "Prepare device" }));
      expect(await screen.findByRole("button", { name: toolId === "harnesses" ? "Save harness" : "Save device" })).toBeTruthy();
      continue;
    }
    if (["cables", "harnesses"].includes(toolId)) {
      const create: Record<string, string> = { cables: "Create cable draft", harnesses: "Create harness draft", assemblies: "Create assembly draft" };
      expect(await screen.findByRole("button", { name: create[toolId]! })).toBeTruthy();
      continue;
    }
    const makeHeadings: Record<string, string> = { inventory: "Inventory", "physical-units": "Physical units", "material-accounting": "Preparation material accounting", bom: "Purpose-specific BOM planning" };
    if (makeHeadings[toolId]) {
      expect(await screen.findByRole("heading", { name: makeHeadings[toolId] })).toBeTruthy();
      expect(screen.queryByRole("region", { name: `${view.title} in the library` })).toBeNull();
      continue;
    }
    if (["copper", "passive-passages", "pcb-disagreement"].includes(toolId)) {
      const list = await screen.findByRole("region", { name: "Boards" });
      expect(within(list).getByRole("button", { name: `New ${TYPED_LIBRARY_VIEWS.pcb!.noun}` })).toBeTruthy();
      expect(window.location.pathname).toBe("/library/boards");
      expect(new URLSearchParams(window.location.search).has("tool")).toBe(false);
      continue;
    }
    const typed = TYPED_LIBRARY_VIEWS[toolId];
    if (toolId === "wire-stock") {
      const back = screen.queryByRole("button", { name: "Back to Wire stocks" });
      if (back) fireEvent.click(back);
      const list = await screen.findByRole("region", { name: "Wire stocks" });
      fireEvent.click(within(list).getByRole("button", { name: "New wire stock" }));
      expect(await screen.findByLabelText("Stock name")).toBeTruthy();
      continue;
    }
    if (toolId === "occurrence-firmware") {
      const browse = screen.queryByRole("button", { name: "Browse designs" });
      if (browse) fireEvent.click(browse);
      fireEvent.click(screen.getByRole("button", { name: "Library" }));
      fireEvent.click(await screen.findByRole("button", { name: "New…" }));
      fireEvent.click(await screen.findByRole("menuitem", { name: "Firmware definition" }));
      expect(await screen.findByRole("textbox", { name: "Firmware name" })).toBeTruthy();
      expect(screen.getByRole("textbox", { name: "Toolchain name" })).toBeTruthy();
      expect(screen.queryByRole("button", { name: "Show firmware" })).toBeNull();
      continue;
    }
    if (toolId === "facts") {
      // The retired global workspace returns to Library; registration is an explicit New action.
      expect(window.location.pathname).toBe("/library");
      expect(screen.queryByRole("combobox", { name: "Registered fact subject" })).toBeNull();
      fireEvent.click(await screen.findByRole("button", { name: "New…" }));
      fireEvent.click(await screen.findByRole("menuitem", { name: "Fact ledger" }));
      await waitFor(() => expect(window.location.search).toContain("tool=facts"));
      expect(await screen.findByRole("heading", { name: "Register a fact ledger" })).toBeTruthy();
      expect(screen.getByRole("combobox", { name: "Fact subject kind" })).toBeTruthy();
      expect(screen.getByRole("button", { name: "Open fact ledger" })).toBeTruthy();
      continue;
    }
    if (["identity", "mechanical-sources"].includes(toolId)) {
      const current = toolId === "mechanical-sources" ? TYPED_LIBRARY_VIEWS.hardware! : typed!;
      const list = await screen.findByRole("region", { name: current.title });
      expect(within(list).getByRole("button", { name: `New ${current.noun}` })).toBeTruthy();
      expect(screen.queryByRole("region", { name: `${current.title} editor` })).toBeNull();
      continue;
    }
    if (["signals", "conventions", "workshop-profiles"].includes(toolId)) {
      const list = await screen.findByRole("region", { name: typed!.title });
      expect(within(list).getByRole("button", { name: `New ${typed!.noun}` })).toBeTruthy();
      expect(screen.queryByRole("region", { name: `${typed!.title} editor` })).toBeNull();
      continue;
    }
    if (["interfaces", "ports", "end-assemblies", "pcb"].includes(toolId)) {
      const list = await screen.findByRole("region", { name: toolId === "interfaces" ? "Connector bodies" : typed!.title });
      expect(within(list).getByRole("button", { name: `New ${toolId === "interfaces" ? "connector body" : typed!.noun}` })).toBeTruthy();
      expect(screen.queryByRole("region", { name: `${typed!.title} editor` })).toBeNull();
      continue;
    }
    expect(await screen.findByRole("region", { name: `${typed?.title ?? view.title} editor` })).toBeTruthy();
    const title = toolId === "interfaces" ? "Connector bodies" : typed?.title ?? `${view.title} in the library`;
    const list = await screen.findByRole("region", { name: title });
    const noun = toolId === "interfaces" ? "connector body" : typed?.noun ?? view.noun;
    expect(within(list).getByRole("button", { name: `New ${noun}` })).toBeTruthy();

  }
  expect(screen.queryByRole("heading", { name: "Choose a project" })).toBeNull();
  expect(screen.queryByText(/This tool could not be opened/)).toBeNull();
  // Designs supplies the collection list; existing authoring controls remain reachable.
  fireEvent.click(screen.getByRole("button", { name: "Designs" }));
  expect(await screen.findByRole("button", { name: "Patch lead" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Designs advanced tools" })).toBeNull();
  expect(screen.queryByRole("menuitem", { name: "Cables" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Create cable draft" })).toBeNull();
});

test("Library scope lists the lens's collection with Used in, and opening a use switches scope but keeps the lens", async () => {
  const fetchMock = server({ authenticated: true }); renderApp();
  await screen.findByRole("button", { name: "Account menu, signed in as local-user" });
  await openTool("Wire stocks");
  expect(await screen.findByRole("heading", { name: "Wire stocks" })).toBeTruthy();
  expect(await screen.findByText("Bench stock")).toBeTruthy();
  expect(fetchMock.mock.calls.some(([path]) => String(path).includes("/projects/project-"))).toBe(false);
  fireEvent.click(screen.getByRole("button", { name: "Bench stock" }));
  await screen.findByRole("heading", { name: "Bench stock" });
  fireEvent.click(screen.getByRole("tab", { name: "More" }));
  fireEvent.click(await screen.findByText("Where used"));
  fireEvent.click(await screen.findByRole("button", { name: "Open Wire stock in Project B" }));
  expect(await screen.findByRole("heading", { name: "Bench stock" })).toBeTruthy();
  expect(screen.getByRole("tab", { name: "Wire stocks" }).getAttribute("aria-selected")).toBe("true");
  expect(window.location.search).toContain("project=project-b");
  expect(screen.queryByRole("button", { name: /^Scope .*: switch$/ })).toBeNull();
});

test("Inventory at Library scope also offers workspace-scoped Sourcing, with the plan picker listing workspace definitions", async () => {
  const fetchMock = server({ authenticated: true }); renderApp();
  await screen.findByRole("button", { name: "Account menu, signed in as local-user" });
  await openTool("Inventory");
  expect(await screen.findByRole("heading", { name: "Sourcing" })).toBeTruthy();
  expect(screen.getByLabelText("Plan definition")).toBeTruthy();
  expect(fetchMock.mock.calls.some(([path]) => String(path) === "/api/v0/workspaces/w1/definitions")).toBe(true);
  expect(screen.queryByRole("heading", { name: "Choose a project" })).toBeNull();
});

test("workspace-level lenses open at Library scope without choosing a project, and workspace access works at both scopes", async () => {
  const fetchMock = server({ authenticated: true }); renderApp();
  await screen.findByRole("button", { name: "Account menu, signed in as local-user" });
  await openTool("Notes & files");
  expect(await screen.findByRole("heading", { name: "Choose a project" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Open Notes & files in Project A" }));
  expect(await screen.findByRole("heading", { name: "Notes, decisions and attachments" })).toBeTruthy();
  expect(window.location.pathname).toBe("/projects/project-a/notes");
  expect(fetchMock.mock.calls.some(([path]) => String(path).startsWith("/api/v0/knowledge/workspaces/w1") && String(path).includes("project_id=project-a"))).toBe(true);
  await openTool("System");
  await waitFor(() => expect(fetchMock.mock.calls.some(([path]) => String(path).startsWith("/api/v0/diagnostics/workspaces/w1"))).toBe(true));
  expect(screen.queryByRole("heading", { name: "Choose a project" })).toBeNull();
  await openTool("Agents");
  expect(await screen.findByRole("heading", { name: "Agent access" })).toBeTruthy();
  expect(fetchMock.mock.calls.some(([path]) => path === "/api/v0/discovery/capabilities?workspace_id=w1")).toBe(true);
  await openTool("People");
  expect(await screen.findByRole("heading", { name: "Workspace access" })).toBeTruthy();
  expect(await screen.findByText("Workspace admins manage members, roles and grants.")).toBeTruthy();
});

test("Make hosts five functional panels without a second collection picker", async () => {
  server({ authenticated: true }); renderApp();
  await screen.findByRole("button", { name: "Account menu, signed in as local-user" });
  const tools = [
    ["Inventory", "/make/inventory", "Create location"],
    ["Physical units", "/make/units", "Register unit"],
    ["Material plans", "/make/material", "Save material plan"],
    ["Procurement BOMs", "/make/procurement", "Create BOM draft"],
    ["3D printing", "/make/printing", "Start new FDM preparation"],
  ];
  for (const [label, href, action] of tools) {
    await openTool(label!);
    expect(await screen.findByRole("button", { name: action! })).toBeTruthy();
    await waitFor(() => expect(window.location.pathname).toBe(href));
    expect(screen.queryByRole("heading", { name: /in the library$/ })).toBeNull();
    expect(screen.queryByRole("heading", { name: "Choose a project" })).toBeNull();
  }
});

test("Library home creates cable, harness and assembly designs through their authoring forms", async () => {
  server({ authenticated: true }); renderApp();
  await screen.findByRole("button", { name: "Account menu, signed in as local-user" });
  for (const [noun, action] of [["Cable", "Create cable draft"], ["Harness", "Save harness"], ["Assembly", "Save device"]]) {
    await openTool("Library home");
    fireEvent.click(await screen.findByRole("button", { name: "New…" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: noun! }));
    if (noun === "Cable") fireEvent.click(await screen.findByRole("button", { name: "Start blank cable" }));
    expect(await screen.findByRole("button", { name: action! })).toBeTruthy();
  }
});

test('Settings tabs open explicit workspace pages without requiring a project', async () => {
  const fetchMock = server({ authenticated: true }); renderApp();
  await screen.findByRole('button', { name: 'Account menu, signed in as local-user' });
  for (const [label, path] of [['Documents', '/settings/documents'], ['Engineering', '/settings/engineering'], ['Part numbering', '/settings/numbering'], ['Validation rules', '/settings/rules'], ['Webhooks', '/settings/webhooks']] as const) {
    await openTool(label);
    expect(await screen.findByRole('heading', { name: label, level: 2 })).toBeTruthy();
    expect(window.location.pathname).toBe(path);
    expect(screen.queryByRole('heading', { name: 'Choose a project' })).toBeNull();
  }
  expect(fetchMock.mock.calls.some(([path, options]) => path === '/api/v0/operations' && JSON.parse(String(options?.body)).operation === 'workspace.settings.get')).toBe(true);
});


test('History is a lazy workspace read for viewers with explicit evidence limits', async () => {
  const fetchMock = server({ authenticated: true, role: 'viewer' }); renderApp();
  await screen.findByRole('button', { name: 'Account menu, signed in as local-user' });
  expect(fetchMock.mock.calls.some(([path]) => path.startsWith('/api/v0/workspace/history?'))).toBe(false);
  await openTool('History');
  expect(await screen.findByRole('table', { name: 'Workspace history' })).toBeTruthy();
  expect(screen.getByText(/This is not a complete edit log/)).toBeTruthy();
  expect(screen.queryByRole('heading', { name: 'Choose a project' })).toBeNull();
  const reads = fetchMock.mock.calls.filter(([path]) => path.startsWith('/api/v0/workspace/history?'));
  expect(reads.length).toBeGreaterThan(0); expect(reads.every(([path, options]) => path.includes('workspace_id=w1') && !options?.method)).toBe(true);
});


test('Products tabs share the shell and retain an unsaved structured family across Lineup', async () => {
  server({ authenticated: true }); renderApp();
  await screen.findByRole('button', { name: 'Account menu, signed in as local-user' });
  await openTool('Families');
  expect(await screen.findByRole('heading', { name: 'Families' })).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'New family' }));
  fireEvent.change(await screen.findByLabelText('Family name'), { target: { value: 'Synthetic local family' } });
  await openTool('Lineup');
  expect(await screen.findByText('No readable frozen variants on this page.')).toBeTruthy();
  await openTool('Families'); await screen.findByLabelText('Family name');
  await waitFor(() => expect((screen.getByLabelText('Family name') as HTMLInputElement).value).toBe('Synthetic local family'));
  expect(screen.queryByRole('heading', { name: 'Choose a project' })).toBeNull();
});


test('an exact secondary source review opens independently of unavailable broader current metadata', async () => {
  const definition='10000000-0000-0000-0000-000000000011';const fallback=server({authenticated:true,role:'editor'});const paths:string[]=[];
  const content={pcb_assertion:{kind:'pcb_assertion',method:'human_assertion',source_role:'schematic',source:{source_revision_id:'10000000-0000-0000-0000-000000000012',manifest_sha256:'a'.repeat(64),path:'synthetic.sch',sha256:'b'.repeat(64),rights:'Synthetic'},coverage:'partial',coverage_basis:'Independent exact assertion',terminals:[]}};
  vi.stubGlobal('fetch',vi.fn(async(path:string,options?:RequestInit)=>{paths.push(path);if(path.startsWith(`/api/v0/workspace/library/${definition}`))return reply({error:{message:'Broader current metadata unavailable'}},403);if(path.includes(`/catalog/definitions/${definition}/record?`))return reply({definition_id:definition,workspace_id:'w1',kind:'pcb_assertion',name:'Exact historic secondary',selected:{kind:'revision',revision_id:'historic-review',number:7,snapshot_id:'historic-snapshot',sha256:'c'.repeat(64),content}});if(path.includes('/pcb-disagreement/revisions/historic-review'))return reply({revision_id:'historic-review',definition_id:definition,sha256:'c'.repeat(64),content,projection:{parity:'not_evaluated',physical_qualification:'not_evaluated'}});return fallback(path,options);}));
  window.history.pushState(null,'',`/library/boards/${definition}@7/~/slot?tool=pcb-disagreement`);window.dispatchEvent(new PopStateEvent('popstate'));renderApp();
  expect(await screen.findByRole('heading',{name:'Exact historic secondary'})).toBeTruthy();expect(paths.some(path=>path.includes(`/catalog/definitions/${definition}/record?revision_number=7`))).toBe(true);expect(screen.queryByText('Opening the exact board section…')).toBeNull();expect(window.location.pathname).toContain(`${definition}@7/~/slot`);
});


test('Home New opens independent option-set and configuration forms without an empty-device detour',async()=>{
 server({authenticated:true,role:'editor'});renderApp();await screen.findByRole('button',{name:'Account menu, signed in as local-user'});
 for(const [menu,kind] of [['Option set','option_set'],['Configuration','configuration']]){
  await act(async()=>window.history.pushState(null,'','/library'));
  fireEvent.click(await screen.findByRole('button',{name:'New…'}));fireEvent.click(await screen.findByRole('menuitem',{name:menu}));
  expect(await screen.findByRole('textbox',{name:`${menu} name`})).toBeTruthy();expect(new URLSearchParams(window.location.search).get('kind')).toBe(kind);expect(new URLSearchParams(window.location.search).get('status')).toBe('new');expect(screen.queryByRole('heading',{name:'No designs yet'})).toBeNull();
 }
});
