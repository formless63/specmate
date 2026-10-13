import { MantineProvider } from "@mantine/core";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { PassivePassagesWorkspace } from "./PassivePassagesWorkspace";
import type { Draft, Graph, Inspection, Interpretation, Model } from "./api";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const a = `terminal-${"a".repeat(64)}`;
const b = `terminal-${"b".repeat(64)}`;
const graph: Graph = { root_revision_id: "root-revision", snapshot_id: "root-snapshot", snapshot_sha256: "a".repeat(64), occurrence_path: [], nodes: [{ id: a, occurrence_path: ["left"], revision_id: "body-revision", terminal: { contact_id: "one" }, label: "pin one", feature_kind: "contact", provenance: { occurrence_path: ["left"], revision_id: "body-revision", snapshot_sha256: "b".repeat(64) } }, { id: b, occurrence_path: ["right"], revision_id: "body-revision", terminal: { contact_id: "two" }, label: "pin two", feature_kind: "contact", provenance: { occurrence_path: ["right"], revision_id: "body-revision", snapshot_sha256: "b".repeat(64) } }], edges: [], boundaries: [{ id: "candidate-boundary", kind: "resistor", members: [a, b], status: "not_evaluated", reason: "Extracted candidate; no reviewed electrical model.", provenance: { occurrence_path: [], revision_id: "root-revision", snapshot_sha256: "a".repeat(64) } }], components: [], selected_component_id: null, continuity: "not_evaluated", compatibility: "not_evaluated", physical_qualification: "not_evaluated", limitations: [] };
const model: Model = { root_revision_id: "root-revision", assumptions: "ideal_lumped_components", model_basis: "Synthetic ideal circuit only", passages: [{ local_id: "r1", kind: "resistor", from_terminal_id: a, to_terminal_id: b, resistance_ohm: "330", capacitance_f: null, condition: null, native_candidate_boundary_id: "candidate-boundary", basis: "Independent explicit declaration", evidence: { status: "unknown" } }] };
const draft: Draft = { definition_id: "model-definition", draft_id: "model-draft", state: "draft-v1", content: { passages: model } };
const inspection: Inspection = { revision_id: "model-revision", sha256: "c".repeat(64), snapshot_id: "model-snapshot", model, graph, state: "passage-review-v0", decision: "unreviewed", reviews: [] };
const unknown: Interpretation = { revision_id: "model-revision", sha256: "c".repeat(64), review_state: "passage-review-v0", query: "dc_continuity", status: "unknown", reason: "current_accepted_model_review_required", paths: [], physical_continuity: "not_evaluated", signal_transfer: "not_evaluated", physical_qualification: "not_evaluated" };
function view(projectId = "project-one", canEdit = true) { return <MantineProvider><PassivePassagesWorkspace projectId={projectId} canEdit={canEdit} canFreeze={canEdit} /></MantineProvider>; }
async function load() {
  fireEvent.change(screen.getByLabelText("Exact frozen passive model revision ID"), { target: { value: "model-revision" } });
  fireEvent.click(screen.getByRole("button", { name: "Inspect frozen passive model" }));
  await screen.findByText("Frozen passive model");
}
function selectQuery() {
  fireEvent.change(screen.getByLabelText("Query from terminal"), { target: { value: a } });
  fireEvent.change(screen.getByLabelText("Query to terminal"), { target: { value: b } });
}

test("native candidate starts unknown and exact electrical decimal is explicitly authored", async () => {
  const calls: unknown[] = [];
  vi.stubGlobal("fetch", vi.fn(async (path: string, init?: RequestInit) => {
    if (path.includes("copper/revisions")) return reply(graph);
    const body = JSON.parse(String(init?.body)); calls.push(body);
    expect(body.operation).toBe("passage.create");
    expect(body.payload.model.passages[0]).toMatchObject({ kind: "resistor", resistance_ohm: "1e-30", from_terminal_id: a, to_terminal_id: b, native_candidate_boundary_id: "candidate-boundary" });
    expect(body.payload.model.assumptions).toBe("ideal_lumped_components");
    return reply({ result: draft });
  }));
  render(view());
  fireEvent.change(screen.getByLabelText("Exact copper root revision ID"), { target: { value: "root-revision" } });
  fireEvent.click(screen.getByRole("button", { name: "Inspect model root" }));
  fireEvent.click(await screen.findByRole("button", { name: "Declare separate passage for resistor candidate" }));
  expect((screen.getByLabelText("Passage 1 kind") as HTMLSelectElement).value).toBe("unknown");
  expect(screen.queryByLabelText(/Passage 1 resistance/)).toBeNull();
  fireEvent.change(screen.getByLabelText("New passive model name"), { target: { value: "Independent ideal resistor model" } });
  fireEvent.click(screen.getByLabelText("I am declaring an ideal lumped component model, separate from physical facts"));
  fireEvent.change(screen.getByLabelText("Ideal model assumptions and basis"), { target: { value: "Ideal circuit assumptions only" } });
  fireEvent.change(screen.getByLabelText("Passage 1 kind"), { target: { value: "resistor" } });
  fireEvent.change(screen.getByLabelText(/Passage 1 resistance/), { target: { value: "1e-30" } });
  fireEvent.change(screen.getByLabelText("Passage 1 declaration basis"), { target: { value: "Explicit independently supplied parameter" } });
  fireEvent.click(screen.getByRole("button", { name: "Save new passive model draft" }));
  await screen.findByText(/Saved draft model-draft/);
  expect(calls).toHaveLength(1);
});

