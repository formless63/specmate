import { MantineProvider } from "@mantine/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { App } from "../../App";
import { project, record, reply, workspaceServer } from "../../test/workspaceServer";

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  Element.prototype.scrollIntoView = vi.fn();
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const board = record("b1", "Main board", { kind: "board", latest_revision: 2, latest_revision_id: "r2" });
const population = record("pop1", "Main board population", { kind: "pcb_population" });

/** A workspace whose library record route answers 404 alike for missing and unreadable ids. */
function serve() {
  return workspaceServer({ projects: [project("p1", "Bench")], library: [board, population] }, (path) => {
    const url = new URL(path, "http://test");
    const match = /^\/api\/v0\/workspace\/library\/([^/]+)$/.exec(url.pathname);
    if (!match) return undefined;
    const found = [board, population].find((row) => row.record_id === decodeURIComponent(match[1]!));
    return found ? reply(found) : reply({ error: { message: "Item not found." } }, 404);
  });
}

function start(href: string) {
  window.history.replaceState(null, "", href);
  const cache = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<MantineProvider><QueryClientProvider client={cache}><App /></QueryClientProvider></MantineProvider>);
}

const here = () => `${window.location.pathname}${window.location.search}`;
/** The browser URL follows navigation after TanStack history flushes (a microtask). */
const at = (href: string) => waitFor(() => expect(here()).toBe(href));
const selection = () => screen.findByRole("region", { name: "Selection" });

test("a reloaded link restores area, lens and the probe, and the Design boards list marks it", async () => {
  const { fetchMock } = serve();
  start("/design/b1@2/~/J1/3?lens=pcb");
  const inspector = await selection();
  expect(await within(inspector).findByText("Main board")).toBeTruthy();
  expect(within(inspector).getByText("r2 exact")).toBeTruthy();
  expect(within(inspector).getByText("J1 / 3")).toBeTruthy();
  expect(screen.getByRole("tab", { name: "PCB intake" }).getAttribute("aria-selected")).toBe("true");
  expect(screen.getByRole("button", { name: "Design" }).getAttribute("aria-current")).toBe("page");
  // The Design boards list is the workspace collection: boards and populations, no owning project.
  expect(await screen.findByRole("heading", { name: "Boards in the library" })).toBeTruthy();
  const row = screen.getByRole("button", { name: "Hide uses of Main board" }).closest("tr")!;
  expect(row.getAttribute("data-probe")).toBe("selected");
  const listed = fetchMock.mock.calls.map(([path]) => String(path)).find((path) => path.startsWith("/api/v0/workspace/library?"))!;
  expect(new URL(listed, "http://test").searchParams.getAll("kinds")).toEqual(["board", "pcb_population"]);
  await at("/design/b1@2/~/J1/3?lens=pcb");
});

test("selecting, switching lens and scope are history entries that back and forward restore", async () => {
  serve();
  start("/design?lens=pcb");
  fireEvent.click(await screen.findByRole("button", { name: "Show uses of Main board" }));
  await at("/design/b1?lens=pcb");
  expect(await within(await selection()).findByText("Main board")).toBeTruthy();
  fireEvent.click(screen.getByRole("tab", { name: "Interfaces" }));
  await at("/design/b1?lens=interfaces");
  fireEvent.click(screen.getByRole("button", { name: "Project" }));
  await at("/project/b1");
  fireEvent.click(await screen.findByRole("button", { name: "Open Bench" }));
  await waitFor(() => expect(here()).toBe("/project/b1?project=p1"));
  await waitFor(() => expect((screen.getByRole("combobox", { name: "Scope" }) as HTMLInputElement).value).toBe("Bench"));

  window.history.back();
  await waitFor(() => expect((screen.getByRole("combobox", { name: "Scope" }) as HTMLInputElement).value).toBe("Library"));
  window.history.back();
  await waitFor(() => expect(screen.getByRole("tab", { name: "Interfaces" }).getAttribute("aria-selected")).toBe("true"));
  window.history.back();
  await waitFor(() => expect(screen.getByRole("tab", { name: "PCB intake" }).getAttribute("aria-selected")).toBe("true"));
  window.history.back();
  await waitFor(() => expect(screen.queryByRole("region", { name: "Selection" })).toBeNull());
  await at("/design?lens=pcb");
  window.history.forward();
  expect(await within(await selection()).findByText("Main board")).toBeTruthy();
});

test("an unreadable or malformed target renders access-lost without naming it", async () => {
  const { fetchMock } = serve();
  start("/inventory/hidden-item@4");
  const lost = await screen.findByRole("alert");
  await within(lost).findByText("Selection not available");
  expect(lost.textContent).not.toMatch(/hidden-item|r4/);
  expect(fetchMock.mock.calls.some(([path]) => String(path) === "/api/v0/workspace/library/hidden-item")).toBe(true);
  fireEvent.click(within(lost).getByRole("button", { name: "Clear selection" }));
  await waitFor(() => expect(here()).toBe("/inventory"));
  cleanup();

  start("/inventory/not%20an%20id");
  expect(await within(await screen.findByRole("alert")).findByText("Selection not available")).toBeTruthy();
});

test("a project context the workspace does not have falls back to the Library without naming it", async () => {
  serve();
  start("/project?project=p-elsewhere");
  expect(await screen.findByText("The project in this link is not available. You are in the Library.")).toBeTruthy();
  expect(document.body.textContent).not.toContain("p-elsewhere");
  await waitFor(() => expect(here()).toBe("/"));
  expect((screen.getByRole("combobox", { name: "Scope" }) as HTMLInputElement).value).toBe("Library");
});

test("a link with project context opens that project and sign-out clears the address", async () => {
  serve();
  start("/project?project=p1");
  await waitFor(() => expect((screen.getByRole("combobox", { name: "Scope" }) as HTMLInputElement).value).toBe("Bench"));
  fireEvent.click(screen.getByRole("button", { name: "Sign out" }));
  await waitFor(() => expect(here()).toBe("/"));
});
