import { MantineProvider } from "@mantine/core";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { PermissionsProvider } from "../../lib/permissions";
import { project, record, reply, ROLE_PERMISSIONS, workspaceServer, type WorkspaceState } from "../../test/workspaceServer";
import type { ResolvedReference } from "../workspace/api";
import { ProjectOverview, START_POINTS } from "./ProjectOverview";

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  Element.prototype.scrollIntoView = vi.fn();
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

function ref(id: string, label: string, extra: Partial<ResolvedReference> = {}): ResolvedReference {
  return { reference_id: id, kind: "definition", target_id: `t-${id}`, pin: "floating", role: "uses", note: "", added_by: "local-user", added_at: "2026-01-01T00:00:00Z",
    removed: false, removed_at: null, removal_reason: "", label, item_kind: "cable", definition_id: `t-${id}`, revision: null, latest_revision: 2, ...extra };
}

type Routes = { inbox?: () => Response; reviews?: () => Response; detail?: () => Response };
function serve(state: Partial<WorkspaceState> = {}, routes: Routes = {}) {
  return workspaceServer({ projects: [project("p1", "Demo")], ...state }, (path) => {
    if (path.includes("/inbox") && routes.inbox) return routes.inbox();
    if (path.includes("/reviews") && routes.reviews) return routes.reviews();
    if (path.startsWith("/api/v0/workspace/projects/") && routes.detail) return routes.detail();
    return undefined;
  });
}

function show(role = "editor", extra: { active?: boolean; onAccessLost?: () => Promise<void>; onLeave?: () => void } = {}) {
  const onOpenTool = vi.fn();
  const changed = vi.fn(async () => {});
  const view = (active: boolean) => <MantineProvider><PermissionsProvider permissions={ROLE_PERMISSIONS[role]!}><ProjectOverview projectId="p1" projectName="Demo" permissions={ROLE_PERMISSIONS[role]!} role={role}
    active={active} onOpenTool={onOpenTool} onAccessLost={extra.onAccessLost} onProjectChanged={changed} onLeave={extra.onLeave} /></PermissionsProvider></MantineProvider>;
  const rendered = render(view(extra.active ?? true));
  return { onOpenTool, changed, rerender: (active: boolean) => rendered.rerender(view(active)) };
}

