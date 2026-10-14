import { MantineProvider } from "@mantine/core";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { AgentCapabilitiesPanel } from "./AgentCapabilitiesPanel";

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  Element.prototype.scrollIntoView = vi.fn();
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const row = (operation: string, status: string, reasons: string[] = [], permission: string | null = "design.edit") => ({
  operation, summary: `Synthetic ${operation}`, requires_expected_state: true, supports_idempotency: true, attachments: [], async: false,
  generic_http_invocation: true, listed_by_operations_endpoint: operation !== "account.login", access: { kind: "workspace", minimum_workspace_permission: permission, basis: "explicit" }, availability: { status, reasons },
});
const body = {
  instance: { version: "0", registry_sha256: "abcdef0123456789" },
  transports: { http_api: { status: "available" }, mcp: { status: "unavailable", reason: "no_mcp_adapter_in_this_instance" } },
  scope: { project_id: "project-a", role: "viewer", permissions: ["workspace.read"] },
  capabilities: { native_execution: { status: "unavailable", reasons: ["no_approved_recipe"], approved_recipes: 0 } },
  notes: ["Object-level authority is still checked."],
  operations: [row("inventory.list", "available", [], "workspace.read"), row("draft.update", "not_permitted", ["missing_permission"]), row("build.request", "unavailable", ["no_approved_recipe"], "build.execute"), row("account.login", "not_applicable", ["pre_authentication_operation"], null)],
};

test("shows the reported transports, native state and per-operation availability", async () => {
  const fetchMock = vi.fn(async (_path: string) => new Response(JSON.stringify(body)));
  vi.stubGlobal("fetch", fetchMock);
  render(<MantineProvider><AgentCapabilitiesPanel workspaceId="w1" projectId="project-a" /></MantineProvider>);
  expect(await screen.findByText("inventory.list")).toBeTruthy();
  expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/v0/discovery/capabilities?workspace_id=w1&project_id=project-a");
  expect(screen.getByText(/mcp: unavailable \(no mcp adapter in this instance\)/)).toBeTruthy();
  expect(screen.getByText(/Native execution: unavailable \(no approved recipe\)/)).toBeTruthy();
  expect(screen.getAllByText("no approved recipe").length).toBeGreaterThan(0);
  expect(screen.getByText("missing permission")).toBeTruthy();
  // The count states which operations GET /api/v0/operations lists and which are public endpoints.
  expect(screen.getByText(/4 operations registered; 3 are listed by GET \/api\/v0\/operations, 1 are public pre-authentication endpoints/)).toBeTruthy();
});

test("without a project the library scope reads capabilities for the workspace alone", async () => {
  const fetchMock = vi.fn(async (_path: string) => new Response(JSON.stringify(body)));
  vi.stubGlobal("fetch", fetchMock);
  render(<MantineProvider><AgentCapabilitiesPanel workspaceId="w1" /></MantineProvider>);
  expect(await screen.findByText("inventory.list")).toBeTruthy();
  expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/v0/discovery/capabilities?workspace_id=w1");
});

test("filters by name and reports an empty match", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(body))));
  render(<MantineProvider><AgentCapabilitiesPanel workspaceId="w1" projectId="project-a" /></MantineProvider>);
  await screen.findByText("inventory.list");
  fireEvent.change(screen.getByLabelText("Find operation"), { target: { value: "draft" } });
  expect(screen.queryByText("inventory.list")).toBeNull();
  expect(screen.getByText("draft.update")).toBeTruthy();
  fireEvent.change(screen.getByLabelText("Find operation"), { target: { value: "zzz" } });
  expect(screen.getByText("No operations match.")).toBeTruthy();
});

test("a scoped denial shows the server error and no stale rows", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: { message: "Project not found." } }), { status: 404 })));
  render(<MantineProvider><AgentCapabilitiesPanel workspaceId="w1" projectId="project-b" /></MantineProvider>);
  expect(await screen.findByText("Project not found.")).toBeTruthy();
  expect(screen.queryByText("inventory.list")).toBeNull();
});
