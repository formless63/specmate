import { MantineProvider } from "@mantine/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { lazy } from "react";
import { App, ToolLoadingBoundary } from "./App";
import { AREAS } from "./features/shell";

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  Element.prototype.scrollIntoView = vi.fn();
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

test("a rejected deferred tool stays contained with explicit reload guidance", async () => {
  const errors = vi.spyOn(console, "error").mockImplementation(() => {});
  const Unavailable = lazy(() => Promise.reject(new Error("Synthetic module unavailable")));
  try {
    render(<MantineProvider><ToolLoadingBoundary><Unavailable /></ToolLoadingBoundary></MantineProvider>);
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.getByText(/unsaved edits will be lost/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Reload page" })).toBeTruthy();
    expect(screen.queryByText("Synthetic module unavailable")).toBeNull();
  } finally { errors.mockRestore(); }
});

function renderApp() {
  const cache = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<MantineProvider><QueryClientProvider client={cache}><App /></QueryClientProvider></MantineProvider>);
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
    if (path.startsWith("/api/v0/workspace/library?")) {
      const url = new URL(path, "http://test");
      const projectId = url.searchParams.get("project_id");
      const rows = library.map((row) => ({ ...row, referenced: projectId ? row.used_in.some((use) => use.project_id === projectId) : null }))
        .filter((row) => url.searchParams.get("referenced_only") !== "true" || row.referenced);
      return reply({ workspace_id: "w1", family: url.searchParams.get("family"), project_id: projectId, results: url.searchParams.getAll("kinds").includes("cable") ? rows : [], next_after: null });
    }
    if (path === "/api/v0/access/workspace") return reply({ workspace_id: "w1", name: "Workspace", role, permissions: ROLES[role] });
    if (path === "/api/v0/access/account-policy") return reply({ can_create_local_accounts: false });
    if (path === "/api/v0/operations") {
      const envelope = JSON.parse(String(options?.body));
      if (["collaboration.list", "collaboration.inbox"].includes(envelope.operation)) return reply({ result: { results: [], next_after: null } });
    }
    if (path.startsWith("/api/v0/diagnostics/workspaces/")) return reply({ workspace_id: "p", evaluated_at: "2026-01-01T00:00:00Z", work: { mode: "running", accepting_new_work: true, reason: "", state_token: "work-v0" }, queue: { states: {}, pending: 0, active: 0, oldest_pending_seconds: null }, dispatch: { undelivered: 0, oldest_undelivered_seconds: null }, runner: { state: "not_enrolled", credentials_usable: 0, stages_holding_lease: 0, stages_lease_expired: 0 }, tools: [], storage: { state: "not_initialized", code: null, sampled: 0 }, workflow_engine: { state: "not_evaluated" }, builds: [], can_execute: false, findings: [] });
    if (path.startsWith("/api/v0/collaboration/inbox?") || path.startsWith("/api/v0/collaboration/reviews?")) return reply({ results: [], next_after: null });
    if (path.startsWith("/api/v0/catalog/definitions?")) return reply({ workspace_id: "workspace", project_id: null, results: [], next_after: null });
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

/** Opens a tool the way a person does: choose its area on the rail, then its lens tab. */
function openTool(label: string) {
  const area = AREAS.find((item) => item.tools.some((tool) => tool.label === label));
  if (!area) throw new Error(`Unknown tool ${label}`);
  fireEvent.click(screen.getByRole("button", { name: area.label }));
  fireEvent.click(screen.getByRole("tab", { name: label }));
}

/** From the project list at Library scope, open a project the way a person does: choose its row. */
async function openProject(name: string) {
  fireEvent.click(await screen.findByRole("button", { name: `Open ${name}` }));
  await screen.findByRole("heading", { name: "Overview" });
}

/** Inside a project, switch with the top-bar project control. */
async function selectProject(name: string) {
  fireEvent.click(screen.getByRole("combobox", { name: "Scope" }));
  fireEvent.click(await screen.findByRole("option", { name, hidden: true }));
}

async function openAuthenticatedProjectTools() {
  server({ authenticated: true }); renderApp();
  await screen.findByText("Signed in as local-user");
  await openProject("Project A");
  openTool("Identities");
  await screen.findByRole("heading", { name: "Reusable identities" });
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
  await screen.findByText("Signed in as local-user");
  // Sign-in lands inside the one shell at Library scope, on the project list; nothing opens automatically.
  expect(screen.getByTestId("sb-top-bar")).toBeTruthy();
  expect(screen.getByRole("navigation", { name: "Areas" })).toBeTruthy();
  expect(await screen.findByRole("region", { name: "Projects" })).toBeTruthy();
  expect((screen.getByRole("combobox", { name: "Scope" }) as HTMLInputElement).value).toBe("Library");
  expect(screen.queryByText("Select or create a project to begin.")).toBeNull();
  await openProject("Project A");
  expect(screen.getByRole("tablist", { name: "Project tools" })).toBeTruthy();
  expect(screen.getByRole("tab", { name: "Overview" }).getAttribute("aria-selected")).toBe("true");
  openTool("Identities");
  await screen.findByRole("heading", { name: "Reusable identities" });
  expect(screen.getByRole("tablist", { name: "Library tools" })).toBeTruthy();
  expect(fetchMock).toHaveBeenCalledWith("/api/v0/catalog/definitions?limit=100&project_id=project-a", expect.anything());
  expect(fetchMock.mock.calls.some(([path]) => path.includes("/stocks") || path.includes("/intakes") || path.includes("/inventory/"))).toBe(false);
  openTool("Wire stock");
  await screen.findByRole("heading", { name: "Wire stock" });
  await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/v0/stocks?project_id=project-a", expect.anything()));
  expect(screen.queryByRole("heading", { name: "Reusable identities" })).toBeNull();
  openTool("PCB intake");
  await screen.findByRole("heading", { name: "PCB intake" });
  await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/v0/pcb/workspaces/w1/intakes", expect.anything()));
  expect(screen.getByRole("button", { name: "Preserve sources" })).toBeTruthy();
  openTool("Inventory");
  await screen.findByRole("heading", { name: "Inventory" });
  await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/v0/inventory/workspaces/w1?offset=0&limit=50", expect.anything()));
});

