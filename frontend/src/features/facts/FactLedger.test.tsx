import { MantineProvider } from "@mantine/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { FactLedger } from "./FactLedger";
import { createMemoryHistory } from "@tanstack/react-router";
import { NavigationProvider, useNavigation } from "../navigation";
import { ProbeProvider } from "../probe";
import { FactRecords } from "./FactRecords";
import { FactRegistration } from "./FactRegistration";
import { valueLabel, type Fact, type Facts } from "./api";
import { PermissionsProvider } from "../../lib/permissions";

beforeEach(() => { vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} }); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

function wrap(child: React.ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <MantineProvider><QueryClientProvider client={client}>{child}</QueryClientProvider></MantineProvider>;
}

function ledger(): Facts {
  return { subject_id: "subject", workspace_id: "ws-1", target: { kind: "project", project_id: "project-1" }, state: "facts-v1", offset: 0, limit: 50, has_more: false, assertions: [], assessments: { cut_allowance: [{ status: "unknown", value: null, assertion_ids: [], reason: "No assertion records this property." }] } };
}

async function select(label: string, text: string) {
  const input = await screen.findByRole("combobox", { name: label });
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
  body.assertions = ["10", "12"].map((magnitude, index) => ({ assertion_id: index ? "second" : "first", subject_id: "subject", sequence: index + 1, fact: { property: "width", status: "known", purpose: "manufacturing", role: "nominal", value: { kind: "quantity", dimension: "length", unit: "mm", magnitude }, conditions: [], basis: `Original synthetic source ${index + 1}`, provenance: { method: index ? "reviewed_association" : "source_observation", evidence: [{ kind: "citation", citation: `Synthetic source ${index + 1}` }] } } as Fact, canonical_value: { kind: "quantity", dimension: "length", unit: "mm", magnitude }, recorded_at: "2026-01-01T12:00:00Z", relation_to_design_state: "attached_evidence", evidence_status: "declared", evidence_kind: index ? "review" : "source_claim" }));
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(body), { status: 200 })));
  render(wrap(<FactLedger subjectId="subject" />));
  fireEvent.change(screen.getByLabelText("Fact property"), { target: { value: "width" } });
  expect(await screen.findByText("width: conflicting")).toBeTruthy();
  expect(screen.getByText("Conflicting assertions retained; no value selected.")).toBeTruthy();
  expect(screen.getByText("10 mm")).toBeTruthy(); expect(screen.getByText("12 mm")).toBeTruthy();
  expect(screen.getByText("known / source_observation")).toBeTruthy(); expect(screen.getByText("known / reviewed_association")).toBeTruthy();
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

test("registration opens the exact real project identity", async () => {
  const onRegistered = vi.fn();
  const calls: { operation: string; payload: unknown }[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, options?: RequestInit) => {
    if (options?.method === "POST") { calls.push(JSON.parse(String(options.body))); return new Response(JSON.stringify({ result: ledger() }), { status: 200 }); }
    return new Response(JSON.stringify(url.includes("/workspaces/") ? [ledger()] : ledger()), { status: 200 });
  }));
  render(wrap(<FactRegistration active principalKey="owner" workspaceId="ws-1" projectId="project-1" onRegistered={onRegistered} />));
  fireEvent.click(await screen.findByRole("button", { name: "Open fact ledger" }));
  await waitFor(() => expect(onRegistered).toHaveBeenCalledWith("subject"));
  expect(calls[0]).toEqual(expect.objectContaining({ operation: "facts.register_subject", payload: { target: { kind: "project", project_id: "project-1" } } }));
});

