import { MantineProvider } from "@mantine/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { PermissionsProvider } from "../../lib/permissions";
import { initialCable, type Cable } from "../cables/api";
import { ProposeWiring, acceptRows, type Proposal } from "./ProposeWiring";

beforeEach(() => vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} }));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const wrap = (children: React.ReactNode) => <MantineProvider><QueryClientProvider client={new QueryClient()}><PermissionsProvider permissions={["workspace.read", "item.create", "design.edit"]}>{children}</PermissionsProvider></QueryClientProvider></MantineProvider>;

const land = (endpoint_id: string, element_path: string, layer_id: string, terminal_id: string) => ({ endpoint_id, element_path, layer_id, terminal_id, basis: "Proposed", terminal_label: `${layer_id} ${terminal_id}` });
const proposal: Proposal = {
  intent_revision_id: "intent", status: "proposed", review: "required", existing_needs: [{ definition_id: "n", name: "Older adapter idea" }],
  cable: { ...initialCable(), stock_revision_id: "stock", assignments: [] },
  rows: [
    { row_id: "from-4", requirement: "required", status: "proposed", conductor: "stock.core-1.center", reason: "preferred by convention", questions: [], assignments: [land("a", "stock.core-1.center", "board", "r"), land("b", "stock.core-1.center", "connector", "15")] },
    { row_id: "from-1", requirement: "required", status: "question", conductor: "stock.core-4.center", reason: "preferred by convention", assignments: [land("a", "stock.core-4.center", "connector", "1"), land("b", "stock.core-4.center", "connector", "20")],
      questions: [{ row_id: "from-1", kind: "missing_part", text: "Neither end carries the required series resistor 470 ohm on Composite sync.", development_need: { need: "adapter_board", summary: "Adapter with series resistor 470 ohm on Composite sync", description: "d" } }] },
    { row_id: "from-8", requirement: "must_not_connect", status: "not_wired", conductor: null, reason: "Must not connect.", questions: [], assignments: [] },
  ],
  questions: [{ row_id: "from-1", kind: "missing_part", text: "Neither end carries the required series resistor 470 ohm on Composite sync.", development_need: { need: "adapter_board", summary: "Adapter with series resistor 470 ohm on Composite sync", description: "d" } }],
  check: { rows: [{ row_id: "from-4", outcome: "pass" }, { row_id: "from-1", outcome: "fail" }] } as unknown as Proposal["check"],
  diff: [{ endpoint_id: "a", element_path: "stock.core-1.center", change: "changed", current: null, proposed: null }],
};

test("accepting replaces only the accepted rows' conductor ends and pins the intent", () => {
  const current: Cable = { ...initialCable(), assignments: [{ endpoint_id: "a", element_path: "stock.core-1.center", layer_id: "board", terminal_id: "b", basis: "old" }, { endpoint_id: "a", element_path: "stock.core-9.center", layer_id: "board", terminal_id: "x", basis: "kept" }] };
  const next = acceptRows(current, proposal, new Set(["from-4"]));
  expect(next.intent_revision_id).toBe("intent");
  expect(next.assignments.map((a) => `${a.endpoint_id}:${a.element_path}:${a.terminal_id}`).sort()).toEqual(["a:stock.core-1.center:r", "a:stock.core-9.center:x", "b:stock.core-1.center:15"]);
});

test("questions show first; proposed rows are pre-selected; rows can be rejected before accepting", async () => {
  const posts: { operation?: string; payload?: unknown }[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, options?: RequestInit) => {
    if (url.includes("cables/propose")) return new Response(JSON.stringify(proposal), { status: 200 });
    posts.push(JSON.parse(String(options?.body)));
    return new Response(JSON.stringify({ result: { definition_id: "need" } }), { status: 200 });
  }));
  const accepted = vi.fn();
  render(wrap(<ProposeWiring intentRevisionId="intent" draftId="draft" current={initialCable()} onAccept={accepted} />));
  fireEvent.click(screen.getByRole("button", { name: "Propose wiring from the intent" }));
  expect(await screen.findByText("1 question")).toBeTruthy();
  const table = screen.getByRole("table", { name: "Proposed rows" });
  expect((within(table).getByLabelText("Accept row from-4") as HTMLInputElement).checked).toBe(true);
  expect((within(table).getByLabelText("Accept row from-1") as HTMLInputElement).checked).toBe(false);
  expect((within(table).getByLabelText("Accept row from-8") as HTMLInputElement).disabled).toBe(true);
  expect(within(table).getByText("A: core-1.center → board r (changed)")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Record as development need" }));
  await waitFor(() => expect(posts[0]).toMatchObject({ operation: "definition.create", payload: { kind: "development_need", content: { development_need: { need: "adapter_board" } } } }));
  fireEvent.click(screen.getByRole("button", { name: "Accept selected rows (1)" }));
  await waitFor(() => expect(accepted).toHaveBeenCalledTimes(1));
  expect((accepted.mock.calls[0]![0] as Cable).assignments).toHaveLength(2);
});
