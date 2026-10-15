import { MantineProvider } from "@mantine/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { ProbeProvider } from "../probe";
import { EvidencePanel } from "./EvidencePanel";
import { evidenceQuery, type EvidenceItem } from "./api";

beforeEach(() => { vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} }); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

function item(over: Partial<EvidenceItem> & Pick<EvidenceItem, "evidence_id" | "kind" | "kind_label" | "statement">): EvidenceItem {
  return {
    source: "facts", workspace_id: "ws-1", subject: { scope: "project", kind: "project", id: "project-1", label: "Project" }, status: "known", conditions: [],
    method: { name: "source_observation" }, basis: { origin: "manual_entry", references: ["citation:Typed from a label."], independently_verified: false },
    recorded_at: "2026-01-01T00:00:00Z", establishes: ["It was reported."], does_not_establish: ["That it was measured."], warnings: [], physical_qualification: false, ...over,
  };
}

const kinds = [
  { kind: "source_claim", label: "Declared claim", subject_scope: "either", summary: "Reported by a source.", establishes: [], does_not_establish: ["Measurement."], fact_methods: [] },
  { kind: "physical_measurement", label: "Physical measurement", subject_scope: "actual", summary: "Observed on a unit.", establishes: [], does_not_establish: ["Qualification."], fact_methods: [] },
];

function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<MantineProvider><QueryClientProvider client={client}><EvidencePanel workspaceId="ws-1" /></QueryClientProvider></MantineProvider>);
}

test("a manual rating and a physical measurement are labeled as different kinds", async () => {
  const urls: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    urls.push(url);
    if (url.includes("taxonomy")) return new Response(JSON.stringify({ kinds }), { status: 200 });
    return new Response(JSON.stringify({ workspace_id: "ws-1", offset: 0, limit: 50, has_more: false, scan_limit_reached: false, items: [
      item({ evidence_id: "fact:1", kind: "source_claim", kind_label: "Declared claim", statement: "Declared rating: current_rating = 2 A" }),
      item({ evidence_id: "fact:2", kind: "physical_measurement", kind_label: "Physical measurement", statement: "width = 11 mm", subject: { scope: "actual", kind: "physical_unit", id: "u", label: "Physical unit SN-1" },
        method: { name: "measurement", instrument: "Synthetic caliper", procedure: "Synthetic procedure" }, basis: { origin: "instrument_record", references: [], independently_verified: false } }),
    ] }), { status: 200 });
  }));
  mount();
  expect(await screen.findByText("Declared rating: current_rating = 2 A")).toBeTruthy();
  expect(screen.getAllByText("Declared claim").length).toBeGreaterThan(0);
  expect(screen.getAllByText("Physical measurement").length).toBeGreaterThan(0);
  expect(screen.getByText("Origin: manual entry")).toBeTruthy();
  expect(screen.getAllByText("Not independently verified").length).toBe(2);
  expect(screen.getByText("Instrument: Synthetic caliper")).toBeTruthy();
  expect(screen.getByText("Actual unit")).toBeTruthy();
  expect(screen.getAllByText(/Does not establish: That it was measured\./).length).toBe(2);
  expect(urls.some((url) => url === `/api/v0/${evidenceQuery("ws-1", [], 0)}`)).toBe(true);
});

test("an empty project never reads as a pass and failures are shown", async () => {
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    if (url.includes("taxonomy")) return new Response(JSON.stringify({ kinds }), { status: 200 });
    return new Response(JSON.stringify({ error: { message: "Project not found." } }), { status: 404 });
  }));
  mount();
  expect(await screen.findByText("Project not found.")).toBeTruthy();
  cleanup();
  vi.stubGlobal("fetch", vi.fn(async (url: string) => new Response(JSON.stringify(url.includes("taxonomy") ? { kinds } : { workspace_id: "ws-1", items: [], offset: 0, limit: 50, has_more: false, scan_limit_reached: false }), { status: 200 })));
  mount();
  expect(await screen.findByText(/Absence is not a pass/)).toBeTruthy();
});

test("kind filters query only the selected kinds from the first page", () => {
  expect(evidenceQuery("p", ["review", "calculation"], 50)).toBe("evidence/workspaces/p?kind=review&kind=calculation&offset=50&limit=50");
  void fireEvent; void waitFor;
});

