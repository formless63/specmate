import { command, read } from "../identity/api";
import type { Boundary, Graph, Origin } from "../copper/api";
export type { Graph };
export type Evidence = { status: "unknown" | "unverified_citation" | "registered_file"; citation?: string | null; source_bundle_revision_id?: string | null; source_path?: string | null; sha256?: string | null; rights?: string | null };
export type ConditionDeclaration = { local_id: string; states: string[]; basis: string };
export type ConditionAssignment = { condition_id: string; state: string };
export type ConditionalContact = ConditionAssignment & { behavior: "ideal_contact" };
export type Passage = { local_id: string; from_terminal_id: string; to_terminal_id: string; kind: "resistor" | "capacitor" | "diode" | "inductor" | "transformer" | "conditional" | "active" | "unknown"; resistance_ohm: string | null; capacitance_f: string | null; condition: string | null; conditional_contact?: ConditionalContact | null; native_candidate_boundary_id: string | null; basis: string; evidence: Evidence };
export type Model = { root_revision_id: string; assumptions: "ideal_lumped_components"; model_basis: string; conditions?: ConditionDeclaration[]; passages: Passage[] };
export type Draft = { definition_id: string; draft_id: string; state: string; content: { passages: Model } };
export type Frozen = { revision_id: string; snapshot_id: string; sha256: string; draft: Draft };
export type Inspection = { revision_id: string; sha256: string; snapshot_id: string; model: Model; assertion_evidence?: { local_id: string; evidence: Evidence }[]; graph: Graph; state: string; decision: string; reviews: { review_id: string; version: number; decision: string; basis: string; evidence: Evidence }[] };
export type Interpretation = {
  revision_id: string; sha256: string; review_id?: string; review_state: string;
  root_revision_id?: string; root_snapshot_sha256?: string;
  query: string; status: string; reason: string; series_resistance_ohm?: string | null;
  limited?: boolean; physical_continuity: string; signal_transfer: string;
  compatibility?: string; physical_qualification: string;
  assumptions?: {
    component_model: string; model_basis: string; copper: string; frequency_hz: string | null;
    condition_assignments?: ConditionAssignment[]; conditional_contacts: string;
  };
  unmodeled_boundaries?: Boundary[];
  paths: {
    terminal_ids: string[]; condition_requirements?: ConditionalContact[];
    conflicting_condition_ids?: string[]; status: string; reasons: string[];
    series_resistance_ohm: string | null; shortness: string;
    series_impedance_ohm: { real: string; imaginary: string; precision: string } | null;
    steps: {
      record_id: string; kind: string; from_terminal_id: string; to_terminal_id: string;
      status: string; basis: string; direction?: string; provenance?: Origin | null;
      resistance_ohm?: string; capacitance_f?: string; condition?: string | null;
      condition_requirement?: ConditionalContact; assigned_state?: string | null;
      evidence: string | Evidence;
    }[];
  }[];
};
export const inspectRoot = (revisionId: string) => read<Graph>(`copper/revisions/${revisionId}`);
export const inspectModel = (revisionId: string) => read<Inspection>(`passive-passages/revisions/${revisionId}`);
export async function inspectDraft(draftId: string) {
  const draft = await read<Draft>(`drafts/${draftId}`);
  if (!draft.content.passages) throw new Error("Selected draft is not a typed passive model.");
  return draft;
}
export const createModel = (projectId: string, name: string, model: Model) => command<Draft>("passage.create", { project_id: projectId, name, model });
export const updateModel = (draft: Draft, model: Model) => command<Draft>("passage.update", { draft_id: draft.draft_id, model }, draft.state);
export const freezeModel = (draft: Draft) => command<Frozen>("passage.freeze", { draft_id: draft.draft_id }, draft.state);
export const reviewModel = (inspection: Inspection, decision: string, basis: string, evidence: Evidence) => command<Inspection>("passage.review", { revision_id: inspection.revision_id, decision, basis, evidence }, inspection.state);
export async function interpretModel(payload: object) {
  const csrf = document.cookie.split("; ").find((c) => c.startsWith("csrftoken="))?.split("=")[1];
  const response = await fetch("/api/v0/operations", { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json", "X-CSRFToken": decodeURIComponent(csrf ?? "") }, body: JSON.stringify({ operation: "passage.interpret", request_id: crypto.randomUUID(), payload }) });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error?.message ?? `Query failed (${response.status})`);
  return body.result as Interpretation;
}
