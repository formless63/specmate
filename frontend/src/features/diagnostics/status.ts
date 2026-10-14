import { requestJson } from "../workspace/api";

export type Category = "tool_unavailable" | "storage_failure" | "permission_denied" | "stale_evidence"
  | "dispatch_stalled" | "work_paused" | "service_unavailable";

export type Finding = {
  code: string; category: Category; severity: "blocking" | "degraded" | "attention" | "info";
  summary: string; recovery: string; evidence: Record<string, unknown>;
};

export type StatusBuild = {
  build_id: string; recipe_id: string; state: string; state_token: string;
  cancellation_requested: boolean; lease_expired: boolean;
};

export type WorkspaceStatus = {
  workspace_id: string; evaluated_at: string;
  work: { mode: "running" | "draining" | "interrupting"; accepting_new_work: boolean; reason: string; state_token: string };
  queue: { states: Record<string, number>; pending: number; active: number; oldest_pending_seconds: number | null };
  dispatch: { undelivered: number; oldest_undelivered_seconds: number | null };
  runner: { state: string; credentials_usable: number; stages_holding_lease: number; stages_lease_expired: number };
  tools: { recipe_id: string; status: string; builds: number }[];
  storage: { state: string; code: string | null; sampled: number; missing?: number };
  workflow_engine: { state: string; reason?: string };
  builds: StatusBuild[];
  can_execute: boolean;
  findings: Finding[];
};

export function readWorkspaceStatus(workspaceId: string, signal?: AbortSignal): Promise<WorkspaceStatus> {
  return requestJson<WorkspaceStatus>(`/api/v0/diagnostics/workspaces/${encodeURIComponent(workspaceId)}/status`, { signal });
}

export const CATEGORY_LABEL: Record<Category, string> = {
  tool_unavailable: "Tool unavailable", storage_failure: "Storage failure", permission_denied: "Permission denied",
  stale_evidence: "Stale evidence", dispatch_stalled: "Dispatch stalled", work_paused: "Work paused",
  service_unavailable: "Service unavailable",
};

export const RUNNER_LABEL: Record<string, string> = {
  not_enrolled: "Runner not enrolled", credential_unusable: "Runner credential unusable", working: "Runner working",
  lease_expired: "Runner lease expired", enrolled_liveness_unknown: "Runner enrolled, liveness unknown",
};

export type LedState = "active" | "review" | "failed" | "idle" | "not-evaluated";
export type Headline = { led: LedState; words: string };

const SEVERITY_RANK = { blocking: 3, degraded: 2, attention: 2, info: 1 } as const;

/** One line of words for the top bar. There is deliberately no generic "OK": idle says why nothing runs. */
export function summarize(status: WorkspaceStatus | null, failure: string | null = null): Headline {
  if (!status) return { led: "not-evaluated", words: failure ? "Status unavailable" : "Status not evaluated" };
  const raised = status.findings.filter((item) => item.severity !== "info")
    .sort((a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity]);
  const first = raised[0];
  if (first) {
    const categories = [...new Set(raised.map((item) => item.category))];
    const label = CATEGORY_LABEL[first.category];
    return { led: first.severity === "blocking" ? "failed" : "review", words: categories.length > 1 ? `${label} +${categories.length - 1}` : label };
  }
  if (status.work.mode === "draining") return { led: "review", words: `Draining: no new work, ${status.queue.pending + status.queue.active} unfinished` };
  if (status.queue.active > 0) return { led: "active", words: `${status.queue.active} running${status.queue.pending ? `, ${status.queue.pending} queued` : ""}` };
  if (status.queue.pending > 0) return { led: "review", words: `${status.queue.pending} queued, none running` };
  return { led: "idle", words: `No jobs · ${RUNNER_LABEL[status.runner.state] ?? "runner state unknown"}` };
}
