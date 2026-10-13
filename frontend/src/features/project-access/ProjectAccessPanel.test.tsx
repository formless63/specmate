import { MantineProvider } from "@mantine/core";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { ProjectAccessPanel } from "./ProjectAccessPanel";

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  Element.prototype.scrollIntoView = vi.fn();
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
function reply(body: unknown, status = 200) { return new Response(JSON.stringify(body), { status }); }
function setup(admin: boolean, denied = false) {
  let state = "access-1";
  const fetchMock = vi.fn(async (path: string, init?: RequestInit) => {
    if (path === "/api/v0/access/account-policy") return reply({ can_create_local_accounts: admin });
    if (path === "/api/v0/access/projects/project-a") return reply({ project_id: "project-a", name: "Synthetic project",
      permissions: admin ? ["project.read", "project.admin"] : ["project.read"],
      ...(admin ? { state, members: [{ username: "first-owner", role: "owner", grants: [] }] } : {}) });
    if (path === "/api/v0/operations") {
      if (denied) return reply({ error: { message: "Project not found." } }, 404);
      const body = JSON.parse(String(init?.body));
      state = "access-2";
      return reply({ result: { username: body.payload.username, state } });
    }
    throw new Error(`Unexpected route ${path}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  const refreshed = vi.fn(async () => {});
  render(<MantineProvider><ProjectAccessPanel projectId="project-a" onAccessChanged={refreshed} /></MantineProvider>);
  return { fetchMock, refreshed };
}

test("readers see their permissions without membership or account administration", async () => {
  setup(false);
  expect(await screen.findByText("Project administrators manage membership and grants.")).toBeTruthy();
  expect(screen.queryByText("first-owner")).toBeNull();
  expect(screen.queryByRole("button", { name: "Save member" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Create local account" })).toBeNull();
});

test("member update submits the current access token and refreshes project scope", async () => {
  const { fetchMock, refreshed } = setup(true);
  fireEvent.change(await screen.findByLabelText(/Local account username/), { target: { value: "new-member" } });
  fireEvent.click(screen.getByRole("button", { name: "Save member" }));
  expect(await screen.findByText("Project membership updated.")).toBeTruthy();
  const body = JSON.parse(String(fetchMock.mock.calls.find(([path]) => path === "/api/v0/operations")?.[1]?.body));
  expect(body).toMatchObject({ operation: "project.set_member", expected_state: "access-1", payload: { project_id: "project-a", username: "new-member", role: "viewer", grants: [] } });
  expect(refreshed).toHaveBeenCalledOnce();
});

test("credential creation does not use an idempotency key and clears the password", async () => {
  const { fetchMock } = setup(true);
  fireEvent.change(await screen.findByLabelText(/New account username/), { target: { value: "new-member" } });
  fireEvent.change(screen.getByLabelText(/New account password/), { target: { value: "independent-test-secret" } });
  fireEvent.click(screen.getByRole("button", { name: "Create local account" }));
  expect(await screen.findByText(/Local account created/)).toBeTruthy();
  const body = JSON.parse(String(fetchMock.mock.calls.find(([path]) => path === "/api/v0/operations")?.[1]?.body));
  expect(body.operation).toBe("account.create");
  expect(body).not.toHaveProperty("idempotency_key");
  expect((screen.getByLabelText(/New account password/) as HTMLInputElement).value).toBe("");
});

test("a scope denial clears the previously displayed roster", async () => {
  const { refreshed } = setup(true, true);
  fireEvent.change(await screen.findByLabelText(/Local account username/), { target: { value: "new-member" } });
  fireEvent.click(screen.getByRole("button", { name: "Save member" }));
  expect(await screen.findByText("Project not found.")).toBeTruthy();
  await waitFor(() => expect(screen.queryByText("first-owner")).toBeNull());
  expect(refreshed).toHaveBeenCalledOnce();
});

test("successful self-removal clears the enclosing workspace and private cache even when detail refresh is denied", async () => {
  const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
  const { WorkspaceShell } = await import("../workspace/WorkspaceShell");
  let removed = false;
  vi.stubGlobal("fetch", vi.fn(async (path: string) => {
    if (path === "/api/v0/session") return reply({ user: { id: "7", username: "first-owner" }, owner_setup_required: false });
    if (path === "/api/v0/projects") return reply(removed ? [] : [{ project_id: "project-a", name: "Synthetic project", permissions: ["project.admin"] }]);
    if (path === "/api/v0/access/account-policy") return reply({ can_create_local_accounts: false });
    if (path === "/api/v0/access/projects/project-a") return removed
      ? reply({ error: { message: "Project not found." } }, 404)
      : reply({ project_id: "project-a", name: "Synthetic project", permissions: ["project.admin"], state: "access-1", members: [{ username: "first-owner", role: "owner", grants: [] }, { username: "other-owner", role: "owner", grants: [] }] });
    if (path === "/api/v0/operations") { removed = true; return reply({ result: { state: "access-2" } }); }
    throw new Error(`Unexpected route ${path}`);
  }));
  const cache = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<MantineProvider><QueryClientProvider client={cache}><WorkspaceShell>{(projectId, _project, refreshProjects) => <>
    <span>Previously scoped private document</span><ProjectAccessPanel projectId={projectId} onAccessChanged={refreshProjects} />
  </>}</WorkspaceShell></QueryClientProvider></MantineProvider>);
  fireEvent.click(await screen.findByRole("combobox", { name: "Project" }));
  fireEvent.click(await screen.findByRole("option", { name: "Synthetic project", hidden: true }));
  expect(await screen.findByText("Previously scoped private document")).toBeTruthy();
  cache.setQueryData(["private-proof"], { content: "formerly authorized" });
  fireEvent.click(await screen.findByRole("button", { name: "Remove first-owner" }));
  await waitFor(() => expect(screen.queryByText("Previously scoped private document")).toBeNull());
  expect(cache.getQueryData(["private-proof"])).toBeUndefined();
  expect(screen.getByText("Select or create a project to begin.")).toBeTruthy();
});
