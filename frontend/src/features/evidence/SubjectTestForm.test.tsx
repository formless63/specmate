import { MantineProvider } from "@mantine/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { PermissionsProvider } from "../../lib/permissions";
import { EvidencePanel } from "./EvidencePanel";
import { SubjectTestForm, buildSubjectTest } from "./SubjectTestForm";
import type { EvidenceItem } from "./api";

beforeEach(() => { vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} }); window.HTMLElement.prototype.scrollIntoView = vi.fn(); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const complete = { kind: "physical_unit", subject: "unit-a", test_kind: "continuity", procedure: "Synthetic procedure", criterion: "Pairs conduct", instrument: "Synthetic meter", finding: "criterion_met", observed_at: "2026-01-01T12:00" };

test("a test body names the exact subject and keeps unknowns unknown", () => {
  const body = buildSubjectTest(complete, [{ property: "humidity", status: "unknown" }]);
  expect(body).toMatchObject({ subject: { kind: "physical_unit", unit_id: "unit-a" }, instruments: [{ name: "Synthetic meter", calibration: "unknown" }], conditions: [{ property: "humidity", status: "unknown" }] });
  expect(body).not.toHaveProperty("configuration_id");
  const batch = buildSubjectTest({ ...complete, kind: "work_batch", subject: "batch-1" }, []);
  expect(batch).toMatchObject({ subject: { kind: "work_batch", work_batch_id: "batch-1" } });
  expect((batch as { subject: object }).subject).not.toHaveProperty("sample_size");
});

test("incomplete or incoherent tests are refused before sending", () => {
  expect(buildSubjectTest({ ...complete, subject: "" }, [])).toMatch(/exact unit or batch/);
  expect(buildSubjectTest({ ...complete, instrument: " " }, [])).toMatch(/instrument/);
  expect(buildSubjectTest({ ...complete, finding: "" }, [])).toMatch(/finding/);
  expect(buildSubjectTest({ ...complete, calibration: "calibrated" }, [])).toMatch(/calibration reference/);
  expect(buildSubjectTest({ ...complete, kind: "work_batch", sample_size: "0" }, [])).toMatch(/Sample size/);
  expect(buildSubjectTest({ ...complete, observed_at: "" }, [])).toMatch(/time/);
});

function mount(permissions: string[] | undefined, children = <SubjectTestForm workspaceId="ws-1" />) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<MantineProvider><QueryClientProvider client={client}><PermissionsProvider permissions={permissions}>{children}</PermissionsProvider></QueryClientProvider></MantineProvider>);
}

test("members without inventory authority see a read-only form and cannot record", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ units: [], work_batches: [] }), { status: 200 })));
  mount(["workspace.read"]);
  const button = (await screen.findByRole("button", { name: "Record test" })) as HTMLButtonElement;
  expect(button.disabled).toBe(true);
  expect(document.querySelector("[data-readonly-note='inventory.manage']")).toBeTruthy();
});

test("recording sends one retry-stable command naming the unit and procedure", async () => {
  const commands: { payload: Record<string, unknown>; idempotency_key: string }[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === "POST") { commands.push(JSON.parse(String(init.body))); return new Response(JSON.stringify({ result: { test_id: "t-1", recorded_at: "2026-01-02T00:00:00Z", applies_to: "this_subject_only", physical_qualification: false } }), { status: 200 }); }
    if (url.includes("physical-units")) return new Response(JSON.stringify({ units: [{ unit_id: "unit-a", serial: "SN-A", revision_id: "rev-1" }] }), { status: 200 });
    return new Response(JSON.stringify({ work_batches: [] }), { status: 200 });
  }));
  mount(["inventory.manage", "workspace.read"]);
  fireEvent.mouseDown(screen.getByRole("combobox", { name: "Tested unit" }));
  fireEvent.click(await screen.findByText("SN-A · revision rev-1"));
  fireEvent.change(screen.getByLabelText("Test kind"), { target: { value: "continuity" } });
  fireEvent.change(screen.getByLabelText("Observed at"), { target: { value: "2026-01-01T12:00" } });
  fireEvent.change(screen.getByLabelText("Procedure"), { target: { value: "Synthetic procedure" } });
  fireEvent.change(screen.getByLabelText("Criterion the finding is judged against"), { target: { value: "Pairs conduct" } });
  fireEvent.change(screen.getByLabelText("Instrument"), { target: { value: "Synthetic meter" } });
  fireEvent.mouseDown(screen.getByRole("combobox", { name: "Finding" }));
  fireEvent.click(await screen.findByText("Inconclusive"));
  fireEvent.click(screen.getByRole("button", { name: "Record test" }));
  expect(await screen.findByText(/applies to this subject only/)).toBeTruthy();
  expect(commands).toHaveLength(1);
  expect(commands[0]!.payload).toMatchObject({ subject: { kind: "physical_unit", unit_id: "unit-a" }, finding: "inconclusive", procedure: "Synthetic procedure" });
  expect(commands[0]!.idempotency_key).toBeTruthy();
});

test("a batch test is displayed as a batch as a whole with its procedure and instrument", async () => {
  const item: EvidenceItem = {
    evidence_id: "test:t-1", kind: "physical_measurement", kind_label: "Physical measurement", source: "subject_tests", workspace_id: "ws-1",
    subject: { scope: "actual", kind: "work_batch", id: "b", label: "Work batch Six (as a whole)" }, statement: "continuity test, criterion met: Pairs conduct", status: "criterion_met",
    conditions: [{ property: "humidity", status: "unknown", value: null }], method: { name: "continuity_test", procedure: "Synthetic procedure", instrument: "Synthetic meter" },
    basis: { origin: "test_record", references: ["instrument:Synthetic meter; calibration unknown"], independently_verified: false }, recorded_at: "2026-01-01T00:00:00Z", observed_at: "2026-01-01T12:00:00Z",
    establishes: [], does_not_establish: ["Behavior of any individual unit in the batch."], warnings: ["Applies to this batch as a whole (sample size not stated); it does not qualify any individual unit in it."], physical_qualification: false,
  };
  vi.stubGlobal("fetch", vi.fn(async (url: string) => new Response(JSON.stringify(url.includes("taxonomy") ? { kinds: [] } : url.includes("evidence/workspaces") ? { workspace_id: "ws-1", items: [item], offset: 0, limit: 50, has_more: false, scan_limit_reached: false } : { units: [], work_batches: [] }), { status: 200 })));
  mount(["workspace.read"], <EvidencePanel workspaceId="ws-1" />);
  expect(await screen.findByText("Actual work batch, as a whole")).toBeTruthy();
  expect(screen.getByText("Procedure: Synthetic procedure")).toBeTruthy();
  expect(screen.getByText("Instrument: Synthetic meter")).toBeTruthy();
  expect(screen.getByText("Condition humidity: unknown")).toBeTruthy();
  expect(screen.getByText(/does not qualify any individual unit/)).toBeTruthy();
  await waitFor(() => expect(screen.getByText("instrument:Synthetic meter; calibration unknown")).toBeTruthy());
});
