import { MantineProvider } from "@mantine/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { AssemblyInspector } from "./AssemblyInspector";
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
  expect(screen.getByText(/Firmware revision:/)).toBeTruthy();
  expect(screen.getByText("right-firmware")).toBeTruthy();
  expect(screen.queryByText("left-firmware")).toBeNull();
  fireEvent.change(screen.getByLabelText("Selected stable feature ID"), { target: { value: "connector-a.pin2" } });
  fireEvent.click(screen.getByRole("tab", { name: "Assembly contents" }));
  expect(screen.getByText("Context: right-module/control-board")).toBeTruthy();
  expect(screen.getByText(/root-snapshot \/ right-module\/control-board \/ connector-a.pin2/)).toBeTruthy();
  fireEvent.click(screen.getByRole("tab", { name: "View arrangement" }));
  fireEvent.click(screen.getByLabelText("Spread occurrences for inspection"));
  expect(screen.getByText("Canonical placement: 100, 0, 0 mm")).toBeTruthy();
  expect(screen.getByText("right-firmware")).toBeTruthy();
  expect(fetchMock).toHaveBeenCalledTimes(1);
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



test('denied frozen refresh cannot retain private canonical placement or mounting details', async () => {
  let denied = false;
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(denied ? { error: { message: 'Frozen source access denied' } } : { snapshot_id: 'snapshot', sha256: 'hash', occurrences: [{ address: { snapshot_id: 'snapshot', path: ['board'] }, name: 'Private board', display_ref: 'A1', revision_id: 'private-revision', snapshot_sha256: 'private-hash', placement: { status: 'known', translation: [50, 0, 0], rotation_xyzw: [0, 0, 1, 0] }, assignments: {} }], relationships: [] }), { status: denied ? 404 : 200 })));
  render(<MantineProvider env="test"><QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><AssemblyInspector snapshotId="snapshot" /></QueryClientProvider></MantineProvider>);
  fireEvent.click(await screen.findByRole('button', { name: 'board · A1' }));
  expect(screen.getByText('Canonical rotation quaternion (X, Y, Z, W): 0, 0, 1, 0')).toBeTruthy();
  denied = true; fireEvent.click(screen.getByRole('button', { name: 'Refresh canonical assembly inspection' }));
  await screen.findByText('Frozen source access denied');
  expect(screen.queryByText('Exact revision: private-revision')).toBeNull();
  expect(screen.queryByText('Canonical placement: 50, 0, 0 mm')).toBeNull();
});
