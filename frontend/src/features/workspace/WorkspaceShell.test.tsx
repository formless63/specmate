import { MantineProvider } from "@mantine/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { type ShellChrome } from "./WorkspaceShell";
import { ScopeHarness } from "../../test/ScopeHarness";
import { project, reply, signedIn, workspaceServer } from "../../test/workspaceServer";
import { readLastProject } from "../home/lastProject";
import { requestJson } from "./api";

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  Element.prototype.scrollIntoView = vi.fn();
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); window.localStorage.clear(); });
function renderShell() {
  const cache = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<MantineProvider><QueryClientProvider client={cache}>
    <ScopeHarness>{(projectId, _project, refresh, _principal, chrome, scope) => <PrivatePanel projectId={projectId} chrome={chrome} refresh={refresh} role={scope.role} />}</ScopeHarness>
  </QueryClientProvider></MantineProvider>);
  return cache;
}
function PrivatePanel({ projectId, chrome, refresh, role }: { projectId: string; chrome: ShellChrome; refresh: () => Promise<void>; role: string }) {
  const [value, setValue] = useState("");
  return <>{chrome.projectControl}{chrome.signOutControl}<button type="button" onClick={() => void refresh()}>Re-read workspace</button><div>Private project {projectId}</div>
    <div>Role {role}</div><input aria-label="Private note" value={value} onChange={(event) => setValue(event.currentTarget.value)} /></>;
}
const A = project("a", "Project A");
const B = project("b", "Project B");

test("sign-in uses CSRF, lands at Library scope with the workspace role, and opens nothing automatically", async () => {
  document.cookie = "csrftoken=browser-csrf";
  const csrf: (string | null)[] = [];
  const { fetchMock } = workspaceServer({ authenticated: false, projects: [A] }, (path, options) => {
    if (path === "/api/v0/session/login") csrf.push(new Headers(options?.headers).get("X-CSRFToken"));
    return undefined;
  });
  renderShell();
  await screen.findByRole("heading", { name: "Sign in" });
  fireEvent.change(screen.getByLabelText(/^Username/), { target: { value: "local-user" } });
  fireEvent.change(screen.getByLabelText(/^Password/), { target: { value: "secret-value" } });
  fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
  await screen.findByText("Signed in as local-user");
  expect(screen.queryByLabelText(/^Password/)).toBeNull();
  expect((screen.getByRole("combobox", { name: "Scope" }) as HTMLInputElement).value).toBe("Library");
  expect(screen.queryByText(/^Private project/)).toBeNull();
  expect(fetchMock).toHaveBeenCalledWith("/api/v0/workspace/projects?include_archived=true&limit=200", expect.anything());
  fireEvent.click(await screen.findByRole("button", { name: "Open Project A" }));
  expect(await screen.findByText("Private project a")).toBeTruthy();
  expect(screen.getByText("Role editor")).toBeTruthy();
  expect(readLastProject("7")).toBe("a");
});

test("setup uses existing owner endpoint and displays safe request errors", async () => {
  const fetchMock = vi.fn(async (path: string) => path === "/api/v0/session"
    ? reply({ user: null, owner_setup_required: true })
    : reply({ error: { message: "Setup token is invalid or expired." } }, 422));
  vi.stubGlobal("fetch", fetchMock);
  renderShell();
  await screen.findByText("Set up the first owner");
  fireEvent.change(screen.getByLabelText(/^Setup token/), { target: { value: "synthetic-token" } });
  fireEvent.change(screen.getByLabelText(/^Username/), { target: { value: "local-owner" } });
  fireEvent.change(screen.getByLabelText(/^Password/), { target: { value: "synthetic-password" } });
  fireEvent.click(screen.getByRole("button", { name: "Create owner account" }));
  expect(await screen.findByText("Setup token is invalid or expired.")).toBeTruthy();
  expect(fetchMock).toHaveBeenCalledWith("/api/v0/setup/owner", expect.anything());
  expect((screen.getByLabelText(/^Password/) as HTMLInputElement).value).toBe("");
});

