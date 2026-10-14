import { MantineProvider } from "@mantine/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { IdentityPanel } from "./IdentityPanel";
import { PermissionsProvider } from "../../lib/permissions";

const definitionId = "00000000-0000-0000-0000-000000000001";
const revisionId = "00000000-0000-0000-0000-000000000002";
const draftId = "00000000-0000-0000-0000-000000000003";
const library = { workspace_id: "workspace-1", project_id: null, results: [{ definition_id: definitionId, name: "Synthetic part", kind: "part" }], next_after: null };

beforeEach(() => { vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} }); });

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

function renderPanel() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<MantineProvider><QueryClientProvider client={client}><IdentityPanel projectId="project-1" /></QueryClientProvider></MantineProvider>);
}

test("creates a reusable definition, freezes exact draft state, then registers a distinct lot", async () => {
  const calls: { operation: string; payload: Record<string, unknown>; expected_state?: string }[] = [];
  const fetchMock = vi.fn(async (url: string, options?: RequestInit) => {
    let body: unknown;
    if (options?.method === "POST") {
      const command = JSON.parse(String(options.body)); calls.push(command);
      body = { result: command.operation === "definition.create" ? { definition_id: definitionId } : command.operation === "draft.freeze" ? { revision_id: revisionId, number: 1 } : command.operation === "project.add_reference" ? { state: "project-v2" } : { lot_id: "lot-1" } };
    } else if (url.includes("access/projects/")) {
      body = { project_id: "project-1", state: "project-v1" };
    } else if (url.includes("/definitions/")) {
      body = { definition_id: definitionId, name: "Synthetic part", kind: "part", drafts: [{ draft_id: draftId, state: "draft-v1", dependencies: [] }], revisions: [{ revision_id: revisionId, number: 1 }] };
    } else if (url.includes("/revisions/")) {
      body = { revision_id: revisionId, variants: [], lots: [], representations: [], source_identifiers: [] };
    } else body = library;
    return new Response(JSON.stringify(body), { status: 200 });
  });
  vi.stubGlobal("fetch", fetchMock);
  renderPanel();
  fireEvent.change(screen.getByLabelText("Definition name"), { target: { value: "Synthetic part" } });
  fireEvent.click(screen.getByText("Create draft"));
  fireEvent.click(await screen.findByText("Freeze current draft"));
  await screen.findByText("Physical lots");
  fireEvent.change(screen.getByLabelText("Lot label"), { target: { value: "Batch A" } });
  fireEvent.click(screen.getByText("Register lot identity"));
  await waitFor(() => expect(calls).toHaveLength(4));
  // The definition joins the workspace library; using it in the project is a separate reference.
  expect(calls[0]).toMatchObject({ operation: "definition.create", payload: { name: "Synthetic part", kind: "part", workspace_id: "workspace-1" } });
  expect(calls[0]!.payload).not.toHaveProperty("project_id");
  expect(calls[1]).toMatchObject({ operation: "project.add_reference", expected_state: "project-v1", payload: { project_id: "project-1", kind: "definition", target_id: definitionId } });
  expect(calls[2]).toMatchObject({ operation: "draft.freeze", expected_state: "draft-v1", payload: { draft_id: draftId, dependencies: [] } });
  expect(calls[3]).toMatchObject({ operation: "catalog.register_lot", payload: { revision_id: revisionId, label: "Batch A", variant_id: null } });
  expect(fetchMock.mock.calls.some(([url]) => String(url).includes("catalog/definitions?") && String(url).includes("project_id=project-1"))).toBe(true);
});

test("without a project the library still works and no reference is offered", async () => {
  const calls: { operation: string; payload: Record<string, unknown> }[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, options?: RequestInit) => {
    if (options?.method === "POST") { const command = JSON.parse(String(options.body)); calls.push(command); return new Response(JSON.stringify({ result: { definition_id: definitionId } }), { status: 200 }); }
    expect(String(url)).not.toContain("project_id");
    return new Response(JSON.stringify(library), { status: 200 });
  }));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<MantineProvider><QueryClientProvider client={client}><IdentityPanel /></QueryClientProvider></MantineProvider>);
  expect(screen.queryByLabelText("Use in this project")).toBeNull();
  fireEvent.change(screen.getByLabelText("Definition name"), { target: { value: "Library part" } });
  fireEvent.click(screen.getByText("Create draft"));
  await waitFor(() => expect(calls).toHaveLength(1));
  expect(calls[0]).toMatchObject({ operation: "definition.create", payload: { workspace_id: "workspace-1", name: "Library part" } });
});

test("displays permission failure without claiming a successful identity registration", async () => {
  vi.stubGlobal("fetch", vi.fn(async (_url: string, options?: RequestInit) => new Response(JSON.stringify(options?.method === "POST" ? { error: { message: "Missing permission item.create." } } : library), { status: options?.method === "POST" ? 403 : 200 })));
  renderPanel();
  fireEvent.change(screen.getByLabelText("Definition name"), { target: { value: "Synthetic part" } });
  fireEvent.click(screen.getByText("Create draft"));
  expect(await screen.findByText("Missing permission item.create.")).toBeTruthy();
  expect(screen.queryByText("Identity registered.")).toBeNull();
});

async function pick(name: string, option: string) {
  const input = await screen.findByRole("combobox", { name });
  fireEvent.focus(input); fireEvent.keyDown(input, { key: "ArrowDown" });
  fireEvent.click(await within(screen.getByRole("listbox", { name, hidden: true })).findByText(option));
}

