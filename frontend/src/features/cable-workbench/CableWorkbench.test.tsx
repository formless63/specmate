import { MantineProvider } from "@mantine/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { PermissionsProvider } from "../../lib/permissions";
import type { Cable } from "../cables/api";
import { CableWorkbench } from "./CableWorkbench";
import { boardEnd, cable, check, inlineEnd, row, stock } from "./fixtures";

beforeEach(() => vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} }));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const wrap = (children: React.ReactNode, permissions?: string[]) => <MantineProvider><QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
  <PermissionsProvider permissions={permissions}>{children}</PermissionsProvider></QueryClientProvider></MantineProvider>;

const proposal = {
  intent_revision_id: "intent", cable: cable(), questions: [], existing_needs: [], status: "proposed", review: "required", check: check([]),
  rows: [{ row_id: "ground", requirement: "required", status: "proposed", conductor: "stock.core-2.screen", reason: "Own screen returns this signal.", questions: [],
    assignments: [{ endpoint_id: "b", element_path: "stock.core-2.screen", layer_id: "connector", terminal_id: "2", basis: "Proposed from the intent", terminal_label: "2" }] }],
  diff: [{ endpoint_id: "b", element_path: "stock.core-2.screen", change: "added", current: null, proposed: null }],
};

function serve() {
  const calls: { url: string; body: unknown }[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, options?: RequestInit) => {
    calls.push({ url, body: options?.body ? JSON.parse(String(options.body)) : null });
    const data = url.includes("intent-check")
      ? check([row("video", "pass", [{ endpoint_id: "a", layer_id: "board", terminal_id: "v" }, { element_path: "stock.core-1.center" }, { endpoint_id: "b", layer_id: "connector", terminal_id: "1" }])])
      : url.includes("cables/propose") ? proposal : {};
    return new Response(JSON.stringify(data), { status: 200 });
  }));
  return calls;
}

function bench(props: Partial<Parameters<typeof CableWorkbench>[0]> = {}) {
  const value = { ...cable(), intent_revision_id: "intent" };
  return <CableWorkbench mode="draft" name="Synthetic cable" cable={value} stacks={[boardEnd(), inlineEnd()]} stock={stock()} draftId="draft" checkVersion="v1"
    revision={{ value: "Draft", sub: "v1" }} {...props} />;
}

test("header cells state one fact each, and the check draws per-row outcomes", async () => {
  serve();
  render(wrap(bench()));
  expect(screen.getByTestId("cell-length").textContent).toContain("1500 mm");
  expect(await screen.findByText("1/1 pass")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Video: pass" })).toBeTruthy();
  expect(screen.getByRole("heading", { name: "Edit draft" })).toBeTruthy();
});

test("probing a wire lights its net and shows the row's ten dimensions; unrelated wires dim", async () => {
  serve();
  render(wrap(bench()));
  await screen.findByText("1/1 pass");
  fireEvent.click(screen.getByRole("button", { name: /^Wire Coax 1 center \(red\) · Video/ }));
  const inspector = within(screen.getByRole("complementary", { name: "Inspector" }));
  expect(inspector.getByRole("list", { name: "Dimensions of Video" }).children).toHaveLength(10);
  expect(inspector.getAllByText("Follows the stock convention.").length).toBeGreaterThan(0);
  const svg = screen.getByRole("group", { name: /^Cable drawing of Synthetic cable/ });
  expect(svg.querySelector('[data-key="t:a/board/din-1"]')!.hasAttribute("data-dim")).toBe(false);
  expect(svg.querySelector('[data-key="w:stock.core-1.screen"]')!.hasAttribute("data-dim")).toBe(true);
});

test("a landing is chosen by clicking a pad in the drawing", async () => {
  serve();
  const onChange = vi.fn();
  render(wrap(bench({ onChange })));
  fireEvent.click(screen.getByRole("button", { name: /^Wire Coax 2 center \(blue\)/ }));
  const inspector = within(screen.getByRole("complementary", { name: "Inspector" }));
  fireEvent.click(inspector.getAllByRole("button", { name: "Choose in drawing" })[1]!);
  expect(screen.getByRole("status").textContent).toContain("End B");
  fireEvent.click(screen.getByRole("button", { name: /^Land on Inline parts R2 · 1/ }));
  const next = onChange.mock.calls.at(-1)![0] as Cable;
  expect(next.assignments.at(-1)).toMatchObject({ endpoint_id: "b", element_path: "stock.core-2.center", layer_id: "inline", terminal_id: "r2.1", basis: "Declared in the cable editor" });
});

test("proposed wires are dashed with per-row accept that writes through the given update", async () => {
  const calls = serve();
  const onAccept = vi.fn(async () => {});
  render(wrap(bench({ onAccept })));
  fireEvent.click(screen.getByRole("button", { name: "Propose wiring" }));
  expect(await screen.findByRole("button", { name: /^Proposed: stock.core-2.screen to 2 at end B/ })).toBeTruthy();
  expect(calls.find((c) => c.url.includes("cables/propose"))!.body).toEqual({ intent_revision_id: "intent", draft_id: "draft" });
  fireEvent.click(within(screen.getByRole("region", { name: "Proposed wiring" })).getByRole("button", { name: "Accept ground" }));
  await waitFor(() => expect(onAccept).toHaveBeenCalledTimes(1));
  const accepted = (onAccept.mock.calls[0] as unknown as [Cable])[0];
  expect(accepted.assignments).toContainEqual({ endpoint_id: "b", element_path: "stock.core-2.screen", layer_id: "connector", terminal_id: "2", basis: "Proposed from the intent" });
  await waitFor(() => expect(screen.queryByRole("button", { name: /^Proposed: stock.core-2.screen/ })).toBeNull());
});

test("without an intent there are no badges; a viewer gets no landing controls", () => {
  serve();
  render(wrap(bench({ cable: cable(), draftId: null, revisionId: "rev", mode: "frozen" }), ["workspace.read"]));
  expect(screen.getByTestId("cell-signals").textContent).toContain("No intent");
  expect(document.querySelector(".cwb-st")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: /^Wire Coax 1 center \(red\)/ }));
  expect(screen.queryByRole("button", { name: "Choose in drawing" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Propose wiring" })).toBeNull();
});

test("signal tiles are keyboard-navigable: arrows move focus, Enter probes", async () => {
  serve();
  render(wrap(bench({ cable: cable(), draftId: null, revisionId: "rev", mode: "frozen" })));
  const strip = screen.getByRole("group", { name: "Conductive elements" });
  const tiles = within(strip).getAllByRole("button");
  tiles[0]!.focus();
  fireEvent.keyDown(tiles[0]!, { key: "ArrowRight" });
  expect(document.activeElement).toBe(tiles[1]);
  fireEvent.keyDown(tiles[1]!, { key: "End" });
  expect(document.activeElement).toBe(tiles.at(-1));
  // The frozen view keeps Check against intent, disabled only for want of a pinned intent.
  expect(screen.getByRole("button", { name: "Check against intent" })).toBeTruthy();
});
