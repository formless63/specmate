import { MantineProvider } from "@mantine/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { PermissionsProvider } from "../../lib/permissions";
import { ConventionEditor, ConventionInspector, conductiveElements } from "./ConventionFields";
import { StockConventions } from "./StockConventions";
import { initialInterface, type Convention, type ConventionView, type StockConventions as Applicable } from "./api";

beforeEach(() => { vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} }); Element.prototype.scrollIntoView = vi.fn(); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
async function select(label: string, option: string | RegExp) {
  const field = await screen.findByRole("combobox", { name: label });
  fireEvent.focus(field); fireEvent.keyDown(field, { key: "ArrowDown" });
  fireEvent.click(await within(screen.getByRole("listbox", { name: label, hidden: true })).findByText(option));
}
function wrap(children: React.ReactNode, permissions = ["workspace.read", "item.create", "design.edit", "design.freeze"]) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <MantineProvider><QueryClientProvider client={client}><PermissionsProvider permissions={permissions}>{children}</PermissionsProvider></QueryClientProvider></MantineProvider>;
}

const unknownQ = { status: "unknown", nominal: null, minimum: null, maximum: null, basis: null };
const signal = (key: string, name: string, type: string) => ({ key, name, type, return_for: [], differential_with: null, level: { ...unknownQ, unit: "unknown" }, impedance: { ...unknownQ, unit: "ohm" }, notes: null, basis: null });
const SIGNALS = { kind: "signal_set", description: null, signals: [signal("video_red", "Red video", "analog_video"), signal("composite_sync", "Composite sync", "sync"), signal("video_ground", "Video ground", "ground_return")] };
const element = (id: string, label: string, kind: string) => ({ id, label, kind, outer_diameter_mm: 1, inner_diameter_mm: 0, material: null, color: null, source: null, x_mm: 0, y_mm: 0 });
const STOCK = { schema_version: "1", construction: "bundle", viewed_from: "a", facts: {}, structure: { id: "stock", label: "Six-coax", kind: "group", role: "stock", children: [
  { id: "core-1", label: "Core 1 (red)", kind: "group", role: "coax", children: [element("center", "Center", "conductor"), element("dielectric", "Dielectric", "dielectric"), element("screen", "Screen", "shield")] },
  { id: "core-2", label: "Core 2 (yellow)", kind: "group", role: "coax", children: [element("center", "Center", "conductor"), element("screen", "Screen", "shield")] },
  element("jacket", "Jacket", "jacket"),
] } };
const DEFINITIONS = [{ definition_id: "set", name: "Workshop AV signals", kind: "signal_set" }, { definition_id: "stock", name: "Six-coax AV stock", kind: "wire_stock" }];

function stub() {
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    let body: unknown = [];
    if (url.includes("catalog/definitions/set")) body = { definition_id: "set", name: "Workshop AV signals", kind: "signal_set", drafts: [], revisions: [{ revision_id: "set-r1", number: 1 }] };
    else if (url.includes("catalog/definitions/stock")) body = { definition_id: "stock", name: "Six-coax AV stock", kind: "wire_stock", drafts: [], revisions: [{ revision_id: "stock-r1", number: 1 }] };
    else if (url.includes("revisions/stock-r1/snapshot")) body = { content: { stock: STOCK } };
    else if (url.includes("interfaces/revisions/set-r1")) body = { revision_id: "set-r1", interface: SIGNALS, compatibility: "not_evaluated" };
    return new Response(JSON.stringify(body));
  }));
}

let latest: Convention | null = null;
function Harness({ initial }: { initial?: Convention }) {
  const [value, setValue] = useState<Convention>(initial ?? (initialInterface("conductor_convention") as Convention));
  latest = value;
  return <ConventionEditor value={value} onChange={setValue} definitions={DEFINITIONS} />;
}

test("only conductors, screens and drains are offered, labeled by their parents", () => {
  expect(conductiveElements(STOCK.structure)).toEqual([
    { path: "stock.core-1.center", label: "Core 1 (red) / Center", kind: "conductor" },
    { path: "stock.core-1.screen", label: "Core 1 (red) / Screen", kind: "shield" },
    { path: "stock.core-2.center", label: "Core 2 (yellow) / Center", kind: "conductor" },
    { path: "stock.core-2.screen", label: "Core 2 (yellow) / Screen", kind: "shield" },
  ]);
});

