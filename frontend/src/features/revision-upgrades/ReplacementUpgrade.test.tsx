import { MantineProvider } from "@mantine/core";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { PermissionsProvider } from "../../lib/permissions";
import { RevisionUpgradeWorkspace } from "./RevisionUpgradeWorkspace";
import type { Proposal } from "./api";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const unevaluated = { status: "not_evaluated" as const };
const impacts = { electrical: unevaluated, mechanical: unevaluated, firmware: unevaluated, manufacturing: unevaluated, evidence: unevaluated };
const pin = (revision_id: string, definition_id: string, name: string, number: number) => ({ revision_id, definition_id, name, number, sha256: "d".repeat(64) });
const nested: Proposal = {
  proposal_id: "proposal-nested", owning_snapshot_id: "root-snapshot", owning_definition_id: "root-def", owning_sha256: "a".repeat(64),
  relation: "declared_replacement", replacement_basis: "Reviewer declares the replacement body.", context_path: ["left"],
  consumer: { snapshot_id: "module-snapshot", definition_id: "module-def", name: "Synthetic module", sha256: "e".repeat(64), revision_id: "module-1", number: 1 },
  old: pin("body-old", "body-def", "Synthetic body", 1), candidate: pin("body-new", "other-def", "Synthetic replacement body", 1),
  paths: [["conn"]], basis: "Reach nested use", state: "upgrade-v0", decision: "unreviewed", impacts,
  compatibility: "not_evaluated", validity: "not_evaluated", qualification: "not_evaluated",
  affected_features: [{ path: ["conn"], feature_id: "pin-a" }],
  relationship_decisions_required: ["inner"], relationship_decisions_allowed: ["inner"],
  assignment_decisions_required: [], assignment_decisions_allowed: [], removed_paths: [],
  parent_propagation: { status: "required", context_path: ["left"], consumer: pin("module-1", "module-def", "Synthetic module", 1), sibling_context_paths: [["right"]], outer_relationships: [{ context_path: [], local_id: "outer" }], outer_assignments: [], owning_snapshot_id: "root-snapshot" },
  occurrences: [], relationships: [], old_relationships: [], candidate_relationships: [], contextual_assignments: [], reviews: [], applications: [], limitations: [],
};
const view = (permissions?: string[]) => <MantineProvider><PermissionsProvider permissions={permissions}><RevisionUpgradeWorkspace projectId="p1" /></PermissionsProvider></MantineProvider>;

test("finds nested consumers and proposes a declared replacement in the exact consuming context", async () => {
  const proposals: object[] = [];
  vi.stubGlobal("fetch", vi.fn(async (path: string, init?: RequestInit) => {
    if (path.includes("revision-upgrades/consumers")) {
      expect(path).toContain("project_id=p1"); expect(path).toContain("revision_id=body-old");
      return reply({ revision: pin("body-old", "body-def", "Synthetic body", 1), truncated: false, compatibility: "not_evaluated", consumers: [{ owning_snapshot_id: "root-snapshot", owning_definition_id: "root-def", name: "Synthetic root", revision_id: "root-1", number: 1, sha256: "f".repeat(64), uses: [{ path: ["left", "conn"], context_path: ["left"], display_ref: "J1" }, { path: ["right", "conn"], context_path: ["right"], display_ref: "J1" }] }] });
    }
    if (path.includes("revision-upgrades/snapshots/root-snapshot")) {
      return reply({ occurrences: [
        { address: { path: ["left"] }, revision_id: "module-1", name: "Synthetic module", display_ref: "M1" },
        { address: { path: ["left", "conn"] }, revision_id: "body-old", name: "Synthetic body", display_ref: "J1" },
        { address: { path: ["right"] }, revision_id: "module-1", name: "Synthetic module", display_ref: "M2" },
        { address: { path: ["right", "conn"] }, revision_id: "body-old", name: "Synthetic body", display_ref: "J1" },
      ] });
    }
    const body = JSON.parse(String(init?.body)); proposals.push(body.payload);
    return reply({ result: nested });
  }));
  render(view());
  fireEvent.change(screen.getByLabelText("Identity relation"), { target: { value: "declared_replacement" } });
  fireEvent.change(screen.getByLabelText("Old revision ID"), { target: { value: "body-old" } });
  fireEvent.change(screen.getByLabelText("Candidate replacement revision ID"), { target: { value: "body-new" } });
  fireEvent.click(screen.getByRole("button", { name: "Find consumers of the old revision" }));
  fireEvent.click(await screen.findByRole("button", { name: "Use owning snapshot root-snapshot" }));
  fireEvent.click(await screen.findByLabelText(/^left \/ conn · Synthetic body/));
  // One consuming context per proposal: the sibling use belongs to another context.
  expect((screen.getByLabelText(/^right \/ conn · Synthetic body/) as HTMLInputElement).disabled).toBe(true);
  expect(screen.getByText(/Consuming context: left\./)).toBeTruthy();
  fireEvent.change(screen.getByLabelText("Proposal basis"), { target: { value: "Reach nested use" } });
  const save = screen.getByRole("button", { name: "Save upgrade proposal" }) as HTMLButtonElement;
  expect(save.disabled).toBe(true);
  fireEvent.change(screen.getByLabelText(/Replacement declaration/), { target: { value: "Reviewer declares the replacement body." } });
  fireEvent.click(save);
  expect(await screen.findByText("Exact proposal proposal-nested")).toBeTruthy();
  expect(proposals).toEqual([{ owning_snapshot_id: "root-snapshot", old_revision_id: "body-old", candidate_revision_id: "body-new", relation: "declared_replacement", replacement_basis: "Reviewer declares the replacement body.", context_path: ["left"], paths: [["conn"]], basis: "Reach nested use" }]);
  expect(screen.getByText("Parent propagation required")).toBeTruthy();
  expect(screen.getByText(/1 outer relationship/)).toBeTruthy();
});

