import { MantineProvider } from "@mantine/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { PermissionsProvider } from "../../lib/permissions";
import { IntentEditor, NewIntent } from "./IntentPanel";
import { emptyIntent, type IntentRow } from "./api";
import { layoutWiring } from "./wiring-model";
import type { CableEnd, ResolvedSignal } from "../interfaces/api";

beforeEach(() => vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} }));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const EDITOR = ["workspace.read", "item.create", "design.edit", "design.freeze"];
const wrap = (children: React.ReactNode, permissions = EDITOR) => <MantineProvider><QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><PermissionsProvider permissions={permissions}>{children}</PermissionsProvider></QueryClientProvider></MantineProvider>;

const red: ResolvedSignal = { signal_set_revision_id: "set", key: "video_red", name: "Red video", type: "analog_video", set_name: "AV", set_revision_number: 1 };
const ground: ResolvedSignal = { ...red, key: "video_ground", name: "Video ground", type: "ground_return" };
const supply: ResolvedSignal = { ...red, key: "supply", name: "+9 V", type: "power" };
const end = (rows: { contact_id: string; signal: ResolvedSignal; mnc?: boolean }[]): CableEnd => ({ kind: "port", revision_id: "x", device_label: "Device", role: "source", variant_label: "V", standard: null, pinout_revision_id: "p", body_revision_id: "b", selected_conditions: {}, compatibility: "not_evaluated",
  rows: rows.map((r) => ({ contact_id: r.contact_id, signal: r.signal, number: r.contact_id, label: r.contact_id, physical_role: "contact", status: "declared", device: r.mnc ? { must_not_connect: true, must_not_connect_reason: "Supply" } as never : null })) });
const base = { signal_ref: null, return_policy: "unknown" as const, conductor: { kind: "unknown" as const, impedance_ohm: null, basis: null }, required_parts: [], basis: null };
const proposed: IntentRow[] = [
  { ...base, row_id: "from-4", requirement: "required", from_contact_id: "4", to_contact_ids: ["15"], pairing: "same_signal", conductor: { kind: "coax", impedance_ohm: 75, basis: "Declared" }, return_policy: "dedicated_screen", question: null,
    required_parts: [{ conditioning: "series_resistor", value: "470 Ω", where: "anywhere", basis: "Level" }] },
  { ...base, row_id: "from-3", requirement: "required", from_contact_id: "3", to_contact_ids: [], pairing: "declared", question: { kind: "several_destinations", text: "Video ground is declared on 2 contacts.", options: [{ contact_id: "5", label: "5 · Video ground" }, { contact_id: "17", label: "17 · Video ground" }] } },
  { ...base, row_id: "from-8", requirement: "must_not_connect", from_contact_id: "8", to_contact_ids: [], pairing: "unpaired", question: null, basis: "Supply stays inside" },
];
const FROM = end([{ contact_id: "3", signal: ground }, { contact_id: "4", signal: red }, { contact_id: "8", signal: supply, mnc: true }]);
const TO = end([{ contact_id: "5", signal: ground }, { contact_id: "15", signal: red }, { contact_id: "17", signal: ground }]);

function serve(posts: { operation: string; payload: { interface?: { rows: IntentRow[] } } }[]) {
  let state = "draft-v1";
  vi.stubGlobal("fetch", vi.fn(async (url: string, options?: RequestInit) => {
    let data: unknown = {};
    if (options?.method === "POST") {
      const cmd = JSON.parse(String(options.body)); posts.push(cmd);
      if (cmd.operation === "interface.update") state = "draft-v2";
      data = { result: cmd.operation === "interface.freeze" ? { revision_id: "intent-rev" } : { definition_id: "d", draft_id: "x", kind: "cable_intent", state, content: {} } };
    } else if (url.includes("intents/propose")) data = { rows: proposed, open_questions: 1 };
    else if (url.includes("revisions/from-rev/end")) data = FROM;
    else if (url.includes("revisions/to-rev/end")) data = TO;
    return new Response(JSON.stringify(data), { status: 200 });
  }));
}

async function chooseEnds() {
  fireEvent.change(screen.getByLabelText("Intent name"), { target: { value: "Console to monitor" } });
  for (const [label, id] of [["From end", "from-rev"], ["To end", "to-rev"]] as const) {
    fireEvent.click(screen.getByRole("button", { name: `Advanced: paste exact revision ID for ${label}` }));
    fireEvent.change(await screen.findByLabelText(`${label} exact revision ID`), { target: { value: id } });
  }
  fireEvent.click(await screen.findByRole("button", { name: "Propose rows from the two ends" }));
  return screen.findByRole("group", { name: "Question on from 3 · Video ground" });
}

