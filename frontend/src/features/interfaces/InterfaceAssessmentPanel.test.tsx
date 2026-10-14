import { grants } from "../../test/grants";
import { PermissionsProvider } from "../../lib/permissions";
import { MantineProvider } from "@mantine/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { AssessmentResults, InterfaceAssessmentPanel } from "./InterfaceAssessmentPanel";
import { initialAssessment, operating, type AssessmentDraft, type Result } from "./assessment-api";

beforeEach(() => { vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} }); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const result: Result = {
  left_pinout_revision_id: "left-exact", right_pinout_revision_id: "right-exact", scope: "exact_pinout_pair_and_explicit_contact_rows", physical_qualification: false,
  findings: [
    { dimension: "mating", pair_id: null, status: "satisfied", basis: "declaration", explanation: "Declared mating pair with explicit basis", evidence: [{ status: "registered_file", source_path: "mating.txt", source_bundle_revision_id: "original-evidence", sha256: "a".repeat(64), rights: "AGPL-3.0-only" }], facts: {} },
    { dimension: "pin_correspondence", pair_id: "signal", status: "invalid", basis: "comparison_of_declarations", explanation: "Contact missing from exact right body", evidence: [], facts: { pair: { left_contact_id: "data", right_contact_id: "missing", expected_signal: "bus", basis: "original proposed map", operating: operating() }, left: { signal: "bus" }, right: null } },
    ...(["levels", "current", "protocol", "shielding", "grounding", "fit"] as const).map(dimension => ({ dimension, pair_id: null, status: "unknown" as const, basis: "comparison_of_declarations" as const, explanation: `${dimension} input is unknown`, evidence: [], facts: {} })),
  ], limitations: ["No overall compatibility or physical qualification is established."],
};
function wrap(node: React.ReactNode, client = new QueryClient({ defaultOptions: { queries: { retry: false } } })) {
  return <MantineProvider env="test"><QueryClientProvider client={client}>{node}</QueryClientProvider></MantineProvider>;
}
function panel(principal = "owner", edit = true) { return <PermissionsProvider permissions={grants({ edit: edit, freeze: edit })}><InterfaceAssessmentPanel projectId="project" principalKey={principal} /></PermissionsProvider>; }
async function choose(label: string, option: string) {
  fireEvent.click(await screen.findByRole("combobox", { name: label }));
  fireEvent.click(await screen.findByRole("option", { name: option }));
}
function original(): AssessmentDraft {
  const value = initialAssessment();
  value.left_pinout_revision_id = "left-exact"; value.right_pinout_revision_id = "right-exact";
  value.mating = { status: "satisfied", basis: "Original declared mating", evidence: { status: "unknown" } };
  value.pairs = [{ local_id: "signal", left_contact_id: "data", right_contact_id: "missing", expected_signal: "bus", basis: "Original proposed pair", evidence: { status: "unknown" }, operating: operating() }];
  return { definition_id: "assessment", draft_id: "draft", state: "draft-v1", content: { interface: value } };
}
function fixture() {
  let draft = original();
  let denied = false;
  let conflict = false;
  let held: Promise<Response> | undefined;
  let lost = false;
  let commandResponse: Promise<Response> | undefined;
  let reorderRead = false;
  const calls: { operation: string; payload: { interface?: ReturnType<typeof initialAssessment> }; expected_state?: string; idempotency_key: string }[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, options?: RequestInit) => {
    if (options?.method === "POST") {
      const request = JSON.parse(String(options.body)); calls.push(request);
      if (commandResponse) return (await commandResponse).clone();
      if (lost) { lost = false; throw new Error("Response unavailable"); }
      if (conflict) return new Response(JSON.stringify({ error: { message: "Draft changed" } }), { status: 409 });
      if (request.operation === "interface.update") draft = { ...draft, state: "draft-v3", content: { interface: request.payload.interface } };
      return new Response(JSON.stringify({ result: request.operation === "interface.freeze" ? { revision_id: "frozen", draft: { ...draft, state: "draft-v4" } } : draft }));
    }
    if (url.includes("interfaces/")) {
      if (held) return (await held).clone();
      if (denied) return new Response(JSON.stringify({ error: { message: "Reference unavailable" } }), { status: 404 });
      const readDraft = reorderRead ? JSON.parse(JSON.stringify(draft, (_key, value) => value && typeof value === "object" && !Array.isArray(value) ? Object.fromEntries(Object.entries(value).reverse()) : value)) : draft;
      return new Response(JSON.stringify(url.includes("drafts/") ? readDraft : { revision_id: "frozen", snapshot_id: "snapshot", sha256: "b".repeat(64), interface: draft.content.interface, assessment: result }));
    }
    if (url.includes("catalog/definitions/")) return new Response(JSON.stringify({ drafts: [{ draft_id: "draft", state: draft.state }], revisions: [{ revision_id: "frozen", number: 1 }] }));
    return new Response(JSON.stringify([{ definition_id: "assessment", name: "Original separated review", kind: "interface_assessment" }]));
  }));
  return { calls, reorderReads: () => { reorderRead = true; }, commandResponse: (value?: Promise<Response>) => { commandResponse = value; }, setDenied: (value: boolean) => { denied = value; }, setConflict: (value: boolean) => { conflict = value; }, setState: (value: string) => { draft = { ...draft, state: value }; }, hold: (value?: Promise<Response>) => { held = value; }, lose: () => { lost = true; } };
}
async function editExisting() {
  await choose("Saved assessment", "Original separated review");
  await choose("Assessment draft", "draft-v1");
  await screen.findByRole("heading", { name: "Edit assessment" });
}

