import { apiErrorMessage } from "../../lib/api-errors";
import { randomUUID } from "../../lib/random-id";
export type SessionState = {
  user: { id: string; username: string } | null;
  owner_setup_required: boolean;
};
/**
 * A project in the signed-in principal's workspace. Every member sees every project;
 * `permissions` are the principal's workspace permissions (projects are not access scopes).
 */
export type Project = {
  project_id: string;
  name: string;
  permissions?: string[];
  purpose?: string;
  archived?: boolean;
  created_by?: string;
  references?: KindCount[];
  dependents?: Record<string, number>;
  can_delete?: boolean;
};
export type KindCount = { kind: string; count: number };
export type OperationResult<T> = {
  operation: string;
  request_id: string;
  status: "completed" | "accepted_async";
  replayed: boolean;
  result: T;
};

export class ApiError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
  }
}

function csrfToken(): string {
  const cookie = document.cookie.split(";").map((item) => item.trim())
    .find((item) => item.startsWith("csrftoken="));
  return cookie ? decodeURIComponent(cookie.slice("csrftoken=".length)) : "";
}

export async function requestJson<T>(path: string, options: RequestInit = {}): Promise<T> {
  const headers = new Headers(options.headers);
  const method = (options.method ?? "GET").toUpperCase();
  if (!["GET", "HEAD", "OPTIONS"].includes(method)) {
    headers.set("X-CSRFToken", csrfToken());
    if (!(options.body instanceof FormData)) headers.set("Content-Type", "application/json");
  }
  const response = await fetch(path, { ...options, headers, credentials: "same-origin" });
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const error = body as { error?: { message?: string } } | null;
    throw new ApiError(response.status, apiErrorMessage(error, `Request failed (HTTP ${response.status}).`));
  }
  return body as T;
}

export function runOperation<T>(
  operation: string,
  payload: unknown,
  options: { expectedState?: string; idempotencyKey?: string } = {},
): Promise<OperationResult<T>> {
  return requestJson("/api/v0/operations", {
    method: "POST",
    body: JSON.stringify({ operation, payload, request_id: randomUUID(),
      expected_state: options.expectedState, idempotency_key: options.idempotencyKey }),
  });
}

/* ---- Workspace reads: the library, the project list and resolved references ---- */

export type LibraryFamily = "definition" | "source_bundle" | "physical_unit" | "stock_account" | "fact_subject";
export type ReferenceKind = "definition" | "revision" | "source_bundle" | "physical_unit" | "work_batch" | "release";
export type UsedIn = { reference_id: string; project_id: string; project_name: string; archived: boolean; pin: "floating" | "exact"; revision: number | null; role: string };
export type LibraryRecord = {
  record_id: string;
  family: LibraryFamily;
  kind: string | null;
  label: string;
  detail: string | null;
  created_at: string;
  latest_revision: number | null;
  latest_revision_id?: string | null;
  changed_at: string | null;
  referenceable: boolean;
  /** Referenced by the context project; null without one. */
  referenced: boolean | null;
  used_in: UsedIn[];
  used_in_total: number;
};
export type LibraryPage = { workspace_id: string; family: LibraryFamily; project_id: string | null; results: LibraryRecord[]; next_after: string | null };
export type WorkspaceProjectPage = { workspace_id: string; role: string; permissions: string[]; results: Project[]; total: number; next_after: string | null };
export type ResolvedReference = {
  reference_id: string;
  kind: ReferenceKind;
  target_id: string;
  pin: "floating" | "exact";
  role: string;
  note: string;
  added_by: string;
  added_at: string;
  removed: boolean;
  removed_at: string | null;
  removal_reason: string;
  label: string;
  item_kind: string | null;
  definition_id: string | null;
  revision: number | null;
  latest_revision: number | null;
};
export type ProjectDetail = {
  project_id: string;
  workspace_id: string;
  name: string;
  purpose: string;
  archived: boolean;
  archived_at: string | null;
  created_by: string;
  state: string;
  permissions: string[];
  references: ResolvedReference[];
  dependents: Record<string, number>;
  can_delete: boolean;
};

export function listLibrary(params: { family: LibraryFamily; kinds: string[]; query: string; projectId: string | null; referencedOnly?: boolean; includeSuperseded?: boolean; after: string | null; limit?: number }): Promise<LibraryPage> {
  const search = new URLSearchParams({ family: params.family, limit: String(params.limit ?? 50) });
  for (const kind of params.kinds) search.append("kinds", kind);
  if (params.query) search.set("query", params.query);
  if (params.projectId) search.set("project_id", params.projectId);
  if (params.referencedOnly) search.set("referenced_only", "true");
  if (params.includeSuperseded) search.set("include_superseded", "true");
  if (params.after) search.set("after", params.after);
  return requestJson(`/api/v0/workspace/library?${search.toString()}`);
}

/** Every project in the workspace (archived included), following the server's pages. */
export async function listWorkspaceProjects(): Promise<WorkspaceProjectPage> {
  let after: string | null = null;
  let first: WorkspaceProjectPage | null = null;
  const results: Project[] = [];
  do {
    const search = new URLSearchParams({ include_archived: "true", limit: "200" });
    if (after) search.set("after", after);
    const page: WorkspaceProjectPage = await requestJson(`/api/v0/workspace/projects?${search.toString()}`);
    first ??= page;
    results.push(...page.results.map((project) => ({ ...project, permissions: page.permissions })));
    after = page.next_after;
  } while (after);
  return { ...(first as WorkspaceProjectPage), results, next_after: null };
}

export function readProjectDetail(projectId: string, includeRemoved = false): Promise<ProjectDetail> {
  return requestJson(`/api/v0/workspace/projects/${encodeURIComponent(projectId)}${includeRemoved ? "?include_removed=true" : ""}`);
}

/** Project edits go through the shared operation endpoint under the project's state token. */
export function addReference(project: { project_id: string; state: string }, target: { kind: ReferenceKind; targetId: string; role: string; note?: string }) {
  return runOperation<{ reference: ResolvedReference; state: string }>("project.add_reference",
    { project_id: project.project_id, kind: target.kind, target_id: target.targetId, role: target.role, note: target.note ?? "" }, { expectedState: project.state });
}

export function removeReference(project: { project_id: string; state: string }, referenceId: string, reason: string) {
  return runOperation<{ state: string }>("project.remove_reference", { project_id: project.project_id, reference_id: referenceId, reason }, { expectedState: project.state });
}