test("selected packages, firmware and mechanical tools mount with scoped read controls", async () => {
  await openAuthenticatedProjectTools();
  openTool("Selected packages");
  await screen.findByRole("heading", { name: "Selected assembly packages" });
  expect(await screen.findByRole("button", { name: "Review exact selected package" })).toBeTruthy();
  openTool("Board firmware");
  await screen.findByRole("heading", { name: "Firmware on repeated boards" });
  expect(screen.getByRole("button", { name: "Show occurrence firmware" })).toBeTruthy();
  openTool("Mechanical sources");
  await screen.findByRole("heading", { name: "Mechanical sources" });
  expect(screen.getByRole("button", { name: "Refresh mechanical sources" })).toBeTruthy();
  openTool("Firmware impact");
  await screen.findByRole("heading", { name: "Firmware change and observation review" });
  expect(screen.getByRole("button", { name: "Show firmware impact" })).toBeTruthy();
});

test("shared, assembly, connected and drawing views mount with scoped read controls", async () => {
  await openAuthenticatedProjectTools();
  openTool("Shared scene");
  await screen.findByRole("heading", { name: "Shared scene" });
  expect(screen.getByRole("button", { name: "Refresh scene access" })).toBeTruthy();
  openTool("Assemblies");
  await screen.findByRole("heading", { name: "Reusable assemblies" });
  // Contributors create workspace items (item.create); editing drafts still needs design.edit.
  expect(screen.getByRole("button", { name: "Create assembly draft" })).toBeTruthy();
  openTool("Connected views");
  await screen.findByRole("heading", { name: "Contextual inspection" });
  expect(screen.getByRole("button", { name: "Refresh contextual scene choices" })).toBeTruthy();
  openTool("Scene drawings");
  await screen.findByRole("heading", { name: "Scene inspection drawings" });
  expect(screen.getByRole("button", { name: "Inspect drawing scene" })).toBeTruthy();
});

test("documents, interfaces and knowledge mount with scoped read controls", async () => {
  await openAuthenticatedProjectTools();
  openTool("Bench documents");
  await screen.findByRole("heading", { name: "Coordinated documents" });
  expect((screen.getByRole("button", { name: "Generate reviewed document set" }) as HTMLButtonElement).disabled).toBe(true);
  openTool("Interfaces");
  await screen.findByRole("heading", { name: "Interface assessments" });
  expect(screen.queryByRole("button", { name: "New assessment" })).toBeNull();
  openTool("Notes & files");
  await screen.findByRole("heading", { name: "Notes, decisions and attachments" });
  // knowledge.create needs item.create, which contributors hold.
  expect(await screen.findByRole("button", { name: "Create knowledge item" })).toBeTruthy();
  await screen.findByRole("heading", { name: "Search notes and attachments" });
  await screen.findByRole("heading", { name: "Team changes" });
  expect((screen.getByRole("button", { name: "Open team review" }) as HTMLButtonElement).disabled).toBe(true);
});

test("project changes reset panel state and selected tab, and sign-out removes private tools", async () => {
  const fetchMock = server({ authenticated: true });
  const cache = renderApp();
  await screen.findByText("Signed in as local-user");
  await openProject("Project A");
  openTool("Inventory");
  fireEvent.change(await screen.findByLabelText("New location name"), { target: { value: "Private shelf draft" } });
  openTool("Identities");
  openTool("Inventory");
  expect((screen.getByLabelText("New location name") as HTMLInputElement).value).toBe("Private shelf draft");
  cache.setQueryData(["private", "project-a"], "synthetic-private-data");
  const inventoryReads = () => fetchMock.mock.calls.filter(([path]) => path === "/api/v0/inventory/workspaces/w1?offset=0&limit=50").length;
  const readsBefore = inventoryReads();
  await selectProject("Project B");
  // The area and lens survive the scope change; the lens remounts empty for the new project.
  expect(screen.getByRole("tab", { name: "Inventory" }).getAttribute("aria-selected")).toBe("true");
  expect(cache.getQueryData(["private", "project-a"])).toBeUndefined();
  expect((await screen.findByLabelText("New location name") as HTMLInputElement).value).toBe("");
  // The inventory is the workspace's; the remounted lens reads it afresh for the new scope.
  await waitFor(() => expect(inventoryReads()).toBeGreaterThan(readsBefore));
  fireEvent.click(screen.getByRole("button", { name: "Sign out" }));
  await screen.findByRole("heading", { name: "Sign in" });
  expect(screen.queryByRole("tablist")).toBeNull();
  expect(screen.queryByLabelText("New location name")).toBeNull();
  expect(cache.getQueryData(["inventory", "w1", null, 0])).toBeUndefined();
});

