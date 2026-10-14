import { MantineProvider } from "@mantine/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { AssessmentEditor, AssessmentResults } from "./InterfaceAssessmentPanel";
import { ContactPositionEditor, ElectricalConditionsEditor } from "./InterfaceConditions";
import { InterfaceInspector } from "./InterfacePanel";
import { unknownElectrical, type ContactView, type Electrical } from "./api";
import { initialAssessment, operating, type Assessment, type Result } from "./assessment-api";

beforeEach(() => { vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} }); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
function wrap(children: React.ReactNode) {
  const cache = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <MantineProvider><QueryClientProvider client={cache}>{children}</QueryClientProvider></MantineProvider>;
}
async function select(label: string, item: string) {
  const input = screen.getByRole("combobox", { name: label });
  fireEvent.focus(input); fireEvent.keyDown(input, { key: "ArrowDown" });
  fireEvent.click(await within(screen.getByRole("listbox", { name: label, hidden: true })).findByText(item));
}

test("structured conditional rating editing retains signed decimal Celsius, explicit limits and evidence pins", async () => {
  let value: Electrical = unknownElectrical();
  function Harness() { const [state, setState] = useState(value); return <ElectricalConditionsEditor value={state} onChange={patch => { value = { ...value, ...patch }; setState(value); }} />; }
  render(wrap(<Harness />));
  await select("Declared polarity", "negative");
  fireEvent.change(screen.getByLabelText("Polarity declaration basis"), { target: { value: "Explicit synthetic negative contact" } });
  fireEvent.change(screen.getByLabelText("New conditional rating ID"), { target: { value: "cold" } });
  fireEvent.click(screen.getByText("Add conditional rating"));
  fireEvent.change(screen.getByLabelText("cold maximum A (blank = unknown)"), { target: { value: "0.25" } });
  const low = screen.getByLabelText("cold scope temperature minimum C (blank = unknown)");
  fireEvent.change(low, { target: { value: "-" } }); expect((low as HTMLInputElement).value).toBe("-");
  fireEvent.change(low, { target: { value: "-20." } }); expect((low as HTMLInputElement).value).toBe("-20.");
  fireEvent.change(low, { target: { value: "-20.5" } });
  fireEvent.change(screen.getByLabelText("cold scope temperature maximum C (blank = unknown)"), { target: { value: "10.75" } });
  fireEvent.change(screen.getByLabelText("cold scope mode (blank = unconstrained)"), { target: { value: "steady" } });
  fireEvent.change(screen.getByLabelText("cold rating basis"), { target: { value: "Synthetic scope declaration" } });
  await select("cold rating evidence", "Exact registered file");
  fireEvent.change(screen.getByLabelText("cold rating evidence bundle revision"), { target: { value: "source-exact-revision" } });
  fireEvent.change(screen.getByLabelText("cold rating evidence file path"), { target: { value: "limits.txt" } });
  expect(value).toMatchObject({ polarity: "negative", polarity_basis: "Explicit synthetic negative contact", conditional_ratings: [{ local_id: "cold", dimension: "current", minimum: null, maximum: 0.25, scope: { temperature: { minimum_c: -20.5, maximum_c: 10.75 }, mode: "steady" }, evidence: { status: "registered_file", source_bundle_revision_id: "source-exact-revision", source_path: "limits.txt" } }] });
});

test("contact coordinate halves remain unknown until both are deliberately entered", () => {
  let value: [number, number] | null = null;
  function Harness() { const [state, setState] = useState(value); return <ContactPositionEditor contactId="physical-left" value={state} onChange={next => { value = next; setState(next); }} />; }
  render(wrap(<Harness />));
  fireEvent.change(screen.getByLabelText("Contact physical-left x mm (blank = unknown)"), { target: { value: "-2.5" } });
  expect(value).toBeNull();
  fireEvent.change(screen.getByLabelText("Contact physical-left y mm (blank = unknown)"), { target: { value: "1.25" } });
  expect(value).toEqual([-2.5, 1.25]);
  fireEvent.change(screen.getByLabelText("Contact physical-left y mm (blank = unknown)"), { target: { value: "" } });
  expect(value).toBeNull();
  expect((screen.getByLabelText("Contact physical-left x mm (blank = unknown)") as HTMLInputElement).value).toBe("-2.5");
});

