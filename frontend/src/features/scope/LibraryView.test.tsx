import { PermissionsProvider } from "../../lib/permissions";
import { MantineProvider } from "@mantine/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { project, record, ROLE_PERMISSIONS, workspaceServer } from "../../test/workspaceServer";
import { LIBRARY_VIEWS } from "../shell/scope";
import type { Project } from "../workspace/api";
import { LibraryView } from "./LibraryView";
import { ProbeProvider } from "../probe";
import { shieldedPair } from "../cable-views/fixtures";
import { initialCable } from "../cables/api";

beforeEach(() => {
  // These cases exercise the dense table layout; the gallery default has its own tests.
  localStorage.setItem("specmate.library.layout", "table");
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  Element.prototype.scrollIntoView = vi.fn();
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const bench = project("p1", "Bench");
const rig = project("p2", "Test rig");
const patch = record("d1", "Patch lead", { latest_revision: 2, latest_revision_id: "rev-2", used_in_total: 1,
  used_in: [{ reference_id: "ref-1", project_id: "p2", project_name: "Test rig", archived: false, pin: "exact", revision: 1, role: "spare" }] });
const loose = record("d2", "Loose lead");

function show({ projectId = null as string | null, role = "editor", current = null as Project | null } = {}) {
  const onOpen = vi.fn();
  const cache = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<MantineProvider><QueryClientProvider client={cache}><PermissionsProvider permissions={ROLE_PERMISSIONS[role]!}><LibraryView view={LIBRARY_VIEWS.cables!} toolLabel="Cables" projectId={projectId} project={current} projects={[bench, rig]} principalKey="7" onOpenInProject={onOpen} /></PermissionsProvider></QueryClientProvider></MantineProvider>);
  return { onOpen };
}

test("at Library scope rows carry no owning project and show where each item is used", async () => {
  const { fetchMock } = workspaceServer({ projects: [bench, rig], library: [patch, loose] });
  const { onOpen } = show();
  expect(await screen.findByRole("heading", { name: "Cables in the library" })).toBeTruthy();
  const table = await screen.findByRole("table");
  const headers = within(table).getAllByRole("columnheader").map((cell) => cell.textContent);
  expect(headers).toContain("Used in");
  expect(headers).not.toContain("Project");
  expect(within(table).getByText("1 project")).toBeTruthy();
  expect(within(table).getByText("unused")).toBeTruthy();
  expect(fetchMock).toHaveBeenCalledWith("/api/v0/workspace/library?family=definition&limit=50&kinds=cable", expect.anything());
  fireEvent.click(within(table).getByRole("button", { name: "Show uses of Patch lead" }));
  const uses = screen.getByRole("list", { name: "Projects using Patch lead" });
  expect(within(uses).getByText("exact r1")).toBeTruthy();
  fireEvent.click(within(uses).getByRole("button", { name: "Open Cables in Test rig" }));
  expect(onOpen).toHaveBeenCalledWith("p2", expect.objectContaining({ record_id: "d1" }));
});

test("Use in project adds a floating reference to the chosen project without moving the item", async () => {
  const { state } = workspaceServer({ projects: [bench, rig], library: [loose] });
  show();
  fireEvent.click(await screen.findByRole("button", { name: "Use in project… Loose lead" }));
  const form = await screen.findByRole("form", { name: "Use Loose lead in a project", hidden: true });
  expect((within(form).getByLabelText("Exact (none frozen)") as HTMLInputElement).disabled).toBe(true);
  fireEvent.click(within(form).getByRole("combobox", { name: "Project", hidden: true }));
  fireEvent.click(await screen.findByRole("option", { name: "Bench", hidden: true }));
  fireEvent.submit(form);
  await waitFor(() => expect(state.operations).toHaveLength(1));
  expect(state.operations[0]).toMatchObject({ operation: "project.add_reference", expected_state: "state-p1",
    payload: { project_id: "p1", kind: "definition", target_id: "d2", role: "uses" } });
  expect(await screen.findByText("Loose lead is now used in Bench.")).toBeTruthy();
});

test("at project scope the project's items come first, the whole library is one switch away, and removal is recorded", async () => {
  const { state, fetchMock } = workspaceServer({ projects: [bench, rig], library: [patch, loose] });
  show({ projectId: "p2", current: rig });
  expect(await screen.findByRole("heading", { name: "Cables in this project" })).toBeTruthy();
  expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining("project_id=p2&referenced_only=true"), expect.anything());
  expect(await screen.findByText("Patch lead")).toBeTruthy();
  expect(screen.queryByText("Loose lead")).toBeNull();
  fireEvent.click(screen.getByText("Whole library"));
  expect(await screen.findByText("Loose lead")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Use here Loose lead" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Stop using Patch lead here" }));
  fireEvent.submit(await screen.findByRole("form", { name: "Remove the reference to Patch lead", hidden: true }));
  await waitFor(() => expect(state.operations).toHaveLength(1));
  expect(state.operations[0]).toMatchObject({ operation: "project.remove_reference", payload: { project_id: "p2", reference_id: "ref-1", reason: "No longer used" } });
});

