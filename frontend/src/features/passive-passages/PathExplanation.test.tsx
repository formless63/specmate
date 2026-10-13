import { MantineProvider } from "@mantine/core";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import { PathExplanation } from "./PathExplanation";
import type { Graph, Interpretation } from "./api";
afterEach(cleanup);
const origin = { occurrence_path: ["board"], revision_id: "board-rev", snapshot_sha256: "board-hash", native_net_name: "same-net-label", native_net_id: "board-net-17", interpretation: { interpretation_id: "native-report", source_revision_id: "board-source-rev", sha256: "native-report-hash" } };
const graph: Graph = { root_revision_id: "assembly-rev", snapshot_id: "assembly-snapshot", snapshot_sha256: "assembly-hash", occurrence_path: [], nodes: [
  { id: "harness-terminal", occurrence_path: ["lead"], revision_id: "harness-rev", label: "same-label", terminal: { endpoint_id: "output", contact_id: "b" }, feature_kind: "endpoint", provenance: { occurrence_path: ["lead"], revision_id: "harness-rev", snapshot_sha256: "harness-hash", stock_revision_id: "stock-rev", section_id: "leg" } },
  { id: "board-terminal", occurrence_path: ["board"], revision_id: "board-rev", label: "same-label", terminal: { component_id: "ic-uuid", pad_id: "pad-uuid" }, feature_kind: "pcb_pad", provenance: origin },
], edges: [], components: [], selected_component_id: null, boundaries: [], continuity: "not_evaluated", compatibility: "not_evaluated", physical_qualification: "not_evaluated", limitations: [] };
const result: Interpretation = { revision_id: "model-rev", sha256: "model-hash", review_id: "model-review", review_state: "passage-review-v1", root_revision_id: "assembly-rev", root_snapshot_sha256: "assembly-hash", query: "dc_continuity", status: "unknown", reason: "missing_parameters_or_unsupported_behavior", physical_continuity: "not_evaluated", signal_transfer: "not_evaluated", physical_qualification: "not_evaluated", assumptions: { component_model: "ideal_lumped_components", model_basis: "Original synthetic declared bridge", copper: "unspecified", frequency_hz: null, condition_assignments: [], conditional_contacts: "ideal_zero_resistance_when_assigned_state_matches" }, paths: [{ terminal_ids: ["harness-terminal", "board-terminal"], status: "unknown", reasons: ["unsupported_active_behavior"], series_resistance_ohm: null, shortness: "unknown", series_impedance_ohm: null, steps: [{ record_id: "native-net-edge", kind: "native_net", from_terminal_id: "harness-terminal", to_terminal_id: "board-terminal", status: "unknown", basis: "Reported membership only", evidence: "reported_net_membership", provenance: origin, direction: "forward" }, { record_id: "passage:active-1", kind: "active", from_terminal_id: "board-terminal", to_terminal_id: "harness-terminal", status: "unknown", basis: "Active transfer unsupported", evidence: { status: "registered_file", source_bundle_revision_id: "datasheet-rev", source_path: "facts.txt", sha256: "facts-hash", rights: "CC0-1.0" } }] }], unmodeled_boundaries: [{ id: "active-boundary", kind: "active", members: ["board-terminal"], status: "unknown", reason: "Unmodeled active behavior", provenance: origin }] };
const view = (value = result, root = graph) => <MantineProvider><PathExplanation result={value} graph={root} /></MantineProvider>;
test("exact endpoints, native pins and unsupported declaration remain distinct despite repeated labels", () => {
  render(view());
  expect(screen.getByText("Step record identity: native-net-edge")).toBeTruthy();
  expect(screen.getByText("Step record identity: passage:active-1")).toBeTruthy();
  expect(screen.getByText(/From: lead · same-label/)).toBeTruthy();
  expect(screen.getByText(/From: board · same-label/)).toBeTruthy();
  expect(screen.getAllByText(/endpoint_id=output · contact_id=b/)).toHaveLength(2);
  expect(screen.getAllByText(/component_id=ic-uuid · pad_id=pad-uuid/)).toHaveLength(2);
  expect(screen.getAllByText("Native net identity: board-net-17").length).toBeGreaterThan(0);
  expect(screen.getAllByText(/Interpretation: native-report · Source revision: board-source-rev/).length).toBeGreaterThan(0);
  expect(screen.getByText(/Source bundle revision: datasheet-rev · Path: facts.txt/)).toBeTruthy();
  expect(screen.getByText(/Source SHA-256: facts-hash · Rights: CC0-1.0/)).toBeTruthy();
  expect(screen.getByText(/Declaration scope: model model-rev/)).toBeTruthy();
  expect(screen.getByText("unsupported active behavior")).toBeTruthy();
  expect(screen.getByText(/Copper assumption: unspecified/)).toBeTruthy();
  expect(screen.getByText("Boundary identity: active-boundary")).toBeTruthy();
  expect(screen.getByText(/No candidate path does not prove physical disconnection/)).toBeTruthy();
});
for (const change of [{ root_revision_id: "other-root" }, { snapshot_sha256: "other-hash" }]) {
  test(`metadata is not borrowed when graph ${Object.keys(change)[0]} differs`, () => {
    render(view(result, { ...graph, ...change }));
    expect(screen.getByText(/inspected graph does not match/)).toBeTruthy();
    expect(screen.queryByText(/same-label/)).toBeNull();
    expect(screen.queryByText(/contact_id=b/)).toBeNull();
    expect(screen.getAllByText("Terminal identity: harness-terminal").length).toBeGreaterThan(0);
    expect(screen.getByText("Step record identity: native-net-edge")).toBeTruthy();
    expect(screen.getAllByText("Native net identity: board-net-17").length).toBeGreaterThan(0);
  });
}
test("approximate signal semantics and search bounds remain explicit", () => {
  render(view({ ...result, limited: true, query: "signal", assumptions: { ...result.assumptions!, copper: "ideal_zero_resistance", frequency_hz: "1000" }, paths: [{ ...result.paths[0]!, status: "modeled_path", reasons: [], series_impedance_ohm: { real: "0", imaginary: "-2.2", precision: "derived_approximation" }, shortness: "not_evaluated", steps: [{ ...result.paths[0]!.steps[1]!, kind: "capacitor", status: "ideal_capacitive_impedance_approximation", capacitance_f: "0.001" }] }] }));
  expect(screen.getByText(/Derived model approximation, not a measurement/)).toBeTruthy();
  expect(screen.getByText("Ideal shortness: not evaluated")).toBeTruthy();
  expect(screen.getByText(/Search limit reached/)).toBeTruthy();
});

