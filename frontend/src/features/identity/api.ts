import { randomUUID } from "../../lib/random-id";
export type Definition = { definition_id: string; name: string; kind: string; workspace_id?: string; latest_revision_number?: number | null; in_project?: boolean };
/** One page of the workspace library; at project scope referenced items come first. */
export type LibraryPage = { workspace_id: string; project_id: string | null; results: Definition[]; next_after: string | null };
export type Identity = Definition & {
  revisions: { revision_id: string; number: number }[];
  drafts: { draft_id: string; state: string; dependencies: string[] }[];
};
export type Representation = {
  representation_id: string; kind: string; label: string; revision_id: string; revision_number: number;
  definition_id: string; definition_name: string; definition_kind: string;
  source_bundle_revision_id: string; source_path: string; sha256: string; media_type: string; rights: string; rights_known: boolean;
};
export type SourceIdentifier = {
  source_identifier_id: string; revision_id: string; revision_number: number; definition_name: string;
  scheme: string; identifier: string; label: string; rights: string; rights_known: boolean;
};
export type Catalog = {
  revision_id: string;
  variants: { variant_id: string; manufacturer: string; part_number: string; association_basis: string }[];
  lots: { lot_id: string; variant_id: string | null; label: string }[];
  representations: Representation[];
  source_identifiers: SourceIdentifier[];
};

export async function read<T>(path: string): Promise<T> {
  const response = await fetch(`/api/v0/${path}`, { credentials: "same-origin" });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error?.message ?? `Request failed (${response.status})`);
  return body as T;
}

export async function command<T>(operation: string, payload: object, expectedState?: string): Promise<T> {
  const csrf = document.cookie.split("; ").find((cookie) => cookie.startsWith("csrftoken="))?.split("=")[1];
  const response = await fetch("/api/v0/operations", {
    method: "POST", credentials: "same-origin",
    headers: { "Content-Type": "application/json", "X-CSRFToken": decodeURIComponent(csrf ?? "") },
    body: JSON.stringify({ operation, payload, request_id: randomUUID(), idempotency_key: randomUUID(), expected_state: expectedState }),
  });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error?.message ?? `Operation failed (${response.status})`);
  return body.result as T;
}

/** Library definitions of the actor's workspace. A project id only orders its references first. */
export function libraryDefinitions(projectId?: string | null, after?: string | null, kind?: string) {
  const params = new URLSearchParams({ limit: "100" });
  if (projectId) params.set("project_id", projectId);
  if (after) params.set("after", after);
  if (kind) params.set("kind", kind);
  return read<LibraryPage>(`catalog/definitions?${params}`);
}

/** Every library definition (bounded pages) for pickers that list the whole workspace. */
export async function allLibraryDefinitions(projectId?: string | null, kind?: string): Promise<Definition[]> {
  const rows: Definition[] = [];
  let after: string | null = null;
  for (let page = 0; page < 20; page++) {
    const result: LibraryPage = await libraryDefinitions(projectId, after, kind);
    rows.push(...result.results);
    after = result.next_after;
    if (!after) break;
  }
  return rows;
}

type ProjectDetail = { project_id: string; state: string };

/**
 * "Use in this project": record a project reference to an existing workspace item. The item
 * itself is never created in, copied into or owned by the project.
 */
export async function addProjectReference(projectId: string, kind: "definition" | "revision" | "source_bundle", targetId: string, role: string) {
  const project = await read<ProjectDetail>(`access/projects/${encodeURIComponent(projectId)}`);
  return command("project.add_reference", { project_id: projectId, kind, target_id: targetId, role }, project.state);
}
