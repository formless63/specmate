import { MantineProvider } from "@mantine/core";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { PermissionsProvider } from "../../lib/permissions";
import { grants } from "../../test/grants";
import { AgentRunsPanel } from "./AgentRunsPanel";
import type { ReviewPackage, RunStep, RunSummary } from "./api";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
beforeEach(() => { vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} }); HTMLElement.prototype.scrollIntoView = vi.fn(); });

const run: RunSummary = {
  run_id: "run-1", workspace_id: "ws", project_id: null, title: "Synthetic stock cleanup", purpose: "Normalize synthetic drafts",
  sponsor: "sponsor", agent: "agent", status: "paused", status_reason: "boundary: draft.freeze (requires design.freeze)", state: "agent-run-v5",
  grant: { allowed_actions: ["definition.create", "draft.update"], boundary_actions: [] },
  budget: { max_actions: 10, actions_used: 2, actions_remaining: 8, checkpoint_every: null, actions_since_checkpoint: 2 },
  deadline: "2026-01-01T12:00:00+00:00", review: { decision: null, reviewed_by: null, reviewed_at: null, note: "" },
  created_at: "2026-01-01T08:00:00+00:00", updated_at: "2026-01-01T09:00:00+00:00",
};
const step = (number: number, kind: RunStep["kind"], outcome: string, operation: string | null, note = ""): RunStep => ({
  step_id: `step-${number}`, number, kind, outcome, step_key: kind === "action" || kind === "boundary" ? `k${number}` : null, operation, payload: {}, expected_state: null,
  result: null, error: null, changes: [], note, budget_consumed: kind === "action" ? 1 : 0, actor: "agent", on_behalf_of: kind === "action" ? "sponsor" : null, request_id: `req-${number}`, created_at: "2026-01-01T09:00:00+00:00",
});
const steps = [step(1, "lifecycle", "created", null), step(2, "action", "applied", "draft.update"), step(3, "boundary", "blocked", "draft.freeze", "Stopped before draft.freeze: requires design.freeze.")];
const pkg: ReviewPackage = {
  run, log_sha256: "a".repeat(64),
  counts: { steps: 3, applied: 1, failed: 0, boundary_stops: 1, proposals: 0, checkpoints: 0, reverts: 0, changed_records: 1 },
  changes: [{
    step_id: "step-2", step_number: 2, operation: "draft.update", record: "design.draft:d1", model: "design.draft", pk: "d1", action: "updated",
    changed_fields: ["content", "version"],
    diffs: { content: { added: { finish: "tinned" }, removed: {}, changed: { gauge: { before: "unknown", after: "22" } } }, version: { before: 1, after: 2 } },
    current: "unchanged_since_step", reverted: false, revertible: true,
    provenance: { agent: "agent", on_behalf_of: "sponsor", step_key: "k2", request_id: "req-2", payload: {}, expected_state: "draft-v1", at: "2026-01-01T09:00:00+00:00" },
  }],
  boundary_stops: [steps[2]!], proposals: [], failures: [], checkpoints: [], reverts: [], truncated_steps: [],
  limitations: ["Changes are captured from model saves."],
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

function withCreated(revert: NonNullable<ReviewPackage["changes"][number]["revert"]>) {
  const [first] = pkg.changes;
  pkg.changes = [{ ...first!, action: "created", model: "design.definition", record: "design.definition:x1", revertible: revert.revertible, revert, diffs: {} }];
}

function fixture() {
  const calls: { operation: string; payload: Record<string, unknown>; expected_state?: string; idempotency_key?: string }[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, options?: RequestInit) => {
    if (url.endsWith("/api/v0/operations")) {
      const body = JSON.parse(String(options?.body)); calls.push(body);
      return json({ operation: body.operation, request_id: "r", status: "completed", replayed: false, result: { run: { ...run, run_id: body.operation === "agent_run.create" ? "run-2" : run.run_id } } });
    }
    if (url.startsWith("/api/v0/discovery/capabilities")) return json({ operations: [
      { operation: "draft.update", attachments: [], async: false, access: { kind: "workspace", minimum_workspace_permission: "design.edit" }, availability: { status: "available" } },
      { operation: "draft.freeze", attachments: [], async: false, access: { kind: "workspace", minimum_workspace_permission: "design.freeze" }, availability: { status: "available" } },
      { operation: "agent_run.act", attachments: [], async: false, access: { kind: "workspace", minimum_workspace_permission: "workspace.read" }, availability: { status: "available" } },
    ] });
    if (url.endsWith("/review-package")) return json(pkg);
    if (url.startsWith("/api/v0/agent-runs?")) return json({ workspace_id: "ws", runs: [run] });
    if (url.startsWith("/api/v0/agent-runs/")) return json({ run, steps });
    return json({ error: { message: "unexpected" } }, 404);
  }));
  return calls;
}

function panel(permissions: string[], username = "sponsor") {
  return <MantineProvider><PermissionsProvider permissions={permissions}><AgentRunsPanel workspaceId="ws" username={username} principalKey={username} /></PermissionsProvider></MantineProvider>;
}

function multiInput(name: string, scope: { getByText: typeof screen.getByText } = screen) {
  const label = scope.getByText(name, { selector: "label" }) as HTMLLabelElement;
  return document.getElementById(label.htmlFor) as HTMLInputElement;
}

async function openRun() {
  fireEvent.click(await screen.findByRole("button", { name: "Open run Synthetic stock cleanup" }));
  return screen.findByRole("region", { name: "Run Synthetic stock cleanup" });
}

