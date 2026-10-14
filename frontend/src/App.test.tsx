import { MantineProvider } from "@mantine/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { lazy } from "react";
import { App, ToolLoadingBoundary } from "./App";

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

function server({ authenticated = false, denyInventory = false, includePermissions = true, permissions = ["project.read", "source.register"] } = {}) {
  const fetchMock = vi.fn(async (path: string, options?: RequestInit) => {
    if (path === "/api/v0/session") return reply({ user: authenticated ? { id: "7", username: "local-user" } : null, owner_setup_required: false });
    if (path === "/api/v0/session/login") { authenticated = true; return reply({ result: {} }); }
    if (path === "/api/v0/session/logout") { authenticated = false; return reply({ result: {} }); }
    if (path === "/api/v0/projects") return reply([{ project_id: "project-a", name: "Project A", ...(includePermissions ? { permissions } : {}) }, { project_id: "project-b", name: "Project B", ...(includePermissions ? { permissions } : {}) }]);
    if (path === "/api/v0/operations") {
      const envelope = JSON.parse(String(options?.body));
      if (["collaboration.list", "collaboration.inbox"].includes(envelope.operation)) return reply({ result: { results: [], next_after: null } });
    }
    if (path.endsWith("/definitions") || path.endsWith("/stocks") || path.endsWith("/intakes")) return reply([]);
    if (path.startsWith("/api/v0/preparation-documents/projects/")) return reply({ document_sets: [] });
    if (path.startsWith("/api/v0/knowledge/projects/")) return reply({ items: [], offset: 0, limit: 50, has_more: false });
    if (path.startsWith("/api/v0/inventory/projects/")) return denyInventory
      ? reply({ error: { message: "Project not found." } }, 404)
      : reply({ accounts: [], locations: [], lots: [] });
    throw new Error(`Unexpected request ${path} ${options?.method ?? "GET"}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

async function selectProject(name: string) {
  fireEvent.click(screen.getByRole("combobox", { name: "Project" }));
  fireEvent.click(await screen.findByRole("option", { name, hidden: true }));
}

async function openAuthenticatedProjectTools() {
  server({ authenticated: true }); renderApp();
  await screen.findByText("Signed in as local-user");
  await selectProject("Project A");
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
  await selectProject("Project A");
  await screen.findByRole("heading", { name: "Reusable identities" });
  expect(screen.getByRole("tablist", { name: "Project tools" })).toBeTruthy();
  expect(fetchMock).toHaveBeenCalledWith("/api/v0/projects/project-a/definitions", expect.anything());
  expect(fetchMock.mock.calls.some(([path]) => path.includes("/stocks") || path.includes("/intakes") || path.includes("/inventory/"))).toBe(false);
  fireEvent.click(screen.getByRole("tab", { name: "Wire stock" }));
  await screen.findByRole("heading", { name: "Wire stock" });
  await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/v0/projects/project-a/stocks", expect.anything()));
  expect(screen.queryByRole("heading", { name: "Reusable identities" })).toBeNull();
  fireEvent.click(screen.getByRole("tab", { name: "PCB intake" }));
  await screen.findByRole("heading", { name: "PCB intake" });
  await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/v0/pcb/projects/project-a/intakes", expect.anything()));
  expect(screen.getByRole("button", { name: "Preserve sources" })).toBeTruthy();
  fireEvent.click(screen.getByRole("tab", { name: "Inventory" }));
  await screen.findByRole("heading", { name: "Inventory" }, { timeout: 5000 });
  await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/v0/inventory/projects/project-a?offset=0&limit=50", expect.anything()));
});

test("selected packages, firmware and mechanical tools mount with scoped read controls", async () => {
  await openAuthenticatedProjectTools();
  fireEvent.click(screen.getByRole("tab", { name: "Selected packages" }));
  await screen.findByRole("heading", { name: "Selected assembly packages" });
  expect(await screen.findByRole("button", { name: "Review exact selected package" })).toBeTruthy();
  fireEvent.click(screen.getByRole("tab", { name: "Board firmware" }));
  await screen.findByRole("heading", { name: "Firmware on repeated boards" });
  expect(screen.getByRole("button", { name: "Show occurrence firmware" })).toBeTruthy();
  fireEvent.click(screen.getByRole("tab", { name: "Mechanical sources" }));
  await screen.findByRole("heading", { name: "Mechanical sources" });
  expect(screen.getByRole("button", { name: "Refresh mechanical sources" })).toBeTruthy();
  fireEvent.click(screen.getByRole("tab", { name: "Firmware impact" }));
  await screen.findByRole("heading", { name: "Firmware change and observation review" });
  expect(screen.getByRole("button", { name: "Show firmware impact" })).toBeTruthy();
});

test("shared, assembly, connected and drawing views mount with scoped read controls", async () => {
  await openAuthenticatedProjectTools();
  fireEvent.click(screen.getByRole("tab", { name: "Shared scene" }));
  await screen.findByRole("heading", { name: "Shared scene" });
  expect(screen.getByRole("button", { name: "Refresh scene access" })).toBeTruthy();
  fireEvent.click(screen.getByRole("tab", { name: "Assemblies" }));
  await screen.findByRole("heading", { name: "Reusable assemblies" });
  expect(screen.queryByRole("button", { name: "Create assembly draft" })).toBeNull();
  fireEvent.click(screen.getByRole("tab", { name: "Connected views" }));
  await screen.findByRole("heading", { name: "Contextual inspection" });
  expect(screen.getByRole("button", { name: "Refresh contextual scene choices" })).toBeTruthy();
  fireEvent.click(screen.getByRole("tab", { name: "Scene drawings" }));
  await screen.findByRole("heading", { name: "Scene inspection drawings" });
  expect(screen.getByRole("button", { name: "Inspect drawing scene" })).toBeTruthy();
});

test("documents, interfaces and knowledge mount with scoped read controls", async () => {
  await openAuthenticatedProjectTools();
  fireEvent.click(screen.getByRole("tab", { name: "Bench documents" }));
  await screen.findByRole("heading", { name: "Coordinated documents" });
  expect((screen.getByRole("button", { name: "Generate reviewed document set" }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole("tab", { name: "Interfaces" }));
  await screen.findByRole("heading", { name: "Interface assessments" });
  expect(screen.queryByRole("button", { name: "New assessment" })).toBeNull();
  fireEvent.click(screen.getByRole("tab", { name: "Notes & files" }));
  await screen.findByRole("heading", { name: "Notes, decisions and attachments" });
  expect(screen.queryByRole("button", { name: "Create knowledge item" })).toBeNull();
  await screen.findByRole("heading", { name: "Search notes and attachments" });
  await screen.findByRole("heading", { name: "Team changes" });
  expect((screen.getByRole("button", { name: "Open team review" }) as HTMLButtonElement).disabled).toBe(true);
});

test("project changes reset panel state and selected tab, and sign-out removes private tools", async () => {
  const fetchMock = server({ authenticated: true });
  const cache = renderApp();
  await screen.findByText("Signed in as local-user");
  await selectProject("Project A");
  fireEvent.click(screen.getByRole("tab", { name: "Inventory" }));
  fireEvent.change(await screen.findByLabelText("New location name"), { target: { value: "Private shelf draft" } });
  fireEvent.click(screen.getByRole("tab", { name: "Identities" }));
  fireEvent.click(screen.getByRole("tab", { name: "Inventory" }));
  expect((screen.getByLabelText("New location name") as HTMLInputElement).value).toBe("Private shelf draft");
  cache.setQueryData(["private", "project-a"], "synthetic-private-data");
  await selectProject("Project B");
  await screen.findByRole("heading", { name: "Reusable identities" });
  expect(screen.queryByLabelText("New location name")).toBeNull();
  expect(cache.getQueryData(["private", "project-a"])).toBeUndefined();
  fireEvent.click(screen.getByRole("tab", { name: "Inventory" }));
  expect((await screen.findByLabelText("New location name") as HTMLInputElement).value).toBe("");
  await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/v0/inventory/projects/project-b?offset=0&limit=50", expect.anything()));
  fireEvent.click(screen.getByRole("button", { name: "Sign out" }));
  await screen.findByRole("heading", { name: "Sign in" });
  expect(screen.queryByRole("tablist")).toBeNull();
  expect(screen.queryByLabelText("New location name")).toBeNull();
  expect(cache.getQueryData(["inventory", "project-b", 0])).toBeUndefined();
});

test.each([true, false])("PCB controls require explicit grants (permissions supplied: %s), and scoped read denial is visible", async (includePermissions) => {
  server({ authenticated: true, permissions: ["project.read"], includePermissions, denyInventory: true }); renderApp();
  await screen.findByText("Signed in as local-user");
  await selectProject("Project A");
  fireEvent.click(screen.getByRole("tab", { name: "PCB intake" }));
  await screen.findByRole("heading", { name: "PCB intake" });
  expect(screen.queryByRole("button", { name: "Preserve sources" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Request native extraction" })).toBeNull();
  fireEvent.click(screen.getByRole("tab", { name: "Inventory" }));
  expect(await screen.findByText("Project not found.")).toBeTruthy();
  expect(screen.queryByText("Inventory operation completed.")).toBeNull();
});