test("eight visible dimensions retain declared mating alongside invalid correspondence and unknown ratings", () => {
  render(wrap(<AssessmentResults result={result} />));
  for (const name of ["Mating", "Pin correspondence", "Levels", "Current", "Protocol", "Shielding", "Grounding", "Fit"]) expect(screen.getByRole("heading", { name })).toBeTruthy();
  const card = (name: string) => within(screen.getByRole("heading", { name }).closest(".mantine-Card-root")! as HTMLElement);
  expect(card("Mating").getByText("Satisfied by declarations")).toBeTruthy();
  expect(card("Pin correspondence").getByText("Invalid / conflicting declaration")).toBeTruthy();
  expect(card("Levels").getByText("Unknown")).toBeTruthy();
  expect(card("Pin correspondence").getByText(/data → missing/)).toBeTruthy();
  expect(screen.getByText(/rights AGPL-3.0-only/)).toBeTruthy();
});

test("prepared fields and original CAS survive refresh and conflict; deliberate basis update and retry retain intent", async () => {
  const f = fixture(); render(wrap(panel())); await editExisting();
  fireEvent.change(screen.getByLabelText("mating basis"), { target: { value: "Prepared original basis" } });
  fireEvent.change(screen.getByLabelText("signal current demand A (blank = unknown)"), { target: { value: "0" } });
  f.setState("draft-v2"); f.setConflict(true);
  fireEvent.click(screen.getByText("Refresh assessment authority"));
  await screen.findByText("Use refreshed draft as editing basis");
  expect((screen.getByLabelText("mating basis") as HTMLInputElement).value).toBe("Prepared original basis");
  fireEvent.click(screen.getByText("Save assessment draft"));
  await screen.findByText("Draft changed");
  expect(f.calls[0]!.expected_state).toBe("draft-v1");
  expect(f.calls[0]!.payload.interface?.pairs[0]!.operating.demand_a).toBe(0);
  expect(f.calls[0]!.payload.interface?.pairs[0]!.operating.voltage_min_v).toBeNull();
  fireEvent.click(screen.getByText("Use refreshed draft as editing basis"));
  f.setConflict(false); f.lose();
  fireEvent.click(screen.getByText("Save assessment draft")); await screen.findByText("Response unavailable");
  fireEvent.click(screen.getByText("Save assessment draft"));
  await screen.findByText("Editing basis draft-v3");
  expect(f.calls[1]!.expected_state).toBe("draft-v2");
  expect(f.calls[1]!.idempotency_key).toBe(f.calls[2]!.idempotency_key);
  expect(f.calls[1]!.idempotency_key).not.toBe(f.calls[0]!.idempotency_key);
  expect(f.calls[2]!.payload.interface?.mating.basis).toBe("Prepared original basis");
});

