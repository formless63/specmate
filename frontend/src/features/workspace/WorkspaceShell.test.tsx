import { MantineProvider } from "@mantine/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { WorkspaceShell, type ShellChrome } from "./WorkspaceShell";
import { readLastProject } from "../home/lastProject";
import { requestJson } from "./api";

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  Element.prototype.scrollIntoView = vi.fn();
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); window.localStorage.clear(); });
function reply(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status });
}
function renderShell() {
  const cache = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<MantineProvider><QueryClientProvider client={cache}>
    <WorkspaceShell>{(projectId, _project, refresh, _principal, chrome) => <PrivatePanel projectId={projectId} chrome={chrome} refresh={refresh} />}</WorkspaceShell>
  </QueryClientProvider></MantineProvider>);
  return cache;
}
function PrivatePanel({ projectId, chrome, refresh }: { projectId: string; chrome: ShellChrome; refresh: () => Promise<void> }) {
  const [value, setValue] = useState("");
  return <>{chrome.projectControl}{chrome.signOutControl}<button type="button" onClick={() => void refresh()}>Re-read projects</button><div>Private project {projectId}</div><input aria-label="Private note" value={value}
    onChange={(event) => setValue(event.currentTarget.value)} /></>;
}
const signedIn = { user: { id: "7", username: "local-user" }, owner_setup_required: false };

test("anonymous login uses CSRF, loads scoped projects, and clears password", async () => {
  document.cookie = "csrftoken=browser-csrf";
  let authenticated = false;
  const fetchMock = vi.fn(async (path: string, options?: RequestInit) => {
    if (path === "/api/v0/session") return reply(authenticated ? signedIn : { user: null, owner_setup_required: false });
    if (path === "/api/v0/session/login") {
      expect(new Headers(options?.headers).get("X-CSRFToken")).toBe("browser-csrf");
      expect(JSON.parse(options?.body as string)).toMatchObject({ username: "local-user", password: "secret-value" });
      authenticated = true;
      return reply({ result: signedIn });
    }
    if (path === "/api/v0/projects") return reply([{ project_id: "a", name: "Project A", hidden: true }]);
    throw new Error(`Unexpected request ${path}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  renderShell();
  await screen.findByRole("heading", { name: "Sign in" });
  fireEvent.change(screen.getByLabelText(/^Username/), { target: { value: "local-user" } });
  fireEvent.change(screen.getByLabelText(/^Password/), { target: { value: "secret-value" } });
  fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
  await screen.findByText("Signed in as local-user");
  expect(screen.queryByLabelText(/^Password/)).toBeNull();
  expect(screen.queryByRole("combobox", { name: "Project" })).toBeNull();
  fireEvent.click(await screen.findByRole("button", { name: "Open Project A" }));
  expect(await screen.findByText("Private project a")).toBeTruthy();
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

test("project selection resets private component state and logout clears query data", async () => {
  let authenticated = true;
  vi.stubGlobal("fetch", vi.fn(async (path: string) => {
    if (path === "/api/v0/session") return reply(authenticated ? signedIn : { user: null, owner_setup_required: false });
    if (path === "/api/v0/projects") return reply([{ project_id: "a", name: "Project A", hidden: true }, { project_id: "b", name: "Project B", hidden: true }]);
    if (path === "/api/v0/session/logout") { authenticated = false; return reply({ result: {} }); }
    throw new Error(`Unexpected request ${path}`);
  }));
  const cache = renderShell();
  await screen.findByText("Signed in as local-user");
  fireEvent.click(await screen.findByRole("button", { name: "Open Project A" }));
  fireEvent.change(screen.getByLabelText("Private note"), { target: { value: "private note" } });
  cache.setQueryData(["private", "a"], "private-data");
  fireEvent.click(screen.getByRole("combobox", { name: "Project" }));
  fireEvent.click(await screen.findByRole("option", { name: "Project B", hidden: true }));
  expect((await screen.findByLabelText("Private note") as HTMLInputElement).value).toBe("");
  expect(cache.getQueryData(["private", "a"])).toBeUndefined();
  cache.setQueryData(["private", "b"], "private-data");
  fireEvent.click(screen.getByRole("button", { name: "Sign out" }));
  await screen.findByRole("heading", { name: "Sign in" });
  expect(screen.queryByLabelText("Private note")).toBeNull();
  expect(cache.getQueryData(["private", "b"])).toBeUndefined();
});

test("project creation uses shared operation and selects the new private project", async () => {
  let created = false;
  const fetchMock = vi.fn(async (path: string, options?: RequestInit) => {
    if (path === "/api/v0/session") return reply(signedIn);
    if (path === "/api/v0/projects") return reply(created ? [{ project_id: "new", name: "New project" }] : []);
    if (path === "/api/v0/operations") {
      expect(JSON.parse(options?.body as string)).toMatchObject({ operation: "project.create", payload: { name: "New project" } });
      created = true;
      return reply({ result: { project_id: "new", name: "New project" } });
    }
    throw new Error(`Unexpected request ${path}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  renderShell();
  await screen.findByText("Signed in as local-user");
  fireEvent.change(screen.getByLabelText(/^New project name/), { target: { value: "New project" } });
  fireEvent.click(screen.getByRole("button", { name: "Create project" }));
  expect(await screen.findByText("Private project new")).toBeTruthy();
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
