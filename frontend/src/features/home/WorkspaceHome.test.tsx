import { MantineProvider } from "@mantine/core";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { project, ROLE_PERMISSIONS, workspaceServer } from "../../test/workspaceServer";
import type { Project } from "../workspace/api";
import { WorkspaceHome } from "./WorkspaceHome";

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  Element.prototype.scrollIntoView = vi.fn();
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

function show(projects: Project[], { role = "editor", lastProjectId = null as string | null } = {}) {
  const onOpen = vi.fn();
  const onCreate = vi.fn(async () => true);
  const onChanged = vi.fn(async () => {});
  render(<MantineProvider><WorkspaceHome username="local-user" role={role} permissions={ROLE_PERMISSIONS[role]!} projects={projects}
    lastProjectId={lastProjectId} busy={false} onOpen={onOpen} onCreate={onCreate} onChanged={onChanged} /></MantineProvider>);
  return { onOpen, onCreate, onChanged };
}

const bench = project("a", "Bench", { purpose: "Synthetic loom", references: [{ kind: "definition", count: 2 }, { kind: "revision", count: 1 }] });
const blocked = project("b", "Blocked", { can_delete: false, dependents: { "knowledge.knowledgeitem": 2 } });
const old = project("c", "Old", { archived: true });

test("projects are a dense table of reference counts with one fact per header cell", () => {
  const { onOpen } = show([bench, blocked, old]);
  const table = screen.getByRole("table");
  const row = within(table).getByRole("button", { name: "Open Bench" }).closest("tr") as HTMLElement;
  expect(within(row).getByText("Synthetic loom")).toBeTruthy();
  expect(within(row).getByText("3")).toBeTruthy();
  expect(within(table).queryByText("Old")).toBeNull();
  expect(screen.getByText("Editor")).toBeTruthy();
  expect(screen.getByText("Active projects").nextSibling?.textContent).toBe("2");
  expect(screen.getByText("Archived").nextSibling?.textContent).toBe("1");
  fireEvent.click(screen.getByLabelText(/Show archived/));
  expect(within(screen.getByRole("table")).getByText("Old")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Open Bench" }));
  expect(onOpen).toHaveBeenCalledWith("a");
});

test("delete is offered only when nothing depends on the project and otherwise shows the dependents", () => {
  show([bench, blocked, project("d", "Not mine", { can_delete: false })]);
  expect((screen.getByRole("button", { name: "Delete Bench" }) as HTMLButtonElement).disabled).toBe(false);
  const blockedDelete = screen.getByRole("button", { name: "Delete Blocked" }) as HTMLButtonElement;
  expect(blockedDelete.disabled).toBe(true);
  expect(blockedDelete.title).toBe("Records depend on this project (2 notes and decisions); archive it instead");
  expect(screen.getByText("2 notes and decisions")).toBeTruthy();
  expect((screen.getByRole("button", { name: "Delete Not mine" }) as HTMLButtonElement).title).toBe("Only the project's creator or an admin can delete it");
});

test("archive and delete use the project's current state token and re-read the list", async () => {
  const { state } = workspaceServer({ projects: [bench] });
  const { onChanged } = show([bench]);
  fireEvent.click(screen.getByRole("button", { name: "Archive Bench" }));
  await waitFor(() => expect(state.operations).toHaveLength(1));
  expect(state.operations[0]).toMatchObject({ operation: "project.archive", payload: { project_id: "a", archived: true }, expected_state: "state-a" });
  await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
  fireEvent.click(screen.getByRole("button", { name: "Delete Bench" }));
  fireEvent.click(await screen.findByRole("button", { name: "Delete project" }));
  await waitFor(() => expect(state.operations).toHaveLength(2));
  expect(state.operations[1]).toMatchObject({ operation: "project.delete", payload: { project_id: "a" }, expected_state: "state-a" });
  expect(await screen.findByText(/Items it referenced stay in the library/)).toBeTruthy();
});

test("viewers see why creation and lifecycle actions are unavailable", () => {
  show([project("a", "Bench", { can_delete: false })], { role: "viewer" });
  const create = screen.getByRole("button", { name: "Create project" }) as HTMLButtonElement;
  expect(create.disabled).toBe(true);
  expect(create.title).toBe("Read-only access: requires Project editing");
  expect((screen.getByRole("button", { name: "Archive Bench" }) as HTMLButtonElement).disabled).toBe(true);
  expect((screen.getByRole("button", { name: "Delete Bench" }) as HTMLButtonElement).title).toBe("Read-only access: requires Project editing");
});

test("creation asks for a name and optional purpose only, never an owner; the last project is offered to continue", async () => {
  const { onCreate, onOpen } = show([bench], { lastProjectId: "a" });
  fireEvent.click(screen.getByRole("button", { name: "Continue in Bench" }));
  expect(onOpen).toHaveBeenCalledWith("a");
  fireEvent.change(screen.getByLabelText(/^New project name/), { target: { value: "Fresh" } });
  fireEvent.change(screen.getByLabelText(/^Purpose/), { target: { value: "Try a loom" } });
  fireEvent.click(screen.getByRole("button", { name: "Create project" }));
  await waitFor(() => expect(onCreate).toHaveBeenCalledWith("Fresh", "Try a loom"));
});

test("with no projects the list says the library works without them", () => {
  show([]);
  expect(screen.getByText("No projects yet")).toBeTruthy();
  expect(screen.getByText(/library works without projects/)).toBeTruthy();
});
