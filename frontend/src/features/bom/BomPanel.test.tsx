import { byContent } from "../../test/text";
import { MantineProvider } from "@mantine/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { BomInspector, BomPanel } from "./BomPanel";
import { blankPlan } from "./api";
import { PermissionsProvider } from "../../lib/permissions";

beforeEach(() => { vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} }); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
async function choose(name: string, option: string) {
  const input = await screen.findByLabelText(name, { selector: "input" });
  for (const details of document.querySelectorAll("details")) if (!details.open) fireEvent.click(details.querySelector("summary")!);
  fireEvent.focus(input); fireEvent.keyDown(input, { key: "ArrowDown" });
  fireEvent.click(await within(screen.getByRole("listbox", { name, hidden: true })).findByText(option));
}
function wrap(children: React.ReactNode) {
  return <MantineProvider><QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{children}</QueryClientProvider></MantineProvider>;
}

test("purpose switch preserves exact occurrence, unknown quantity and bought boundary explanation", async () => {
  const urls: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    urls.push(url);
    return new Response(JSON.stringify({ revision_id: "plan-rev", bom: { assembly_revision_id: "assembly-rev" }, status: "unknown", rows: [{ address: { snapshot_id: "root", path: ["left", "board"] }, revision_id: "board-rev", name: "Synthetic board", quantity: { status: "unknown", amount: null, unit: "ea" }, reason: "buy_boundary", basis: "Explicit choice", need_id: null }], boundaries: [{ address: { path: ["left", "board"] }, decision: "buy" }], unresolved: [{ address: { path: ["left", "board"] }, reason: "quantity_unknown", need_id: null }], excluded_needs: [{ need_id: "wipe", reason: "ancestor_buy" }], limitations: ["Counts only"] }), { status: 200 });
  }));
  render(wrap(<BomInspector revisionId="plan-rev" />));
  expect(await screen.findByText(byContent("– – – unknown"))).toBeTruthy();
  expect(screen.getByText("board-rev")).toBeTruthy();
  expect(screen.getByText("Boundary: left / board · buy")).toBeTruthy();
  expect(screen.getByText("Excluded process need: wipe · ancestor_buy")).toBeTruthy();
  await choose("BOM purpose", "Assembly contents");
  await waitFor(() => expect(urls.some(u => u.endsWith("purpose=assembly_contents"))).toBe(true));
});

test("revoked frozen read exposes no retained occurrence rows", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: { message: "BOM plan unavailable." } }), { status: 404 })));
  render(wrap(<BomInspector revisionId="restricted" />));
  expect(await screen.findByText("BOM plan unavailable.")).toBeTruthy();
  expect(screen.queryByRole("table")).toBeNull();
});

test("new plan chooses exact root and sends explicit unknown count and root buy policy", async () => {
  const commands: Record<string, unknown>[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, options?: RequestInit) => {
    if (options?.method === "POST") {
      commands.push(JSON.parse(String(options.body)));
      return new Response(JSON.stringify({ error: { message: "Captured command" } }), { status: 409 });
    }
    const body = url.includes("catalog/definitions/") ? { revisions: [{ revision_id: "root-rev", number: 1 }], drafts: [] }
      : url.includes("assemblies/snapshots/") ? { occurrences: [] }
      : url.includes("revisions/root-rev") ? { snapshot_id: "root-snapshot" }
      : [{ definition_id: "assembly", name: "Synthetic assembly", kind: "assembly" }];
    return new Response(JSON.stringify(body), { status: 200 });
  }));
  render(wrap(<BomPanel projectId="project" />));
  fireEvent.change(screen.getByLabelText("BOM plan name"), { target: { value: "Boundary plan" } });
  await waitFor(() => expect(screen.getByRole("combobox", { name: "Root assembly definition" })).toBeTruthy());
  await choose("Root assembly definition", "Synthetic assembly (assembly)");
  await choose("Root assembly exact revision", "Revision 1");
  await screen.findByRole("combobox", { name: "Decision for Root assembly" });
  await choose("Decision for Root assembly", "buy");
  fireEvent.change(screen.getByLabelText("Decision basis for Root assembly"), { target: { value: "Bought populated assembly" } });
  fireEvent.click(screen.getByText("Create BOM draft"));
  await screen.findByText("Captured command");
  expect(commands[0]).toMatchObject({ operation: "bom.create", payload: { bom: { assembly_revision_id: "root-rev", quantity: { status: "unknown", amount: null }, policies: [{ path: [], revision_id: "root-rev", decision: "buy", basis: "Bought populated assembly" }], needs: [] } } });
});

