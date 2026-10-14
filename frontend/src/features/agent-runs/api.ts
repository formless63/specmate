import { randomUUID } from "../../lib/random-id";
import { requestJson, runOperation } from "../workspace/api";

export type RunStatus = "active" | "paused" | "exhausted" | "expired" | "completed" | "cancelled";
export type RunSummary = {
  run_id: string; workspace_id: string; project_id: string | null; title: string; purpose: string;
  sponsor: string; agent: string; status: RunStatus; status_reason: string; state: string;
  grant: { allowed_actions: string[]; boundary_actions: string[] };
  budget: { max_actions: number; actions_used: number; actions_remaining: number; checkpoint_every: number | null; actions_since_checkpoint: number };
  deadline: string;
  review: { decision: "accepted" | "changes_requested" | "rejected" | null; reviewed_by: string | null; reviewed_at: string | null; note: string };
  created_at: string; updated_at: string;
};
export type RunStep = {
  step_id: string; number: number; kind: "action" | "boundary" | "proposal" | "checkpoint" | "lifecycle" | "revert";
  outcome: string; step_key: string | null; operation: string | null; payload: unknown; expected_state: string | null;
  result: unknown; error: { code: string; message: string } | null; changes: unknown[]; note: string;
  budget_consumed: number; actor: string; on_behalf_of: string | null; request_id: string; created_at: string;
};
export type FieldDiff = { before: unknown; after: unknown } | { added: Record<string, unknown>; removed: Record<string, unknown>; changed: Record<string, { before: unknown; after: unknown }> };
export type PackageChange = {
  step_id: string; step_number: number; operation: string; record: string; model: string; pk: string;
  action: "created" | "updated" | "deleted"; changed_fields: string[]; diffs: Record<string, FieldDiff>;
  current: "unchanged_since_step" | "changed_since_step" | "missing" | "unknown"; reverted: boolean; revertible: boolean;
  provenance: { agent: string; on_behalf_of: string | null; step_key: string | null; request_id: string; payload: unknown; expected_state: string | null; at: string };
};
export type ReviewPackage = {
  run: RunSummary; log_sha256: string;
  counts: { steps: number; applied: number; failed: number; boundary_stops: number; proposals: number; checkpoints: number; reverts: number; changed_records: number };
  changes: PackageChange[]; boundary_stops: RunStep[]; proposals: RunStep[]; failures: RunStep[]; checkpoints: RunStep[]; reverts: RunStep[];
  truncated_steps: number[]; limitations: string[];
};

export function listRuns(workspaceId: string, projectId: string | null, status: string | null) {
  const query = new URLSearchParams({ workspace_id: workspaceId });
  if (projectId) query.set("project_id", projectId);
  if (status) query.set("status", status);
  return requestJson<{ runs: RunSummary[] }>(`/api/v0/agent-runs?${query.toString()}`);
}

export function readRun(runId: string) {
  return requestJson<{ run: RunSummary; steps: RunStep[] }>(`/api/v0/agent-runs/${encodeURIComponent(runId)}`);
}

export function readPackage(runId: string) {
  return requestJson<ReviewPackage>(`/api/v0/agent-runs/${encodeURIComponent(runId)}/review-package`);
}

/** Every run mutation goes through the shared operation envelope. */
export async function runCommand(operation: string, payload: object, options: { expectedState?: string; idempotent?: boolean } = {}) {
  const result = await runOperation<{ run: RunSummary }>(operation, payload, {
    expectedState: options.expectedState, idempotencyKey: options.idempotent ? randomUUID() : undefined,
  });
  return result.result.run;
}

/** Permissions whose operations are boundaries; a run needs each of them granted by name. */
export const BOUNDARY_PERMISSIONS = new Set(["design.freeze", "build.execute", "inventory.manage", "inventory.reserve", "workspace.admin"]);