test("queries require current review and send explicit assumptions without an idempotency key", async () => {
  let current = inspection;
  vi.stubGlobal("fetch", vi.fn(async (path: string, init?: RequestInit) => {
    if (path.includes("passive-passages/revisions")) return reply(current);
    const body = JSON.parse(String(init?.body));
    if (body.operation === "passage.review") {
      expect(body.expected_state).toBe("passage-review-v0");
      current = { ...inspection, state: "passage-review-v1", decision: "accepted", reviews: [{ review_id: "review-one", version: 1, decision: "accepted", basis: "Ideal model reviewed", evidence: { status: "unknown" } }] };
      return reply({ result: current });
    }
    expect(body.operation).toBe("passage.interpret");
    expect(body.idempotency_key).toBeUndefined();
    expect(body.payload.copper_assumption).toBe("unspecified");
    return reply({ result: unknown });
  }));
  render(view()); await load(); selectQuery();
  fireEvent.click(screen.getByRole("button", { name: "Interpret reviewed model" }));
  await screen.findByText(/unknown · current accepted model review required/);
  fireEvent.change(screen.getByLabelText("Passive model review decision"), { target: { value: "accepted" } });
  fireEvent.change(screen.getByLabelText("Passive model review basis"), { target: { value: "Ideal model reviewed" } });
  fireEvent.click(screen.getByRole("button", { name: "Append passive model review" }));
  await screen.findByText("Review 1: accepted · Ideal model reviewed");
  expect(screen.queryByText("Declared model query result")).toBeNull();
  expect(screen.getByText(/Model review and path reachability establish no physical continuity/)).toBeTruthy();
});

test("signal frequency remains exact text and empty frequency is not guessed", async () => {
  const payloads: { frequency_hz?: string }[] = [];
  vi.stubGlobal("fetch", vi.fn(async (path: string, init?: RequestInit) => {
    if (path.includes("passive-passages/revisions")) return reply({ ...inspection, decision: "accepted" });
    const body = JSON.parse(String(init?.body)); payloads.push(body.payload);
    return reply({ result: { ...unknown, query: "signal", reason: "positive_frequency_and_capacitance_required" } });
  }));
  render(view()); await load(); selectQuery();
  fireEvent.change(screen.getByLabelText("Passive query meaning"), { target: { value: "signal" } });
  fireEvent.click(screen.getByRole("button", { name: "Interpret reviewed model" }));
  await screen.findByText(/positive frequency and capacitance required/);
  expect(payloads[0]?.frequency_hz).toBeUndefined();
  fireEvent.change(screen.getByLabelText(/Signal frequency in hertz/), { target: { value: "1e3" } });
  fireEvent.click(screen.getByRole("button", { name: "Interpret reviewed model" }));
  await waitFor(() => expect(payloads[1]?.frequency_hz).toBe("1e3"));
});

test("revoked focus refresh clears frozen model, reviewed sources and query controls", async () => {
  let revoked = false;
  vi.stubGlobal("fetch", vi.fn(async () => revoked ? reply({ error: { message: "Passive source unavailable." } }, 404) : reply(inspection)));
  render(view()); await load();
  revoked = true; fireEvent(window, new Event("focus"));
  await screen.findByText(/Cached model, graph and query results were cleared/);
  expect(screen.queryByText("Frozen passive model")).toBeNull();
  expect(screen.queryByText("Synthetic ideal circuit only")).toBeNull();
  expect(screen.queryByLabelText("Query from terminal")).toBeNull();
  expect(screen.queryByRole("button", { name: "Append passive model review" })).toBeNull();
});

