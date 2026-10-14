import { read } from "../identity/api";

export type SearchKind = "project" | "definition" | "source_bundle" | "variant" | "lot" | "stock";

export type SearchRecord = {
  record_id: string; workspace_id: string; project_id?: string; label: string; in_project?: boolean;
  definition_kind?: string; definition_id?: string; revision_id?: string;
  role?: string; association_basis?: string;
};
export type SearchPage = {
  kind: SearchKind; query: string; project_id: string | null; results: SearchRecord[]; next_after: string | null;
};
export type UseRecord = {
  record_id: string; snapshot_id: string; workspace_id: string; definition_id: string;
  definition_kind?: string; label: string; relation: "exact_revision_pin"; in_project?: boolean;
};
/** A project's declared use of a revision: an exact pin or a floating definition reference. */
export type ProjectUse = {
  reference_id: string; project_id: string; project_name: string; archived: boolean;
  kind: "revision" | "definition"; relation: "project_reference_exact" | "project_reference_floating";
  role: string; in_project: boolean;
};
export type UsePage = {
  revision_id: string; workspace_id: string; project_id: string | null; results: UseRecord[]; next_after: string | null;
  project_references: ProjectUse[]; project_references_truncated: boolean;
};
export type DefinitionRevisions = {
  definition_id: string; name: string; revisions: { revision_id: string; number: number }[];
};

export type ImpactPage = UsePage & {
  definition_id: string; definition_kind: string; current_number: number;
  candidate_revision_id: string; candidate_number: number;
  current_sha256: string; candidate_sha256: string; content_changed: boolean;
  dependency_pins_changed: boolean; adoption: "new_owning_draft_required";
  compatibility: "not_evaluated"; existing_pins: "retained";
};

export function revisionImpact(revisionId: string, candidateRevisionId: string, after?: string, projectId?: string | null) {
  const params = new URLSearchParams({ revision_id: revisionId, candidate_revision_id: candidateRevisionId, limit: "25" });
  if (after) params.set("after", after);
  if (projectId) params.set("project_id", projectId);
  return read<ImpactPage>(`catalog/revision-impact?${params}`);
}

/** Library search; a project id is context that lists that project's referenced items first. */
export function searchCatalog(kind: SearchKind, query: string, projectId?: string | null, after?: string) {
  const params = new URLSearchParams({ kind, query, limit: "25" });
  if (projectId) params.set("project_id", projectId);
  if (after) params.set("after", after);
  return read<SearchPage>(`catalog/search?${params}`);
}

export function whereUsed(revisionId: string, after?: string, projectId?: string | null) {
  const params = new URLSearchParams({ revision_id: revisionId, limit: "25" });
  if (after) params.set("after", after);
  if (projectId) params.set("project_id", projectId);
  return read<UsePage>(`catalog/where-used?${params}`);
}

export function revisionsOf(definitionId: string, offset = 0) {
  return read<DefinitionRevisions>(`catalog/definitions/${definitionId}?offset=${offset}&limit=50`);
}