test("the layout draws matched lines, crossed must-not-connect stubs, part markers and non-overlapping callouts", () => {
  const twoQuestions = [...proposed, { ...proposed[1]!, row_id: "from-4b", from_contact_id: "4" }];
  const w = layoutWiring(twoQuestions, FROM, TO);
  expect(w.lines.map((l) => [l.rowId, l.family, l.parts.length])).toEqual([["from-4", "video", 1]]);
  expect(w.stubs).toMatchObject([{ rowId: "from-8", side: "from", kind: "must_not_connect" }]);
  expect(w.open).toBe(2);
  expect(w.mustNotConnect).toBe(1);
  const [first, second] = w.callouts;
  expect(second!.top).toBeGreaterThanOrEqual(first!.top + first!.height);
  expect(first!.options.map((o) => o.y)).toEqual([12, 60]);
});

test("answer a question on its pin callout, save, then freeze: open questions and unsaved answers block freezing", async () => {
  const posts: { operation: string; payload: { interface?: { rows: IntentRow[] } } }[] = [];
  serve(posts);
  const frozen = vi.fn();
  render(wrap(<NewIntent projectId={null} definitions={[]} onFrozen={frozen} />));
  const callout = await chooseEnds();
  expect(screen.getByText("1 open question")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Line Red video" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "From pin must not connect" })).toBeTruthy();
  expect(screen.getByText("R 470 Ω")).toBeTruthy();
  // The fallback table keeps every row, including the question, behind a disclosure.
  const table = screen.getByRole("table", { name: "Intent rows", hidden: true });
  expect(within(table).getByText("Video ground is declared on 2 contacts.")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Save intent draft" }));
  const freeze = await screen.findByRole("button", { name: "Freeze intent" });
  expect((freeze as HTMLButtonElement).disabled).toBe(true);
  expect(screen.getByText(/Answer 1 open question to unlock freezing/)).toBeTruthy();
  fireEvent.click(within(callout).getByRole("button", { name: "All 2" }));
  await waitFor(() => expect(screen.getByText("none open")).toBeTruthy());
  expect(screen.queryByRole("group", { name: /Question on/ })).toBeNull();
  expect(screen.getAllByRole("button", { name: "Line Video ground" })).toHaveLength(2);
  expect((screen.getByRole("button", { name: "Freeze intent" }) as HTMLButtonElement).disabled).toBe(true);
  expect(screen.getByText("Save the answers to unlock freezing.")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
  await waitFor(() => expect(posts.some((p) => p.operation === "interface.update")).toBe(true));
  const saved = posts.find((p) => p.operation === "interface.update")!.payload.interface!.rows.find((r) => r.row_id === "from-3")!;
  expect(saved).toMatchObject({ to_contact_ids: ["5", "17"], question: null, pairing: "answered" });
  await waitFor(() => expect((screen.getByRole("button", { name: "Freeze intent" }) as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(screen.getByRole("button", { name: "Freeze intent" }));
  await waitFor(() => expect(frozen).toHaveBeenCalledWith("intent-rev"));
});

test("selecting a line opens it in the inspector, where its requirement is edited", async () => {
  serve([]);
  render(wrap(<NewIntent projectId={null} definitions={[]} />));
  await chooseEnds();
  fireEvent.click(screen.getByRole("button", { name: "Line Red video" }));
  const inspector = screen.getByRole("complementary", { name: "Intent inspector" });
  expect(within(inspector).getByRole("heading", { name: "Red video" })).toBeTruthy();
  expect(within(inspector).getByText("coax 75 Ω")).toBeTruthy();
  expect(within(inspector).getByText("Series resistor 470 Ω")).toBeTruthy();
  // Selecting a pin lights its rows; the pin of the must-not-connect row names the device's rule.
  fireEvent.click(screen.getByRole("button", { name: "From pin 8, +9 V, must not connect" }));
  expect(within(inspector).getByText("Must not connect: Supply")).toBeTruthy();
});

test("below 900 px the questions move into the inspector; a viewer sees them but cannot answer", async () => {
  const media = window.matchMedia;
  vi.stubGlobal("matchMedia", (query: string) => ({ ...media(query), matches: query === "(max-width: 899px)" || query === "(prefers-reduced-motion: reduce)" }));
  serve([]);
  const change = vi.fn();
  render(wrap(<IntentEditor value={{ ...emptyIntent(), from_revision_id: "from-rev", to_revision_id: "to-rev", rows: proposed }} onChange={change} definitions={[]} />, ["workspace.read"]));
  expect(await screen.findByRole("button", { name: "Open question on from 3 · Video ground" })).toBeTruthy();
  const inspector = screen.getByRole("complementary", { name: "Intent inspector" });
  const card = within(inspector).getByRole("group", { name: "Question on from 3 · Video ground" });
  const answer = within(card).getByRole("button", { name: "17 · Video ground" }) as HTMLButtonElement;
  expect(answer.disabled).toBe(true);
  expect(answer.title).toMatch(/Read-only access/);
  fireEvent.click(answer);
  expect(change).not.toHaveBeenCalled();
});
