import { MantineProvider } from "@mantine/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { FactLedger, FactsPanel } from "./FactsPanel";
import { valueLabel, type Fact, type Facts } from "./api";

beforeEach(() => { vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} }); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

function wrap(child: React.ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <MantineProvider><QueryClientProvider client={client}>{child}</QueryClientProvider></MantineProvider>;
}

function ledger(): Facts {
  return { subject_id: "subject", project_id: "project-1", target: { kind: "project", project_id: "project-1" }, state: "facts-v1", offset: 0, limit: 50, has_more: false, assertions: [], assessments: { cut_allowance: [{ status: "unknown", value: null, assertion_ids: [], reason: "No assertion records this property." }] } };
}

async function select(label: string, text: string) {
  const input = screen.getByRole("combobox", { name: label });
  fireEvent.focus(input); fireEvent.keyDown(input, { key: "ArrowDown" });
  const options = screen.getByRole("listbox", { name: label, hidden: true });
  fireEvent.click(await within(options).findByText(text, { exact: true }));
}

test("an absent allowance stays unknown and is recorded without a guessed zero or false", async () => {
  const calls: { operation: string; expected_state?: string; payload: Record<string, unknown> }[] = [];
  vi.stubGlobal("fetch", vi.fn(async (_url: string, options?: RequestInit) => {
    if (options?.method === "POST") { calls.push(JSON.parse(String(options.body))); return new Response(JSON.stringify({ result: { ...ledger(), state: "facts-v2" } }), { status: 200 }); }
    return new Response(JSON.stringify(ledger()), { status: 200 });
  }));
  render(wrap(<FactLedger subjectId="subject" />));
  expect(await screen.findByText("cut_allowance: unknown")).toBeTruthy();
  expect(screen.getByText("No known value.")).toBeTruthy();
  expect(screen.queryByLabelText("Magnitude")).toBeNull();
  fireEvent.change(screen.getByLabelText("Assertion basis"), { target: { value: "Allowance is not recorded." } });
  fireEvent.change(screen.getByLabelText("Evidence citation"), { target: { value: "Original synthetic missing allowance record." } });
  fireEvent.click(screen.getByText("Record immutable assertion"));
  await waitFor(() => expect(calls).toHaveLength(1));
  expect(calls[0]).toMatchObject({ operation: "facts.append", expected_state: "facts-v1", payload: { subject_id: "subject", fact: { status: "unknown", value: null, property: "cut_allowance", purpose: "manufacturing", role: "nominal" } } });
});

test("conflicting dimensional assertions remain visible without a selected winner", async () => {
  const body = ledger();
  body.assessments = { width: [{ status: "conflicting", value: null, assertion_ids: ["first", "second"], purpose: "manufacturing", role: "nominal" }] };
  body.assertions = ["10", "12"].map((magnitude, index) => ({ assertion_id: index ? "second" : "first", subject_id: "subject", sequence: index + 1, fact: { property: "width", status: "known", purpose: "manufacturing", role: "nominal", value: { kind: "quantity", dimension: "length", unit: "mm", magnitude }, conditions: [], basis: `Original synthetic source ${index + 1}`, provenance: { method: index ? "measurement" : "source_observation", evidence: [{ kind: "citation", citation: `Synthetic source ${index + 1}` }] } } as Fact, canonical_value: { kind: "quantity", dimension: "length", unit: "mm", magnitude }, recorded_at: "2026-01-01T12:00:00Z", relation_to_design_state: "attached_evidence", evidence_status: "declared" }));
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(body), { status: 200 })));
  render(wrap(<FactLedger subjectId="subject" />));
  fireEvent.change(screen.getByLabelText("Fact property"), { target: { value: "width" } });
  expect(await screen.findByText("width: conflicting")).toBeTruthy();
  expect(screen.getByText("Conflicting assertions retained; no value selected.")).toBeTruthy();
  expect(screen.getByText("10 mm")).toBeTruthy(); expect(screen.getByText("12 mm")).toBeTruthy();
  expect(screen.getByText("known / source_observation")).toBeTruthy(); expect(screen.getByText("known / measurement")).toBeTruthy();
  expect(screen.getByText("Original synthetic source 1")).toBeTruthy(); expect(screen.getByText("Original synthetic source 2")).toBeTruthy();
});

test("known boolean requires explicit choice and preserves an intentionally chosen false", async () => {
  const calls: { payload: { fact: Fact } }[] = [];
  vi.stubGlobal("fetch", vi.fn(async (_url: string, options?: RequestInit) => {
    if (options?.method === "POST") calls.push(JSON.parse(String(options.body)));
    return new Response(JSON.stringify(options?.method === "POST" ? { result: ledger() } : ledger()), { status: 200 });
  }));
  render(wrap(<FactLedger subjectId="subject" />));
  await screen.findByText("Record assertion");
  await select("Assertion status", "known"); await select("Value type", "boolean");
  fireEvent.change(screen.getByLabelText("Assertion basis"), { target: { value: "Explicit false observation." } });
  fireEvent.change(screen.getByLabelText("Evidence citation"), { target: { value: "Synthetic source." } });
  expect(screen.getByText("Record immutable assertion").closest("button")?.disabled).toBe(true);
  await select("Known boolean value", "False");
  fireEvent.click(screen.getByText("Record immutable assertion"));
  await waitFor(() => expect(calls).toHaveLength(1));
  expect(calls[0]!.payload.fact).toMatchObject({ status: "known", role: "actual", value: { kind: "boolean", value: false } });
});