test("run detail shows one fact per header cell, the step log and a review package with diffs and provenance", async () => {
  fixture(); render(panel(grants({ edit: true })));
  const region = await openRun();
  const r = within(region);
  await r.findByText("Review package");
  expect(r.getByText("2 of 10")).toBeTruthy();
  expect(r.getByText("boundary: draft.freeze (requires design.freeze)")).toBeTruthy();
  expect(r.getByRole("cell", { name: '"unknown"' })).toBeTruthy();
  expect(r.getByRole("cell", { name: '"22"' })).toBeTruthy();
  expect(r.getByRole("cell", { name: '"tinned"' })).toBeTruthy();
  expect(r.getAllByText(/agent for sponsor/).length).toBe(2);
  expect(r.getAllByText(/draft\.freeze/).length).toBeGreaterThan(0);
  expect(r.getByRole("button", { name: "Revert this draft change" })).toBeTruthy();
});

test("sponsor resumes with expected state and explicitly grants the stopped boundary", async () => {
  const calls = fixture(); render(panel(["workspace.read", "design.edit"]));
  const region = await openRun();
  const r = within(region);
  await r.findByText("Grant stopped boundaries", { selector: "label" });
  const input = multiInput("Grant stopped boundaries", r);
  fireEvent.focus(input); fireEvent.click(input);
  fireEvent.click(await screen.findByRole("option", { name: "draft.freeze", hidden: true }));
  fireEvent.click(r.getByRole("button", { name: "Resume run" }));
  await waitFor(() => expect(calls.some((c) => c.operation === "agent_run.resume")).toBe(true));
  const resume = calls.find((c) => c.operation === "agent_run.resume")!;
  expect(resume.expected_state).toBe("agent-run-v5");
  expect(resume.payload).toMatchObject({ run_id: "run-1", grant_boundary_actions: ["draft.freeze"], add_actions: 0, deadline: null });
});

test("revert and review post the run operations", async () => {
  const calls = fixture(); render(panel(grants({ edit: true }), "reviewer"));
  const region = await openRun();
  fireEvent.click(await within(region).findByRole("button", { name: "Revert this draft change" }));
  await waitFor(() => expect(calls.find((c) => c.operation === "agent_run.revert_change")?.payload).toEqual({ run_id: "run-1", step_id: "step-2", record: "design.draft:d1" }));
  const again = await openRun();
  fireEvent.click(await within(again).findByRole("button", { name: "Record review" }));
  await waitFor(() => expect(calls.find((c) => c.operation === "agent_run.review")?.payload).toMatchObject({ run_id: "run-1", decision: "accepted" }));
  // A non-sponsor without admin sees no resume or cancel controls.
  expect(within(again).queryByRole("button", { name: "Resume run" })).toBeNull();
  expect(within(again).queryByRole("button", { name: "Cancel run" })).toBeNull();
});

test("read-only members inspect runs without authoring, revert or review controls", async () => {
  fixture(); render(panel(["workspace.read"], "viewer"));
  const region = await openRun();
  await within(region).findByText("Review package");
  expect(within(region).queryByRole("button", { name: "Revert this draft change" })).toBeNull();
  expect(within(region).queryByRole("button", { name: "Record review" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Start run" })).toBeNull();
  expect(screen.getAllByRole("note").some((note) => note.textContent?.includes("Starting a run needs contributor access"))).toBe(true);
});

test("starting a run offers only usable non-run operations and sends a bounded grant", async () => {
  const calls = fixture(); render(panel(grants({ edit: true })));
  fireEvent.change(await screen.findByRole("textbox", { name: "Run title" }), { target: { value: "New synthetic run" } });
  const allowed = multiInput("Allowed draft actions");
  fireEvent.focus(allowed); fireEvent.click(allowed);
  const option = await screen.findByRole("option", { name: "draft.update", hidden: true });
  expect(screen.queryByRole("option", { name: "agent_run.act", hidden: true })).toBeNull();
  fireEvent.click(option);
  fireEvent.click(screen.getByRole("button", { name: "Start run" }));
  await waitFor(() => expect(calls.some((c) => c.operation === "agent_run.create")).toBe(true));
  const create = calls.find((c) => c.operation === "agent_run.create")!;
  expect(create.payload).toMatchObject({ workspace_id: "ws", title: "New synthetic run", allowed_actions: ["draft.update"], boundary_actions: [], max_actions: 20, agent_username: null });
  expect(typeof create.idempotency_key).toBe("string");
});

test("a created record that is frozen explains what blocks the discard", async () => {
  const original = pkg.changes;
  withCreated({ kind: "discard", revertible: false, blockers: [{ kind: "frozen", model: "design.revision", count: 1, reason: "1 frozen revision(s) exist" }] });
  try {
    fixture(); render(panel(grants({ edit: true })));
    const r = within(await openRun());
    await r.findByText("Cannot be discarded");
    expect(r.getByText("1 frozen revision(s) exist")).toBeTruthy();
    expect(r.queryByRole("button", { name: "Discard this created draft" })).toBeNull();
  } finally { pkg.changes = original; }
});

test("an unreferenced created record offers the discard", async () => {
  const original = pkg.changes;
  withCreated({ kind: "discard", revertible: true, blockers: [] });
  try {
    fixture(); render(panel(grants({ edit: true })));
    const r = within(await openRun());
    expect(await r.findByRole("button", { name: "Discard this created draft" })).toBeTruthy();
  } finally { pkg.changes = original; }
});
