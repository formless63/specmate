import { apiErrorMessage } from "../../lib/api-errors";
import { randomUUID } from "../../lib/random-id";
export class MatchingRequestError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api/v0/${path}`, { credentials: "same-origin", ...init });
  const body = await response.json();
  if (!response.ok) throw new MatchingRequestError(apiErrorMessage(body, `Request failed (${response.status})`), response.status);
  return body as T;
}

async function command(operation: string, payload: object, expectedState?: string): Promise<Candidate> {
  const csrf = document.cookie.split("; ").find((cookie) => cookie.startsWith("csrftoken="))?.split("=")[1];
  const body = await request<{ result: Candidate }>("operations", {
    method: "POST", headers: { "Content-Type": "application/json", "X-CSRFToken": decodeURIComponent(csrf ?? "") },
    body: JSON.stringify({ operation, payload, request_id: randomUUID(), idempotency_key: randomUUID(), expected_state: expectedState }),
  });
  return body.result;
}

export type RevisionIdentity = {
  revision_id: string; definition_id: string; workspace_id: string; name: string;
  kind: string; number: number; sha256: string;
};
export type Evidence = {
  status: "unknown" | "unverified_citation" | "registered_file";
  citation?: string | null; source_bundle_revision_id?: string | null;
  source_path?: string | null; sha256?: string | null; rights?: string | null;
  media_type?: string | null;
};
export type EvidenceFile = {
  file_id: number; bundle_name: string; bundle_number: number;
  source_bundle_revision_id: string; source_path: string; sha256: string;
  rights: string; media_type: string;
};
export type Candidate = {
  candidate_id: string; source: RevisionIdentity; target: RevisionIdentity;
  association_kind: "import" | "supplier" | "model";
  observed_source_identifier: string; observed_target_identifier: string;
  basis: string; evidence: Evidence; state: string;
  decision: "unreviewed" | "accepted" | "rejected" | "needs_evidence";
  meaning: "reviewed_correspondence_only"; created_at: string; proposed_by_id: number;
  reviews: {
    review_id: string; version: number; decision: "accepted" | "rejected" | "needs_evidence";
    basis: string; evidence: Evidence; reviewed_at: string; reviewed_by_id: number;
  }[];
};
export type CandidatePage = { source_revision_id: string; results: Candidate[]; next_after: string | null };
export type EvidencePage = { workspace_id?: string; results: EvidenceFile[]; next_after: number | null };
export type SupplierSuggestion = {
  source_variant_id: string; target_variant_id: string; manufacturer: string; part_number: string;
  source_association_basis: string; target_association_basis: string; target: RevisionIdentity;
  match_basis: "exact_manufacturer_and_part_number"; review: "not_reviewed"; compatibility: "not_evaluated";
};
export type SupplierSuggestionPage = {
  source: RevisionIdentity; workspace_id: string; results: SupplierSuggestion[];
  next_after: string | null; inspection_truncated: boolean; meaning: "identifier_suggestions_only";
};
/** Exact identifier suggestions from the source revision's workspace library. */
export function supplierSuggestions(sourceRevision: string, sourceVariant: string, after?: string) {
  const params = new URLSearchParams({ source_variant_id: sourceVariant, limit: "25" });
  if (after) params.set("after", after);
  return request<SupplierSuggestionPage>(`catalog-matching/revisions/${sourceRevision}/supplier-suggestions?${params}`);
}

export function candidates(revisionId: string, after?: string) {
  const params = new URLSearchParams({ limit: "25" });
  if (after) params.set("after", after);
  return request<CandidatePage>(`catalog-matching/revisions/${revisionId}?${params}`);
}
export function candidateDetail(candidateId: string) {
  return request<Candidate>(`catalog-matching/candidates/${candidateId}`);
}
/** Registered source files of the actor's workspace, for exact evidence selection. */
export function evidenceFiles(after?: number) {
  const params = new URLSearchParams({ limit: "50" });
  if (after !== undefined) params.set("after", String(after));
  return request<EvidencePage>(`catalog-matching/evidence-files?${params}`);
}
export function proposeMatch(payload: object) {
  return command("catalog.propose_match", payload);
}
export function reviewMatch(payload: object, state: string) {
  return command("catalog.review_match", payload, state);
}