function view(side: "mating" | "termination"): ContactView {
  const orientation = { viewing_side: side, rotation_degrees: 0, datum: "origin-key" };
  return { source_orientation: { ...orientation, viewing_side: "termination" }, selected_orientation: orientation, mirrored: side === "mating", convention: "declared", limitations: ["Display coordinates do not change identity or correspondence."], contacts: [
    { contact_id: "stable-left", number: "1", label: "same", physical_role: "contact", source_position_mm: [-2, 1], display_position_mm: side === "mating" ? [2, 1] : [-2, 1], reason: null },
    { contact_id: "stable-right", number: "1", label: "same", physical_role: "contact", source_position_mm: [3, -1], display_position_mm: side === "mating" ? [-3, -1] : [3, -1], reason: null },
    { contact_id: "unlocated", number: null, label: "", physical_role: "contact", source_position_mm: null, display_position_mm: null, reason: "Contact coordinates are unknown." },
  ] };
}
test("switching frozen drawing sides uses server coordinates and stable IDs, denied refresh clears retained drawing", async () => {
  let denied = false;
  vi.stubGlobal("fetch", vi.fn(async () => denied ? new Response(JSON.stringify({ error: { message: "Current source unavailable." } }), { status: 404 }) : new Response(JSON.stringify({ revision_id: "pin-exact", compatibility: "not_evaluated", interface: { kind: "pinout", body_revision_id: "body-exact", review: "unreviewed", orientation: view("mating").selected_orientation }, contacts: [], contact_view: view("mating"), contact_views: { mating: view("mating"), termination: view("termination") } }), { status: 200 })));
  render(wrap(<InterfaceInspector revisionId="pin-exact" />));
  const image = await screen.findByRole("img", { name: "Declared contact positions with stable identity" });
  expect(Number(image.querySelectorAll("circle")[0]!.getAttribute("cx"))).toBeCloseTo(2 / 3);
  expect(image.textContent).toContain("stable-left · 1");
  await select("Contact drawing viewing side", "termination");
  expect(Number(image.querySelectorAll("circle")[0]!.getAttribute("cx"))).toBeCloseTo(-2 / 3);
  expect(image.textContent).toContain("stable-left · 1");
  expect(image.textContent).toContain("stable-right · 1");
  expect(screen.getByText("Contact coordinates are unknown.")).toBeTruthy();
  denied = true;
  fireEvent.click(screen.getByText("Refresh interface authority"));
  expect(await screen.findByText("Current source unavailable.")).toBeTruthy();
  await waitFor(() => expect(screen.queryByRole("img")).toBeNull());
  expect(screen.queryByText("stable-left")).toBeNull();
});

test("assessment operating conditions preserve negative decimals as explicit assumptions", () => {
  let value: Assessment = { ...initialAssessment(), pairs: [{ local_id: "row", left_contact_id: "left", right_contact_id: "right", expected_signal: null, basis: "Synthetic", evidence: { status: "unknown" }, operating: operating() }] };
  function Harness() { const [state, setState] = useState(value); return <AssessmentEditor value={state} onChange={next => { value = next; setState(next); }} />; }
  render(wrap(<Harness />));
  fireEvent.change(screen.getByLabelText("row operating temperature minimum C (blank = unknown)"), { target: { value: "-5.25" } });
  fireEvent.change(screen.getByLabelText("row operating temperature maximum C (blank = unknown)"), { target: { value: "30.5" } });
  fireEvent.change(screen.getByLabelText("row operating mode (blank = unknown)"), { target: { value: "steady" } });
  expect(value.pairs[0]!.operating).toMatchObject({ temperature: { minimum_c: -5.25, maximum_c: 30.5 }, mode: "steady", demand_a: null });
});

test("results expose independent unknown polarity and out-of-scope rating without compatible inference", () => {
  const result: Result = { left_pinout_revision_id: "left-exact", right_pinout_revision_id: "right-exact", scope: "exact", physical_qualification: false, limitations: [], findings: [
    { dimension: "polarity", pair_id: "row", status: "unknown", basis: "comparison_of_declarations", explanation: "Retained polarity is unknown.", evidence: [], facts: {} },
    { dimension: "current", pair_id: "row", status: "unknown", basis: "comparison_of_declarations", explanation: "No scoped rating available.", evidence: [{ status: "registered_file", source_bundle_revision_id: "source-exact", source_path: "rating.txt", sha256: "abc", rights: "synthetic-original" }], facts: { rating_scope: { left: { effective_limits: null, conditional_ratings: [{ status: "out_of_scope", explanation: "Temperature outside declared envelope.", rating: { local_id: "cold", dimension: "current", minimum: null, maximum: 0.25, scope: { temperature: { minimum_c: -20, maximum_c: 0 }, mode: "steady" }, basis: "Exact declared synthetic rating", evidence: { status: "unknown" } } }] } } } },
  ] };
  render(wrap(<AssessmentResults result={result} />));
  expect(screen.getByText("Retained polarity is unknown.")).toBeTruthy();
  expect(screen.getByText("left conditional cold (current): out of scope")).toBeTruthy();
  expect(screen.getByText("left effective declared limits: unknown")).toBeTruthy();
  expect(screen.getByText(/source-exact \/ rating.txt.*rights synthetic-original/)).toBeTruthy();
  expect(screen.queryByText(/^Compatible$/)).toBeNull();
});