test.each([
  ["viewer", ["workspace.read"], true, true],
  ["contributor", ["workspace.read", "item.create"], false, true],
  ["editor", ["workspace.read", "item.create", "design.edit", "design.freeze"], false, false],
] as const)("%s permissions gate identity create, freeze and registration", async (_name, permissions, editOff, freezeOff) => {
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    const body = url.includes("/definitions/") ? { definition_id: definitionId, name: "Synthetic part", kind: "part", drafts: [{ draft_id: draftId, state: "draft-v1", dependencies: [] }], revisions: [{ revision_id: revisionId, number: 1 }] }
      : url.includes("/revisions/") ? { revision_id: revisionId, variants: [], lots: [], representations: [], source_identifiers: [] }
      : library;
    return new Response(JSON.stringify(body), { status: 200 });
  }));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<MantineProvider><QueryClientProvider client={client}><PermissionsProvider permissions={[...permissions]}><IdentityPanel projectId="project-1" /></PermissionsProvider></QueryClientProvider></MantineProvider>);
  await pick("Definition", "Synthetic part (part)");
  const freeze = await screen.findByRole("button", { name: "Freeze current draft" }) as HTMLButtonElement;
  expect(freeze.disabled).toBe(freezeOff);
  expect(freeze.title).toBe(freezeOff ? "Read-only access: requires Freeze" : "");
  await pick("Exact revision", "Revision 1");
  await screen.findByText("Physical lots");
  fireEvent.change(screen.getByLabelText("Lot label"), { target: { value: "Batch A" } });
  for (const name of ["Register lot identity", "Create draft"]) {
    const control = screen.getByRole("button", { name }) as HTMLButtonElement;
    expect(control.hasAttribute("data-readonly-reason")).toBe(editOff);
  }
  expect((screen.getByRole("button", { name: "Register lot identity" }) as HTMLButtonElement).disabled).toBe(editOff);
});

const bundleId = "00000000-0000-0000-0000-000000000009";
const repCatalog = {
  revision_id: revisionId, variants: [], lots: [],
  representations: [{ representation_id: "r1", kind: "datasheet", label: "Datasheet", revision_id: revisionId, revision_number: 1, definition_id: definitionId, definition_name: "Synthetic part", definition_kind: "part", source_bundle_revision_id: bundleId, source_path: "docs/sheet.pdf", sha256: "ab".repeat(32), media_type: "application/pdf", rights: "unknown", rights_known: false }],
  source_identifiers: [{ source_identifier_id: "s1", revision_id: revisionId, revision_number: 1, definition_name: "Synthetic part", scheme: "library-id", identifier: "Synthetic:Part", label: "Library symbol", rights: "CC0-1.0", rights_known: true }],
};

test("shows the exact model revision, flags unknown rights and registers a linked file and identifier", async () => {
  const calls: { operation: string; payload: Record<string, unknown> }[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, options?: RequestInit) => {
    let body: unknown;
    if (options?.method === "POST") { const command = JSON.parse(String(options.body)); calls.push(command); body = { result: {} }; }
    else if (url.includes("sources/workspaces/")) body = { revisions: [{ revision_id: bundleId, bundle_id: "b", name: "Vendor docs", role: "original", number: 1, manifest_sha256: "m", derived_from: null }], next_after: null };
    else if (url.includes("sources/revisions/")) body = { revision_id: bundleId, manifest: { ancestry: [], files: [{ path: "docs/sheet.pdf", sha256: "cd".repeat(32), bytes: 3, media_type: "application/pdf", rights: "unknown" }] } };
    else if (url.includes("/definitions/")) body = { definition_id: definitionId, name: "Synthetic part", kind: "part", drafts: [], revisions: [{ revision_id: revisionId, number: 1 }] };
    else if (url.includes("/revisions/")) body = repCatalog;
    else body = library;
    return new Response(JSON.stringify(body), { status: 200 });
  }));
  renderPanel();
  await pick("Definition", "Synthetic part (part)");
  await pick("Exact revision", "Revision 1");
  expect(await screen.findByText("unknown · not cleared")).toBeTruthy();
  expect(screen.getByText("CC0-1.0")).toBeTruthy();
  expect(screen.getAllByText("Revision 1").length).toBeGreaterThan(0);
  expect(screen.getByText(/not an orderable part or a physical lot/)).toBeTruthy();
  fireEvent.change(screen.getByLabelText("Representation label"), { target: { value: "Sheet" } });
  await pick("Source bundle revision", "Vendor docs · revision 1 (original)");
  await pick("Source file", "docs/sheet.pdf");
  fireEvent.click(screen.getByRole("button", { name: "Register representation" }));
  await waitFor(() => expect(calls).toHaveLength(1));
  expect(calls[0]).toMatchObject({ operation: "catalog.register_representation", payload: { revision_id: revisionId, kind: "datasheet", source_bundle_revision_id: bundleId, source_path: "docs/sheet.pdf" } });
  const register = screen.getByRole("button", { name: "Register source identifier" }) as HTMLButtonElement;
  expect(register.disabled).toBe(true);
  fireEvent.change(screen.getByLabelText("Identifier scheme"), { target: { value: "url" } });
  fireEvent.change(screen.getByLabelText("Source identifier"), { target: { value: "https://example.invalid/p" } });
  fireEvent.change(screen.getByLabelText("Source identifier label"), { target: { value: "Page" } });
  expect(register.disabled).toBe(true);
  fireEvent.change(screen.getByLabelText(/Rights statement/), { target: { value: "unknown" } });
  fireEvent.click(register);
  await waitFor(() => expect(calls).toHaveLength(2));
  expect(calls[1]).toMatchObject({ operation: "catalog.register_source_identifier", payload: { scheme: "url", identifier: "https://example.invalid/p", label: "Page", rights: "unknown" } });
});
