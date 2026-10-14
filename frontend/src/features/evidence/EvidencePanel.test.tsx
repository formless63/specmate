import { MantineProvider } from "@mantine/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
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

test("a manual rating and a physical measurement are labelled as different kinds", async () => {
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