test("exact dimensional occurrence demand and additive waste remain strings in command", async () => {
  const commands: Record<string, unknown>[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, options?: RequestInit) => {
    if (options?.method === "POST") {
      commands.push(JSON.parse(String(options.body)));
      return new Response(JSON.stringify({ error: { message: "Captured dimensional command" } }), { status: 409 });
    }
    const body = url.includes("catalog/definitions/") ? { revisions: [{ revision_id: "root-rev", number: 1 }], drafts: [] }
      : url.includes("assemblies/snapshots/") ? { occurrences: [] }
      : url.includes("revisions/root-rev") ? { snapshot_id: "root-snapshot" }
      : [{ definition_id: "assembly", name: "Synthetic assembly", kind: "assembly" }];
    return new Response(JSON.stringify(body), { status: 200 });
  }));
  render(wrap(<BomPanel projectId="project" />));
  fireEvent.change(screen.getByLabelText("BOM plan name"), { target: { value: "Dimensional plan" } });
  await choose("Root assembly definition", "Synthetic assembly (assembly)");
  await choose("Root assembly exact revision", "Revision 1");
  fireEvent.click(await screen.findByLabelText("Declare material demand for Root assembly"));
  await choose("Root assembly net demand per root assembly unit", "mm");
  fireEvent.change(screen.getByLabelText("Root assembly net demand per root assembly"), { target: { value: "1234.5000" } });
  fireEvent.change(screen.getByLabelText("Root assembly demand basis"), { target: { value: "Reviewed synthetic declaration" } });
  fireEvent.click(screen.getByLabelText("Declare additive waste for Root assembly"));
  fireEvent.change(screen.getByLabelText("Root assembly additive waste per root assembly"), { target: { value: "0" } });
  fireEvent.change(screen.getByLabelText("Root assembly waste basis"), { target: { value: "Explicit zero allowance" } });
  fireEvent.click(screen.getByText("Create BOM draft"));
  await screen.findByText("Captured dimensional command");
  expect(commands[0]).toMatchObject({ payload: { bom: { occurrence_demands: [{ path: [], revision_id: "root-rev", quantity: { status: "known", amount: "1234.5000", unit: "mm" }, basis: "Reviewed synthetic declaration", waste: { quantity: { status: "known", amount: "0", unit: "mm" }, basis: "Explicit zero allowance" } }] } } });
});

test("frozen dimensional demand shows net, independent structural count and unknown gross", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ revision_id: "plan-rev", bom: { assembly_revision_id: "assembly-rev" }, status: "unknown", rows: [{ address: { snapshot_id: "root", path: ["wire"] }, revision_id: "wire-rev", name: "Synthetic stock", quantity: { status: "known", amount: "2.50", unit: "m" }, structural_quantity: { status: "known", amount: 2, unit: "ea" }, net_quantity: { status: "known", amount: "2.50", unit: "m" }, waste_quantity: { status: "unknown", amount: null, unit: "m" }, required_quantity: { status: "unknown", amount: null, unit: "m" }, waste_status: "not_evaluated", demand_basis: "Explicit synthetic length", waste_basis: null, reason: "buy_boundary", basis: "Buy", need_id: null }], boundaries: [], unresolved: [], excluded_needs: [], limitations: [] }), { status: 200 })));
  render(wrap(<BomInspector revisionId="plan-rev" />));
  expect(await screen.findAllByText(byContent("2.50 m"))).toBeTruthy();
  expect(screen.getByText(byContent("Structural: 2 ea"))).toBeTruthy();
  expect(screen.getByText(byContent("Net demand: 2.50 m"))).toBeTruthy();
  expect(screen.getByText(byContent("Gross: – – – unknown"))).toBeTruthy();
  expect(screen.getByText(byContent(/^Waste: – – – unknown/))).toBeTruthy();
});