test("open work is built from real unread notifications and open reviews, and deep links open the owning tool", async () => {
  serve({}, {
    inbox: () => reply({ results: [{ notification_id: "n1", review_id: "r1", title: "Connector change", action: "request", read_at: null }], next_after: null }),
    reviews: () => reply({ results: [{ review_id: "r1", title: "Connector change", status: "open" }, { review_id: "r2", title: "Old closed review", status: "closed" }], next_after: "r2" }),
  });
  const { onOpenTool } = show();
  const list = await screen.findByRole("group", { name: "Open work" });
  await waitFor(() => expect(within(list).getAllByText("Connector change")).toHaveLength(2));
  expect(within(list).queryByText("Old closed review")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Open notification: Connector change" }));
  expect(onOpenTool).toHaveBeenLastCalledWith("knowledge");
  const summary = screen.getByRole("region", { name: "Project summary" });
  expect(within(summary).getByText("Open reviews").closest("div")?.textContent).toContain("1+");
});

test("references are grouped by the area that opens them and counted as references, not owned records", async () => {
  serve({ details: { p1: { references: [ref("1", "Patch lead"), ref("2", "Main loom", { item_kind: "harness", pin: "exact", revision: 1, kind: "revision" }),
    ref("3", "Board sources", { kind: "source_bundle", item_kind: "original", definition_id: null, latest_revision: null })] } } });
  const { onOpenTool } = show();
  const table = await screen.findByRole("group", { name: "Project references" });
  expect(within(table).getByLabelText("Designs references")).toBeTruthy();
  expect(within(table).getByLabelText("Library references")).toBeTruthy();
  expect(within(table).getByText("exact r1")).toBeTruthy();
  expect(within(screen.getByRole("region", { name: "Project summary" })).getByText("References").closest("div")?.textContent).toContain("3");
  fireEvent.click(within(table).getByRole("button", { name: "Open Main loom" }));
  expect(onOpenTool).toHaveBeenLastCalledWith("harnesses");
  fireEvent.click(within(table).getByRole("button", { name: "Open Board sources" }));
  expect(onOpenTool).toHaveBeenLastCalledWith("sources");
});

test("adding from the library records a floating or explicitly pinned reference under the project state", async () => {
  const { state } = serve({ library: [record("d1", "Patch lead", { latest_revision: 2, latest_revision_id: "rev-2" })] });
  show();
  fireEvent.click(await screen.findByRole("button", { name: "Add from library…" }));
  fireEvent.click(await screen.findByRole("button", { name: "Choose Patch lead" }));
  const form = await screen.findByRole("form", { name: "Use Patch lead in a project", hidden: true });
  fireEvent.click(within(form).getByLabelText("Exact r2"));
  fireEvent.submit(form);
  await waitFor(() => expect(state.operations).toHaveLength(1));
  expect(state.operations[0]).toMatchObject({ operation: "project.add_reference", expected_state: "state-p1",
    payload: { project_id: "p1", kind: "revision", target_id: "rev-2", role: "uses" } });
  expect(await screen.findByText(/pinned to r2/)).toBeTruthy();
});

test("removing a reference asks for a reason and leaves the item in the library", async () => {
  const { state } = serve({ details: { p1: { references: [ref("1", "Patch lead")] } } });
  show();
  fireEvent.click(await screen.findByRole("button", { name: "Remove reference to Patch lead" }));
  fireEvent.click(await screen.findByRole("button", { name: "Remove reference" }));
  await waitFor(() => expect(state.operations).toHaveLength(1));
  expect(state.operations[0]).toMatchObject({ operation: "project.remove_reference", payload: { reference_id: "1", reason: "No longer used" } });
  expect(await screen.findByText(/stays in the library/)).toBeTruthy();
});

test("an archived project is read-only until unarchived", async () => {
  serve({ projects: [project("p1", "Demo", { archived: true })], details: { p1: { references: [ref("1", "Patch lead")] } } });
  show();
  expect(await screen.findByText(/This project is read-only/)).toBeTruthy();
  expect((screen.getByRole("button", { name: "Add from library…" }) as HTMLButtonElement).disabled).toBe(true);
  expect((screen.getByRole("button", { name: "Remove reference to Patch lead" }) as HTMLButtonElement).disabled).toBe(true);
  expect((screen.getByRole("button", { name: "Edit details" }) as HTMLButtonElement).disabled).toBe(true);
  expect((screen.getByRole("button", { name: "Unarchive" }) as HTMLButtonElement).disabled).toBe(false);
});

test("delete shows dependents when blocked and leaves the project once deleted", async () => {
  serve({ projects: [project("p1", "Demo", { can_delete: false, dependents: { "collaboration.changereview": 1 } })] });
  show();
  const blocked = await screen.findByRole("button", { name: "Delete Demo" }) as HTMLButtonElement;
  expect(blocked.disabled).toBe(true);
  expect(blocked.title).toContain("1 review");
  expect(screen.getByText("1 review")).toBeTruthy();
  cleanup();
  const { state } = serve();
  const leave = vi.fn();
  const { changed } = show("editor", { onLeave: leave });
  fireEvent.click(await screen.findByRole("button", { name: "Delete Demo" }));
  fireEvent.click(await screen.findByRole("button", { name: "Delete project" }));
  await waitFor(() => expect(leave).toHaveBeenCalledTimes(1));
  expect(state.operations[0]).toMatchObject({ operation: "project.delete", expected_state: "state-p1" });
  expect(changed).toHaveBeenCalled();
});

test("renaming edits name and purpose under the state token", async () => {
  const { state } = serve();
  show();
  fireEvent.click(await screen.findByRole("button", { name: "Edit details" }));
  fireEvent.change(screen.getByLabelText(/^Project name/), { target: { value: "Renamed" } });
  fireEvent.change(screen.getByLabelText(/^Purpose/), { target: { value: "Bench loom" } });
  fireEvent.click(screen.getByRole("button", { name: "Save details" }));
  await waitFor(() => expect(state.operations).toHaveLength(1));
  expect(state.operations[0]).toMatchObject({ operation: "project.rename", expected_state: "state-p1", payload: { name: "Renamed", purpose: "Bench loom" } });
});

test("nothing waiting is stated honestly, and start points open the matching tool", async () => {
  serve();
  const { onOpenTool } = show("admin");
  expect(await screen.findByText("Nothing is waiting on you in this project.")).toBeTruthy();
  expect(screen.getByText("This project references nothing yet.")).toBeTruthy();
  const expected: Record<string, string> = { "Stock record": "wire-stock", "Cable": "cables", "Board": "pcb", "Assembly": "assemblies", "Import source": "sources", "Physical unit": "physical-units" };
  expect(START_POINTS.map((point) => point.title)).toEqual(Object.keys(expected));
  for (const [title, tool] of Object.entries(expected)) {
    fireEvent.click(screen.getByRole("button", { name: `Start: ${title}` }));
    expect(onOpenTool).toHaveBeenLastCalledWith(tool);
  }
  fireEvent.click(screen.getByRole("button", { name: "Workspace members and roles" }));
  expect(onOpenTool).toHaveBeenLastCalledWith("access");
});

test("viewers are tagged read-only and see why project edits are unavailable", async () => {
  serve();
  show("viewer");
  expect(await screen.findByText("read-only")).toBeTruthy();
  expect(screen.getByText(/starting something that creates records is unavailable/)).toBeTruthy();
  for (const point of START_POINTS) {
    const tile = screen.getByRole("button", { name: `Start: ${point.title}` }) as HTMLButtonElement;
    expect(tile.disabled).toBe(true);
    expect(tile.title).toMatch(/^Read-only access: requires /);
  }
  expect((screen.getByRole("button", { name: "Add from library…" }) as HTMLButtonElement).title).toBe("Read-only access: requires Project editing");
});

test("start tiles follow the permission each one needs", async () => {
  serve();
  const { onOpenTool } = show("contributor");
  await screen.findByText("Nothing is waiting on you in this project.");
  const tile = (title: string) => screen.getByRole("button", { name: `Start: ${title}` }) as HTMLButtonElement;
  expect(tile("Stock record").disabled).toBe(false);
  expect(tile("Import source").disabled).toBe(false);
  expect(tile("Physical unit").disabled).toBe(true);
  expect(tile("Physical unit").title).toBe("Read-only access: requires Inventory management");
  fireEvent.click(tile("Physical unit"));
  expect(onOpenTool).not.toHaveBeenCalled();
});

test("a failed part shows as unavailable instead of an invented zero", async () => {
  serve({}, { reviews: () => reply({ error: { message: "Boom" } }, 500) });
  show();
  expect(await screen.findByText("Reviews are unavailable right now.")).toBeTruthy();
  expect((screen.getByText("Open reviews").closest("div") as HTMLElement).textContent).toContain("Not reported");
});

test("when every read is denied the overview clears and asks the owner to re-read access", async () => {
  const denied = () => reply({ error: { message: "Project not found." } }, 404);
  serve({}, { detail: denied, inbox: denied, reviews: denied });
  const lost = vi.fn(async () => {});
  show("viewer", { onAccessLost: lost });
  expect(await screen.findByText("This project is no longer available to you.")).toBeTruthy();
  expect(lost).toHaveBeenCalledTimes(1);
});

test("showing the overview again refreshes what is waiting", async () => {
  const { fetchMock } = serve();
  const { rerender } = show("viewer", { active: true });
  await screen.findByText("Nothing is waiting on you in this project.");
  const before = fetchMock.mock.calls.filter(([path]) => String(path).includes("/inbox")).length;
  rerender(false);
  rerender(true);
  await waitFor(() => expect(fetchMock.mock.calls.filter(([path]) => String(path).includes("/inbox")).length).toBe(before + 1));
});
