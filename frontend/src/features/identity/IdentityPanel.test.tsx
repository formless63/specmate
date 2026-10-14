import { MantineProvider } from "@mantine/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { IdentityPanel } from "./IdentityPanel";
import { PermissionsProvider } from "../../lib/permissions";

const definitionId = "00000000-0000-0000-0000-000000000001";
const revisionId = "00000000-0000-0000-0000-000000000002";
const draftId = "00000000-0000-0000-0000-000000000003";

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
      body = { result: command.operation === "definition.create" ? { definition_id: definitionId } : command.operation === "draft.freeze" ? { revision_id: revisionId, number: 1 } : { lot_id: "lot-1" } };
    } else if (url.includes("/definitions/")) {
      body = { definition_id: definitionId, name: "Synthetic part", kind: "part", drafts: [{ draft_id: draftId, state: "draft-v1", dependencies: [] }], revisions: [{ revision_id: revisionId, number: 1 }] };
    } else if (url.includes("/revisions/")) {
      body = { revision_id: revisionId, variants: [], lots: [], representations: [] };
    } else body = [{ definition_id: definitionId, name: "Synthetic part", kind: "part" }];
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
  await waitFor(() => expect(calls).toHaveLength(3));
  expect(calls[0]).toMatchObject({ operation: "definition.create", payload: { name: "Synthetic part", kind: "part", project_id: "project-1" } });
  expect(calls[1]).toMatchObject({ operation: "draft.freeze", expected_state: "draft-v1", payload: { draft_id: draftId, dependencies: [] } });
  expect(calls[2]).toMatchObject({ operation: "catalog.register_lot", payload: { revision_id: revisionId, label: "Batch A", variant_id: null } });
});

test("displays permission failure without claiming a successful identity registration", async () => {
  vi.stubGlobal("fetch", vi.fn(async (_url: string, options?: RequestInit) => new Response(JSON.stringify(options?.method === "POST" ? { error: { message: "Missing permission design.edit." } } : []), { status: options?.method === "POST" ? 403 : 200 })));
  renderPanel();
  fireEvent.change(screen.getByLabelText("Definition name"), { target: { value: "Synthetic part" } });
  fireEvent.click(screen.getByText("Create draft"));
  expect(await screen.findByText("Missing permission design.edit.")).toBeTruthy();
  expect(screen.queryByText("Identity registered.")).toBeNull();
});

async function pick(name: string, option: string) {
  const input = await screen.findByRole("combobox", { name });
  fireEvent.focus(input); fireEvent.keyDown(input, { key: "ArrowDown" });
  fireEvent.click(await within(screen.getByRole("listbox", { name, hidden: true })).findByText(option));
}

test.each([
  ["read-only", ["project.read"], true, true],
  ["editor", ["project.read", "design.edit"], false, true],
  ["editor with freeze", ["project.read", "design.edit", "design.freeze"], false, false],
] as const)("%s permissions gate identity create, freeze and registration", async (_name, permissions, editOff, freezeOff) => {
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    const body = url.includes("/definitions/") ? { definition_id: definitionId, name: "Synthetic part", kind: "part", drafts: [{ draft_id: draftId, state: "draft-v1", dependencies: [] }], revisions: [{ revision_id: revisionId, number: 1 }] }
      : url.includes("/revisions/") ? { revision_id: revisionId, variants: [], lots: [], representations: [] }
      : [{ definition_id: definitionId, name: "Synthetic part", kind: "part" }];
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