test.each([
  ["read-only", ["workspace.read"], true, true],
  ["editor", ["workspace.read", "item.create", "design.edit"], false, true],
  ["editor with freeze", ["workspace.read", "item.create", "design.edit", "design.freeze"], false, false],
] as const)("%s permissions gate BOM create, save and freeze", async (_name, permissions, saveOff, freezeOff) => {
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    const body = url.includes("bom/drafts/") ? { definition_id: "bom", draft_id: "d1", state: "v1", content: { bom: blankPlan() } }
      : url.includes("catalog/definitions/") ? { drafts: [{ draft_id: "d1", state: "v1" }], revisions: [] }
      : [{ definition_id: "bom", name: "Synthetic BOM", kind: "bom_plan" }];
    return new Response(JSON.stringify(body), { status: 200 });
  }));
  render(wrap(<PermissionsProvider permissions={[...permissions]}><BomPanel projectId="project" /></PermissionsProvider>));
  await waitFor(() => expect(screen.getByRole("combobox", { name: "Existing BOM plan" })).toBeTruthy());
  await choose("Existing BOM plan", "Synthetic BOM");
  for (const details of document.querySelectorAll("details")) if (!details.open) fireEvent.click(details.querySelector("summary")!);
  await waitFor(() => expect(screen.getByRole("combobox", { name: "BOM draft" })).toBeTruthy());
  await choose("BOM draft", "d1 · v1");
  const save = await screen.findByRole("button", { name: "Save BOM draft" }) as HTMLButtonElement;
  const freeze = screen.getByRole("button", { name: "Freeze BOM revision" }) as HTMLButtonElement;
  expect(save.disabled).toBe(saveOff);
  expect(freeze.disabled).toBe(freezeOff);
  expect(save.title).toBe(saveOff ? "Read-only access: requires Edit" : "");
  expect(freeze.title).toBe(freezeOff ? "Read-only access: requires Freeze" : "");
  expect(screen.getByRole("button", { name: "Create BOM draft" }).hasAttribute("data-readonly-reason")).toBe(saveOff);
});

test("an existing draft's new process need pre-fills the preferred length unit", async () => {
  const plan = { ...blankPlan(), assembly_revision_id: "root-rev" };
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    const body = url.includes("/api/v0/preferences") ? { workspace_id: "ws", kind: "preference", engineering_fact: false, note: "", workspace: { values: {}, state_token: "w" }, user: { values: {}, state_token: "u" }, effective: { default_length_unit: { value: "cm", source: "user" } } }
      : url.includes("bom/drafts/") ? { definition_id: "plan", draft_id: "d1", state: "s1", content: { bom: plan } }
      : url.includes("catalog/definitions/plan") ? { name: "Plan", revisions: [], drafts: [{ draft_id: "d1", state: "open" }] }
      : url.includes("catalog/definitions/") ? { revisions: [{ revision_id: "root-rev", number: 1 }], drafts: [] }
      : url.includes("assemblies/snapshots/") ? { occurrences: [] }
      : url.includes("revisions/root-rev") ? { snapshot_id: "root-snapshot" }
      : [{ definition_id: "plan", name: "Existing plan", kind: "bom_plan" }, { definition_id: "assembly", name: "Synthetic assembly", kind: "assembly" }];
    return new Response(JSON.stringify(body), { status: 200 });
  }));
  render(wrap(<BomPanel projectId="project" workspaceId="ws" />));
  await choose("Existing BOM plan", "Existing plan");
  for (const details of document.querySelectorAll("details")) if (!details.open) fireEvent.click(details.querySelector("summary")!);
  await screen.findByRole("combobox", { name: "BOM draft" });
  await choose("BOM draft", "d1 · open");
  const unit = await waitFor(() => {
    const all = screen.getAllByRole("combobox", { name: "Need net demand per root assembly unit" });
    expect(all.length).toBe(1);
    return all[0] as HTMLInputElement;
  });
  await waitFor(() => expect(unit.value).toBe("cm"));
  expect(screen.getByText("from preference")).toBeTruthy();
});