test("panel registers the real project identity before opening its ledger", async () => {
  const calls: { operation: string; payload: unknown }[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, options?: RequestInit) => {
    if (options?.method === "POST") { calls.push(JSON.parse(String(options.body))); return new Response(JSON.stringify({ result: ledger() }), { status: 200 }); }
    return new Response(JSON.stringify(url.includes("/projects/") ? [ledger()] : ledger()), { status: 200 });
  }));
  render(wrap(<FactsPanel projectId="project-1" />));
  fireEvent.click(screen.getByText("Open fact ledger"));
  await screen.findByText("cut_allowance: unknown");
  expect(calls[0]).toEqual(expect.objectContaining({ operation: "facts.register_subject", payload: { target: { kind: "project", project_id: "project-1" } } }));
});

test("panel selects a serialized unit and labels its independent fact ledger", async () => {
  const calls: { operation: string; payload: unknown }[] = [];
  const unitLedger: Facts = { ...ledger(), target: { kind: "physical_unit", unit_id: "unit-1" }, physical_unit_serial: "SERIAL-1" };
  vi.stubGlobal("fetch", vi.fn(async (url: string, options?: RequestInit) => {
    if (options?.method === "POST") {
      calls.push(JSON.parse(String(options.body)));
      return new Response(JSON.stringify({ result: unitLedger }), { status: 200 });
    }
    const body = url.includes("physical-units/projects/")
      ? { units: [{ unit_id: "unit-1", serial: "SERIAL-1", revision_id: "rev-1" }] }
      : url.includes("facts/projects/") ? [unitLedger] : unitLedger;
    return new Response(JSON.stringify(body), { status: 200 });
  }));
  render(wrap(<FactsPanel projectId="project-1" />));
  await select("Fact subject kind", "Physical unit");
  await select("Actual physical unit", "SERIAL-1 · revision rev-1");
  fireEvent.click(screen.getByText("Open fact ledger"));
  await waitFor(() => expect(calls).toHaveLength(1));
  expect(calls[0]).toEqual(expect.objectContaining({ operation: "facts.register_subject", payload: {
    target: { kind: "physical_unit", unit_id: "unit-1" },
  } }));
  expect(await screen.findByText(/Subject: Physical unit SERIAL-1/)).toBeTruthy();
  expect(screen.getByText(/they do not qualify a lot or release/)).toBeTruthy();
  expect(screen.getByRole("combobox", { name: "Value role" })).toHaveProperty("value", "actual");
});

test("revoked or unavailable evidence shows no partial assertions", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: { message: "Evidence unavailable." } }), { status: 404 })));
  render(wrap(<FactLedger subjectId="restricted" />));
  expect(await screen.findByText("Evidence unavailable.")).toBeTruthy();
  expect(screen.queryByText("Record assertion")).toBeNull();
});

test("a rejected append refreshes authority and hides previously cached assertions after revocation", async () => {
  let reads = 0;
  vi.stubGlobal("fetch", vi.fn(async (_url: string, options?: RequestInit) => {
    const revoked = options?.method === "POST" || reads++ > 0;
    return new Response(JSON.stringify(revoked ? { error: { message: "Evidence unavailable." } } : ledger()), { status: revoked ? 404 : 200 });
  }));
  render(wrap(<FactLedger subjectId="subject" />));
  await screen.findByText("Record assertion");
  fireEvent.change(screen.getByLabelText("Assertion basis"), { target: { value: "Unknown allowance." } });
  fireEvent.change(screen.getByLabelText("Evidence citation"), { target: { value: "Synthetic source." } });
  fireEvent.click(screen.getByText("Record immutable assertion"));
  await waitFor(() => expect(screen.queryByText("Record assertion")).toBeNull());
  expect(await screen.findByText("Evidence unavailable.")).toBeTruthy();
  expect(screen.queryByText("cut_allowance: unknown")).toBeNull();
});

test("display keeps explicit false, unknown, bounds and tolerance distinct", () => {
  expect(valueLabel(null)).toBe("No value");
  expect(valueLabel({ kind: "boolean", value: false })).toBe("False");
  expect(valueLabel({ kind: "range", dimension: "length", unit: "mm", lower: "1", upper: "2" })).toBe("1 to 2 mm");
  expect(valueLabel({ kind: "tolerance", dimension: "length", unit: "mm", minus: "0.1", plus: "0.2" })).toBe("−0.1 / +0.2 mm");
});
