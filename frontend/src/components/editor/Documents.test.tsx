import { MantineProvider } from "@mantine/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { PermissionsProvider } from "../../lib/permissions";
import { cable, stock, boardEnd, inlineEnd } from "../../features/cable-workbench/fixtures";
import { emptyConfiguration, type Configuration, type Manifest, type Preview } from "../../features/preparation-documents/api";
import { Documents, printDocument, RootDocuments, type DocumentsProps } from "./Documents";
import * as documentApi from "../../features/preparation-documents/api";

beforeEach(() => { vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} }); HTMLElement.prototype.scrollIntoView = vi.fn(); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
function projection(config: Configuration): Preview {
  const manifest: Manifest = {
    inputs_sha256: "synthetic-hash", readiness: "declared_with_unknowns",
    inputs: { root: { revision_id: config.root_revision_id, snapshot_id: "snapshot", snapshot_sha256: "sha", name: "Synthetic cable", kind: "cable" }, generator: "specmate.preparation-documents/4", format: "specmate.coordinated-document-set/0.1", physical_test: "not_performed", physical_continuity: "not_evaluated", fit: "not_evaluated", physical_qualification: false, revision_pins: [], source_pins: [], rights_reviews: [{ subject: "design:exact-r1", review: { subject: "design:exact-r1", decision: "unknown", basis: "" } }], configuration: config },
    context_pins: [{ address: { root_snapshot_id: "snapshot", path: [], revision_id: "exact-r1", snapshot_sha256: "sha" }, kind: "cable", disposition: "unknown", sections: [{ section_id: null, stock_revision_id: "stock", end_ids: ["a", "b"] }] }], document_assessments: {}, issues: [], outputs: [],
  };
  return { manifest, state: `token:${config.quantity}`, sections: { revision_specifications: [], specifications: [], schematic: [], cut_preparation: [{ address: { path: [] }, row_kind: "declared_physical_piece", design_piece_count: config.quantity, length_mm: null }], end_preparation: [], terminations: [{ address: { path: [] }, rows: [{ endpoint_id: "a", endpoint_label: "Supply", element_path: "stock.中心", layer_id: "plug", target_label: "端子/β:07" }], assignments: [{ endpoint_id: "a", element_path: "stock.中心", layer_id: "plug", terminal_id: "端子/β:07" }], unassigned: [{ endpoint_id: "b", element_path: "stock.中心" }] }], test_intent: [{ address: { path: [] }, declarations: { test_plan: { pairs: [{ local_id: "authored-1", first: { endpoint_id: "a", contact_id: "端子/β:07" }, second: { endpoint_id: "b", contact_id: "3" }, intent: "isolation" }] } } }], procurement: null, issues: [] } };
}
function server() {
  let status = 200, failGenerate = false;
  let generateWait: Promise<void> | null = null, previewWait: Promise<void> | null = null;
  const calls: { operation: string; payload: Configuration; expected_state?: string; idempotency_key?: string }[] = [];
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.includes("workspace/library?")) return json({ results: [], next_after: null });
    if (url.endsWith("/operations")) {
      const body = JSON.parse(String(init?.body)); calls.push(body);
      if (status !== 200) return json({ error: { message: status === 403 ? "Current authority withdrawn" : "Temporary document outage" } }, status);
      const config = { ...emptyConfiguration(), ...body.payload };
      const projected = projection(config);
      if (body.operation === "preparation_documents.defaults") return json({ result: { configuration: config, root: projected.manifest.inputs.root, context_pins: projected.manifest.context_pins, rights_subjects: ["design:exact-r1"] } });
      if (body.operation === "preparation_documents.preview") { if (previewWait) await previewWait; return json({ result: projected }); }
      if (body.operation === "preparation_documents.generate") {
        if (generateWait) await generateWait;
        if (failGenerate) { failGenerate = false; return json({ error: { message: "Response unavailable" } }, 503); }
        return json({ result: { document_set_id: "set-1", manifest: projected.manifest, sha256: "synthetic-hash", created_by_id: 1, created_at: "2026-01-01", generator: projected.manifest.inputs.generator } });
      }
    }
    throw new Error(`Unexpected request ${url}`);
  });
  vi.stubGlobal("fetch", fetch);
  return { calls, fetch, status: (value: number) => { status = value; }, failGenerate: () => { failGenerate = true; }, holdGenerate: () => { let release!: () => void; generateWait = new Promise(resolve => { release = resolve; }); return release; }, holdPreview: () => { let release!: () => void; previewWait = new Promise(resolve => { release = resolve; }); return release; } };
}
function mount(draft = false, editable = true) {
  const cache = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const authorize = vi.fn(async () => {});
  const props: DocumentsProps = { name: "Synthetic cable", principalKey: "owner:w1", workspaceId: "w1", active: true, cable: cable(), stock: stock(), stacks: [boardEnd(), inlineEnd()], snapshot: { definitionId: "c1", revisionId: draft ? null : "exact-r1", draftId: draft ? "draft-1" : null, working: cable(), saved: cable(), dirty: draft }, authorizeWorking: authorize };
  const element = () => <MantineProvider><QueryClientProvider client={cache}><PermissionsProvider permissions={editable ? ["workspace.read", "design.edit"] : ["workspace.read"]}><Documents {...props} /></PermissionsProvider></QueryClientProvider></MantineProvider>;
  const result = render(element());
  return { cache, props, authorize, update: (next: Partial<DocumentsProps>) => { Object.assign(props, next); result.rerender(element()); } };
}
const paper = (title = "Build sheet preview") => screen.getByTitle(title) as HTMLIFrameElement;