test("a stock convention maps elements by label to signals by name; unstated elements are omitted", async () => {
  stub();
  render(wrap(<Harness />));
  await select("Signal set definition", "Workshop AV signals");
  await waitFor(() => expect(latest?.signal_set_revision_id).toBe("set-r1"));
  await select("Wire stock definition", "Six-coax AV stock");
  await waitFor(() => expect(latest?.stock_revision_id).toBe("stock-r1"));
  await screen.findByText("Core 1 (red) / Center");
  await select("Use of Core 1 (red) / Center", "Carries signal");
  await select("Signal for Core 1 (red) / Center", "Red video");
  await select("Use of Core 1 (red) / Screen", "Return of");
  // A return is the return of a signal, never of another return: the ground is not offered.
  fireEvent.focus(await screen.findByRole("combobox", { name: "Signal for Core 1 (red) / Screen" }));
  fireEvent.keyDown(screen.getByRole("combobox", { name: "Signal for Core 1 (red) / Screen" }), { key: "ArrowDown" });
  const listbox = screen.getByRole("listbox", { name: "Signal for Core 1 (red) / Screen", hidden: true });
  expect(within(listbox).queryByText("Video ground")).toBeNull();
  fireEvent.click(within(listbox).getByText("Red video"));
  await select("Use of Core 2 (yellow) / Center", "Spare");
  fireEvent.change(screen.getByLabelText("Basis for Core 2 (yellow) / Center"), { target: { value: "Spare in this shop" } });
  await waitFor(() => expect(latest?.rules).toHaveLength(3));
  expect(latest).toMatchObject({ scope: "stock", signal_set_revision_id: "set-r1", stock_revision_id: "stock-r1", rules: [
    { element_path: "stock.core-1.center", use: { kind: "signal", signal_key: "video_red" }, preference: "preferred" },
    { element_path: "stock.core-1.screen", use: { kind: "return_of", signal_key: "video_red" } },
    { element_path: "stock.core-2.center", use: { kind: "spare" }, basis: "Spare in this shop" },
  ] });
  // Clearing a use returns the element to unknown: the rule disappears.
  const clear = screen.getByRole("combobox", { name: "Use of Core 2 (yellow) / Center" }).closest(".mantine-Select-wrapper")?.querySelector("button");
  expect(clear).toBeTruthy();
  fireEvent.click(clear as HTMLElement);
  await waitFor(() => expect(latest?.rules).toHaveLength(2));
});

test("a color code is authored by color with an exact display color and element kind", async () => {
  stub();
  render(wrap(<Harness initial={{ ...(initialInterface("conductor_convention") as Convention), scope: "color_code", signal_set_revision_id: "set-r1" }} />));
  fireEvent.change(screen.getByLabelText("Color name"), { target: { value: "Red" } });
  fireEvent.change(screen.getByLabelText(/Exact display color/), { target: { value: "#c0392b" } });
  await select("Applies to", "Conductor");
  fireEvent.click(screen.getByText("Add color rule"));
  await select("Use of Red conductor", "Carries a signal type");
  await waitFor(() => expect(latest?.rules[0]).toMatchObject({ element_path: null, color: "Red", color_hex: "#c0392b", element_kind: "conductor", use: { kind: "signal_type", signal_type: "analog_video" } }));
  fireEvent.change(screen.getByLabelText(/Exact display color/), { target: { value: "red" } });
  expect(screen.getByText("Use #RRGGBB")).toBeTruthy();
});

