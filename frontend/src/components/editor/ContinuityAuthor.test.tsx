import { MantineProvider } from "@mantine/core";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useEffect } from "react";
import { afterEach, expect, test, vi } from "vitest";
import { PermissionsProvider } from "../../lib/permissions";
import type { TestPlan } from "../../features/cable-test-intent/api";
import { ContinuityAuthor } from "./ContinuityAuthor";

vi.mock("../../features/cable-test-intent/CableTestIntentPanel", () => ({ PlanEditor: ({ value, onChange, onAuthorityChange, disabled }: { value: TestPlan; onChange: (v: TestPlan) => void; onAuthorityChange: (v: boolean) => void; disabled: boolean }) => {
  useEffect(() => onAuthorityChange(false), [onAuthorityChange]);
  return <input aria-label="Prepared label" disabled={disabled} value={value.labels[0]?.text ?? ""} onChange={event => onChange({ ...value, labels: [{ local_id: "label-1", text: event.currentTarget.value, basis: "Synthetic authoring basis", evidence: { status: "unknown" } }] })} />;
} }));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const json = (result: unknown, status = 200) => new Response(JSON.stringify(status === 200 ? { result } : { error: { message: result } }), { status });

test("independent authored-plan CAS and failed retry preserve buffer, exact root, expected state and idempotency intent", async () => {
  let saved: TestPlan; let state = "v1"; let conflict = false;
  const calls: { operation: string; payload: { name?: string; test_plan?: TestPlan }; expected_state?: string; idempotency_key?: string }[] = [];
  const bound = vi.fn();
  vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)); calls.push(body);
    if (body.operation === "cable_test_plan.create") saved = body.payload.test_plan;
    if (body.operation === "cable_test_plan.update") { if (conflict) return json("Draft changed elsewhere", 409); saved = body.payload.test_plan; state = "v2"; }
    const draft = { draft_id: "plan-draft", definition_id: "plan-definition", state, content: { test_plan: saved! } };
    return json(body.operation === "cable_test_plan.freeze" ? { revision_id: "plan-r1", draft } : draft);
  }));
  render(<MantineProvider><PermissionsProvider permissions={["workspace.read", "item.create", "design.edit", "design.freeze"]}><ContinuityAuthor name="Synthetic cable" revisionId="exact-cable-r1" workspaceId="w1" principalKey="owner:w1" active onBound={bound} onDenied={() => {}} /></PermissionsProvider></MantineProvider>);
  fireEvent.change(screen.getByLabelText("Prepared label"), { target: { value: "端子/β:07" } });
  fireEvent.click(screen.getByRole("button", { name: "Create test-plan draft" }));
  await screen.findByRole("button", { name: "Save test-plan draft" });
  expect(calls[0]?.payload.test_plan).toMatchObject({ root_revision_id: "exact-cable-r1", cable_revision_id: "exact-cable-r1", occurrence_path: [] });
  fireEvent.change(screen.getByLabelText("Prepared label"), { target: { value: "Unsaved retained" } });
  expect(screen.getByRole("button", { name: "Freeze and bind saved test plan" }).hasAttribute("disabled")).toBe(true);
  conflict = true; fireEvent.click(screen.getByRole("button", { name: "Save test-plan draft" })); await screen.findByText("Draft changed elsewhere");
  expect((screen.getByLabelText("Prepared label") as HTMLInputElement).value).toBe("Unsaved retained");
  conflict = false; fireEvent.click(screen.getByRole("button", { name: "Save test-plan draft" }));
  await waitFor(() => expect(screen.getByRole("button", { name: "Freeze and bind saved test plan" }).hasAttribute("disabled")).toBe(false));
  const updates = calls.filter(row => row.operation === "cable_test_plan.update");
  expect(updates.map(row => row.expected_state)).toEqual(["v1", "v1"]); expect(updates[0]?.idempotency_key).toBe(updates[1]?.idempotency_key);
  fireEvent.click(screen.getByRole("button", { name: "Freeze and bind saved test plan" })); await waitFor(() => expect(bound).toHaveBeenCalledWith("plan-r1"));
  expect(calls.at(-1)?.expected_state).toBe("v2");
});

test("viewer cannot create, save or freeze authored expectations", () => {
  render(<MantineProvider><PermissionsProvider permissions={["workspace.read"]}><ContinuityAuthor name="Synthetic" revisionId="r1" workspaceId="w1" principalKey="viewer:w1" active onBound={() => {}} onDenied={() => {}} /></PermissionsProvider></MantineProvider>);
  expect(screen.getByRole("button", { name: "Create test-plan draft" }).hasAttribute("disabled")).toBe(true);
  expect(screen.getByLabelText("Prepared label").hasAttribute("disabled")).toBe(true);
});
