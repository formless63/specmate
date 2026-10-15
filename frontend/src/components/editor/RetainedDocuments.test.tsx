import { Blob as NodeBlob } from "node:buffer";
import { createHash } from "node:crypto";
import { MantineProvider } from "@mantine/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import * as api from "../../features/preparation-documents/api";
import { RetainedDocuments } from "./RetainedDocuments";

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal("Blob", NodeBlob);
  HTMLElement.prototype.scrollIntoView = vi.fn();
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
const bytes = "Original retained sheet · 端子/β:07\n";
const sha = createHash("sha256").update(bytes).digest("hex");
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
function server(version = 2) {
  let status = 200, expired = false, holdDownload: Promise<void> | null = null;
  const calls: { operation?: string; payload?: Record<string, unknown>; document_set_id?: string; filename?: string }[] = [];
  const retained: api.Receipt = {
    document_set_id: "historic-set", generator: `specmate.preparation-documents/${version}`, created_at: "2026-01-01T01:00:00Z", created_by_id: 1, sha256: "historic-input-hash",
    manifest: { inputs_sha256: "historic-input-hash", readiness: "declared_with_unknowns", inputs: {
      root: { revision_id: "exact-r1", snapshot_id: "snapshot-r1", snapshot_sha256: "snapshot-hash", name: "Original synthetic root", kind: "cable" },
      generator: `specmate.preparation-documents/${version}`, format: "specmate.coordinated-document-set/0.1", physical_test: "not_performed", physical_continuity: "not_evaluated", fit: "not_evaluated", physical_qualification: false,
      revision_pins: [], source_pins: [], rights_reviews: [], configuration: { ...api.emptyConfiguration(), root_revision_id: "exact-r1", quantity: null },
    }, context_pins: [], document_assessments: {}, issues: [], outputs: [{ filename: "build-sheet.html", sha256: sha, size: Buffer.byteLength(bytes), media_type: "text/html", rights: "unknown", inputs_sha256: "historic-input-hash" }] },
  };
  const row = { document_set_id: "historic-set", root_revision_id: "exact-r1", created_at: retained.created_at, generator: retained.generator, quantity: null, inputs_sha256: retained.sha256 };
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)); calls.push(body);
    if (url.endsWith("/download")) {
      if (holdDownload) await holdDownload;
      return status === 200 ? new Response(bytes) : json({ error: { message: "Current retained source unavailable" } }, status);
    }
    if (status !== 200) return json({ error: { message: "Current retained source unavailable" } }, status);
    if (body.operation === "preparation_documents.list") {
      if (body.payload.after && expired) return json({ error: { message: "Document cursor unavailable for this root." } }, 422);
      return json({ result: { root_revision_id: "exact-r1", results: body.payload.after ? [] : [row], next_after: body.payload.after ? null : "opaque-cursor", listing: "current_readable_page_no_hidden_total" } });
    }
    if (body.operation === "preparation_documents.read") return json({ result: retained });
    throw new Error(`Unexpected operation ${body.operation}`);
  }));
  return { calls, retained, status: (value: number) => { status = value; }, expire: () => { expired = true; }, hold: () => { let release!: () => void; holdDownload = new Promise(resolve => { release = resolve; }); return release; } };
}
function mount() {
  const cache = new QueryClient({ defaultOptions: { queries: { retry: false } } }), denied = vi.fn();
  const ui = (active = true) => <MantineProvider env="test"><QueryClientProvider client={cache}><RetainedDocuments rootRevisionId="exact-r1" principalKey="viewer:w1" workspaceId="w1" active={active} onDenied={denied} /></QueryClientProvider></MantineProvider>;
  const result = render(ui());
  return { cache, denied, active: (value: boolean) => result.rerender(ui(value)) };
}
async function open() {
  await screen.findByRole("combobox", { name: "Retained document set" });
  fireEvent.click(screen.getByRole("combobox", { name: "Retained document set" }));
  fireEvent.click(await screen.findByRole("option", { name: /quantity unknown/ }));
  await screen.findByText(/Immutable set historic-set/);
}

test.each([2, 3])("older generator /%i reopens exact receipt and downloads original hash-verified bytes without regenerating", async version => {
  const backend = server(version); const save = vi.spyOn(api, "saveFile").mockImplementation(() => {}); mount();
  await open();
  expect(screen.getByText(/Immutable set/).textContent).toContain(`preparation-documents/${version}`);
  fireEvent.click(screen.getByRole("button", { name: "Download historic build-sheet.html" }));
  await waitFor(() => expect(save).toHaveBeenCalledOnce());
  expect(await save.mock.calls[0]![0].text()).toBe(bytes);
  expect(backend.calls).toContainEqual(expect.objectContaining({ operation: "preparation_documents.read", payload: { document_set_id: "historic-set" } }));
  expect(backend.calls).toContainEqual({ document_set_id: "historic-set", filename: "build-sheet.html" });
  expect(backend.calls.filter(call => call.operation).every(call => ["preparation_documents.list", "preparation_documents.read"].includes(call.operation!))).toBe(true);
  expect(backend.retained.manifest.outputs[0]!.sha256).toBe(sha);
});

test("denied refetch withdraws retained cached identity and restores private selection only after fresh confirmation", async () => {
  const backend = server(); const session = mount(); await open(); backend.status(403);
  await act(async () => { await session.cache.invalidateQueries({ queryKey: ["retained-document-receipt"] }); });
  await screen.findByText("Current retained source unavailable");
  expect(screen.queryByText(/Immutable set/)).toBeNull(); expect(screen.queryByText(/historic-input-hash/)).toBeNull();
  expect(screen.queryByRole("button", { name: /Download historic/ })).toBeNull();
  expect(session.denied).toHaveBeenCalledOnce();
  expect(session.cache.getQueryCache().findAll({ queryKey: ["retained-document-receipt"] }).some(query => query.state.data && query.state.status === "error")).toBe(true);
  backend.status(200); fireEvent.click(screen.getByRole("button", { name: "Refresh retained document access" }));
  await screen.findByText(/Immutable set historic-set/);
});

test("held historic download cannot save after inactivation and expired paging can restart at the selected root", async () => {
  const backend = server(); const save = vi.spyOn(api, "saveFile").mockImplementation(() => {}); const session = mount(); await open();
  const release = backend.hold(); fireEvent.click(screen.getByRole("button", { name: "Download historic build-sheet.html" }));
  session.active(false); await act(async () => { release(); });
  expect(save).not.toHaveBeenCalled(); expect(screen.queryByText(/Immutable set/)).toBeNull();
  session.active(true); await screen.findByText(/Immutable set historic-set/); backend.expire();
  fireEvent.click(screen.getByRole("button", { name: "Older document sets" })); await screen.findByText("Document cursor unavailable for this root.");
  fireEvent.click(screen.getByRole("button", { name: "Newest document sets" })); await screen.findByRole("combobox", { name: "Retained document set" });
  expect(backend.calls.filter(call => call.operation === "preparation_documents.list").every(call => call.payload?.root_revision_id === "exact-r1")).toBe(true);
  expect(backend.calls.filter(call => call.operation === "preparation_documents.list").at(-1)?.payload?.after).toBeNull();
});
