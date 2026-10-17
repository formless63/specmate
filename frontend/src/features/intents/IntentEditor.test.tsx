import { useState } from "react";
import { MantineProvider } from "@mantine/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { PermissionsProvider } from "../../lib/permissions";
import { IntentEditor, IntentInspector } from "./IntentEditor";
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

test("answer a question on its pin callout preserves intent rows and must-not-connect declarations", async () => {
  serve([]); const onValue = vi.fn();
  function Editable() { const [value, setValue] = useState(emptyIntent()); return <IntentEditor value={value} definitions={[]} onChange={next => { setValue(next); onValue(next); }} />; }
  render(wrap(<Editable />)); const callout = await chooseEnds();
  expect(screen.getByRole('button', { name: 'Line Red video' })).toBeTruthy();
  expect(screen.getByRole('button', { name: 'From pin must not connect' })).toBeTruthy();
  expect(screen.getByText('R 470 Ω')).toBeTruthy();
  const table = screen.getByRole('table', { name: 'Intent rows', hidden: true });
  expect(within(table).getByText('Video ground is declared on 2 contacts.')).toBeTruthy();
  fireEvent.click(within(callout).getByRole('button', { name: 'All 2' }));
  await waitFor(() => expect(screen.getByText('none open')).toBeTruthy());
  expect(onValue.mock.lastCall![0].rows.find((row: IntentRow) => row.row_id === 'from-3')).toMatchObject({ to_contact_ids: ['5', '17'], question: null, pairing: 'answered' });
  expect(onValue.mock.lastCall![0].rows.find((row: IntentRow) => row.row_id === 'from-8')).toMatchObject({ requirement: 'must_not_connect', basis: 'Supply stays inside' });
});

test("selecting a line opens it in the inspector, where its requirement is edited", async () => {
  serve([]);
  function Editable() { const [value, setValue] = useState(emptyIntent()); return <IntentEditor value={value} onChange={setValue} definitions={[]} />; }
  render(wrap(<Editable />));
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

test('a frozen intent withdraws retained face wiring when either exact end read is denied', async () => {
  let denied = false; const onDenied = vi.fn(), cache = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const value = { ...emptyIntent(), from_revision_id: 'from-rev', to_revision_id: 'to-rev', rows: proposed };
  vi.stubGlobal('fetch', vi.fn(async (path: string) => new Response(JSON.stringify(path.includes('from-rev/end') && denied ? { error: { message: 'Exact source withdrawn' } } : path.includes('from-rev/end') ? FROM : path.includes('to-rev/end') ? TO : { revision_id: 'intent-rev', interface: value, intent: { from: { ...FROM, name: 'From', revision_number: 1 }, to: { ...TO, name: 'To', revision_number: 1 }, check: { reason: 'Not evaluated' } } }), { status: path.includes('from-rev/end') && denied ? 403 : 200 })));
  render(<MantineProvider><QueryClientProvider client={cache}><IntentInspector revisionId="intent-rev" onAccessDenied={onDenied} /></QueryClientProvider></MantineProvider>);
  await screen.findByRole('button', { name: 'Line Red video' }); denied = true;
  await act(async () => { await cache.refetchQueries({ queryKey: ['intent-end', 'from-rev'] }); });
  await screen.findByText('Exact source withdrawn'); expect(screen.queryByRole('button', { name: 'Line Red video' })).toBeNull(); expect(onDenied).toHaveBeenCalled();
  denied = false; await act(async () => { await cache.refetchQueries({ queryKey: ['intent-end', 'from-rev'] }); });
  await screen.findByRole('button', { name: 'Line Red video' });
});
test('a held row proposal cannot overwrite a newer authored intent value', async () => {
  let complete: ((response: Response) => void) | null = null;
  vi.stubGlobal('fetch', vi.fn(async (path: string) => path.includes('intents/propose') ? new Promise<Response>(resolve => { complete = resolve; }) : new Response(JSON.stringify(path.includes('from-rev/end') ? FROM : path.includes('to-rev/end') ? TO : {}))));
  function Editable() { const [value, setValue] = useState({ ...emptyIntent(), from_revision_id: 'from-rev', to_revision_id: 'to-rev' }); return <IntentEditor value={value} onChange={setValue} definitions={[]} />; }
  render(wrap(<Editable />)); fireEvent.click(await screen.findByRole('button', { name: 'Propose rows from the two ends' })); await waitFor(() => expect(complete).not.toBeNull());
  fireEvent.change(await screen.findByLabelText('Description'), { target: { value: 'Newer hand-authored purpose' } });
  await act(async () => complete!(new Response(JSON.stringify({ rows: proposed }))));
  expect((screen.getByLabelText('Description') as HTMLInputElement).value).toBe('Newer hand-authored purpose'); expect(screen.queryByRole('button', { name: 'Line Red video' })).toBeNull();
});

test('row isolation keeps legacy strict until explicitly changed and can restore the omitted setting',async()=>{
 serve([]);const changed=vi.fn();
 function Editable(){const[value,setValue]=useState(emptyIntent());return <IntentEditor value={value} definitions={[]} onChange={next=>{setValue(next);changed(next);}} />;}
 render(wrap(<Editable />));await chooseEnds();fireEvent.click(screen.getByRole('button',{name:'Line Red video'}));
 const select=screen.getByLabelText('Isolation of row from-4');expect((select as HTMLInputElement).value).toBe('Strict (legacy)');
 expect(changed.mock.lastCall![0].rows[0].isolation).toBeUndefined();
 fireEvent.click(select);fireEvent.click(screen.getByRole('option',{name:'Unknown',exact:true}));
 expect(changed.mock.lastCall![0].rows[0].isolation).toBe('unknown');
 fireEvent.click(select);fireEvent.click(screen.getByRole('option',{name:'Strict (legacy)',exact:true}));
 expect(changed.mock.lastCall![0].rows[0].isolation).toBeUndefined();
 expect(JSON.stringify(changed.mock.lastCall![0].rows[0])).not.toContain('isolation');
 expect(proposed[0]!.isolation).toBeUndefined();
});

test('frozen row inspection names an unknown isolation policy without offering editing',async()=>{
 serve([]);const value={...emptyIntent(),from_revision_id:'from-rev',to_revision_id:'to-rev',rows:proposed.map(row=>({...row,isolation:'unknown' as const}))};
 render(wrap(<IntentEditor value={value} definitions={[]} />,['workspace.read']));
 fireEvent.click(await screen.findByRole('button',{name:'Line Red video'}));
 const inspector=screen.getByRole('complementary',{name:'Intent inspector'});
 expect(within(inspector).getByText('Row isolation')).toBeTruthy();expect(within(inspector).getByText('Unknown',{exact:true})).toBeTruthy();
 expect(screen.queryByLabelText('Isolation of row from-4')).toBeNull();
});