test("registration selects the actual serialized unit before opening its independent fact ledger", async () => {
  const onRegistered = vi.fn();
  const calls: { operation: string; payload: unknown }[] = [];
  const unitLedger: Facts = { ...ledger(), target: { kind: "physical_unit", unit_id: "unit-1" }, physical_unit_serial: "SERIAL-1" };
  vi.stubGlobal("fetch", vi.fn(async (url: string, options?: RequestInit) => {
    if (options?.method === "POST") {
      calls.push(JSON.parse(String(options.body)));
      return new Response(JSON.stringify({ result: unitLedger }), { status: 200 });
    }
    const body = url.includes("physical-units/workspaces/")
      ? { units: [{ unit_id: "unit-1", serial: "SERIAL-1", revision_id: "rev-1" }] }
      : url.includes("facts/workspaces/") ? [unitLedger] : unitLedger;
    return new Response(JSON.stringify(body), { status: 200 });
  }));
  render(wrap(<FactRegistration active principalKey="owner" workspaceId="ws-1" projectId="project-1" onRegistered={onRegistered} />));
  await select("Fact subject kind", "Physical unit");
  await select("Actual physical unit", "SERIAL-1 · revision rev-1");
  fireEvent.click(await screen.findByRole("button", { name: "Open fact ledger" }));
  await waitFor(() => expect(calls).toHaveLength(1));
  expect(calls[0]).toEqual(expect.objectContaining({ operation: "facts.register_subject", payload: {
    target: { kind: "physical_unit", unit_id: "unit-1" },
  } }));
  expect(onRegistered).toHaveBeenCalledWith("subject");
  expect(screen.getByText(/they do not qualify a lot or release/)).toBeTruthy();
  cleanup(); render(wrap(<FactLedger subjectId="subject" />));
  expect(await screen.findByText(/Subject: Physical unit SERIAL-1/)).toBeTruthy();
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
  await waitFor(() => expect(screen.queryByRole("heading", { name: "Record assertion" })).toBeNull());
  expect(await screen.findAllByText("Evidence unavailable.")).toHaveLength(2);
  expect(screen.getByText("cut_allowance: unknown").closest("[hidden]")).toBeTruthy();
});

test("display keeps explicit false, unknown, bounds and tolerance distinct", () => {
  expect(valueLabel(null)).toBe("No value");
  expect(valueLabel({ kind: "boolean", value: false })).toBe("False");
  expect(valueLabel({ kind: "range", dimension: "length", unit: "mm", lower: "1", upper: "2" })).toBe("1 to 2 mm");
  expect(valueLabel({ kind: "tolerance", dimension: "length", unit: "mm", minus: "0.1", plus: "0.2" })).toBe("−0.1 / +0.2 mm");
});

test.each([
  ["read-only", ["workspace.read"], "project", true],
  ["editor", ["workspace.read", "item.create"], "project", false],
  ["editor on a physical unit", ["workspace.read", "item.create"], "physical_unit", true],
  ["inventory manager on a physical unit", ["workspace.read", "inventory.manage"], "physical_unit", false],
] as const)("%s permissions gate recording assertions (%s subject)", async (_name, permissions, kind, off) => {
  const body = ledger();
  body.target = kind === "project" ? body.target : { kind: "physical_unit", unit_id: "unit-1" } as Facts["target"];
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(body), { status: 200 })));
  render(wrap(<PermissionsProvider permissions={[...permissions]}><FactLedger subjectId="subject" /></PermissionsProvider>));
  await screen.findByText("cut_allowance: unknown");
  fireEvent.change(screen.getByLabelText("Assertion basis"), { target: { value: "Allowance is not recorded." } });
  fireEvent.change(screen.getByLabelText("Evidence citation"), { target: { value: "Original synthetic missing allowance record." } });
  const record = screen.getByRole("button", { name: "Record immutable assertion" }) as HTMLButtonElement;
  expect(record.disabled).toBe(off);
  expect(record.title).toBe(off ? `Read-only access: requires ${kind === "project" ? "Contributor access" : "Inventory management"}` : "");
});