test("accepting requires explicit relationship decisions and sends them with correspondence", async () => {
  let reviewed = nested;
  vi.stubGlobal("fetch", vi.fn(async (path: string, init?: RequestInit) => {
    if (path.endsWith("/definitions")) return reply([{ definition_id: "root-def" }]);
    if (path.includes("revision-upgrades/proposals")) return reply(reviewed);
    const body = JSON.parse(String(init?.body));
    expect(body.operation).toBe("upgrade.review");
    expect(body.payload.relationships).toEqual([{ local_id: "inner", decision: "retain", basis: "Same use in the module" }]);
    expect(body.payload.features).toEqual([{ path: ["conn"], old_feature_id: "pin-a", candidate_feature_id: "c1", basis: "Declared mapping" }]);
    reviewed = { ...nested, state: "upgrade-v1", decision: "accepted", reviews: [{ review_id: "r1", version: 1, decision: "accepted", basis: "Reviewed", features: body.payload.features, relationship_decisions: body.payload.relationships, assignment_decisions: [], impacts, evidence: { status: "unknown" } }] };
    return reply({ result: reviewed });
  }));
  render(view());
  fireEvent.change(screen.getByLabelText("Saved proposal ID"), { target: { value: "proposal-nested" } });
  fireEvent.click(screen.getByRole("button", { name: "Reload proposal" }));
  await screen.findByText("Exact proposal proposal-nested");
  fireEvent.change(screen.getByLabelText("Candidate feature for conn pin-a"), { target: { value: "c1" } });
  fireEvent.change(screen.getByLabelText("Correspondence basis for conn pin-a"), { target: { value: "Declared mapping" } });
  fireEvent.change(screen.getByLabelText("Review decision"), { target: { value: "accepted" } });
  fireEvent.change(screen.getByLabelText("Review basis"), { target: { value: "Reviewed" } });
  const append = screen.getByRole("button", { name: "Append review" }) as HTMLButtonElement;
  expect(append.disabled).toBe(true);
  fireEvent.change(screen.getByLabelText("Relationship inner (decision required)"), { target: { value: "retain" } });
  expect(append.disabled).toBe(true);
  fireEvent.change(screen.getByLabelText("Relationship inner decision basis"), { target: { value: "Same use in the module" } });
  expect(append.disabled).toBe(false);
  fireEvent.click(append);
  expect(await screen.findByText("Relationship inner: retain · Same use in the module")).toBeTruthy();
});

test("read-only grants withhold proposal, review and adoption with a visible reason", async () => {
  vi.stubGlobal("fetch", vi.fn(async (path: string) => path.endsWith("/definitions") ? reply([{ definition_id: "root-def" }]) : reply({ ...nested, decision: "accepted" })));
  render(view(["workspace.read"]));
  expect(screen.getByText(/Read-only access: requires Edit/)).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Save upgrade proposal" })).toBeNull();
  fireEvent.change(screen.getByLabelText("Saved proposal ID"), { target: { value: "proposal-nested" } });
  fireEvent.click(screen.getByRole("button", { name: "Reload proposal" }));
  await screen.findByText("Exact proposal proposal-nested");
  expect(screen.queryByRole("button", { name: "Append review" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Apply reviewed upgrade to draft" })).toBeNull();
});