test("exact selected root renders numbered landings and authored continuity without loading workspace history or definitions", async () => {
  const api = server(); mount(); await screen.findByTitle("Build sheet preview");
  expect(paper().srcdoc).toContain("端子/β:07"); expect(paper().srcdoc).toContain("unassigned");
  expect(paper().srcdoc).toContain("<td>1</td>"); expect(paper().srcdoc).not.toContain("UNRELEASED");
  fireEvent.click(screen.getByRole("tab", { name: "Continuity spec" }));
  expect(paper("Continuity spec preview").srcdoc).toContain("authored-1");
  expect(paper("Continuity spec preview").srcdoc).toContain("physical test not performed");
  expect(api.fetch.mock.calls.every(([url]) => url === "/api/v0/operations")).toBe(true);
  expect(api.calls.every(call => call.payload.root_revision_id === "exact-r1")).toBe(true);
  expect(screen.queryByLabelText("Document root definition")).toBeNull();
});

test("success then current authority denial hides cached sheet, exact metadata and staged inputs, restoring private values only after confirmation", async () => {
  const api = server(); const session = mount(); await screen.findByTitle("Build sheet preview");
  fireEvent.change(screen.getByLabelText("Document quantity"), { target: { value: "7" } });
  await waitFor(() => expect(api.calls.some(call => call.operation === "preparation_documents.preview" && call.payload.quantity === 7)).toBe(true));
  await screen.findByTitle("Build sheet preview"); api.status(403);
  await act(async () => { await session.cache.invalidateQueries({ queryKey: ["document-preview"] }); });
  await screen.findByText("Document content is hidden until current access is confirmed. Prepared inputs remain private.");
  expect(screen.queryByTitle("Build sheet preview")).toBeNull(); expect(screen.queryByLabelText("Document quantity")).toBeNull();
  expect(session.cache.getQueryCache().findAll({ queryKey: ["document-preview"] }).some(query => query.state.status === "error" && query.state.data)).toBe(true);
  api.status(200); fireEvent.click(screen.getByRole("button", { name: "Refresh document access" }));
  await screen.findByTitle("Build sheet preview"); expect((screen.getByLabelText("Document quantity") as HTMLInputElement).value).toBe("7");
});

test("transient failure is unavailable rather than authority denial; invalid quantity cannot export an older valid projection", async () => {
  const api = server(); const session = mount(); await screen.findByTitle("Build sheet preview");
  fireEvent.change(screen.getByLabelText("Document quantity"), { target: { value: "invalid" } });
  expect(screen.getByRole("button", { name: "Print" }).hasAttribute("disabled")).toBe(true);
  expect(screen.queryByTitle("Build sheet preview")).toBeNull();
  fireEvent.change(screen.getByLabelText("Document quantity"), { target: { value: "1" } });
  api.status(500); await act(async () => { await session.cache.invalidateQueries({ queryKey: ["document-preview"] }); });
  await screen.findByText("Temporary document outage");
  expect(screen.queryByText("Current authority withdrawn")).toBeNull(); expect(screen.queryByTitle("Build sheet preview")).toBeNull();
});

test("draft is live UNRELEASED and retained across inactive view changes; no server preview or writes", async () => {
  const api = server(); const session = mount(true); await screen.findByTitle("Build sheet preview");
  expect(paper().srcdoc).toContain("UNRELEASED"); expect(paper().srcdoc).toContain("unsaved changes");
  const next = structuredClone(session.props.snapshot); next.working.assignments[0]!.terminal_id = "missing/端子";
  session.update({ snapshot: next }); expect(paper().srcdoc).toContain("missing/端子");
  session.update({ active: false }); expect(screen.queryByTitle("Build sheet preview")).toBeNull();
  session.update({ active: true }); expect(paper().srcdoc).toContain("missing/端子");
  expect(api.calls).toEqual([]);
});