test("read-only permissions disable registration while contributors can open a declared project ledger", async () => {
  const onRegistered = vi.fn();
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ workspace_id: "ws-1" }), { status: 200 })));
  render(wrap(<PermissionsProvider permissions={["workspace.read"]}><FactRegistration active principalKey="owner" workspaceId="ws-1" projectId="project-1" onRegistered={onRegistered} /></PermissionsProvider>));
  const open = await screen.findByRole("button", { name: "Open fact ledger" }) as HTMLButtonElement;
  expect(open.disabled).toBe(true);
  expect(open.title).toBe("Read-only access: requires Contributor access");
  cleanup();
  render(wrap(<PermissionsProvider permissions={["workspace.read", "item.create"]}><FactRegistration active principalKey="owner" workspaceId="ws-1" projectId="project-1" onRegistered={onRegistered} /></PermissionsProvider>));
  expect(((await screen.findByRole("button", { name: "Open fact ledger" })) as HTMLButtonElement).disabled).toBe(false);
});

test("a design-scope ledger cannot choose the physical measurement method", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(ledger()), { status: 200 })));
  render(wrap(<FactLedger subjectId="subject" />));
  await screen.findByText("Record assertion");
  const input = screen.getByRole("combobox", { name: "Assertion method" });
  fireEvent.focus(input); fireEvent.keyDown(input, { key: "ArrowDown" });
  const options = screen.getByRole("listbox", { name: "Assertion method", hidden: true });
  expect(within(options).queryByText("measurement", { exact: true })).toBeNull();
  expect(within(options).getByText("calculation", { exact: true })).toBeTruthy();
});


test("exact fact subjects open directly without depending on the first subject page", async () => {
  const reads: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    reads.push(url);
    if (url.includes("/facts/subjects/subject-75?")) return new Response(JSON.stringify({ ...ledger(), subject_id: "subject-75" }));
    if (url === "/api/v0/access/workspace") return new Response(JSON.stringify({ workspace_id: "ws-1" }));
    throw new Error(`Unexpected list lookup ${url}`);
  }));
  const history = createMemoryHistory({ initialEntries: ["/library/subject-75@2/~/retained?tool=facts"] });
  function Routed() { const nav = useNavigation()!; return <ProbeProvider probe={nav.location.probe} onProbe={() => {}}><FactRecords active principalKey="owner" workspaceId="ws-1" /></ProbeProvider>; }
  render(wrap(<NavigationProvider history={history}><Routed /></NavigationProvider>));
  await screen.findByRole("heading", { name: "Record assertion" });
  expect(reads.some(url => url.includes("/facts/workspaces/"))).toBe(false);
  expect(history.location.pathname).toContain("subject-75@2/~/retained");
});

test("focus denial withdraws a ledger and recovery preserves the prepared assertion", async () => {
  let denied = false;
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(denied ? { error: { message: "Current subject denied" } } : ledger()), { status: denied ? 403 : 200 })));
  // Keep the query client stable while changing activation.
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const stable = (active: boolean) => <MantineProvider><QueryClientProvider client={client}><FactLedger active={active} subjectId="subject" /></QueryClientProvider></MantineProvider>;
  const view = render(stable(true));
  await screen.findByRole("heading", { name: "Record assertion" });
  fireEvent.change(screen.getByLabelText("Assertion basis"), { target: { value: "Retained manual basis" } });
  view.rerender(stable(false)); denied = true; view.rerender(stable(true));
  act(() => window.dispatchEvent(new Event("focus")));
  await screen.findByText("Current subject denied");
  expect(screen.queryByRole("heading", { name: "Record assertion" })).toBeNull();
  denied = false; fireEvent.click(screen.getByRole("button", { name: "Refresh fact access" }));
  await screen.findByRole("heading", { name: "Record assertion" });
  expect(screen.getByLabelText("Assertion basis")).toHaveProperty("value", "Retained manual basis");
});