test("steps and boundaries are paginated and selecting another path resets step pagination", () => {
  const steps = Array.from({ length: 21 }, (_, index) => ({ ...result.paths[0]!.steps[0]!, record_id: `edge-${index}` }));
  const boundaries = Array.from({ length: 21 }, (_, index) => ({ ...result.unmodeled_boundaries![0]!, id: `boundary-${index}` }));
  render(view({ ...result, paths: [{ ...result.paths[0]!, steps }, result.paths[0]!], unmodeled_boundaries: boundaries }));
  expect(screen.queryByText("Step record identity: edge-20")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Next path steps" }));
  expect(screen.getByText("Step record identity: edge-20")).toBeTruthy();
  expect(screen.queryByText("Step record identity: edge-0")).toBeNull();
  fireEvent.change(screen.getByLabelText("Candidate path to explain"), { target: { value: "1" } });
  expect(screen.getByText("Step record identity: passage:active-1")).toBeTruthy();
  expect(screen.queryByText("Boundary identity: boundary-20")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Next source boundaries" }));
  expect(screen.getByText("Boundary identity: boundary-20")).toBeTruthy();
});

for (const states of [["closed"], ["closed", "open"]]) {
  test(`backend-shaped grouped conditional requirements render ${states.length} exclusive states`, () => {
    const conflicting = states.length > 1;
    const contact = { condition_id: "switch-1", state: "closed", behavior: "ideal_contact" as const };
    render(view({ ...result, query: "dc_continuity", status: "unknown", reason: "missing_parameters_or_unsupported_behavior", paths: [{
      ...result.paths[0]!, status: "unknown", reasons: [conflicting ? "mutually_exclusive_condition_states" : "condition_assignment_required"],
      condition_requirements: [{ condition_id: "switch-1", states }], conflicting_condition_ids: conflicting ? ["switch-1"] : [],
      steps: states.map((state) => ({ ...result.paths[0]!.steps[1]!, record_id: `passage:contact-${state}`, kind: "conditional", status: conflicting ? "incompatible_condition_requirements" : "unknown", condition_requirement: { ...contact, state }, assigned_state: null })),
    }] }));
    expect(screen.getByText(`Path requires switch-1: ${states.join(", ")} · ${conflicting ? "multiple exclusive states; incompatible requirements" : "required declared state"}`)).toBeTruthy();
    expect(screen.getByText(/Requires switch-1 = closed; query state unspecified/)).toBeTruthy();
    if (conflicting) {
      expect(screen.getByText(/Mutually exclusive requirements conflict: switch-1/)).toBeTruthy();
      expect(screen.getByText("mutually exclusive condition states")).toBeTruthy();
      expect(screen.getByText(/Requires switch-1 = open; query state unspecified/)).toBeTruthy();
    } else {
      expect(screen.queryByText(/Mutually exclusive requirements conflict/)).toBeNull();
      expect(screen.getByText("condition assignment required")).toBeTruthy();
    }
  });
}