test("viewers and archived projects see why reference changes are unavailable", async () => {
  workspaceServer({ projects: [bench, rig], library: [patch, loose] });
  show({ role: "viewer" });
  const add = await screen.findByRole("button", { name: "Use in project… Loose lead" }) as HTMLButtonElement;
  expect(add.disabled).toBe(true);
  expect(add.title).toBe("Read-only access: requires Project editing");
  cleanup();
  show({ projectId: "p2", current: { ...rig, archived: true } });
  const remove = await screen.findByRole("button", { name: "Stop using Patch lead here" }) as HTMLButtonElement;
  expect(remove.disabled).toBe(true);
  expect(remove.title).toBe("Archived projects are read-only");
});

test("an empty project list offers the whole library", async () => {
  workspaceServer({ projects: [bench], library: [loose] });
  show({ projectId: "p1", current: bench });
  expect(await screen.findByText("This project references no cable yet.")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Show the whole library" }));
  expect(await screen.findByText("Loose lead")).toBeTruthy();
});

// Selecting a cable row opens its views for the selected revision (the probe), here through real child reads.
const unknownOrient = { viewing_side: "unknown" };
function cableReads(path: string): Response | undefined {
  const json = (data: unknown) => new Response(JSON.stringify(data), { status: 200 });
  if (path.startsWith("/api/v0/catalog/definitions/")) return json({ definition_id: "d1", name: "Patch lead", kind: "cable", revisions: [{ revision_id: "rev-1", number: 1 }, { revision_id: "rev-2", number: 2 }], drafts: [] });
  if (path.startsWith("/api/v0/cables/revisions/")) {
    const cable = { ...initialCable(), stock_revision_id: "stock-1" };
    return json({ revision_id: path.split("/").pop(), snapshot_id: "s", cable, conductors: [], continuity: "not_evaluated", compatibility: "not_evaluated", physical_qualification: "not_evaluated",
      endpoints: cable.endpoints.map((e) => ({ ...e, body: { kind: "connector_body", contacts: [], drawing_orientation: unknownOrient }, pinout: { kind: "pinout", assignments: [], orientation: unknownOrient } })) });
  }
  if (path.includes("/snapshot")) return json({ content: { stock: shieldedPair() } });
  if (path.includes("revision-labels")) return json({ labels: [], source_labels: [] });
  return undefined;
}

test("selecting a cable row opens its section view at the selected frozen revision", async () => {
  const { fetchMock } = workspaceServer({ projects: [bench, rig], library: [patch, loose] }, cableReads);
  show();
  fireEvent.click(await screen.findByRole("button", { name: "Show uses of Patch lead" }));
  expect(await screen.findByLabelText("Cable section drawing")).toBeTruthy();
  expect(fetchMock.mock.calls.some(([path]) => String(path).includes("cables/revisions/rev-2"))).toBe(true);
  expect(screen.getByRole("tab", { name: "3D model" })).toBeTruthy();
});

test("a link to a cable that is not on the visible page still opens its views at the exact revision", async () => {
  const stray = record("d9", "Far lead", { latest_revision: 2, latest_revision_id: "rev-2" });
  const { fetchMock } = workspaceServer({ projects: [bench], library: [loose] }, (path) => {
    if (path.startsWith("/api/v0/workspace/library/d9")) return new Response(JSON.stringify(stray), { status: 200 });
    if (path.startsWith("/api/v0/catalog/definitions/d9")) return new Response(JSON.stringify({ definition_id: "d9", name: "Far lead", kind: "cable", revisions: [{ revision_id: "rev-1", number: 1 }, { revision_id: "rev-2", number: 2 }], drafts: [] }), { status: 200 });
    return cableReads(path);
  });
  const cache = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<MantineProvider><QueryClientProvider client={cache}><PermissionsProvider permissions={ROLE_PERMISSIONS.editor!}><ProbeProvider probe={{ object: "d9", rev: 1, path: [] }} onProbe={() => {}}>
    <LibraryView view={LIBRARY_VIEWS.cables!} toolLabel="Cables" projectId={null} project={null} projects={[bench]} principalKey="7" onOpenInProject={() => {}} />
  </ProbeProvider></PermissionsProvider></QueryClientProvider></MantineProvider>);
  expect(await screen.findByLabelText("Cable section drawing")).toBeTruthy();
  expect(fetchMock.mock.calls.some(([path]) => String(path).includes("cables/revisions/rev-1"))).toBe(true);
  expect(fetchMock.mock.calls.some(([path]) => String(path).includes("cables/revisions/rev-2"))).toBe(false);
});