test("a selected plan read denial stays visible outside collapsed version controls", async () => {
  vi.stubGlobal("fetch", vi.fn(async (url: string) => new Response(JSON.stringify(
    url.includes("catalog/definitions/") ? { error: { message: "Plan access unavailable." } }
      : [{ definition_id: "plan", name: "Existing plan", kind: "bom_plan" }],
  ), { status: url.includes("catalog/definitions/") ? 404 : 200 })));
  render(wrap(<BomPanel />));
  await screen.findByRole("combobox", { name: "Existing BOM plan" });
  await choose("Existing BOM plan", "Existing plan");
  const error = await screen.findByText("Plan access unavailable.");
  expect(error.closest("details")).toBeNull();
  expect(screen.queryByRole("combobox", { name: "BOM draft" })).toBeNull();
});


test.each(["draft", "identity", "root", "tree"])("denied %s refetch hides retained draft values and recovery keeps edits and original CAS", async deniedRead => {
  let denied = false; let restored = false;
  const commands: { operation: string; expected_state: string }[] = [];
  const plan = { ...blankPlan(), assembly_revision_id: "root-rev" };
  const cache = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const keys: Record<string, unknown[]> = { draft: ["bom-draft", "d1"], identity: ["bom-identity", "plan", 0], root: ["bom-root", "root-rev"], tree: ["bom-tree", "root-snapshot"] };
  vi.stubGlobal("fetch", vi.fn(async (url: string, options?: RequestInit) => {
    if (options?.method === "POST") {
      commands.push(JSON.parse(String(options.body)));
      return new Response(JSON.stringify({ error: { message: "Original token conflicts." } }), { status: 409 });
    }
    const kind = url.includes("bom/drafts/") ? "draft" : url.includes("catalog/definitions/plan") ? "identity" : url.includes("assemblies/snapshots/") ? "tree" : url.includes("revisions/root-rev") ? "root" : "list";
    if (denied && kind === deniedRead) return new Response(JSON.stringify({ error: { message: "Retained read denied." } }), { status: 403 });
    const body = kind === "draft" ? { definition_id: "plan", draft_id: "d1", state: restored ? "new-server-token" : "original-token", content: { bom: plan } }
      : kind === "identity" ? { name: "Existing plan", revisions: [], drafts: [{ draft_id: "d1", state: "open" }] }
      : kind === "tree" ? { occurrences: [] }
      : kind === "root" ? { snapshot_id: "root-snapshot" }
      : [{ definition_id: "plan", name: "Existing plan", kind: "bom_plan" }];
    return new Response(JSON.stringify(body), { status: 200 });
  }));
  render(<MantineProvider><QueryClientProvider client={cache}><BomPanel /></QueryClientProvider></MantineProvider>);
  await choose("Existing BOM plan", "Existing plan");
  await choose("BOM draft", "d1 · open");
  const save = await screen.findByRole("button", { name: "Save BOM draft" });
  const editor = save.closest(".mantine-Card-root") as HTMLElement;
  const basis = await within(editor).findByRole("textbox", { name: "Decision basis for Root assembly" });
  fireEvent.change(basis, { target: { value: "Private unsaved basis" } });
  denied = true;
  await act(() => cache.refetchQueries({ queryKey: keys[deniedRead], exact: true }));
  await screen.findByText("Retained read denied.");
  expect(within(editor).queryByRole("textbox", { name: "Decision basis for Root assembly" })).toBeNull();
  expect((save as HTMLButtonElement).disabled).toBe(true);
  expect(commands).toHaveLength(0);
  denied = false; restored = true;
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: deniedRead === "root" || deniedRead === "tree" ? "Refresh BOM sources" : "Refresh BOM access" }));
    await cache.refetchQueries({ queryKey: ["bom-draft", "d1"], exact: true });
  });
  expect((await within(editor).findByRole("textbox", { name: "Decision basis for Root assembly" }) as HTMLInputElement).value).toBe("Private unsaved basis");
  fireEvent.click(save);
  await screen.findByText("Original token conflicts.");
  expect(commands.at(-1)).toMatchObject({ operation: "bom.update", expected_state: "original-token" });
});


