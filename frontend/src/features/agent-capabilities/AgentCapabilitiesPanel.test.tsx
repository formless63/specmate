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
  generic_http_invocation: true, access: { kind: "project", minimum_project_permission: permission, basis: "explicit" }, availability: { status, reasons },
});
const body = {
  instance: { version: "0", registry_sha256: "abcdef0123456789" },
  transports: { http_api: { status: "available" }, mcp: { status: "unavailable", reason: "no_mcp_adapter_in_this_instance" } },
  scope: { project_id: "project-a", role: "viewer", permissions: ["project.read"] },
  capabilities: { native_execution: { status: "unavailable", reasons: ["no_approved_recipe"], approved_recipes: 0 } },
  notes: ["Object-level authority is still checked."],
  operations: [row("inventory.list", "available", [], "project.read"), row("draft.update", "not_permitted", ["missing_permission"]), row("build.request", "unavailable", ["no_approved_recipe"], "build.execute")],
};

test("shows the reported transports, native state and per-operation availability", async () => {
  const fetchMock = vi.fn(async (_path: string) => new Response(JSON.stringify(body)));
  vi.stubGlobal("fetch", fetchMock);
  render(<MantineProvider><AgentCapabilitiesPanel projectId="project-a" /></MantineProvider>);
  expect(await screen.findByText("inventory.list")).toBeTruthy();
  expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/v0/discovery/capabilities?project_id=project-a");
  expect(screen.getByText(/mcp: unavailable \(no mcp adapter in this instance\)/)).toBeTruthy();
  expect(screen.getByText(/Native execution: unavailable \(no approved recipe\)/)).toBeTruthy();
  expect(screen.getAllByText("no approved recipe").length).toBeGreaterThan(0);
  expect(screen.getByText("missing permission")).toBeTruthy();
});

test("filters by name and reports an empty match", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(body))));
  render(<MantineProvider><AgentCapabilitiesPanel projectId="project-a" /></MantineProvider>);
  await screen.findByText("inventory.list");
  fireEvent.change(screen.getByLabelText("Find operation"), { target: { value: "draft" } });
  expect(screen.queryByText("inventory.list")).toBeNull();
  expect(screen.getByText("draft.update")).toBeTruthy();
  fireEvent.change(screen.getByLabelText("Find operation"), { target: { value: "zzz" } });
  expect(screen.getByText("No operations match.")).toBeTruthy();
});

test("a scoped denial shows the server error and no stale rows", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: { message: "Project not found." } }), { status: 404 })));
  render(<MantineProvider><AgentCapabilitiesPanel projectId="project-b" /></MantineProvider>);
  expect(await screen.findByText("Project not found.")).toBeTruthy();
  expect(screen.queryByText("inventory.list")).toBeNull();
});