test("a recorded result shows its stale state and exact pins on request", async () => {
  const urls: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    urls.push(url);
    if (url.includes("taxonomy")) return new Response(JSON.stringify({ kinds }), { status: 200 });
    if (url.includes("evidence/recorded/")) return new Response(JSON.stringify({ record_id: "rec-1", workspace_id: "ws-1", source: "interface_assessment", kind: "generated_check", algorithm_version: "interface_assessment/0.1",
      request: {}, result: {}, result_sha256: "a".repeat(64), note: "", recorded_at: "2026-01-01T00:00:00Z", recorded_by_id: 1, stale: true, rewritten: false, physical_qualification: false,
      pins: [{ role: "left_pinout", revision_id: "rev-left", definition_id: "def-left", number: 1, latest_number: 2, newer_revision_exists: true }] }), { status: 200 });
    return new Response(JSON.stringify({ workspace_id: "ws-1", offset: 0, limit: 50, has_more: false, scan_limit_reached: false, items: [
      item({ evidence_id: "recorded:rec-1", kind: "generated_check", kind_label: "Generated check", source: "interface_assessment", statement: "Interface assessment: 1 satisfied by declarations, 0 invalid, 0 flagged, 8 unknown findings; no overall compatibility result",
        status: "recorded", stale: true, warnings: ["Stale: pinned left pinout revision 1 has newer revision 2. The recorded result is kept unchanged."],
        method: { name: "interface_assessment", algorithm_version: "interface_assessment/0.1" }, basis: { origin: "recorded_result", references: ["recorded:rec-1"], independently_verified: false } }),
    ] }), { status: 200 });
  }));
  mount();
  expect(await screen.findByText("Stale: newer input revision")).toBeTruthy();
  expect(screen.getByText(/kept unchanged/)).toBeTruthy();
  expect(urls.some((url) => url.includes("evidence/recorded/"))).toBe(false);
  fireEvent.click(screen.getByRole("button", { name: "Show recorded inputs" }));
  expect(await screen.findByText(/left pinout: revision 1 \(rev-left\) · newer revision 2 exists/)).toBeTruthy();
  expect(urls).toContain("/api/v0/evidence/recorded/rec-1");
});

test("evidence recorded against an earlier revision reads as stale with the preserved change", async () => {
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    if (url.includes("taxonomy")) return new Response(JSON.stringify({ kinds }), { status: 200 });
    if (url.includes("/applicability/")) return new Response(JSON.stringify({
      workspace_id: "ws-1", offset: 0, limit: 50, has_more: false, scan_limit_reached: false,
      revision: { revision_id: "11111111-1111-4111-8111-111111111111", definition_id: "d", number: 2, latest_number: 2, is_latest: true },
      items: [{ item: item({ evidence_id: "fact:9", kind: "source_claim", kind_label: "Declared claim", statement: "continuity checked = true" }),
        applicability: { status: "stale_earlier_revision", reason: "Recorded against revision 1. Revision 2 is selected.", evidence_revision_id: "r1", evidence_revision_number: 1,
          change: { from_number: 1, to_number: 2, content_changed: true, changed_sections: ["termination.style"], sections_truncated: false }, observation_preserved: true, qualifies_selected_revision: false } }],
    }), { status: 200 });
    return new Response(JSON.stringify({ workspace_id: "ws-1", offset: 0, limit: 50, has_more: false, scan_limit_reached: false, items: [] }), { status: 200 });
  }));
  mount();
  fireEvent.change(screen.getByLabelText("Revision ID"), { target: { value: "11111111-1111-4111-8111-111111111111" } });
  fireEvent.click(screen.getByText("Check applicability"));
  expect(await screen.findByText("stale: earlier revision")).toBeTruthy();
  expect(screen.getByText("Changed since revision 1: termination.style")).toBeTruthy();
  expect(screen.getByText("continuity checked = true")).toBeTruthy();
});

test("the stale badge says whether a revision, new assertions or both went stale", async () => {
  const base = { kind: "generated_check" as const, kind_label: "Generated check", stale: true };
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    if (url.includes("taxonomy")) return new Response(JSON.stringify({ kinds }), { status: 200 });
    return new Response(JSON.stringify({ workspace_id: "ws-1", offset: 0, limit: 50, has_more: false, scan_limit_reached: false, items: [
      item({ ...base, evidence_id: "recorded:a", statement: "A", warnings: ["Stale: new fact assertions arrived in this comparison's scope."] }),
      item({ ...base, evidence_id: "recorded:b", statement: "B", warnings: ["Stale: new fact assertions arrived.", "Stale: pinned left pinout revision 1 has newer revision 2."] }),
    ] }), { status: 200 });
  }));
  mount();
  expect(await screen.findByText("Stale: new fact assertions")).toBeTruthy();
  expect(screen.getByText("Stale: newer input revision and new fact assertions")).toBeTruthy();
});