test("stale query response cannot repopulate after changing query meaning", async () => {
  let resolve: ((response: Response) => void) | undefined;
  vi.stubGlobal("fetch", vi.fn(async (path: string) => path.includes("passive-passages/revisions") ? reply(inspection) : new Promise<Response>((r) => { resolve = r; })));
  render(view()); await load(); selectQuery();
  fireEvent.click(screen.getByRole("button", { name: "Interpret reviewed model" }));
  fireEvent.change(screen.getByLabelText("Passive query meaning"), { target: { value: "resistance" } });
  resolve?.(reply({ result: unknown }));
  await waitFor(() => expect((screen.getByRole("button", { name: "Interpret reviewed model" }) as HTMLButtonElement).disabled).toBe(false));
  expect(screen.queryByText("Declared model query result")).toBeNull();
});

test("draft focus detects concurrent edits without adopting a newer token over local content", async () => {
  let changed = false;
  vi.stubGlobal("fetch", vi.fn(async (path: string) => path.includes("drafts/") ? reply({ ...draft, state: changed ? "draft-v2" : "draft-v1" }) : reply(graph)));
  render(view());
  fireEvent.change(screen.getByLabelText("Existing passive draft ID"), { target: { value: "model-draft" } });
  fireEvent.click(screen.getByRole("button", { name: "Open passive draft" }));
  await screen.findByText(/Saved draft model-draft/);
  fireEvent.change(screen.getByLabelText(/Passage 1 resistance/), { target: { value: "470" } });
  changed = true; fireEvent(window, new Event("focus"));
  await screen.findByText(/Saved model draft changed/);
  expect(screen.queryByRole("button", { name: "Update passive model draft" })).toBeNull();
});

test("changing project fences delayed frozen inspection and clears private evidence", async () => {
  let resolve: ((response: Response) => void) | undefined;
  vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>((r) => { resolve = r; })));
  const { rerender } = render(view());
  fireEvent.change(screen.getByLabelText("Exact frozen passive model revision ID"), { target: { value: "model-revision" } });
  fireEvent.click(screen.getByRole("button", { name: "Inspect frozen passive model" }));
  rerender(view("project-two")); resolve?.(reply(inspection));
  await waitFor(() => expect((screen.getByLabelText("Exact frozen passive model revision ID") as HTMLInputElement).value).toBe(""));
  expect(screen.queryByText("Frozen passive model")).toBeNull();
});

test("readers can inspect/query but cannot append model reviews", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => reply(inspection)));
  render(view("project-one", false)); await load();
  expect((screen.getByRole("button", { name: "Append passive model review" }) as HTMLButtonElement).disabled).toBe(true);
});

test("update and freeze use saved draft concurrency tokens independently", async () => {
  let current = draft;
  const commands: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (path: string, init?: RequestInit) => {
    if (path.includes("drafts/")) return reply(current);
    if (path.includes("copper/revisions")) return reply(graph);
    const body = JSON.parse(String(init?.body)); commands.push(body.operation);
    if (body.operation === "passage.update") {
      expect(body.expected_state).toBe("draft-v1");
      expect(body.payload.model.passages[0].resistance_ohm).toBe("470");
      current = { ...draft, state: "draft-v2", content: { passages: body.payload.model } };
      return reply({ result: current });
    }
    expect(body.operation).toBe("passage.freeze");
    expect(body.expected_state).toBe("draft-v2");
    expect(body.payload).toEqual({ draft_id: "model-draft" });
    return reply({ result: { revision_id: "revision-two", snapshot_id: "snapshot-two", sha256: "d".repeat(64), draft: { ...current, state: "draft-v3" } } });
  }));
  render(view());
  fireEvent.change(screen.getByLabelText("Existing passive draft ID"), { target: { value: "model-draft" } });
  fireEvent.click(screen.getByRole("button", { name: "Open passive draft" }));
  await screen.findByText(/Saved draft model-draft/);
  fireEvent.change(screen.getByLabelText(/Passage 1 resistance/), { target: { value: "470" } });
  fireEvent.click(screen.getByRole("button", { name: "Update passive model draft" }));
  await screen.findByText(/model-draft · draft-v2/);
  fireEvent.click(screen.getByRole("button", { name: "Freeze saved passive model" }));
  await waitFor(() => expect((screen.getByLabelText("Exact frozen passive model revision ID") as HTMLInputElement).value).toBe("revision-two"));
  expect(commands).toEqual(["passage.update", "passage.freeze"]);
});

test("registered assertion provenance is shown without turning source rights into qualification", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => reply({ ...inspection, assertion_evidence: [{ local_id: "r1", evidence: { status: "registered_file", source_bundle_revision_id: "source-revision", source_path: "declared.txt", sha256: "e".repeat(64), rights: "synthetic-original" } }] })));
  render(view()); await load();
  expect(screen.getByText(/source-revision \/ declared.txt/).textContent).toContain("synthetic-original");
  expect(screen.getByText(/Model review and path reachability establish no physical continuity/)).toBeTruthy();
});
