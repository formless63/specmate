import { expect, test } from "vitest";
import { summarize, type Finding, type WorkspaceStatus } from "./status";

const base: WorkspaceStatus = {
  workspace_id: "w", evaluated_at: "2026-01-01T00:00:00Z",
  work: { mode: "running", accepting_new_work: true, reason: "", state_token: "work-v0" },
  queue: { states: {}, pending: 0, active: 0, oldest_pending_seconds: null },
  dispatch: { undelivered: 0, oldest_undelivered_seconds: null },
  runner: { state: "not_enrolled", credentials_usable: 0, stages_holding_lease: 0, stages_lease_expired: 0 },
  tools: [], storage: { state: "available", code: null, sampled: 0 }, workflow_engine: { state: "not_evaluated" },
  builds: [], can_execute: true, findings: [],
};
const finding = (category: Finding["category"], severity: Finding["severity"]): Finding => ({ code: category, category, severity, summary: "s", recovery: "r", evidence: {} });

test("an unread status is not evaluated and a failed read is unavailable, never a stale good state", () => {
  expect(summarize(null)).toEqual({ led: "not-evaluated", words: "Status not evaluated" });
  expect(summarize(null, "HTTP 500")).toEqual({ led: "not-evaluated", words: "Status unavailable" });
});

test("idle says why nothing runs and never claims a generic OK", () => {
  const idle = summarize(base);
  expect(idle.led).toBe("idle");
  expect(idle.words).toBe("No jobs · Runner not enrolled");
  expect(`${idle.words}`.toLowerCase()).not.toMatch(/\bok\b|healthy/);
});

test("queue and running counts come from the project's own status", () => {
  expect(summarize({ ...base, queue: { ...base.queue, active: 2, pending: 1 } })).toEqual({ led: "active", words: "2 running, 1 queued" });
  expect(summarize({ ...base, queue: { ...base.queue, pending: 3 } })).toEqual({ led: "review", words: "3 queued, none running" });
});

test("each failure category keeps its own words and blocking findings outrank attention", () => {
  expect(summarize({ ...base, findings: [finding("storage_failure", "blocking")] })).toEqual({ led: "failed", words: "Storage failure" });
  expect(summarize({ ...base, findings: [finding("stale_evidence", "attention"), finding("tool_unavailable", "blocking")] })).toEqual({ led: "failed", words: "Tool unavailable +1" });
  expect(summarize({ ...base, findings: [finding("permission_denied", "attention")] })).toEqual({ led: "review", words: "Permission denied" });
  expect(summarize({ ...base, findings: [finding("permission_denied", "info")] }).led).toBe("idle");
});

test("draining is visible even with no other finding", () => {
  const draining = summarize({ ...base, work: { ...base.work, mode: "draining" }, queue: { ...base.queue, active: 1 }, findings: [finding("work_paused", "info")] });
  expect(draining).toEqual({ led: "review", words: "Draining: no new work, 1 unfinished" });
});
