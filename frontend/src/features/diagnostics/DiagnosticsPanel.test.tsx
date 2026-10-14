import { MantineProvider } from "@mantine/core";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { PermissionsProvider } from "../../lib/permissions";
import { DiagnosticsPanel } from "./DiagnosticsPanel";
import { StatusIndicator } from "./StatusIndicator";
import type { WorkspaceStatus } from "./status";

beforeEach(() => { vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} }); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const status: WorkspaceStatus = {
  workspace_id: "w1", evaluated_at: "2026-01-01T12:00:00Z",
  work: { mode: "running", accepting_new_work: true, reason: "", state_token: "work-v0" },
  queue: { states: { queued: 1, running: 1 }, pending: 1, active: 1, oldest_pending_seconds: 5 },
  dispatch: { undelivered: 0, oldest_undelivered_seconds: null },
  runner: { state: "working", credentials_usable: 1, stages_holding_lease: 1, stages_lease_expired: 0 },
  tools: [], storage: { state: "degraded", code: "storage_blobs_missing", sampled: 2, missing: 1 },
  workflow_engine: { state: "not_evaluated" },
  builds: [
    { build_id: "b1", recipe_id: "synthetic-check-r1", state: "queued", state_token: "stage-v2", cancellation_requested: false, lease_expired: false },
    { build_id: "b2", recipe_id: "synthetic-check-r1", state: "running", state_token: "stage-v4", cancellation_requested: false, lease_expired: true },
  ],
  can_execute: true,
  findings: [
    { code: "storage_blobs_missing", category: "storage_failure", severity: "blocking", summary: "Some recorded files are missing.", recovery: "Ask the operator to restore them.", evidence: { build_ids: ["b9"] } },
    { code: "lease_expired_unreconciled", category: "stale_evidence", severity: "attention", summary: "A stage lease expired.", recovery: "Wait for the runner.", evidence: { build_ids: ["b2"] } },
  ],
};
const reply = (body: unknown, code = 200) => new Response(JSON.stringify(body), { status: code });

function show(permissions: string[], fetchMock: ReturnType<typeof vi.fn>) {
  vi.stubGlobal("fetch", fetchMock);
  return render(<MantineProvider><PermissionsProvider permissions={permissions}><DiagnosticsPanel workspaceId="w1" /></PermissionsProvider></MantineProvider>);
}

test("distinct categories each show their own summary and recovery path", async () => {
  show(["project.read"], vi.fn(async () => reply(status)));
  const list = await screen.findByRole("list", { name: "Findings" });
  const items = within(list).getAllByRole("listitem");
  expect(items).toHaveLength(2);
  expect(items[0]?.textContent).toContain("Storage failure");
  expect(items[0]?.textContent).toContain("Recovery: Ask the operator to restore them.");
  expect(items[1]?.textContent).toContain("Stale evidence");
  expect(screen.getByText(/Closing the browser never cancels work/)).toBeTruthy();
  expect(screen.getByText(/lease expired, outcome unknown/)).toBeTruthy();
});

test("a read-only member cannot cancel and is told why", async () => {
  show(["project.read"], vi.fn(async () => reply(status)));
  const buttons = await screen.findAllByRole("button", { name: "Cancel build" });
  for (const button of buttons) expect((button as HTMLButtonElement).disabled).toBe(true);
  expect(screen.getByText(/Read-only access: requires Native execution/)).toBeTruthy();
});

test("cancelling sends the stage state token and reports a requested, unconfirmed stop honestly", async () => {
  const fetchMock = vi.fn(async (path: string, options?: RequestInit) => {
    if (path === "/api/v0/operations") return reply({ result: { state: "cancellation_requested" } });
    void options;
    return reply(status);
  });
  show(["project.read", "build.execute"], fetchMock);
  const buttons = await screen.findAllByRole("button", { name: "Cancel build" });
  fireEvent.click(buttons[1] as HTMLElement);
  await waitFor(() => expect(screen.getByText(/stays listed until its runner confirms it stopped/)).toBeTruthy());
  const call = fetchMock.mock.calls.find(([path]) => path === "/api/v0/operations");
  const body = JSON.parse(String((call?.[1] as RequestInit).body));
  expect(body).toMatchObject({ operation: "build.cancel", payload: { build_id: "b2" }, expected_state: "stage-v4" });
});

test("an unreadable status is shown as not evaluated rather than healthy", async () => {
  show(["project.read"], vi.fn(async () => reply({ error: { message: "Project not found." } }, 404)));
  expect(await screen.findByText("Status unavailable")).toBeTruthy();
  expect(screen.getByText(/not evaluated until this read succeeds/)).toBeTruthy();
});

test("the top-bar indicator pairs its LED with words from the scoped read and opens the tool", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => reply(status)));
  const onOpen = vi.fn();
  render(<MantineProvider><StatusIndicator workspaceId="w1" onOpen={onOpen} /></MantineProvider>);
  const button = await screen.findByRole("button", { name: /Storage failure \+1\. Open status and recovery/ });
  expect(document.querySelector(".sb-led")?.getAttribute("data-state")).toBe("failed");
  fireEvent.click(button);
  expect(onOpen).toHaveBeenCalled();
});

test("the indicator reports unavailable, not the last good state, when a later read fails", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  try {
    let fail = false;
    vi.stubGlobal("fetch", vi.fn(async () => fail ? reply({ error: { message: "x" } }, 500) : reply({ ...status, findings: [], queue: { ...status.queue, active: 0, pending: 0 } })));
    render(<MantineProvider><StatusIndicator workspaceId="w1" onOpen={() => {}} /></MantineProvider>);
    await screen.findByRole("button", { name: /No jobs/ });
    fail = true;
    await vi.advanceTimersByTimeAsync(15500);
    await screen.findByRole("button", { name: /Status unavailable/ });
  } finally { vi.useRealTimers(); }
});
