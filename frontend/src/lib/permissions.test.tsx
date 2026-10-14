import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import { PermissionsProvider, ReadOnlyNote, gateFor, holds, readOnlyReason, usePermission } from "./permissions";

afterEach(cleanup);

test("without a provider permissions are unknown and controls stay available; an empty report grants nothing", () => {
  expect(holds(undefined, "design.edit")).toBe(true);
  expect(holds([], "design.freeze")).toBe(false);
});

test("reported permissions are matched exactly, with inventory management implying reservation", () => {
  const editor = ["project.read", "design.edit", "source.register"];
  expect(holds(editor, "design.edit")).toBe(true);
  expect(holds(editor, "design.freeze")).toBe(false);
  expect(holds(editor, "build.execute")).toBe(false);
  expect(holds(["project.read", "inventory.manage"], "inventory.reserve")).toBe(true);
  expect(holds(["project.read", "inventory.reserve"], "inventory.manage")).toBe(false);
  expect(holds(["project.read", "project.admin"], "design.edit")).toBe(false);
});

test("a denied gate disables the control and carries a stable reason", () => {
  const denied = gateFor(["project.read"], "design.edit");
  expect(denied.allowed).toBe(false);
  expect(denied.reason).toBe("Read-only access: requires Edit");
  expect(denied.props).toEqual({ disabled: true, title: "Read-only access: requires Edit", "data-readonly-reason": "Read-only access: requires Edit" });
  expect(gateFor(["design.edit"], "design.edit").props).toEqual({});
  expect(readOnlyReason("design.freeze")).toBe("Read-only access: requires Freeze");
  expect(readOnlyReason("build.execute")).toBe("Read-only access: requires Native execution");
});

function Probe() {
  const edit = usePermission("design.edit");
  return <button {...edit.props}>Save</button>;
}

test("the hook reads the provider and defaults to allowed without one", () => {
  render(<Probe />);
  expect((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(false);
  cleanup();
  render(<PermissionsProvider permissions={["project.read"]}><Probe /><ReadOnlyNote permission="design.edit">Saving is unavailable</ReadOnlyNote></PermissionsProvider>);
  expect((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(true);
  expect(screen.getByRole("note").textContent).toBe("Read-only access: requires Edit. Saving is unavailable");
  cleanup();
  render(<PermissionsProvider permissions={["project.read", "design.edit"]}><Probe /><ReadOnlyNote permission="design.edit" /></PermissionsProvider>);
  expect((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(false);
  expect(screen.queryByRole("note")).toBeNull();
});

test("workspace atoms are matched and the former per-project names read as their workspace names", () => {
  const contributor = ["workspace.read", "item.create", "source.register", "project.edit"];
  expect(holds(contributor, "item.create")).toBe(true);
  expect(holds(contributor, "project.edit")).toBe(true);
  expect(holds(contributor, "design.edit")).toBe(false);
  expect(holds(contributor, "project.read")).toBe(true);
  expect(holds(["workspace.read", "workspace.admin"], "project.admin")).toBe(true);
  expect(holds(["project.admin"], "workspace.admin")).toBe(true);
  expect(holds(["workspace.read"], "workspace.admin")).toBe(false);
  expect(readOnlyReason("item.create")).toBe("Read-only access: requires Contributor access");
});
