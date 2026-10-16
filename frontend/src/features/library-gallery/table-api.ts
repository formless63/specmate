import { requestJson, type LibraryPage, type LibraryRecord } from "../workspace/api";

export type LibraryField = { key: string; label: string; value: string | number | null; unit: string | null };
export type LibrarySummary = {
  basis: "latest_frozen" | "newest_draft" | "unknown";
  revision_id: string | null;
  draft_id: string | null;
  draft_version: number | null;
  numbers: { manufacturer: string; value: string; basis: "manufacturer_variant" }[];
  numbers_truncated?: boolean;
  fields: LibraryField[];
  flags: string[];
};
export type LibraryTableRecord = LibraryRecord & { summary: LibrarySummary };
export type LibraryTablePage = Omit<LibraryPage, "results"> & { results: LibraryTableRecord[] };

export function listLibraryTable(params: { kinds: string[]; query: string; projectFilterId: string | null; after: string | null; catalogClass?: 'parts' | 'hardware' | 'kits' }): Promise<LibraryTablePage> {
  const search = new URLSearchParams({ limit: "50" });
  for (const kind of params.kinds) search.append("kinds", kind);
  if (params.query) search.set("query", params.query);
  if (params.projectFilterId) { search.set("project_id", params.projectFilterId); search.set("referenced_only", "true"); }
  if (params.after) search.set("after", params.after);
  if (params.catalogClass) search.set('catalog_class', params.catalogClass);
  return requestJson(`/api/v0/workspace/library-table?${search}`);
}