test("a test record on an older design revision reads as stale; a batch test applies to the batch only", async () => {
  const test_ = item({ evidence_id: "test:t1", kind: "physical_measurement", kind_label: "Physical measurement", statement: "continuity test, criterion met", source: "subject_tests", stale: true,
    subject: { scope: "actual", kind: "work_batch", id: "b-1", label: "Work batch B (as a whole)" }, warnings: ["Stale: tested against design revision 1; revision 2 is newer."] });
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    if (url.includes("taxonomy")) return new Response(JSON.stringify({ kinds }), { status: 200 });
    if (url.includes("/applicability/")) return new Response(JSON.stringify({ workspace_id: "ws-1", offset: 0, limit: 50, has_more: false, scan_limit_reached: false,
      revision: { revision_id: "r-1", definition_id: "d", number: 1, latest_number: 2, is_latest: false },
      items: [{ item: test_, applicability: { status: "exact_batch_only", reason: "Tested on one work batch, as a whole.", evidence_revision_id: "r-1", evidence_revision_number: 1, observation_preserved: true, qualifies_selected_revision: false } }] }), { status: 200 });
    return new Response(JSON.stringify({ workspace_id: "ws-1", offset: 0, limit: 50, has_more: false, scan_limit_reached: false, items: [test_] }), { status: 200 });
  }));
  mount();
  expect(await screen.findByText("Stale: newer design revision")).toBeTruthy();
  fireEvent.change(screen.getByLabelText("Revision ID"), { target: { value: "00000000-0000-4000-8000-000000000001" } });
  fireEvent.click(screen.getByRole("button", { name: "Check applicability" }));
  expect(await screen.findByText("one batch of this revision, as a whole")).toBeTruthy();
});

test("the applicability revision defaults to the shared selection and is picked from its revisions", async () => {
  const urls: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    urls.push(url);
    if (url.includes("taxonomy")) return new Response(JSON.stringify({ kinds }), { status: 200 });
    if (url.includes("catalog/definitions/")) return new Response(JSON.stringify({ revisions: [{ revision_id: "r-1", number: 1 }, { revision_id: "r-2", number: 2 }] }), { status: 200 });
    if (url.includes("/applicability/")) return new Response(JSON.stringify({ workspace_id: "ws-1", offset: 0, limit: 50, has_more: false, scan_limit_reached: false,
      revision: { revision_id: "r-1", definition_id: "d", number: 1, latest_number: 2, is_latest: false }, items: [] }), { status: 200 });
    return new Response(JSON.stringify({ workspace_id: "ws-1", offset: 0, limit: 50, has_more: false, scan_limit_reached: false, items: [] }), { status: 200 });
  }));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<MantineProvider><QueryClientProvider client={client}><ProbeProvider probe={{ object: "def-1", rev: 1, path: [] }} onProbe={() => {}}><EvidencePanel workspaceId="ws-1" /></ProbeProvider></QueryClientProvider></MantineProvider>);
  expect(await screen.findByText(/Selected revision 1; latest is revision 2/)).toBeTruthy();
  expect(urls.some((u) => u.includes("/applicability/r-1"))).toBe(true);
  expect(screen.queryByLabelText("Revision ID")).toBeNull();
});

test("the evidence table sits in the contained horizontal scroller", async () => {
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    if (url.includes("taxonomy")) return new Response(JSON.stringify({ kinds }), { status: 200 });
    return new Response(JSON.stringify({ workspace_id: "ws-1", offset: 0, limit: 50, has_more: false, scan_limit_reached: false, items: [
      item({ evidence_id: "fact:1", kind: "source_claim", kind_label: "Declared claim", statement: "Declared rating" }),
    ] }), { status: 200 });
  }));
  mount();
  await screen.findByText("Declared rating");
  expect(document.querySelector(".sb-ws-scroll table")).not.toBeNull();
});
