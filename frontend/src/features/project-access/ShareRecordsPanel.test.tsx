import { MantineProvider } from "@mantine/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { ShareRecordsPanel } from "./ShareRecordsPanel";

beforeEach(() => { vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} }); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const archive = "a".repeat(32) + "b".repeat(32);
const manifest = "c".repeat(64);
const row = { id: "s1", kind: "export_package", root_revision_id: "rev-1", release_id: null, purpose: "supplier quote", archive_sha256: archive, manifest_sha256: manifest, shared_by: 7, shared_by_username: "bench", shared_at: "2026-10-13T12:00:00+00:00", via: "web" };
const wrap = (node: React.ReactNode) => <MantineProvider><QueryClientProvider client={new QueryClient()}>{node}</QueryClientProvider></MantineProvider>;

test("lists shares with username, truncated hashes and the share.list query", async () => {
  const fetchMock = vi.fn(async (path: string) => {
    if (path === "/api/v0/operations") return new Response(JSON.stringify({ result: { workspace_id: "w1", shares: [row], total: 1, offset: 0, limit: 50 } }));
    return new Response(JSON.stringify({ name: "Root", number: 2 }));
  });
  vi.stubGlobal("fetch", fetchMock);
  render(wrap(<ShareRecordsPanel workspaceId="w1" />));
  expect(await screen.findByText("Export package")).toBeTruthy();
  expect(screen.getByText("bench")).toBeTruthy();
  expect(screen.getByText("supplier quote")).toBeTruthy();
  expect(document.querySelector(`abbr[data-full="${archive}"]`)).toBeTruthy();
  expect(document.querySelector(`abbr[data-full="${manifest}"]`)).toBeTruthy();
  const call = fetchMock.mock.calls.find(([path]) => path === "/api/v0/operations")!;
  const init = (call as unknown as [string, RequestInit])[1];
  expect(JSON.parse(String(init.body))).toMatchObject({ operation: "share.list", payload: { workspace_id: "w1", offset: 0 } });
});

test("empty and denied states say so", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ result: { workspace_id: "w1", shares: [], total: 0, offset: 0, limit: 50 } }))));
  render(wrap(<ShareRecordsPanel workspaceId="w1" />));
  expect(await screen.findByText("Nothing has been shared from this workspace.")).toBeTruthy();
  cleanup();
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: { message: "Not found." } }), { status: 404 })));
  render(wrap(<ShareRecordsPanel workspaceId="w1" />));
  await waitFor(() => expect(screen.getByRole("alert").textContent).toBe("Not found."));
  expect(screen.queryByRole("table")).toBeNull();
});
