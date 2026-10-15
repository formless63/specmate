import { MantineProvider } from "@mantine/core";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { boardEnd, cable, inlineEnd, stock } from "../../features/cable-workbench/fixtures";
import { Schematic } from "./Schematic";
import { schematicRows } from "./schematicModel";

afterEach(cleanup);
const input = () => ({ cable: cable(), stock: stock(), stacks: [boardEnd(), inlineEnd()] });

test("declared schematic contains every stock element, exact landings and explicit unassigned ends", () => {
  const rows = schematicRows(input());
  expect(rows).toHaveLength(4);
  expect(rows.find(row => row.path === "stock.core-1.center")).toMatchObject({ stock: "declared", ends: [
    { key: "t:a/board/v", target: "Synthetic board r1 · V", basis: "Synthetic table", state: "declared" },
    { key: "t:b/connector/1", target: "Synthetic socket r1 · 1", state: "declared" },
  ] });
  expect(rows.find(row => row.path === "stock.core-2.center")?.ends.map(end => end.state)).toEqual(["unassigned", "unassigned"]);
  // Shared stock identity does not add an assignment to either open end.
  expect(rows.find(row => row.path === "stock.core-2.screen")?.ends[1]).toMatchObject({ key: null, state: "unassigned" });
  expect(rows.find(row => row.path === "stock.core-1.screen")?.color).toBeNull();
});

test("live unsaved mappings and missing targets remain declarations, never inferred or accepted", () => {
  const value = input(), original = JSON.stringify(value);
  const changed = { ...value.cable, assignments: value.cable.assignments.map(row => row.endpoint_id === "b" && row.element_path === "stock.core-1.center" ? { ...row, layer_id: "inline", terminal_id: "r2.1", basis: "Unreleased hand edit" } : row) };
  expect(schematicRows({ ...value, cable: changed }).find(row => row.path === "stock.core-1.center")?.ends[1]).toMatchObject({ target: "R2 · R2 · 1", basis: "Unreleased hand edit", state: "declared" });
  const dangling = { ...changed, assignments: [...changed.assignments, { endpoint_id: "b", element_path: "stock.missing", layer_id: "gone", terminal_id: "unknown", basis: "Unresolved declaration" }] };
  expect(schematicRows({ ...value, cable: dangling }).find(row => row.path === "stock.missing")).toMatchObject({ stock: "missing", ends: [{ state: "unassigned" }, { target: "gone · unknown (unresolved)", state: "unresolved" }] });
  expect(JSON.stringify(value)).toBe(original);
});

test("unavailable stock and unresolved end source never become evidence of missing membership or a valid target", () => {
  const rows = schematicRows({ cable: cable(), stacks: [] });
  expect(rows.every(row => row.stock === "unknown")).toBe(true);
  expect(rows.every(row => row.kind === "kind unknown" && row.color === null)).toBe(true);
  expect(rows[0]?.ends[0]?.state).toBe("unresolved");
  expect(schematicRows({ cable: { ...cable(), assignments: [] }, stacks: [] })).toEqual([]);
});

test("schematic wire and terminal marks share keyboard/click probe selection and Fit/zoom controls", () => {
  const select = vi.fn(), value = input();
  const view = render(<MantineProvider><Schematic {...value} name="Synthetic cable" state="Working draft · unsaved changes" unreleased selection={null} onSelect={select} /></MantineProvider>);
  const wire = screen.getByRole("button", { name: /^Probe wire Coax 1 center/ });
  fireEvent.keyDown(wire, { key: "Enter" }); expect(select).toHaveBeenLastCalledWith("w:stock.core-1.center");
  fireEvent.click(screen.getByRole("button", { name: "Source end: Synthetic board r1 · V" })); expect(select).toHaveBeenLastCalledWith("t:a/board/v");
  view.rerender(<MantineProvider><Schematic {...value} name="Synthetic cable" state="Exact frozen r1" unreleased={false} selection="w:stock.core-1.center" onSelect={select} /></MantineProvider>);
  expect(screen.getByRole("button", { name: /^Probe wire Coax 1 center/ }).getAttribute("aria-pressed")).toBe("true");
  expect(screen.queryByText("UNRELEASED")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: /^Probe wire Coax 1 center/ })); expect(select).toHaveBeenLastCalledWith(null);
  fireEvent.keyDown(screen.getByRole("button", { name: /^Probe wire Coax 1 center/ }), { key: "Escape" }); expect(select).toHaveBeenLastCalledWith(null);
  const sheet = screen.getByRole("group", { name: "Declared schematic of Synthetic cable" });
  expect(sheet.getAttribute("width")).toBe("100%");
  fireEvent.click(screen.getByRole("button", { name: "Zoom schematic in" })); expect(Number(sheet.getAttribute("width"))).toBeGreaterThan(1200);
  fireEvent.click(screen.getByRole("button", { name: "Fit schematic" })); expect(sheet.getAttribute("width")).toBe("100%");
});

test("user names remain escaped SVG text and no source scripts or external references are embedded", () => {
  render(<MantineProvider><Schematic {...input()} name={'<script>alert("name")</script>'} state="Saved draft" unreleased selection={null} onSelect={() => {}} /></MantineProvider>);
  const svg = screen.getByRole("group", { name: /^Declared schematic of/ });
  expect(svg.querySelectorAll("script,image,foreignObject")).toHaveLength(0);
  expect(svg.textContent).toContain('<script>alert("name")</script>');
  expect(screen.getByText("UNRELEASED")).toBeTruthy();
});
