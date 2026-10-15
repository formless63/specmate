import { MantineProvider } from "@mantine/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { PermissionsProvider } from "../../lib/permissions";
import { SignalSetInspector, SignalSetPanel } from "./SignalSetPanel";
import type { SignalSet } from "./api";

beforeEach(() => { vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} }); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
async function select(label: string, option: string | RegExp) {
  const field = await screen.findByRole("combobox", { name: label });
  fireEvent.focus(field); fireEvent.keyDown(field, { key: "ArrowDown" });
  fireEvent.click(await within(screen.getByRole("listbox", { name: label, hidden: true })).findByText(option));
}

const EDITOR = ["workspace.read", "item.create", "design.edit", "design.freeze"];
function wrap(children: React.ReactNode, permissions = EDITOR) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <MantineProvider><QueryClientProvider client={client}><PermissionsProvider permissions={permissions}>{children}</PermissionsProvider></QueryClientProvider></MantineProvider>;
}

const unknown = { status: "unknown", nominal: null, minimum: null, maximum: null, basis: null } as const;
const FROZEN: SignalSet = { kind: "signal_set", description: "Synthetic AV", signals: [
  { key: "video_red", name: "Red video", type: "analog_video", return_for: [], differential_with: null, level: { status: "known", nominal: 0.7, minimum: null, maximum: null, basis: "Synthetic", unit: "Vpp" }, impedance: { status: "known", nominal: 75, minimum: null, maximum: null, basis: "Synthetic", unit: "ohm" }, notes: null, basis: "Synthetic" },
  { key: "composite_sync", name: "Composite sync", type: "sync", return_for: [], differential_with: null, level: { ...unknown, unit: "unknown" }, impedance: { ...unknown, unit: "ohm" }, notes: null, basis: null },
  { key: "video_ground", name: "Video ground", type: "ground_return", return_for: ["video_red", "composite_sync"], differential_with: null, level: { ...unknown, unit: "unknown" }, impedance: { ...unknown, unit: "ohm" }, notes: null, basis: null },
] };

test("a new signal set is authored by name with type and return relation, unknown values omitted", async () => {
  const calls: { operation: string; payload: { name?: string; interface?: SignalSet } }[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, options?: RequestInit) => {
    if (options?.method === "POST") {
      calls.push(JSON.parse(String(options.body)));
      return new Response(JSON.stringify({ result: { definition_id: "set", draft_id: "draft", state: "draft-v1" } }), { status: 200 });
    }
    if (url.includes("catalog/definitions/")) return new Response(JSON.stringify({ definition_id: "set", name: "Workshop AV signals", kind: "signal_set", drafts: [{ draft_id: "draft", state: "draft-v1", dependencies: [] }], revisions: [] }));
    if (url.includes("interfaces/drafts/")) return new Response(JSON.stringify({ definition_id: "set", kind: "signal_set", draft_id: "draft", state: "draft-v1", content: { interface: calls[0]?.payload.interface } }));
    return new Response(JSON.stringify([]));
  }));
  render(wrap(<SignalSetPanel projectId={null} />));
  fireEvent.change(screen.getByLabelText("Signal set name"), { target: { value: "Workshop AV signals" } });
  for (const name of ["Red video", "Video ground"]) {
    fireEvent.change(screen.getByLabelText("New signal name"), { target: { value: name } });
    fireEvent.click(screen.getByText("Add signal"));
  }
  expect(screen.getByText("red_video")).toBeTruthy();
  await select("Type of Video ground", "Ground / return");
  await select("Signals returned by Video ground", "Red video");
  fireEvent.click(screen.getByText("Create signal set draft"));
  await screen.findByText("Edit signal set draft");
  expect(calls[0]).toMatchObject({ operation: "interface.create", payload: { name: "Workshop AV signals", interface: { kind: "signal_set", signals: [
    { key: "red_video", name: "Red video", type: "unknown", level: { status: "unknown", nominal: null }, impedance: { status: "unknown", nominal: null } },
    { key: "video_ground", name: "Video ground", type: "ground_return", return_for: ["red_video"] },
  ] } } });
});

test("a viewer reads signal sets but authoring is withheld", () => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify([]))));
  render(wrap(<SignalSetPanel projectId="project" />, ["workspace.read"]));
  expect((screen.getByText("Create signal set draft").closest("button") as HTMLButtonElement).disabled).toBe(true);
  expect(screen.getByText(/Creating signal sets is unavailable/)).toBeTruthy();
});

test("a frozen set shows names, type chips, returns by name and unknown levels hatched, never zero", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ revision_id: "set-r1", interface: FROZEN, compatibility: "not_evaluated" }))));
  render(wrap(<SignalSetInspector revisionId="set-r1" />));
  const row = (await screen.findByText("Video ground")).closest("tr") as HTMLElement;
  expect(within(row).getByText("Ground / return")).toBeTruthy();
  expect(within(row).getByText("Red video, Composite sync")).toBeTruthy();
  const sync = screen.getByText("Composite sync", { selector: "td" }).closest("tr") as HTMLElement;
  expect(within(sync).getByText("Level unknown")).toBeTruthy();
  expect(within(sync).getByText("Impedance unknown")).toBeTruthy();
  expect(within(sync).queryByText(/^0/)).toBeNull();
  const red = screen.getByText("Red video", { selector: "td" }).closest("tr") as HTMLElement;
  expect(within(red).getByText("0.7 Vpp")).toBeTruthy();
  expect(within(red).getByText("75 ohm")).toBeTruthy();
});
