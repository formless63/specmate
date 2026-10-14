import { apiErrorMessage } from "../../lib/api-errors";
import { randomUUID } from "../../lib/random-id";
export class UpgradeRequestError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}
async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api/v0/${path}`, { credentials: "same-origin", ...init });
  const body = await response.json();
  if (!response.ok) throw new UpgradeRequestError(apiErrorMessage(body, `Request failed (${response.status})`), response.status);
  return body as T;
}
async function command<T>(operation: string, payload: object, expectedState?: string): Promise<T> {
  const csrf = document.cookie.split("; ").find((c) => c.startsWith("csrftoken="))?.split("=")[1];
  const response = await request<{ result: T }>("operations", {
    method: "POST", headers: { "Content-Type": "application/json", "X-CSRFToken": decodeURIComponent(csrf ?? "") },
    body: JSON.stringify({ operation, payload, request_id: randomUUID(), idempotency_key: randomUUID(), expected_state: expectedState }),
  });
  return response.result;
}
export type Feature = { path: string[]; old_feature_id: string; candidate_feature_id: string; basis: string };
export type RelationshipDecision = { local_id: string; decision: "retain" | "remove"; basis: string };
export type AssignmentDecision = { path: string[]; decision: "retain" | "remove"; basis: string };
export type Relation = "later_revision" | "declared_replacement";
export type Propagation = { status: "not_applicable" } | {
  status: "required"; context_path: string[]; consumer: Pin; sibling_context_paths: string[][];
  outer_relationships: { context_path: string[]; local_id: string }[]; outer_assignments: string[][]; owning_snapshot_id: string;
};
export type Impact = { status: "not_evaluated" | "unknown" | "reviewed"; basis?: string | null };
export type Impacts = Record<"electrical" | "mechanical" | "firmware" | "manufacturing" | "evidence", Impact>;
export type ImpactStatus = "changed" | "unknown" | "no_difference_found" | "none_found" | "not_evaluated";
export type DisciplineImpact = { status: ImpactStatus; reason: string; sections: string[] };
export type ImpactSection = { section: string; status: "changed" | "uncomparable"; reviews: string[]; summary: string; details: object[] };
export type StaleEvidence = { evidence_id: string; kind_label: string; statement: string; subject: string; recorded_at: string; applicability: string; reason: string; evidence_revision_number: number | null; changed_sections: string[] };
export type EvidenceGroup = { items: StaleEvidence[]; total: number; truncated: boolean; scan_limit_reached: boolean; reason: string };
/** Derived on read from frozen content and recorded evidence; never adopts anything. */
export type ComputedImpact = {
  kind: string; adapter: { name: string | null; status: "computed" | "failed" | "not_available"; reason: string | null };
  content: { comparable: boolean; from_number: number; to_number: number; content_changed: boolean; changed_sections: string[]; sections_truncated: boolean };
  sections: ImpactSection[];
  disciplines: Record<"electrical" | "mechanical" | "firmware" | "manufacturing" | "evidence", DisciplineImpact>;
  evidence: { becomes_stale: EvidenceGroup; consumer_stale: EvidenceGroup | null; definition_scope_unverified: EvidenceGroup; candidate_recorded: EvidenceGroup };
  derived_on_read: true; adopted: false; compatibility: string;
};
export type Pin = { revision_id: string; definition_id: string; name: string; number: number; sha256: string };
export type Proposal = {
  proposal_id: string; owning_snapshot_id: string; owning_definition_id: string; owning_sha256: string;
  old: Pin; candidate: Pin; paths: string[][]; basis: string; state: string;
  relation?: Relation; replacement_basis?: string | null; context_path?: string[];
  consumer?: { snapshot_id: string; definition_id: string; name: string; sha256: string; revision_id: string | null; number: number | null };
  relationship_decisions_required?: string[]; relationship_decisions_allowed?: string[];
  assignment_decisions_required?: string[][]; assignment_decisions_allowed?: string[][];
  removed_paths?: string[][]; parent_propagation?: Propagation;
  decision: "unreviewed" | "accepted" | "rejected" | "needs_evidence";
  impacts: Impacts; computed_impact?: ComputedImpact; compatibility: string; validity: string; qualification: string;
  affected_features: { path: string[]; feature_id: string }[];
  occurrences: { path: string[]; old_revision_id: string | null; candidate_revision_id: string | null; selected: boolean;
    old_pin?: Pin | null; candidate_pin?: Pin | null;
    old_placement: object | null; candidate_placement: object | null; old_assignments: { firmware_revision_id: string | null } | null;
    candidate_assignments: { firmware_revision_id: string | null } | null }[];
  relationships: object[]; old_relationships: Record<string, unknown>[]; candidate_relationships: Record<string, unknown>[]; contextual_assignments: object[]; limitations: string[];
  reviews: { review_id: string; version: number; decision: string; basis: string; features: Feature[];
    relationship_decisions?: RelationshipDecision[]; assignment_decisions?: AssignmentDecision[];
    impacts: Impacts; evidence: { status: string; citation?: string | null; source_bundle_revision_id?: string | null; source_path?: string | null; sha256?: string | null; rights?: string | null } }[];
  applications: { application_id: string; draft_id: string; draft_version: number; review_id: string }[];
};
export type Assembly = { occurrences: { address: { path: string[] }; revision_id: string; name: string; display_ref: string }[] };
export type Applied = { proposal_id: string; application_id: string; draft_id: string; state: string; base_revision_id: string | null; parent_propagation?: "required" | "not_applicable" };
export type Consumers = {
  revision: Pin; workspace_id?: string; project_id?: string | null; truncated: boolean; compatibility: string;
  consumers: { owning_snapshot_id: string; owning_definition_id: string; name: string; revision_id: string | null; number: number | null; sha256: string; in_project?: boolean;
    uses: { path: string[]; context_path: string[]; display_ref: string }[] }[];
};
export function inspectAssembly(snapshotId: string) { return request<Assembly>(`revision-upgrades/snapshots/${snapshotId}`); }
/** Workspace consumers of an exact revision; a project id only lists its referenced consumers first. */
export function findConsumers(revisionId: string, projectId?: string | null) {
  const params = new URLSearchParams({ revision_id: revisionId });
  if (projectId) params.set("project_id", projectId);
  return request<Consumers>(`revision-upgrades/consumers?${params}`);
}
export function loadProposal(id: string) { return request<Proposal>(`revision-upgrades/proposals/${id}`); }
export function proposeUpgrade(payload: object) { return command<Proposal>("upgrade.propose", payload); }
export function reviewUpgrade(payload: object, state: string) { return command<Proposal>("upgrade.review", payload, state); }
export function applyUpgrade(payload: object, state: string) { return command<Applied>("upgrade.apply", payload, state); }