test("saving after freeze uses the returned draft token and retains the editor", async () => {
  let state = "v1"; let saved = { ...blankPlan(), assembly_revision_id: "root-rev" };
  const commands: { operation: string; expected_state: string }[] = [];
  const draft = () => ({ definition_id: "plan", draft_id: "d1", state, content: { bom: saved } });
  vi.stubGlobal("fetch", vi.fn(async (url: string, options?: RequestInit) => {
    let body: unknown;
    if (options?.method === "POST") {
      const command = JSON.parse(String(options.body)); commands.push(command);
      if (command.operation === "bom.freeze") { state = "v3"; body = { result: { revision_id: "frozen", draft: { draft_id: "d1", state } } }; }
      else { saved = command.payload.bom; state = state === "v1" ? "v2" : "v4"; body = { result: draft() }; }
    } else body = url.includes("bom/drafts/") ? draft()
      : url.includes("catalog/definitions/plan") ? { name: "Existing plan", revisions: [], drafts: [{ draft_id: "d1", state: "open" }] }
      : url.includes("assemblies/snapshots/") ? { occurrences: [] }
      : url.includes("bom/revisions/frozen") ? { revision_id: "frozen", bom: saved, status: "unknown", rows: [], boundaries: [], unresolved: [], excluded_needs: [], limitations: [] }
      : url.includes("revisions/root-rev") ? { snapshot_id: "root-snapshot" }
      : [{ definition_id: "plan", name: "Existing plan", kind: "bom_plan" }];
    return new Response(JSON.stringify(body), { status: 200 });
  }));
  render(wrap(<BomPanel />)); await choose("Existing BOM plan", "Existing plan"); await choose("BOM draft", "d1 · open");
  const save = await screen.findByRole("button", { name: "Save BOM draft" });
  const editor = save.closest(".mantine-Card-root") as HTMLElement;
  const field = await within(editor).findByRole("textbox", { name: "Decision basis for Root assembly" });
  fireEvent.change(field, { target: { value: "First saved basis" } }); fireEvent.click(save);
  const freeze = screen.getByRole("button", { name: "Freeze BOM revision" });
  await waitFor(() => expect((freeze as HTMLButtonElement).disabled).toBe(false)); fireEvent.click(freeze);
  await waitFor(() => expect(commands).toHaveLength(2));
  await waitFor(() => expect((save as HTMLButtonElement).disabled).toBe(false));
  fireEvent.change(field, { target: { value: "After frozen basis" } }); fireEvent.click(save);
  await waitFor(() => expect(commands).toHaveLength(3));
  expect(commands.map(command => [command.operation, command.expected_state])).toEqual([["bom.update", "v1"], ["bom.freeze", "v2"], ["bom.update", "v3"]]);
  expect((field as HTMLInputElement).value).toBe("After frozen basis");
});