test.each(["refresh", "focus"])("%s held and denied current reads hide cached findings and prepared editor until exact recovery", async trigger => {
  const f = fixture(); render(wrap(panel())); await editExisting();
  fireEvent.change(screen.getByLabelText("mating basis"), { target: { value: "Recover this prepared basis" } });
  await choose("Frozen assessment revision", "Revision 1");
  await screen.findByText("Declared mating pair with explicit basis");
  let release!: (response: Response) => void;
  f.hold(new Promise<Response>(resolve => { release = resolve; }));
  if (trigger === "focus") fireEvent(window, new Event("focus"));
  else fireEvent.click(screen.getByText("Refresh assessment authority"));
  await waitFor(() => expect(screen.queryByText("Declared mating pair with explicit basis")).toBeNull());
  expect(screen.queryByRole("button", { name: "Save assessment draft" })).toBeNull();
  f.setDenied(true); f.hold();
  release(new Response(JSON.stringify({ error: { message: "Reference unavailable" } }), { status: 404 }));
  await screen.findAllByText("Reference unavailable");
  expect(screen.queryByRole("heading", { name: "Edit assessment" })).toBeNull();
  f.setDenied(false); fireEvent.click(screen.getByText("Refresh assessment authority"));
  await screen.findByText("Declared mating pair with explicit basis");
  expect((screen.getByLabelText("mating basis") as HTMLInputElement).value).toBe("Recover this prepared basis");
  expect(f.calls).toHaveLength(0);
});

test("principal changes discard prepared edits and writer controls", async () => {
  fixture(); const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = render(wrap(panel(), client)); await editExisting();
  fireEvent.change(screen.getByLabelText("mating basis"), { target: { value: "Private prepared sentinel" } });
  view.rerender(wrap(panel("viewer", false), client));
  await waitFor(() => expect(screen.queryByRole("button", { name: "New assessment" })).toBeNull());
  expect(screen.queryByDisplayValue("Private prepared sentinel")).toBeNull();
  await choose("Saved assessment", "Original separated review");
  expect(screen.queryByRole("combobox", { name: "Assessment draft" })).toBeNull();
  await choose("Frozen assessment revision", "Revision 1");
  await screen.findByText("Declared mating pair with explicit basis");
  expect(screen.queryByRole("button", { name: "Save assessment draft" })).toBeNull();
});

test("deliberate freezing uses the saved token and exposes exact immutable assessment pins", async () => {
  const f = fixture(); render(wrap(panel())); await editExisting();
  fireEvent.click(screen.getByRole("button", { name: "Freeze assessment revision" }));
  await screen.findByRole("heading", { name: "Separated assessment results" });
  expect(f.calls).toHaveLength(1);
  expect(f.calls[0]!.operation).toBe("interface.freeze");
  expect(f.calls[0]!.expected_state).toBe("draft-v1");
  expect(screen.getAllByText('frozen', { selector: 'code' }).length).toBeGreaterThan(0);
  expect(screen.getAllByText('snapshot', { selector: 'code' }).length).toBeGreaterThan(0);
  expect(screen.getAllByText('left-exact', { selector: 'code' }).length).toBeGreaterThan(0);
  expect(screen.getAllByText('right-exact', { selector: 'code' }).length).toBeGreaterThan(0);
});


test("ordinary decimal entry keeps its intermediate point and preserves explicit zero", async () => {
  const f = fixture();
  render(wrap(panel()));
  await editExisting();
  const minimum = screen.getByLabelText("signal operating minimum V (blank = unknown)") as HTMLInputElement;
  fireEvent.change(minimum, { target: { value: "1" } });
  fireEvent.change(minimum, { target: { value: "1." } });
  expect(minimum.value).toBe("1.");
  fireEvent.change(minimum, { target: { value: "1.25" } });
  fireEvent.change(screen.getByLabelText("signal operating maximum V (blank = unknown)"), { target: { value: "1.5" } });
  fireEvent.change(screen.getByLabelText("signal current demand A (blank = unknown)"), { target: { value: "0" } });
  fireEvent.change(screen.getByLabelText("signal operating basis"), { target: { value: "Explicit decimal envelope and zero demand" } });
  fireEvent.click(screen.getByRole("button", { name: "Save assessment draft" }));
  await waitFor(() => expect(f.calls.length).toBe(1));
  expect(f.calls[0]?.payload.interface?.pairs[0]?.operating).toMatchObject({ voltage_min_v: 1.25, voltage_max_v: 1.5, demand_a: 0 });
});