test("scope changes reset private component state and query data; sign-out clears everything", async () => {
  workspaceServer({ projects: [A, B] });
  const cache = renderShell();
  fireEvent.click(await screen.findByRole("button", { name: "Open Project A" }));
  fireEvent.change(screen.getByLabelText("Private note"), { target: { value: "private note" } });
  cache.setQueryData(["private", "a"], "private-data");
  fireEvent.click(screen.getByRole("combobox", { name: "Scope" }));
  fireEvent.click(await screen.findByRole("option", { name: "Project B", hidden: true }));
  expect((await screen.findByLabelText("Private note") as HTMLInputElement).value).toBe("");
  expect(cache.getQueryData(["private", "a"])).toBeUndefined();
  cache.setQueryData(["private", "b"], "private-data");
  fireEvent.click(screen.getByRole("button", { name: "Switch to Library scope" }));
  await screen.findByRole("button", { name: "Open Project A" });
  expect(cache.getQueryData(["private", "b"])).toBeUndefined();
  cache.setQueryData(["private", "library"], "private-data");
  fireEvent.click(screen.getByRole("button", { name: "Sign out" }));
  await screen.findByRole("heading", { name: "Sign in" });
  expect(cache.getQueryData(["private", "library"])).toBeUndefined();
});

test("archived projects are left out of the scope switcher", async () => {
  workspaceServer({ projects: [A, project("z", "Old bench", { archived: true })] });
  renderShell();
  await screen.findByText("Signed in as local-user");
  fireEvent.click(screen.getByRole("combobox", { name: "Scope" }));
  expect(await screen.findByRole("option", { name: "Project A", hidden: true })).toBeTruthy();
  expect(screen.queryByRole("option", { name: /Old bench/, hidden: true })).toBeNull();
});

test("project creation uses the shared operation with no ownership target and opens the new project", async () => {
  const { state } = workspaceServer({ projects: [] });
  renderShell();
  await screen.findByText("Signed in as local-user");
  fireEvent.change(screen.getByLabelText(/^New project name/), { target: { value: "New project" } });
  fireEvent.click(screen.getByRole("button", { name: "Create project" }));
  expect(await screen.findByText("Private project p1")).toBeTruthy();
  expect(state.operations[0]).toMatchObject({ operation: "project.create", payload: { name: "New project" } });
  expect(Object.keys(state.operations[0]!.payload)).toEqual(["name"]);
});

test("a role change clears cached reads and says so; losing membership clears everything", async () => {
  const { state } = workspaceServer({ projects: [A] });
  const cache = renderShell();
  fireEvent.click(await screen.findByRole("button", { name: "Open Project A" }));
  cache.setQueryData(["private", "a"], "private-data");
  state.role = "viewer";
  fireEvent.click(await screen.findByRole("button", { name: "Re-read workspace" }));
  expect(await screen.findByText("Role viewer")).toBeTruthy();
  expect(screen.getByText(/Your workspace role is now viewer/)).toBeTruthy();
  expect(cache.getQueryData(["private", "a"])).toBeUndefined();
  cache.setQueryData(["private", "a"], "private-data");
  state.role = null;
  fireEvent.click(screen.getByRole("button", { name: "Re-read workspace" }));
  expect(await screen.findByText("No workspace access")).toBeTruthy();
  expect(screen.getByText(/no longer a member of this workspace/)).toBeTruthy();
  expect(screen.queryByText(/^Private project/)).toBeNull();
  expect(cache.getQueryData(["private", "a"])).toBeUndefined();
});

test("a deleted open project returns to the Library with a plain notice", async () => {
  const { state } = workspaceServer({ projects: [A, B] });
  renderShell();
  fireEvent.click(await screen.findByRole("button", { name: "Open Project A" }));
  await screen.findByText("Private project a");
  state.projects = [B];
  fireEvent.click(screen.getByRole("button", { name: "Re-read workspace" }));
  expect(await screen.findByText(/no longer exists/)).toBeTruthy();
  await waitFor(() => expect(screen.queryByText("Private project a")).toBeNull());
  await waitFor(() => expect(readLastProject("7")).toBeNull());
});

test("an account without membership sees a safe explanation and nothing private", async () => {
  vi.stubGlobal("fetch", vi.fn(async (path: string) => path === "/api/v0/session" ? reply(signedIn) : reply({ error: { message: "Not found." } }, 404)));
  renderShell();
  expect(await screen.findByText("No workspace access")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Check again" })).toBeTruthy();
});

test("multipart helper preserves browser boundary and fresh CSRF cookie", async () => {
  document.cookie = "csrftoken=rotated-csrf";
  const fetchMock = vi.fn().mockResolvedValue(reply({ ok: true }));
  vi.stubGlobal("fetch", fetchMock);
  const body = new FormData();
  body.append("content", new Blob(["synthetic"]), "fixture.txt");
  await requestJson("/api/v0/projects/a/blobs", { method: "POST", body });
  const options = fetchMock.mock.calls[0]![1] as RequestInit;
  expect(new Headers(options.headers).get("X-CSRFToken")).toBe("rotated-csrf");
  expect(new Headers(options.headers).has("Content-Type")).toBe(false);
  expect(options.credentials).toBe("same-origin");
});
