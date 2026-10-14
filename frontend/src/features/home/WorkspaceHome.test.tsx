import { MantineProvider } from "@mantine/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { WorkspaceShell } from "../workspace/WorkspaceShell";
import { readLastProject, writeLastProject } from "./lastProject";

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  Element.prototype.scrollIntoView = vi.fn();
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); window.localStorage.clear(); });

const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const signedIn = { user: { id: "7", username: "local-user" }, owner_setup_required: false };

type Options = { projects?: unknown[]; session?: unknown; inbox?: unknown; reviews?: unknown; failSession?: boolean };
function setup({ projects = [], session = signedIn, inbox = { results: [], next_after: null }, reviews = { results: [], next_after: null }, failSession = false }: Options = {}) {
  let list = projects;
  const fetchMock = vi.fn(async (path: string, options?: RequestInit) => {
    if (path === "/api/v0/session") { if (failSession) throw new Error("Network down"); return reply(session); }
    if (path === "/api/v0/projects") return reply(list);
    if (path.includes("/inbox")) return reply(inbox);
    if (path.endsWith("/reviews") || path.includes("/reviews?")) return reply(reviews);
    if (path === "/api/v0/session/logout") return reply({ result: {} });
    if (path === "/api/v0/operations") {
      const body = JSON.parse(String(options?.body)) as { operation: string };
      if (body.operation === "project.create") return reply({ error: { message: "Session expired." } }, 401);
    }
    throw new Error(`Unexpected request ${path}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  const cache = new QueryClient();
  render(<MantineProvider><QueryClientProvider client={cache}>
    <WorkspaceShell>{(projectId, _project, refresh, _principal, chrome) => <>{chrome.projectControl}{chrome.signOutControl}
      <button type="button" onClick={() => { list = []; void refresh(); }}>Revoke all</button><div>Inside {projectId}</div></>}</WorkspaceShell>
  </QueryClientProvider></MantineProvider>);
  return { fetchMock, cache };
}

const A = { project_id: "a", name: "Project A", permissions: ["project.read", "design.edit", "source.register"] };
const B = { project_id: "b", name: "Project B", permissions: ["project.read"] };
const C = { project_id: "c", name: "Project C" };

test("the home lists authorized projects as rows with access, a read-only tag and unreported access, inside the shell chrome", async () => {
  setup({ projects: [A, B, C] });
  const nav = await screen.findByRole("navigation", { name: "Projects" });
  expect(screen.getByTestId("sb-top-bar")).toBeTruthy();
  expect(screen.getByText("SPECMATE")).toBeTruthy();
  expect(screen.getByText("Signed in as local-user")).toBeTruthy();
  expect(within(nav).getByRole("button", { name: "Open Project A" }).textContent).toContain("Edit");
  const b = within(nav).getByRole("button", { name: "Open Project B" });
  expect(b.textContent).toContain("Read");
  expect(b.textContent).toContain("read-only");
  const c = within(nav).getByRole("button", { name: "Open Project C" });
  expect(c.textContent).toContain("access not reported");
  expect(c.textContent).not.toContain("read-only");
  expect(screen.queryByRole("combobox")).toBeNull();
  expect(screen.queryByText("Select or create a project to begin.")).toBeNull();
  // Nothing is entered automatically.
  expect(screen.queryByText(/^Inside /)).toBeNull();
});

test("the project filter narrows rows and reports no match", async () => {
  setup({ projects: [A, B] });
  fireEvent.change(await screen.findByLabelText("Filter projects"), { target: { value: "project b" } });
  expect(screen.queryByRole("button", { name: "Open Project A" })).toBeNull();
  expect(screen.getByRole("button", { name: "Open Project B" })).toBeTruthy();
  fireEvent.change(screen.getByLabelText("Filter projects"), { target: { value: "zzz" } });
  expect(screen.getByText("No project matches this filter.")).toBeTruthy();
});

test("with no projects the home says so and offers inline creation", async () => {
  setup({ projects: [] });
  expect(await screen.findByText("No projects yet")).toBeTruthy();
  expect(screen.getByLabelText(/^New project name/)).toBeTruthy();
  expect(screen.queryByText(/Continue in/)).toBeNull();
});

test("a remembered project that is still authorized is offered as Continue with real open-work counts, and is not entered automatically", async () => {
  writeLastProject("7", "b");
  const { fetchMock } = setup({ projects: [A, B],
    inbox: { results: [{ notification_id: "n1", review_id: "r1", title: "Review one", action: "request", read_at: null }], next_after: null },
    reviews: { results: [{ review_id: "r1", title: "Review one", status: "open" }, { review_id: "r2", title: "Done", status: "closed" }], next_after: null } });
  const button = await screen.findByRole("button", { name: "Continue in Project B" });
  expect(await screen.findByText(/1 unread notifications · 1 open reviews/)).toBeTruthy();
  expect(screen.queryByText(/^Inside /)).toBeNull();
  expect(fetchMock.mock.calls.some(([path]) => String(path).includes("/definitions"))).toBe(false);
  fireEvent.click(button);
  expect(await screen.findByText("Inside b")).toBeTruthy();
});

test("a remembered project that is no longer authorized is neither offered nor entered, and the stale memory is dropped", async () => {
  writeLastProject("7", "gone");
  setup({ projects: [A] });
  await screen.findByRole("button", { name: "Open Project A" });
  expect(screen.queryByText(/Continue in/)).toBeNull();
  expect(screen.getByText("Choose a project")).toBeTruthy();
  await waitFor(() => expect(readLastProject("7")).toBeNull());
});

test("memory is per user: another user's remembered project is ignored", async () => {
  writeLastProject("99", "a");
  setup({ projects: [A, B] });
  await screen.findByRole("button", { name: "Open Project A" });
  expect(screen.queryByText(/Continue in/)).toBeNull();
});

test("opening a project remembers it, and returning to all projects offers it again", async () => {
  setup({ projects: [A, B] });
  fireEvent.click(await screen.findByRole("button", { name: "Open Project A" }));
  await screen.findByText("Inside a");
  expect(readLastProject("7")).toBe("a");
  fireEvent.click(screen.getByRole("button", { name: "All projects" }));
  expect(await screen.findByRole("button", { name: "Continue in Project A" })).toBeTruthy();
});

test("sign-out leaves the sign-in screen with no project data, and the memory stays with its user", async () => {
  const { cache } = setup({ projects: [A] });
  fireEvent.click(await screen.findByRole("button", { name: "Open Project A" }));
  await screen.findByText("Inside a");
  cache.setQueryData(["private", "a"], "data");
  vi.mocked(fetch).mockImplementation(async (path) => {
    if (path === "/api/v0/session") return reply({ user: null, owner_setup_required: false });
    return reply({ result: {} });
  });
  fireEvent.click(screen.getByRole("button", { name: "Sign out" }));
  await screen.findByRole("heading", { name: "Sign in" });
  expect(screen.queryByRole("navigation", { name: "Projects" })).toBeNull();
  expect(screen.queryByText("Project A")).toBeNull();
  expect(cache.getQueryData(["private", "a"])).toBeUndefined();
  expect(readLastProject("7")).toBe("a");
});

test("losing every project while one is open returns to the home with a plain notice and cleared data", async () => {
  const { cache } = setup({ projects: [A] });
  fireEvent.click(await screen.findByRole("button", { name: "Open Project A" }));
  await screen.findByText("Inside a");
  cache.setQueryData(["private", "a"], "data");
  fireEvent.click(screen.getByRole("button", { name: "Revoke all" }));
  expect(await screen.findByText(/no longer available to you/)).toBeTruthy();
  expect(screen.getByText("No projects yet")).toBeTruthy();
  expect(cache.getQueryData(["private", "a"])).toBeUndefined();
});

test("an unreachable workshop and an expired session each show a styled state", async () => {
  setup({ failSession: true });
  expect(await screen.findByText("Workshop unavailable")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Retry connection" })).toBeTruthy();
  expect(screen.getByTestId("sb-top-bar")).toBeTruthy();
  cleanup();
  setup({ projects: [] });
  await screen.findByText("No projects yet");
  fireEvent.change(screen.getByLabelText(/^New project name/), { target: { value: "Fresh" } });
  vi.mocked(fetch).mockImplementation(async (path) => path === "/api/v0/session"
    ? reply({ user: null, owner_setup_required: false }) : reply({ error: { message: "Session expired." } }, 401));
  fireEvent.click(screen.getByRole("button", { name: "Create project" }));
  expect(await screen.findByText(/Your session has ended/)).toBeTruthy();
  expect(screen.getByRole("heading", { name: "Sign in" })).toBeTruthy();
});