test("retaining uses reviewed state and stable retry key; viewer cannot generate", async () => {
  const api = server(); mount(); await screen.findByTitle("Build sheet preview");
  fireEvent.click(screen.getByRole("tab", { name: "Export" })); api.failGenerate();
  fireEvent.click(screen.getByRole("button", { name: "Retain reviewed document set" })); await screen.findByText("Response unavailable");
  fireEvent.click(screen.getByRole("button", { name: "Retain reviewed document set" })); await screen.findByText(/Retained set set-1/);
  const writes = api.calls.filter(call => call.operation === "preparation_documents.generate");
  expect(writes).toHaveLength(2); expect(writes[0]?.expected_state).toBe("token:1"); expect(writes[0]?.idempotency_key).toBe(writes[1]?.idempotency_key);
  cleanup(); mount(false, false); await screen.findByTitle("Build sheet preview"); fireEvent.click(screen.getByRole("tab", { name: "Export" }));
  expect(screen.getByRole("button", { name: "Retain reviewed document set" }).hasAttribute("disabled")).toBe(true);
});

test("held generation completion stays private while inactive and cannot cross a replacement workspace/definition context", async () => {
  const api = server(); const session = mount(); await screen.findByTitle("Build sheet preview");
  const release = api.holdGenerate(); fireEvent.click(screen.getByRole("tab", { name: "Export" }));
  fireEvent.click(screen.getByRole("button", { name: "Retain reviewed document set" }));
  await waitFor(() => expect(api.calls.some(call => call.operation === "preparation_documents.generate")).toBe(true));
  session.update({ active: false }); await act(async () => release());
  expect(screen.queryByText(/Retained set set-1/)).toBeNull();
  session.update({ active: true }); await screen.findByText(/Retained set set-1/);
  session.update({ workspaceId: "w2", principalKey: "owner:w2", snapshot: { ...session.props.snapshot, definitionId: "c2" } });
  await screen.findByTitle("Build sheet preview");
  fireEvent.click(screen.getByRole("tab", { name: "Export" })); expect(screen.queryByText(/Retained set set-1/)).toBeNull();
});

test("focus reactivation withdraws the cached sheet until current exact inputs settle", async () => {
  const api = server(); mount(); await screen.findByTitle("Build sheet preview");
  const release = api.holdPreview(); act(() => window.dispatchEvent(new Event("blur")));
  expect(screen.queryByTitle("Build sheet preview")).toBeNull();
  act(() => window.dispatchEvent(new Event("focus")));
  await screen.findByText("Reading exact document inputs…"); expect(screen.queryByTitle("Build sheet preview")).toBeNull();
  await act(async () => release()); await screen.findByTitle("Build sheet preview");
});

test("fresh export denial cannot download retained cached rows; print dialog receives only the rendered document", async () => {
  const api = server(); mount(); await screen.findByTitle("Build sheet preview");
  const save = vi.spyOn(documentApi, "saveFile").mockImplementation(() => {});
  api.status(403); fireEvent.click(screen.getByRole("button", { name: "Export…" }));
  fireEvent.click(await screen.findByRole("menuitem", { name: "Landings CSV" }));
  await screen.findByText("Current authority withdrawn"); expect(save).not.toHaveBeenCalled();
  printDocument("<!doctype html><p>Actual isolated sheet</p>");
  const frame = screen.getByTitle("Print design document") as HTMLIFrameElement;
  const print = vi.fn(), focus = vi.fn(); Object.assign(frame.contentWindow!, { print, focus });
  fireEvent.load(frame); expect(print).toHaveBeenCalledOnce(); expect(frame.srcdoc).toContain("Actual isolated sheet");
  frame.contentWindow!.dispatchEvent(new Event("afterprint")); expect(screen.queryByTitle("Print design document")).toBeNull();
});

test("generic frozen root accepts a separate Formboard adapter without loading cable working data", async () => {
  server(); const cache = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<MantineProvider><QueryClientProvider client={cache}><RootDocuments name="Synthetic harness" snapshot={{ definitionId: "h1", revisionId: "exact-harness-r1", draftId: null }} workspaceId="w1" principalKey="owner:w1" active authorizeWorking={async () => {}} formboard={sheet => `<!doctype html><p>Formboard of ${sheet.identity}</p>`} /></QueryClientProvider></MantineProvider>);
  await screen.findByTitle("Build sheet preview"); fireEvent.click(screen.getByRole("tab", { name: "Formboard" }));
  expect(paper("Formboard preview").srcdoc).toContain("Formboard of exact-harness-r1");
});
