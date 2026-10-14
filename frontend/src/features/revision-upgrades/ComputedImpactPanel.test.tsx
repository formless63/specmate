import { MantineProvider } from "@mantine/core";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { grants } from "../../test/grants";
import { PermissionsProvider } from "../../lib/permissions";
import { ComputedImpactPanel } from "./ComputedImpactPanel";
import { RevisionUpgradeWorkspace } from "./RevisionUpgradeWorkspace";
import type { ComputedImpact, EvidenceGroup, Proposal } from "./api";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const group = (reason: string, items: EvidenceGroup["items"] = []): EvidenceGroup => ({ items, total: items.length, truncated: false, scan_limit_reached: false, reason });
const impact: ComputedImpact = {
  kind: "cable", adapter: { name: "cable_sections", status: "computed", reason: null },
  content: { comparable: true, from_number: 1, to_number: 2, content_changed: true, changed_sections: ["cable.assignments"], sections_truncated: false },
  sections: [{ section: "terminations", status: "changed", reviews: ["documents", "preparation"], summary: "Conductor-to-contact terminations changed.", details: [] }],
  disciplines: {
    electrical: { status: "changed", reason: "Changed cable sections: terminations.", sections: ["terminations"] },
    mechanical: { status: "no_difference_found", reason: "No compared cable section that maps to this discipline changed.", sections: [] },
    firmware: { status: "not_evaluated", reason: "Cable revisions declare no firmware.", sections: [] },
    manufacturing: { status: "unknown", reason: "Sections without a known discipline mapping (other).", sections: ["other"] },
    evidence: { status: "changed", reason: "1 evidence record(s) become stale or inapplicable on adoption.", sections: [] },
  },
  evidence: {
    becomes_stale: group("Recorded against the old revision.", [{ evidence_id: "fact:one", kind_label: "Source claim", statement: "continuity_checked = true", subject: "Synthetic cable revision 1", recorded_at: "2026-01-01T00:00:00Z", applicability: "stale_earlier_revision", reason: "Recorded against revision 1.", evidence_revision_number: 1, changed_sections: ["cable.assignments"] }]),
    consumer_stale: group("Recorded against the consuming revision."),
    definition_scope_unverified: group("Attached to the definition as a whole."),
    candidate_recorded: group("Already recorded against the candidate revision."),
  },
  derived_on_read: true, adopted: false, compatibility: "not_evaluated",
};

const row = (discipline: string) => document.querySelector(`[data-discipline="${discipline}"]`) as HTMLElement;

test("shows each computed discipline status with its reason; unknown is never no impact", () => {
  render(<MantineProvider><ComputedImpactPanel impact={impact} /></MantineProvider>);
  expect(within(row("electrical")).getByText("changed, review required")).toBeTruthy();
  expect(within(row("manufacturing")).getByText("unknown, review required")).toBeTruthy();
  expect(within(row("firmware")).getByText("not evaluated")).toBeTruthy();
  expect(within(row("firmware")).getByText("Cable revisions declare no firmware.")).toBeTruthy();
  expect(within(row("mechanical")).getByText("no difference in compared sections")).toBeTruthy();
  expect(screen.getByText(/terminations · changed · Conductor-to-contact/)).toBeTruthy();
  expect(screen.getByText("Changed content: cable.assignments")).toBeTruthy();
  expect(screen.getByText("Becomes stale on adoption: 1")).toBeTruthy();
  expect(screen.getByText(/continuity_checked = true · Synthetic cable revision 1 · recorded at r1 · changed since: cable.assignments/)).toBeTruthy();
  expect(screen.queryByText(/no impact/i)).toBeNull();
});

test("a missing computed impact reads as unknown, not as no impact", () => {
  render(<MantineProvider><ComputedImpactPanel /></MantineProvider>);
  expect(screen.getByText("Impact unknown")).toBeTruthy();
});

test("readers see computed impact and pins as name plus revision with the exact ID secondary", async () => {
  const pin = (revision_id: string, number: number) => ({ revision_id, definition_id: "cable-def", name: "Synthetic cable", number, sha256: "b".repeat(64) });
  const unevaluated = { status: "not_evaluated" as const };
  const proposal: Proposal = {
    proposal_id: "proposal-one", owning_snapshot_id: "snapshot-one", owning_definition_id: "kit", owning_sha256: "a".repeat(64),
    old: pin("old-one", 1), candidate: pin("candidate-two", 2), paths: [["jumper"]], basis: "Inspect", state: "upgrade-v0", decision: "unreviewed",
    impacts: { electrical: unevaluated, mechanical: unevaluated, firmware: unevaluated, manufacturing: unevaluated, evidence: unevaluated },
    computed_impact: impact, compatibility: "not_evaluated", validity: "not_evaluated", qualification: "not_evaluated", affected_features: [],
    occurrences: [{ path: ["jumper"], old_revision_id: "old-one", candidate_revision_id: "candidate-two", selected: true, old_pin: pin("old-one", 1), candidate_pin: pin("candidate-two", 2), old_placement: null, candidate_placement: null, old_assignments: null, candidate_assignments: null }],
    relationships: [], old_relationships: [], candidate_relationships: [], contextual_assignments: [], reviews: [], applications: [], limitations: [],
  };
  vi.stubGlobal("fetch", vi.fn(async (path: string) => path.includes("revision-upgrades/proposals") ? reply(proposal) : reply([])));
  render(<MantineProvider><PermissionsProvider permissions={grants({ edit: false })}><RevisionUpgradeWorkspace projectId="p1" /></PermissionsProvider></MantineProvider>);
  fireEvent.change(screen.getByLabelText("Saved proposal ID"), { target: { value: "proposal-one" } });
  fireEvent.click(screen.getByRole("button", { name: "Reload proposal" }));
  expect(await screen.findByText("Computed impact")).toBeTruthy();
  const table = screen.getByText(/jumper \(selected\)/).closest("tr") as HTMLElement;
  expect(within(table).getAllByText("Synthetic cable")).toHaveLength(2);
  expect(within(table).getByText("r1")).toBeTruthy();
  expect(within(table).getByText("r2")).toBeTruthy();
  // The exact UUID stays available in the collapsed disclosure, not as the primary label.
  expect(within(table).getByText("old-one", { selector: "code" })).toBeTruthy();
  expect(within(table).queryByText("old-one", { selector: "td" })).toBeNull();
});