test("replacing a voltage with a negative value keeps the intermediate minus sign", async () => {
  const f = fixture();
  render(wrap(panel()));
  await editExisting();
  const minimum = screen.getByLabelText("signal operating minimum V (blank = unknown)") as HTMLInputElement;
  fireEvent.change(minimum, { target: { value: "1.25" } });
  fireEvent.change(minimum, { target: { value: "-" } });
  expect(minimum.value).toBe("-");
  fireEvent.change(minimum, { target: { value: "-1.25" } });
  fireEvent.change(screen.getByLabelText("signal operating maximum V (blank = unknown)"), { target: { value: "-1" } });
  fireEvent.change(screen.getByLabelText("signal operating basis"), { target: { value: "Explicit negative voltage envelope" } });
  fireEvent.click(screen.getByRole("button", { name: "Save assessment draft" }));
  await waitFor(() => expect(f.calls.length).toBe(1));
  expect(f.calls[0]?.payload.interface?.pairs[0]?.operating).toMatchObject({ voltage_min_v: -1.25, voltage_max_v: -1, demand_a: null });
});


test("inactive tab return checks authority before restoring prepared edits and original CAS", async () => {
  const f = fixture(); const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const node = (active: boolean) => wrap(<PermissionsProvider permissions={grants({ edit: true, freeze: true })}><InterfaceAssessmentPanel projectId="project" principalKey="owner" active={active} /></PermissionsProvider>, client);
  const view = render(node(true)); await editExisting();
  fireEvent.change(screen.getByLabelText("mating basis"), { target: { value: "Prepared across inactive tab" } });
  await choose("Frozen assessment revision", "Revision 1");
  await screen.findByText("Declared mating pair with explicit basis");
  f.lose(); fireEvent.click(screen.getByRole("button", { name: "Save assessment draft" }));
  await screen.findByText("Response unavailable");
  await waitFor(() => expect((screen.getByRole("button", { name: "Save assessment draft" }) as HTMLButtonElement).disabled).toBe(false));
  view.rerender(node(false));
  expect(screen.queryByText("Declared mating pair with explicit basis")).toBeNull();
  expect(screen.queryByRole("heading", { name: "Edit assessment" })).toBeNull();
  f.setDenied(true); view.rerender(node(true));
  await screen.findAllByText("Reference unavailable");
  expect(screen.queryByText("Declared mating pair with explicit basis")).toBeNull();
  f.setDenied(false); f.setState("draft-v2");
  fireEvent.click(screen.getByText("Refresh assessment authority"));
  await screen.findByText("Declared mating pair with explicit basis");
  expect((screen.getByLabelText("mating basis") as HTMLInputElement).value).toBe("Prepared across inactive tab");
  expect(screen.getByText("Editing basis draft-v1")).toBeTruthy();
  fireEvent.click(screen.getByText("Save assessment draft"));
  await waitFor(() => expect(f.calls).toHaveLength(2));
  expect(f.calls[0]!.expected_state).toBe("draft-v1");
  expect(f.calls[1]!.idempotency_key).toBe(f.calls[0]!.idempotency_key);
});

