import { read } from "../identity/api";

export type SearchKind = "project" | "definition" | "source_bundle" | "variant" | "lot" | "stock";

export type SearchRecord = {
  record_id: string; project_id: string; label: string;
  definition_kind?: string; definition_id?: string; revision_id?: string;
  role?: string; association_basis?: string;
};
export type SearchPage = {
  kind: SearchKind; query: string; results: SearchRecord[]; next_after: string | null;
};
export type UseRecord = {
  record_id: string; snapshot_id: string; project_id: string; definition_id: string;
  label: string; relation: "exact_revision_pin";
};
export type UsePage = { revision_id: string; results: UseRecord[]; next_after: string | null };
export type DefinitionRevisions = {
  definition_id: string; name: string; revisions: { revision_id: string; number: number }[];
};

export function searchCatalog(kind: SearchKind, query: string, projectId?: string, after?: string) {
  const params = new URLSearchParams({ kind, query, limit: "25" });
  if (projectId) params.set("project_id", projectId);
  if (after) params.set("after", after);
  return read<SearchPage>(`catalog/search?${params}`);
}

export function whereUsed(revisionId: string, after?: string) {
  const params = new URLSearchParams({ revision_id: revisionId, limit: "25" });
  if (after) params.set("after", after);
  return read<UsePage>(`catalog/where-used?${params}`);
}

export function revisionsOf(definitionId: string, offset = 0) {
  return read<DefinitionRevisions>(`catalog/definitions/${definitionId}?offset=${offset}&limit=50`);
}
