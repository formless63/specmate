import { MantineProvider } from "@mantine/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { PermissionsProvider } from "../../lib/permissions";
import { IntentCheckPanel } from "./IntentCheckPanel";
import { DIMENSIONS, type CheckRow, type Dimension, type IntentCheck } from "./api";

beforeEach(() => vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} }));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const wrap = (children: React.ReactNode) => <MantineProvider><QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><PermissionsProvider permissions={["workspace.read", "item.create"]}>{children}</PermissionsProvider></QueryClientProvider></MantineProvider>;
const d = (status: Dimension["status"], reason = "r"): Dimension => ({ status, reason, evidence: [] });
const dims = (patch: Partial<Record<(typeof DIMENSIONS)[number], Dimension>>) => ({ ...Object.fromEntries(DIMENSIONS.map((n) => [n, d("not_evaluated")])), ...patch }) as CheckRow["dimensions"];
const red = { signal_set_revision_id: "s", key: "video_red", name: "Red video", type: "analog_video", set_name: "AV", set_revision_number: 1 } as const;
const result: IntentCheck = {
  algorithm_version: "cable_intent_check/0.1", cable_revision_id: "cable-rev", draft_id: null, intent_revision_id: "intent-rev", intent_name: "Console to monitor", intent_number: 1,
  ends: { from: { endpoint_id: "a", label: "Console end", intent_end: "Console out", mating: d("pass") }, to: { endpoint_id: "b", label: "Monitor end", intent_end: "Monitor in", mating: d("pass") } },
  rows: [
    { row_id: "from-4", requirement: "required", from_label: "4 · Red video", to_labels: ["15 · Red video"], signal: red, outcome: "fail", reached: ["7 · Blue video"],
      dimensions: dims({ connection: d("fail", "No declared path to 15 · Red video."), signal_match: d("fail", "Reaches 7 · Blue video."), convention: d("flagged", "The convention uses this core for Blue video.") }),
      path: [{ kind: "port_pin", label: "Console out 4 · Red video" }, { kind: "landing", label: "landing (unreviewed)", status: "unknown" }, { kind: "port_pin", label: "Monitor in 7 · Blue video" }] },
    { row_id: "from-1", requirement: "required", from_label: "1 · Composite sync", to_labels: ["20 · Composite sync"], signal: { ...red, key: "composite_sync", name: "Composite sync", type: "sync" }, outcome: "unknown", reached: [], path: [],
      dimensions: dims({ connection: d("pass"), level: d("unknown", "The from end declares no level for this pin.") }) },
  ],
  cable: { isolation: d("pass"), shield: d("not_evaluated", "The stock has no overall shield or drain.") }, counts: { fail: 1, unknown: 1 },
  continuity: "not_evaluated", physical_qualification: "not_evaluated",
};

test("rows show outcomes and dimension LEDs; a row expands to its path and reasons; the check can be recorded", async () => {
  const posts: { operation: string; payload: unknown }[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, options?: RequestInit) => {
    if (options?.method === "POST") { posts.push(JSON.parse(String(options.body))); return new Response(JSON.stringify({ result: { record_id: "rec", source: "cable_intent_check" } }), { status: 200 }); }
    expect(url).toContain("cables/revisions/cable-rev/intent-check?intent_revision_id=intent-rev");
    return new Response(JSON.stringify(result), { status: 200 });
  }));
  render(wrap(<IntentCheckPanel revisionId="cable-rev" intentRevisionId="intent-rev" />));
  const table = await screen.findByRole("table", { name: "Intent check rows" });
  expect(within(table).getAllByLabelText("Connection fail")).toHaveLength(1);
  // Unknown is its own state, never shown as pass.
  expect(within(table).getByLabelText("Level unknown")).toBeTruthy();
  expect(within(table).getByLabelText("Convention flagged")).toBeTruthy();
  fireEvent.click(within(table).getByRole("button", { name: "Path and reasons for from-4" }));
  const chain = await screen.findByRole("list", { name: "Declared path" });
  expect(within(chain).getByText("landing (unreviewed)").getAttribute("data-unknown")).toBe("true");
  expect(screen.getByText("Reaches 7 · Blue video.")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Record this check as evidence" }));
  await waitFor(() => expect(posts[0]).toMatchObject({ operation: "evidence.record_cable_intent_check", payload: { cable_revision_id: "cable-rev", intent_revision_id: "intent-rev" } }));
});

test("without a pinned intent the panel says how to start, and drafts cannot record", async () => {
  render(wrap(<IntentCheckPanel draftId="draft" intentRevisionId={null} />));
  expect(screen.getByText("Pin a cable intent on this cable to check it signal by signal.")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Record this check as evidence" })).toBeNull();
});