test.each(["Save assessment draft", "Freeze assessment revision"])("%s fences protected content during pending authority and denial, retaining retry identity", async action => {
  const f = fixture(); render(wrap(panel())); await editExisting();
  if (action.startsWith("Save")) fireEvent.change(screen.getByLabelText("mating basis"), { target: { value: "Recover denied prepared basis" } });
  await choose("Frozen assessment revision", "Revision 1");
  await screen.findByText("Declared mating pair with explicit basis");
  let release!: (value: Response) => void;
  f.commandResponse(new Promise(resolve => { release = resolve; }));
  fireEvent.click(screen.getByRole("button", { name: action }));
  await waitFor(() => expect(f.calls).toHaveLength(1));
  expect(screen.queryByText("Declared mating pair with explicit basis")).toBeNull();
  expect(screen.queryByRole("heading", { name: "Edit assessment" })).toBeNull();
  f.setDenied(true);
  release(new Response(JSON.stringify({ error: { message: "Reference unavailable" } }), { status: 404 }));
  await screen.findAllByText("Reference unavailable");
  expect(screen.queryByText("Declared mating pair with explicit basis")).toBeNull();
  expect(screen.queryByRole("heading", { name: "Edit assessment" })).toBeNull();
  await waitFor(() => expect((screen.getByRole("button", { name: "Refresh assessment authority" }) as HTMLButtonElement).disabled).toBe(false));
  f.setDenied(false); f.commandResponse();
  fireEvent.click(screen.getByText("Refresh assessment authority"));
  await screen.findByText("Declared mating pair with explicit basis");
  expect(screen.getByText("Editing basis draft-v1")).toBeTruthy();
  if (action.startsWith("Save")) expect((screen.getByLabelText("mating basis") as HTMLInputElement).value).toBe("Recover denied prepared basis");
  fireEvent.click(screen.getByRole("button", { name: action }));
  await waitFor(() => expect(f.calls).toHaveLength(2));
  expect(f.calls[1]).toMatchObject({ operation: f.calls[0]!.operation, payload: f.calls[0]!.payload,
    expected_state: f.calls[0]!.expected_state, idempotency_key: f.calls[0]!.idempotency_key });
});


test("fresh nested JSON key order after saving does not prevent freeze, while changed operating values do", async () => {
  const f = fixture(); render(wrap(panel())); await editExisting();
  fireEvent.change(screen.getByLabelText("mating basis"), { target: { value: "Saved declared mating basis" } });
  f.reorderReads();
  fireEvent.click(screen.getByRole("button", { name: "Save assessment draft" }));
  await screen.findByText("Editing basis draft-v3");
  const freeze = () => screen.getByRole("button", { name: "Freeze assessment revision" }) as HTMLButtonElement;
  await waitFor(() => expect(freeze().disabled).toBe(false));
  const minimum = screen.getByLabelText("signal operating minimum V (blank = unknown)");
  fireEvent.change(minimum, { target: { value: "2.25" } });
  expect(freeze().disabled).toBe(true);
  expect(screen.getByText("Save prepared changes before freezing.")).toBeTruthy();
  fireEvent.change(minimum, { target: { value: "" } });
  expect(freeze().disabled).toBe(false);
  fireEvent.click(freeze());
  await screen.findByRole("heading", { name: "Separated assessment results" });
  expect(f.calls.at(-1)).toMatchObject({ operation: "interface.freeze", expected_state: "draft-v3" });
});

test("a frozen result is recorded only by an explicit contributor action", async () => {
  const f = fixture();
  render(wrap(<PermissionsProvider permissions={["workspace.read"]}><InterfaceAssessmentPanel projectId="project" principalKey="viewer" /></PermissionsProvider>));
  await choose("Saved assessment", "Original separated review");
  await choose("Frozen assessment revision", "Revision 1");
  await screen.findByText("Declared mating pair with explicit basis");
  const readOnly = screen.getByRole("button", { name: "Record result as evidence" }) as HTMLButtonElement;
  expect(readOnly.disabled).toBe(true);
  expect(readOnly.title).toMatch(/Contributor access/);
  expect(f.calls.some(call => call.operation.startsWith("evidence."))).toBe(false);
  cleanup();
  const g = fixture();
  render(wrap(<PermissionsProvider permissions={["workspace.read", "item.create"]}><InterfaceAssessmentPanel projectId="project" principalKey="contributor" /></PermissionsProvider>));
  await choose("Saved assessment", "Original separated review");
  await choose("Frozen assessment revision", "Revision 1");
  await screen.findByText("Declared mating pair with explicit basis");
  expect(g.calls.length).toBe(0);
  fireEvent.click(screen.getByRole("button", { name: "Record result as evidence" }));
  await waitFor(() => expect(g.calls.length).toBe(1));
  expect(g.calls[0]).toMatchObject({ operation: "evidence.record_interface_assessment", payload: { revision_id: "frozen" } });
  expect(g.calls[0]!.idempotency_key).toBeTruthy();
});
