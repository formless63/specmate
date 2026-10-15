import { MantineProvider } from "@mantine/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { PermissionsProvider } from "../../lib/permissions";
import { EndAssemblyPanel } from "./EndAssemblyPanel";
import { StackView } from "./StackEditor";
import type { ResolvedStack } from "./api";

beforeEach(() => vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} }));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const wrap = (children: React.ReactNode) => <MantineProvider><QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{children}</QueryClientProvider></MantineProvider>;

const red = { key: "video_red", name: "Red video", type: "analog_video", set_name: "AV signals", set_revision_number: 1 } as const;
const sync = { key: "composite_sync", name: "Composite sync", type: "sync", set_name: "AV signals", set_revision_number: 1 } as const;
// A board-form end: pad R reaches contact 4 by straight copper; CS through a resistor; 5V reaches nothing.
const resolved: ResolvedStack = {
  layers: [
    { layer_id: "board", kind: "board", name: "Adapter board r1", carried_connector_id: "plug", carried_status: "reviewed", paths: [], terminals: [
      { terminal_id: "r", label: "R", kind: "solder_pad", reaches: [{ contact_id: "4", label: "4", signal: red, status: "declared", via: ["Straight copper", "landing"] }] },
      { terminal_id: "cs", label: "CS", kind: "solder_pad", reaches: [{ contact_id: "1", label: "1", signal: sync, status: "unknown", via: ["R1 470R resistor", "landing (unreviewed)"] }] },
      { terminal_id: "v5", label: "5V", kind: "solder_pad", reaches: [] },
    ] },
    { layer_id: "connector", kind: "connector", name: "10-pin plug r1", variant_label: "Console A AV", terminals: [{ terminal_id: "4", label: "4", kind: "contact", signal: red, signal_status: "declared", reaches: [] }] },
    { layer_id: "shell", kind: "shell", name: null, electrical: "none_unless_bonded", terminals: [{ terminal_id: "body", label: "Shell body", kind: "shell", reaches: [] }] },
  ],
  joins: [], connector_layer_id: "connector", body_revision_id: "plug", pinout_revision_id: "variant",
  evaluation: [{ layer_id: "shell", status: "not_evaluated", reason: "A shell is mechanical." }], continuity: "not_evaluated",
};

test("a resolved stack reads by labels: chips, declared reaches, unknown steps and no invented landing", () => {
  render(wrap(<StackView resolved={resolved} label="End A" />));
  const chips = screen.getByRole("list", { name: "End A stack" });
  expect(within(chips).getAllByRole("listitem").map((chip) => chip.textContent)).toEqual(["BoardAdapter board r1", "Connector10-pin plug r1 · Console A AV", "Shellunknown"]);
  const pads = screen.getByRole("table", { name: "Board terminals" });
  expect(within(pads).getByText(/→ 4 · Red video/)).toBeTruthy();
  expect(within(pads).getByText(/via Straight copper, landing/)).toBeTruthy();
  // An unreviewed step stays visibly unknown; a pad without a path reaches nothing.
  expect(within(pads).getByText("step unknown")).toBeTruthy();
  expect(within(pads).getByText("Signal unknown")).toBeTruthy();
  expect(screen.getByText("Mechanical; joined only by a declared bond.")).toBeTruthy();
});

test("new end assembly: layers are added in wire-outward order and create sends the stack", async () => {
  const posts: { operation?: string; payload?: { interface?: { stack: { layers: { kind: string }[] } } } }[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, options?: RequestInit) => {
    if (options?.method === "POST") { posts.push(JSON.parse(String(options.body))); return new Response(JSON.stringify({ result: { definition_id: "d", draft_id: "x", state: "draft-v1", kind: "end_assembly", content: {} } }), { status: 200 }); }
    return new Response(JSON.stringify(url.endsWith("workspace/definitions") ? [] : {}), { status: 200 });
  }));
  render(wrap(<PermissionsProvider permissions={["workspace.read", "item.create", "design.edit"]}><EndAssemblyPanel projectId={null} /></PermissionsProvider>));
  fireEvent.change(screen.getByLabelText("End assembly name"), { target: { value: "Plug end" } });
  fireEvent.click(screen.getByRole("button", { name: "Add shell" }));
  fireEvent.click(screen.getByRole("button", { name: "Add board" }));
  fireEvent.click(screen.getByRole("button", { name: "Create end assembly draft" }));
  await vi.waitFor(() => expect(posts.some((p) => p.operation === "interface.create")).toBe(true));
  const created = posts.find((p) => p.operation === "interface.create")!;
  expect(created.payload!.interface!.stack.layers.map((l) => l.kind)).toEqual(["board", "connector", "shell"]);
});

test("viewers see the editor fields as read-only and cannot create", () => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify([]), { status: 200 })));
  render(wrap(<PermissionsProvider permissions={["workspace.read"]}><EndAssemblyPanel projectId={null} /></PermissionsProvider>));
  expect((screen.getByRole("button", { name: "Create end assembly draft" }) as HTMLButtonElement).disabled).toBe(true);
});