test("cached frozen rows withdraw on failed identity or frozen refetch and reappear only after recovery", async () => {
  let denied: "identity" | "frozen" | null = null;
  const cache = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    const identity = url.includes("catalog/definitions/plan"); const frozen = url.includes("bom/revisions/frozen");
    if ((identity && denied === "identity") || (frozen && denied === "frozen")) return new Response(JSON.stringify({ error: { message: "Frozen authority denied." } }), { status: 404 });
    const body = identity ? { name: "Existing plan", drafts: [], revisions: [{ revision_id: "frozen", number: 1 }] }
      : frozen ? { revision_id: "frozen", bom: { assembly_revision_id: "root-rev" }, status: "unknown", rows: [{ address: { path: ["sensitive-branch"] }, revision_id: "item-rev", name: "Retained private item", quantity: { status: "unknown", amount: null, unit: "ea" }, reason: "buy_boundary", basis: "Retained basis" }], boundaries: [], unresolved: [], excluded_needs: [], limitations: [] }
      : [{ definition_id: "plan", kind: "bom_plan", name: "Existing plan" }];
    return new Response(JSON.stringify(body), { status: 200 });
  }));
  render(<MantineProvider><QueryClientProvider client={cache}><BomPanel /></QueryClientProvider></MantineProvider>);
  await choose("Existing BOM plan", "Existing plan");
  await choose("Frozen BOM revision", "Existing plan · r1");
  await screen.findByRole("cell", { name: /Retained private item/ });
  denied = "identity"; await act(() => cache.refetchQueries({ queryKey: ["bom-identity", "plan", 0], exact: true }));
  await screen.findByText("Frozen authority denied."); expect(screen.queryByRole("cell", { name: /Retained private item/ })).toBeNull();
  denied = null; await act(() => cache.refetchQueries({ queryKey: ["bom-identity", "plan", 0], exact: true }));
  await screen.findByRole("cell", { name: /Retained private item/ });
  denied = "frozen"; await act(() => cache.refetchQueries({ queryKey: ["bom-inspect", "frozen", "procurement"], exact: true }));
  await screen.findByText("Frozen authority denied."); expect(screen.queryByText("Retained private item")).toBeNull();
  denied = null; await act(() => cache.refetchQueries({ queryKey: ["bom-inspect", "frozen", "procurement"], exact: true }));
  await screen.findByRole("cell", { name: /Retained private item/ });
});

test.each(['allowed', 'readonly', 'inactive'])('Library New BOM request resets a selected record only for an active permitted creator: %s', async mode => {
  const { requestNew } = await import('../library-gallery/newRequest');
  const { LIBRARY_VIEWS } = await import('../shell/scope');
  vi.stubGlobal('fetch', vi.fn(async (url: string) => new Response(JSON.stringify(url.includes('catalog/definitions/')
    ? { definition_id: 'plan', name: 'Existing plan', revisions: [], drafts: [] }
    : [{ definition_id: 'plan', kind: 'bom_plan', name: 'Existing plan' }]), { status: 200 })));
  const permissions = mode === 'readonly' ? ['workspace.read'] : ['workspace.read', 'item.create'];
  const view = render(wrap(<PermissionsProvider permissions={permissions}><BomPanel active={mode !== 'inactive'} /></PermissionsProvider>));
  await choose('Existing BOM plan', 'Existing plan');
  await waitFor(() => expect((screen.getByLabelText('BOM plan name').closest('details') as HTMLDetailsElement).open).toBe(false));
  act(() => requestNew(LIBRARY_VIEWS.bom!));
  if (mode === 'allowed') {
    await waitFor(() => expect((screen.getByLabelText('BOM plan name').closest('details') as HTMLDetailsElement).open).toBe(true));
    expect((screen.getByLabelText('BOM plan name') as HTMLInputElement).value).toBe('');
    expect((screen.getByLabelText('Existing BOM plan', { selector: 'input' }) as HTMLInputElement).value).toBe('');
    expect(document.activeElement).toBe(screen.getByLabelText('BOM plan name'));
  } else {
    await new Promise(resolve => setTimeout(resolve, 90));
    expect((screen.getByLabelText('BOM plan name').closest('details') as HTMLDetailsElement).open).toBe(false);
    // Consume the deliberately pending request only after the matching form is permitted and active.
    view.rerender(wrap(<PermissionsProvider permissions={['workspace.read', 'item.create']}><BomPanel active /></PermissionsProvider>));
    await waitFor(() => expect((screen.getByLabelText('BOM plan name').closest('details') as HTMLDetailsElement).open).toBe(true));
  }
});