test("occurrence registration retains the exact root, repeated path and stable feature", async () => {
  const writes: { payload: unknown }[] = [], registered = vi.fn();
  vi.stubGlobal("fetch", vi.fn(async (_url: string, options?: RequestInit) => {
    if (options?.method === "POST") { writes.push(JSON.parse(String(options.body))); return new Response(JSON.stringify({ result: ledger() })); }
    return new Response(JSON.stringify({ workspace_id: "ws-1" }));
  }));
  render(wrap(<FactRegistration active principalKey="owner" workspaceId="ws-1" onRegistered={registered} />));
  await select("Fact subject kind", "occurrence");
  fireEvent.change(screen.getByLabelText("Fact root assembly snapshot ID"), { target: { value: "exact-root" } });
  fireEvent.change(screen.getByLabelText("Fact contextual occurrence path"), { target: { value: "left/repeated-board" } });
  fireEvent.change(screen.getByLabelText("Fact stable feature ID"), { target: { value: "mount" } });
  fireEvent.click(screen.getByRole("button", { name: "Open fact ledger" }));
  await waitFor(() => expect(registered).toHaveBeenCalledWith("subject"));
  expect(writes[0]!.payload).toEqual({ target: { kind: "occurrence", snapshot_id: "exact-root", path: ["left", "repeated-board"], feature_id: "mount" } });
});


test("registration searches bounded metadata and explicitly chooses an older revision beyond the first page", async () => {
  const reads: string[] = [], writes: { payload: unknown }[] = [], registered = vi.fn();
  vi.stubGlobal("fetch", vi.fn(async (url: string, options?: RequestInit) => {
    reads.push(url);
    if (options?.method === "POST") { writes.push(JSON.parse(String(options.body))); return new Response(JSON.stringify({ result: ledger() })); }
    if (url === "/api/v0/access/workspace") return new Response(JSON.stringify({ workspace_id: "ws-1" }));
    if (url.includes("/workspace/library-table?")) return new Response(JSON.stringify({ results: [{ family: "definition", record_id: "def", label: "Synthetic board", kind: "board" }], next_after: null }));
    if (url.includes("/catalog/definitions/def?offset=")) return new Response(JSON.stringify({ name: "Synthetic board", revisions: url.endsWith("offset=50") ? [{ revision_id: "r75", number: 75 }] : Array.from({ length: 50 }, (_, index) => ({ revision_id: `r${index+1}`, number: index+1 })) }));
    throw new Error(`Unexpected unbounded read ${url}`);
  }));
  render(wrap(<FactRegistration active principalKey="owner" workspaceId="ws-1" onRegistered={registered} />));
  await select("Fact subject kind", "revision");
  await select("Fact definition", "Synthetic board (board)");
  const next = screen.getByRole("button", { name: "Next subject revisions" });
  await waitFor(() => expect((next as HTMLButtonElement).disabled).toBe(false)); fireEvent.click(next);
  await select("Fact exact revision", "Synthetic board · r75");
  fireEvent.click(screen.getByRole("button", { name: "Open fact ledger" }));
  await waitFor(() => expect(registered).toHaveBeenCalledWith("subject"));
  expect(writes[0]!.payload).toEqual({ target: { kind: "revision", revision_id: "r75", feature_id: null } });
  expect(reads.some(url => url.includes("library-table?limit=50"))).toBe(true);
  expect(reads.some(url => url.includes("/workspace/definitions"))).toBe(false);
});

test("a held registration cannot navigate after the principal changes", async () => {
  let complete: ((response: Response) => void) | undefined;
  const registered = vi.fn();
  vi.stubGlobal("fetch", vi.fn(async (_url: string, options?: RequestInit) => {
    if (options?.method === "POST") return new Promise<Response>(resolve => { complete = resolve; });
    return new Response(JSON.stringify({ workspace_id: "ws-1" }));
  }));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const tree = (principalKey: string) => <MantineProvider><QueryClientProvider client={client}><FactRegistration active principalKey={principalKey} workspaceId="ws-1" projectId="project-1" onRegistered={registered} /></QueryClientProvider></MantineProvider>;
  const view = render(tree("first"));
  fireEvent.click(await screen.findByRole("button", { name: "Open fact ledger" }));
  await waitFor(() => expect(complete).toBeDefined());
  view.rerender(tree("second"));
  await act(async () => complete!(new Response(JSON.stringify({ result: ledger() }))));
  expect(registered).not.toHaveBeenCalled();
  expect(screen.queryByRole("button", { name: "Open registered fact ledger" })).toBeNull();
});
