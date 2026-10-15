import { runOperation } from "../workspace/api";

export type SearchField = "name" | "part_number" | "identifier" | "connector_family" | "kind";
export type SearchItem = {
  record_id: string;
  kind: string;
  label: string;
  latest_revision: number | null;
  latest_revision_id: string | null;
  match: { field: SearchField; text: string; rank: 0 | 1 | 2 };
};
export type LibrarySearch = { workspace_id: string; query: string; results: SearchItem[]; truncated: boolean };

export const SEARCH_LIMIT = 8;

/** Items of the workspace library matching a name, part number, identifier, connector family or kind. */
export async function searchLibrary(query: string, limit = SEARCH_LIMIT): Promise<LibrarySearch> {
  return (await runOperation<LibrarySearch>("library.search", { query, limit })).result;
}
