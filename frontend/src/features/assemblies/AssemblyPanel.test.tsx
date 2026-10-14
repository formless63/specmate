import { MantineProvider } from "@mantine/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { AssemblyInspector, AssemblyPanel } from "./AssemblyPanel";
import { addressKey, relationship, type ProjectionNode } from "./api";

beforeEach(() => { vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} }); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

function wrap(children: React.ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <MantineProvider><QueryClientProvider client={client}>{children}</QueryClientProvider></MantineProvider>;
}

function node(side: "left" | "right"): ProjectionNode {
  return { address: { snapshot_id: "root-snapshot", path: [`${side}-module`, "control-board"] }, definition_id: "same-board", revision_id: "board-rev-1", kind: "board", name: "Synthetic board", display_ref: "J1", placement: { status: "known", translation: [side === "left" ? 10 : 100, 0, 0], rotation_xyzw: [0, 0, 0, 1] }, assignments: { firmware_revision_id: `${side}-firmware` }, snapshot_sha256: "child-hash" };
}

test("second repeated J1 keeps its occurrence selection across tree, contents and display layout", async () => {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify({ snapshot_id: "root-snapshot", definition_id: "assembly", sha256: "root-hash", occurrences: [node("left"), node("right")], relationships: [] }), { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
  render(wrap(<AssemblyInspector snapshotId="root-snapshot" />));
  fireEvent.click(await screen.findByRole("button", { name: "right-module/control-board · J1" }));
  expect(screen.getByText("Context: right-module/control-board")).toBeTruthy();
  expect(screen.getByText("Firmware revision: right-firmware")).toBeTruthy();
  expect(screen.queryByText("Firmware revision: left-firmware")).toBeNull();
  fireEvent.change(screen.getByLabelText("Selected stable feature ID"), { target: { value: "connector-a.pin2" } });
  fireEvent.click(screen.getByRole("tab", { name: "Assembly contents" }));
  expect(screen.getByText("Context: right-module/control-board")).toBeTruthy();
  expect(screen.getByText(/root-snapshot \/ right-module\/control-board \/ connector-a.pin2/)).toBeTruthy();
  fireEvent.click(screen.getByRole("tab", { name: "View arrangement" }));
  fireEvent.click(screen.getByLabelText("Spread occurrences for inspection"));
  expect(screen.getByText("Canonical placement: 100, 0, 0 mm")).toBeTruthy();
  expect(screen.getByText("Firmware revision: right-firmware")).toBeTruthy();
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

test("assembly create, edit and freeze send shared operations with expected state and exact pin", async () => {
  const calls: { operation: string; expected_state?: string; payload: Record<string, unknown> }[] = [];
  let assembly = { occurrences: [] as object[], relationships: [] };
  let state = "draft-v1";
  const draft = () => ({ definition_id: "assembly", draft_id: "draft", state, content: { assembly } });
  vi.stubGlobal("fetch", vi.fn(async (url: string, options?: RequestInit) => {
    let body: unknown;
    if (options?.method === "POST") {
      const cmd = JSON.parse(String(options.body)); if (cmd.operation !== "assembly.placement_inputs") calls.push(cmd);
      if (cmd.operation === "assembly.update") { assembly = cmd.payload.assembly; state = "draft-v2"; }
      body = { result: cmd.operation === "assembly.placement_inputs" ? { draft_id: "draft", state, occurrences: [], relationships: [] } : cmd.operation === "assembly.freeze" ? { snapshot_id: "snapshot", draft: draft() } : draft() };
    } else if (url.includes("assemblies/drafts/")) body = draft();
    else if (url.includes("assemblies/snapshots/")) body = { snapshot_id: "snapshot", definition_id: "assembly", sha256: "hash", occurrences: [], relationships: [] };
    else if (url.includes("catalog/definitions/")) body = { definition_id: "assembly", name: "Synthetic", kind: "assembly", drafts: [{ draft_id: "draft", state, dependencies: [] }], revisions: [{ revision_id: "exact-revision", number: 1 }] };
    else body = [{ definition_id: "board", name: "Synthetic board", kind: "board" }, { definition_id: "assembly", name: "Synthetic", kind: "assembly" }];
    return new Response(JSON.stringify(body), { status: 200 });
  }));
  render(wrap(<AssemblyPanel projectId="project-1" />));
  fireEvent.change(screen.getByLabelText("Assembly name"), { target: { value: "Synthetic" } });
  fireEvent.click(screen.getByText("Create assembly draft"));
  await screen.findByText("Occurrences");
  fireEvent.change(screen.getByLabelText("Stable local occurrence ID"), { target: { value: "second-board" } });
  fireEvent.change(screen.getByLabelText("Display reference"), { target: { value: "J1" } });
  fireEvent.focus(screen.getByRole("combobox", { name: "Child definition" }));
  fireEvent.change(screen.getByRole("combobox", { name: "Child definition" }), { target: { value: "Synthetic board" } });
  fireEvent.click(await screen.findByText("Synthetic board (board)"));
  await waitFor(() => expect(screen.getByRole("combobox", { name: "Pinned child revision" })).toBeTruthy());
  fireEvent.focus(screen.getByRole("combobox", { name: "Pinned child revision" }));
  fireEvent.keyDown(screen.getByRole("combobox", { name: "Pinned child revision" }), { key: "ArrowDown" });
  fireEvent.click(await within(screen.getByRole("listbox", { name: "Pinned child revision", hidden: true })).findByText("Synthetic · r1"));
  await waitFor(() => expect(screen.getByText("Add occurrence").closest("button")?.disabled).toBe(false));
  fireEvent.click(screen.getByText("Add occurrence"));
  await screen.findByText(/Local ID: second-board/);
  expect(screen.getAllByText("exact-revision", { selector: 'code' }).length).toBeGreaterThan(0);
  fireEvent.click(screen.getByText("Freeze assembly revision"));
  await waitFor(() => expect(calls).toHaveLength(3));
  expect(calls[0]).toMatchObject({ operation: "assembly.create", payload: { name: "Synthetic" } }); expect(calls[0]?.payload).not.toHaveProperty("project_id");
  expect(calls[1]).toMatchObject({ operation: "assembly.update", expected_state: "draft-v1", payload: { draft_id: "draft", assembly: { occurrences: [{ local_id: "second-board", revision_id: "exact-revision", display_ref: "J1", placement: { status: "unknown" } }] } } });
  expect(calls[2]).toMatchObject({ operation: "assembly.freeze", expected_state: "draft-v2", payload: { draft_id: "draft" } });
});

test("unavailable assembly renders no partial private closure", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: { message: "Assembly unavailable." } }), { status: 404 })));
  render(wrap(<AssemblyInspector snapshotId="restricted" />));
  expect(await screen.findByText("Assembly unavailable.")).toBeTruthy();
  expect(screen.queryByRole("tab", { name: "Occurrence tree" })).toBeNull();
});

test("path keys and typed role fields preserve contextual meaning", () => {
  expect(addressKey(["a", "bc"])).not.toBe(addressKey(["ab", "c"]));
  expect(relationship("containment", "contains", "", "a", "old-feature", "old-feature")).toMatchObject({ parent: { kind: "occurrence", path: [], feature_id: null }, child: { path: ["a"], feature_id: null } });
  expect(relationship("electrical", "wire", "left/board", "right/board", "pin-a", "pin-b")).toMatchObject({ a: { path: ["left", "board"], feature_id: "pin-a" }, b: { path: ["right", "board"], feature_id: "pin-b" } });
  expect(relationship("procurement", "order", "a", "exact-revision", "", "")).toMatchObject({ subject: { path: ["a"] }, orderable: { kind: "revision", revision_id: "exact-revision" } });
});
