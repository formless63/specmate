import { vi } from "vitest";
import type { LibraryRecord, Project, ProjectDetail } from "../features/workspace/api";

/** A synthetic workspace backend for shell, home and overview tests. */
export const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
export const signedIn = { user: { id: "7", username: "local-user" }, owner_setup_required: false };

export const ROLE_PERMISSIONS: Record<string, string[]> = {
  viewer: ["workspace.read"],
  contributor: ["item.create", "project.edit", "source.register", "workspace.read"],
  editor: ["design.edit", "design.freeze", "inventory.reserve", "item.create", "project.edit", "source.register", "workspace.read"],
  admin: ["build.execute", "design.edit", "design.freeze", "inventory.manage", "inventory.reserve", "item.create", "project.edit", "source.register", "workspace.admin", "workspace.read"],
};

export type WorkspaceState = {
  authenticated: boolean;
  /** Null: not a member (the projects read answers 404). */
  role: string | null;
  projects: Project[];
  library: LibraryRecord[];
  details: Record<string, Partial<ProjectDetail>>;
  operations: { operation: string; payload: Record<string, unknown>; expected_state?: string }[];
};

export function project(id: string, name: string, extra: Partial<Project> = {}): Project {
  return { project_id: id, name, purpose: "", archived: false, created_by: "local-user", references: [], dependents: {}, can_delete: true, ...extra };
}

export function record(id: string, label: string, extra: Partial<LibraryRecord> = {}): LibraryRecord {
  return { record_id: id, family: "definition", kind: "cable", label, detail: null, created_at: "2026-01-02T00:00:00Z", latest_revision: null,
    latest_revision_id: null, changed_at: null, referenceable: true, referenced: null, used_in: [], used_in_total: 0, ...extra };
}

export function detailFor(state: WorkspaceState, id: string): ProjectDetail {
  const base = state.projects.find((p) => p.project_id === id);
  return { project_id: id, workspace_id: "w1", name: base?.name ?? id, purpose: base?.purpose ?? "", archived: !!base?.archived, archived_at: null,
    created_by: base?.created_by ?? "local-user", state: `state-${id}`, permissions: ROLE_PERMISSIONS[state.role ?? "viewer"] ?? [], references: [],
    dependents: base?.dependents ?? {}, can_delete: !!base?.can_delete, ...state.details[id] };
}

/**
 * Stubs fetch. `extra` answers anything else (return undefined to fall through to an error).
 */
export function workspaceServer(initial: Partial<WorkspaceState> = {}, extra?: (path: string, init?: RequestInit) => Response | undefined) {
  const state: WorkspaceState = { authenticated: true, role: "editor", projects: [], library: [], details: {}, operations: [], ...initial };
  const fetchMock = vi.fn(async (path: string, init?: RequestInit) => {
    const url = new URL(path, "http://test");
    if (path === "/api/v0/operations") state.operations.push(JSON.parse(String(init?.body)) as WorkspaceState["operations"][number]);
    const answered = extra?.(path, init);
    if (answered) return answered;
    if (path === "/api/v0/session") return reply(state.authenticated ? signedIn : { user: null, owner_setup_required: false });
    if (path === "/api/v0/session/login") { state.authenticated = true; return reply({ result: {} }); }
    if (path === "/api/v0/session/logout") { state.authenticated = false; return reply({ result: {} }); }
    if (url.pathname === "/api/v0/workspace/projects") {
      if (!state.role) return reply({ error: { message: "Not found." } }, 404);
      return reply({ workspace_id: "w1", role: state.role, permissions: ROLE_PERMISSIONS[state.role], results: state.projects, total: state.projects.length, next_after: null });
    }
    if (url.pathname.startsWith("/api/v0/workspace/projects/")) return reply(detailFor(state, decodeURIComponent(url.pathname.split("/").pop() ?? "")));
    if (url.pathname === "/api/v0/workspace/library") {
      const projectId = url.searchParams.get("project_id");
      const referencedOnly = url.searchParams.get("referenced_only") === "true";
      const rows = state.library.map((row) => ({ ...row, referenced: projectId ? row.used_in.some((use) => use.project_id === projectId) : null }))
        .filter((row) => !referencedOnly || row.referenced);
      return reply({ workspace_id: "w1", family: url.searchParams.get("family"), project_id: projectId, results: rows, next_after: null });
    }
    if (path === "/api/v0/operations") {
      const body = state.operations[state.operations.length - 1]!;
      if (body.operation === "library.home") {
        const kinds = [...new Set(state.library.map((row) => row.kind ?? ""))].map((kind) => ({ kind, count: state.library.filter((row) => row.kind === kind).length }));
        return reply({ result: { workspace_id: "w1", attention: [], attention_total: 0, recent: [], kinds, definitions_total: state.library.length, scan_limit_reached: false,
          totals: { failing_checks: 0, unknown_checks: 0, open_questions: 0, stale_evidence: 0, unknown_values: 0 } } });
      }
      if (body.operation === "library.previews") return reply({ result: { workspace_id: "w1", previews: [] } });
      if (body.operation === "project.create") {
        const created = project(`p${state.projects.length + 1}`, String(body.payload.name));
        state.projects = [...state.projects, created];
        return reply({ result: created });
      }
      return reply({ result: { state: "next" } });
    }
    if (path.includes("/inbox") || path.includes("/reviews")) return reply({ results: [], next_after: null });
    throw new Error(`Unexpected request ${path} ${init?.method ?? "GET"}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return { state, fetchMock };
}
