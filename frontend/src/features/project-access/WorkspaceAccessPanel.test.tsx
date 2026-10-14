import { MantineProvider } from "@mantine/core";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { WorkspaceAccessPanel } from "./WorkspaceAccessPanel";

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  Element.prototype.scrollIntoView = vi.fn();
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
function reply(body: unknown, status = 200) { return new Response(JSON.stringify(body), { status }); }
function setup(admin: boolean, denied = false) {
  let state = "workspace-1";
  const fetchMock = vi.fn(async (path: string, init?: RequestInit) => {
    if (path === "/api/v0/access/account-policy") return reply({ can_create_local_accounts: admin });
    if (path === "/api/v0/access/workspace") return reply({ workspace_id: "w1", name: "Workspace",
      role: admin ? "admin" : "viewer", permissions: admin ? ["workspace.read", "workspace.admin", "build.execute", "inventory.manage"] : ["workspace.read"],
      ...(admin ? { state, members: [{ username: "first-owner", role: "admin", grants: [] }, { username: "bench", role: "contributor", grants: ["build.execute"] }] } : {}) });
    if (path === "/api/v0/operations") {
      if (denied) return reply({ error: { message: "Not found." } }, 404);
      const body = JSON.parse(String(init?.body));
      state = "workspace-2";
      return reply({ result: { username: body.payload.username, state } });
    }
    throw new Error(`Unexpected route ${path}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  const refreshed = vi.fn(async () => {});
  render(<MantineProvider><WorkspaceAccessPanel onAccessChanged={refreshed} /></MantineProvider>);
  return { fetchMock, refreshed };
}
const operation = (fetchMock: ReturnType<typeof vi.fn>) => JSON.parse(String(fetchMock.mock.calls.find(([path]) => path === "/api/v0/operations")?.[1]?.body));

test("members who are not admins see their role, not the roster or account administration", async () => {
  setup(false);
  expect(await screen.findByText("Workspace admins manage members, roles and grants.")).toBeTruthy();
  expect(screen.getByText("Viewer")).toBeTruthy();
  expect(screen.getByText("Admins only")).toBeTruthy();
  expect(screen.queryByText("first-owner")).toBeNull();
  expect(screen.queryByRole("button", { name: "Save member" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Create local account" })).toBeNull();
});

test("setting a member uses workspace.set_member with the access token, roles and explicit grants only", async () => {
  const { fetchMock, refreshed } = setup(true);
  expect(await screen.findByText("bench")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Edit bench" }));
  expect((screen.getByLabelText(/Local account username/) as HTMLInputElement).value).toBe("bench");
  fireEvent.click(screen.getByRole("button", { name: "Save member" }));
  expect(await screen.findByText("Workspace membership updated.")).toBeTruthy();
  expect(operation(fetchMock)).toMatchObject({ operation: "workspace.set_member", expected_state: "workspace-1",
    payload: { workspace_id: "w1", username: "bench", role: "contributor", grants: ["build.execute"] } });
  expect(refreshed).toHaveBeenCalledOnce();
});

test("removing a member uses workspace.remove_member", async () => {
  const { fetchMock } = setup(true);
  fireEvent.click(await screen.findByRole("button", { name: "Remove bench" }));
  expect(await screen.findByText("bench is no longer a member.")).toBeTruthy();
  expect(operation(fetchMock)).toMatchObject({ operation: "workspace.remove_member", expected_state: "workspace-1", payload: { username: "bench" } });
});

test("a denied change clears the panel and asks the shell to re-read membership", async () => {
  const { refreshed } = setup(true, true);
  fireEvent.click(await screen.findByRole("button", { name: "Remove bench" }));
  expect(await screen.findByText("Not found.")).toBeTruthy();
  await waitFor(() => expect(refreshed).toHaveBeenCalledOnce());
  expect(screen.queryByText("first-owner")).toBeNull();
});

test("the installation owner can create a local account, which grants no membership", async () => {
  const { fetchMock } = setup(true);
  fireEvent.change(await screen.findByLabelText(/New account username/), { target: { value: "newcomer" } });
  fireEvent.change(screen.getByLabelText(/New account password/), { target: { value: "synthetic-password" } });
  fireEvent.click(screen.getByRole("button", { name: "Create local account" }));
  expect(await screen.findByText(/Add it as a member to grant access/)).toBeTruthy();
  expect(operation(fetchMock)).toMatchObject({ operation: "account.create", payload: { username: "newcomer" } });
  expect((screen.getByLabelText(/New account password/) as HTMLInputElement).value).toBe("");
});