const VIEW: ConventionView = { scope: "stock", effect: "preference", effect_note: "A convention ranks proposals and flags deviations. It is a preference: it never makes a check pass, and a conductor without a rule stays unknown.",
  stock: { revision_id: "stock-r1", definition_id: "stock", name: "Six-coax AV stock", number: 1 }, signal_set: { revision_id: "set-r1", name: "Workshop AV signals", number: 1 },
  rows: [
    { element_path: "stock.core-1.center", element_label: "Core 1 (red) / Center", element_kind: "conductor", color: null, color_hex: null, use: { kind: "signal", signal_key: "video_red", signal_type: null, signal: { signal_set_revision_id: "set-r1", key: "video_red", name: "Red video", type: "analog_video", set_name: "AV", set_revision_number: 1 } }, preference: "preferred", basis: "Shop habit" },
    { element_path: "stock.core-1.screen", element_label: "Core 1 (red) / Screen", element_kind: "shield", color: null, color_hex: null, use: { kind: "return_of", signal_key: "video_red", signal_type: null, signal: { signal_set_revision_id: "set-r1", key: "video_red", name: "Red video", type: "analog_video", set_name: "AV", set_revision_number: 1 } }, preference: "preferred", basis: null },
  ],
  unmapped: [{ element_path: "stock.core-2.center", element_label: "Core 2 (yellow) / Center", element_kind: "conductor" }] };

test("a frozen convention reads by label and signal name, unmapped conductors are unknown, and it is only a preference", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ revision_id: "c-r1", interface: { ...initialInterface("conductor_convention"), review: "reviewed" }, convention: VIEW, compatibility: "not_evaluated" }))));
  render(wrap(<ConventionInspector revisionId="c-r1" />));
  const red = (await screen.findByText("Core 1 (red) / Center", { selector: "td" })).closest("tr") as HTMLElement;
  expect(within(red).getByText("Red video")).toBeTruthy();
  expect(within(red).getByText("Analog video")).toBeTruthy();
  const screenRow = screen.getByText("Core 1 (red) / Screen", { selector: "td" }).closest("tr") as HTMLElement;
  expect(within(screenRow).getByText("Return of Red video")).toBeTruthy();
  const open = screen.getByText("Core 2 (yellow) / Center", { selector: "td" }).closest("tr") as HTMLElement;
  expect(within(open).getByText("Use unknown")).toBeTruthy();
  expect(within(open).queryByText(/spare/i)).toBeNull();
  expect(screen.getByText("Preference only")).toBeTruthy();
  expect(screen.getByText(/never makes a check pass/)).toBeTruthy();
});

test("a stock view lists exact conventions with rows, others by name, and color matches", async () => {
  const applicable: Applicable = { stock_revision_id: "stock-r1", effect: "preference", effect_note: VIEW.effect_note, conventions: [
    { definition_id: "c1", name: "Six-coax AV convention", revision_id: "c-r1", number: 1, scope: "stock", review: "reviewed", rule_count: 2, exact: true, convention: VIEW },
    { definition_id: "c2", name: "Older habit", revision_id: "c-r2", number: 3, scope: "stock", review: "unreviewed", rule_count: 4, exact: false },
    { definition_id: "c3", name: "AV color code", revision_id: "c-r3", number: 1, scope: "color_code", review: "reviewed", rule_count: 1, exact: false,
      matches: [{ element_path: "stock.core-1.center", element_label: "Core 1 (red) / Center", rule: { ...VIEW.rows[0]!, element_path: null, color: "Red", color_hex: "#c0392b", use: { kind: "signal_type", signal_key: null, signal_type: "analog_video", signal: null } } }] },
  ] };
  vi.stubGlobal("fetch", vi.fn(async (url: string) => new Response(JSON.stringify(url.includes("stock-revisions/stock-r1/conventions") ? applicable : {}))));
  render(wrap(<StockConventions revisionId="stock-r1" />));
  expect(await screen.findByText(/Six-coax AV convention · revision 1 · pinned to this revision/)).toBeTruthy();
  expect(screen.getByText("Return of Red video")).toBeTruthy();
  expect(screen.getByText(/Older habit · revision 3 · pinned to another revision/)).toBeTruthy();
  expect(screen.getByText(/mappings are not shown here/)).toBeTruthy();
  expect(screen.getByText("Any analog video signal · preferred")).toBeTruthy();
  expect(screen.getAllByText(/never makes a check pass/).length).toBeGreaterThan(0);
});

test("a stock with no convention says what each conductor carries is unknown", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ stock_revision_id: "s", effect: "preference", effect_note: "Preference only.", conventions: [] }))));
  render(wrap(<StockConventions revisionId="s" />));
  expect(await screen.findByText(/No frozen convention applies/)).toBeTruthy();
  expect(screen.getByText("Use unknown")).toBeTruthy();
});