test("PCB controls require explicit grants, and a denied read is visible", async () => {
  server({ authenticated: true, role: "viewer", denyInventory: true }); renderApp();
  await screen.findByText("Signed in as local-user");
  await openProject("Project A");
  openTool("PCB intake");
  await screen.findByRole("heading", { name: "PCB intake" });
  expect(screen.queryByRole("button", { name: "Preserve sources" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Request native extraction" })).toBeNull();
  openTool("Inventory");
  expect(await screen.findByText("Project not found.")).toBeTruthy();
  expect(screen.queryByText("Inventory operation completed.")).toBeNull();
});

test("overview start points and open-work links open the owning tool through the shell", async () => {
  server({ authenticated: true }); renderApp();
  await screen.findByText("Signed in as local-user");
  await openProject("Project A");
  fireEvent.click(screen.getByRole("button", { name: "Start: Stock record" }));
  await screen.findByRole("heading", { name: "Wire stock" });
  expect(screen.getByRole("tab", { name: "Wire stock" }).getAttribute("aria-selected")).toBe("true");
  expect(screen.getByRole("tablist", { name: "Library tools" })).toBeTruthy();
  // The Overview keeps its place in the Project area and returns without losing the project.
  fireEvent.click(screen.getByRole("button", { name: "Project" }));
  expect(screen.getByRole("tab", { name: "Overview" }).getAttribute("aria-selected")).toBe("true");
});

test.each([
  ["a viewer", "viewer", true],
  ["a contributor", "contributor", false],
])("workspace permissions reach tool panels: %s sees Save stock disabled: %s", async (_name, role, off) => {
  server({ authenticated: true, role }); renderApp();
  await screen.findByText("Signed in as local-user");
  await openProject("Project A");
  openTool("Wire stock");
  await screen.findByRole("heading", { name: "Wire stock" });
  const save = screen.getByRole("button", { name: "Save stock" }) as HTMLButtonElement;
  expect(save.disabled).toBe(off);
  expect(save.title).toBe(off ? "Read-only access: requires Contributor access" : "");
  expect((screen.getByRole("button", { name: "Freeze saved stock" }) as HTMLButtonElement).disabled).toBe(true);
  openTool("Inventory");
  await screen.findByRole("heading", { name: "Inventory" });
  expect((screen.getByRole("button", { name: "Create location" }) as HTMLButtonElement).title).toBe("Read-only access: requires Inventory management");
});

test("Library scope lists the lens's collection with Used in, and opening a use switches scope but keeps the lens", async () => {
  const fetchMock = server({ authenticated: true }); renderApp();
  await screen.findByText("Signed in as local-user");
  openTool("Cables");
  expect(await screen.findByRole("heading", { name: "Cables in the library" })).toBeTruthy();
  expect(await screen.findByText("Patch lead")).toBeTruthy();
  expect(fetchMock.mock.calls.some(([path]) => String(path).includes("/projects/project-"))).toBe(false);
  fireEvent.click(screen.getByRole("button", { name: "Show uses of Patch lead" }));
  fireEvent.click(screen.getByRole("button", { name: "Open Cables in Project B" }));
  expect(await screen.findByRole("heading", { name: "Cables in this project" })).toBeTruthy();
  expect(screen.getByRole("tab", { name: "Cables" }).getAttribute("aria-selected")).toBe("true");
  expect((screen.getByRole("combobox", { name: "Scope" }) as HTMLInputElement).value).toBe("Project B");
  expect(screen.getByText("Opened from the library")).toBeTruthy();
});

test("project-held lenses offer an inline chooser at Library scope, and workspace access works at both scopes", async () => {
  server({ authenticated: true }); renderApp();
  await screen.findByText("Signed in as local-user");
  openTool("Notes & files");
  expect(await screen.findByRole("heading", { name: "Choose a project" })).toBeTruthy();
  openTool("Workspace access");
  expect(await screen.findByRole("heading", { name: "Workspace access" })).toBeTruthy();
  expect(await screen.findByText("Workspace admins manage members, roles and grants.")).toBeTruthy();
  openTool("Notes & files");
  fireEvent.click(screen.getByRole("button", { name: "Open Notes & files in Project A" }));
  await screen.findByRole("heading", { name: "Notes, decisions and attachments" });
  expect((screen.getByRole("combobox", { name: "Scope" }) as HTMLInputElement).value).toBe("Project A");
});
