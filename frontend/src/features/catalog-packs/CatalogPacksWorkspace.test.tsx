import { MantineProvider } from "@mantine/core";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { CatalogPacksWorkspace } from "./CatalogPacksWorkspace";
import type { Decision, Manifest, Pack, Version } from "./api";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
beforeEach(() => vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} }));
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const sha = "a".repeat(64);
const manifest: Manifest = { format: "specmate.catalog-pack", contract_version: "1", package_key: "synthetic.parts", label: " Synthetic catalog ", version: "1.0", publisher: "Declared publisher", rights: " unknown rights ", capabilities: [], requested_authority: [], dependencies: [], signature_claim: null, entries: [{ key: "part", label: " Adopted item ", category: "content", revision_id: "source-revision", revision_sha256: sha, rights: "unknown" }] };
const version: Version = { version_id: "version-1", pack_id: "pack-1", sha256: "b".repeat(64), manifest, manifest_source: null, signature_status: "unsigned", publisher_status: "unverified_claim", compatibility: "supported_contract", execution_authority: "none", registered_at: "2026-01-01T00:00:00Z", registered_by_id: 1, entries: [{ ...manifest.entries[0]!, engineering: { definition_id: "source-definition", revision_id: "source-revision", name: "Source item", kind: "part", number: 2, sha256: sha }, interpretation: "draft_copy_available" }] };
const initialPack: Pack = { pack_id: "pack-1", project_id: "project-1", package_key: "synthetic.parts", state: "pack-v0", installed_version_id: null, enabled: false, versions: [{ version_id: "version-1", version: "1.0", label: manifest.label, sha256: version.sha256 }], execution_authority: "none" };
const projects = [{ project_id: "project-1", name: "Synthetic project", permissions: ["project.read", "design.edit"] }];
function common(path: string) {
  if (path === "/api/v0/projects") return response(projects);
  if (path === "/api/v0/projects/project-1/definitions") return response([{ definition_id: "source-definition", name: "Source item", kind: "part" }]);
  if (path.startsWith("/api/v0/catalog/definitions/source-definition")) return response({ revisions: [{ revision_id: "source-revision", number: 2 }] });
  if (path === "/api/v0/revisions/source-revision") return response({ revision_id: "source-revision", sha256: sha });
  if (path.startsWith("/api/v0/catalog-packs/projects/project-1/source-files")) return response({ results: [{ file_id: 9, bundle_name: "Model sources", bundle_number: 3, source_bundle_revision_id: "bundle-3", source_path: "models/model.step ", sha256: sha, rights: " declared file rights " }], next_after: null });
  return null;
}
function fillRegistration() {
  for (const [label, value] of [["Package key", "synthetic.parts"], ["Catalog label", " Synthetic catalog "], ["Version label", "1.0"], ["Declared publisher", "Declared publisher"], ["Declared pack rights", " unknown rights "], ["Entry 1 key", "part"], ["Entry 1 label", " Adopted item "]]) fireEvent.change(screen.getByLabelText(new RegExp(`^${label}`)), { target: { value } });
}

test("registers structured exact content, installs it, and deliberately creates a local draft", async () => {
  let registered = false;
  let current = initialPack;
  const decisions: Decision[] = [];
  vi.stubGlobal("fetch", vi.fn(async (path: string, init?: RequestInit) => {
    const base = common(path); if (base) return base;
    if (path === "/api/v0/operations") {
      const envelope = JSON.parse(String(init?.body));
      expect(envelope.idempotency_key).toBeTruthy();
      if (envelope.operation === "catalog_pack.register") { expect(envelope.payload.manifest).toEqual(manifest); expect(envelope.payload.pack_id).toBeNull(); registered = true; return response({ result: version }); }
      if (envelope.operation === "catalog_pack.install") { expect(envelope.expected_state).toBe("pack-v0"); current = { ...current, state: "pack-v1", enabled: true, installed_version_id: "version-1" }; decisions.push({ decision_id: "install-1", sequence: 1, action: "install", version_id: "version-1", version: "1.0", basis: envelope.payload.basis, decided_by_id: 1, decided_at: "2026-01-02T00:00:00Z", adoptions: [] }); return response({ result: current }); }
      expect(envelope.operation).toBe("catalog_pack.adopt"); expect(envelope.expected_state).toBe("pack-v1"); expect(envelope.payload.entry_keys).toEqual(["part"]);
      current = { ...current, state: "pack-v2" }; decisions.push({ decision_id: "adopt-1", sequence: 2, action: "adopt", version_id: "version-1", version: "1.0", basis: envelope.payload.basis, decided_by_id: 1, decided_at: "2026-01-03T00:00:00Z", adoptions: [{ key: "part", source_revision_id: "source-revision", definition_id: "new-definition", draft_id: "new-draft", status: "draft_created" }] }); return response({ result: current });
    }
    if (path.startsWith("/api/v0/catalog-packs/projects/project-1?")) return response({ results: registered ? [current] : [], next_after: null });
    if (path === "/api/v0/catalog-packs/packs/pack-1") return response(current);
    if (path.includes("/packs/pack-1/history")) return response({ results: decisions, next_after: null });
    if (path === "/api/v0/catalog-packs/versions/version-1") return response(version);
    throw new Error(`Unexpected path ${path}`);
  }));
  render(<MantineProvider><CatalogPacksWorkspace projectId="project-1" /></MantineProvider>);
  await screen.findByRole("option", { name: "Source item · part" }); fillRegistration();
  fireEvent.change(screen.getByLabelText(/Entry 1 source definition/), { target: { value: "source-definition" } });
  await screen.findByRole("option", { name: "Source item · r2" });
  fireEvent.change(screen.getByLabelText(/Entry 1 exact source revision/), { target: { value: "source-revision" } });
  await waitFor(() => expect(vi.mocked(fetch).mock.calls.some(([path]) => path === "/api/v0/revisions/source-revision")).toBe(true));
  fireEvent.click(screen.getByRole("button", { name: "Register exact version" }));
  expect(await screen.findByText(/Canonical manifest SHA-256/)).toBeTruthy();
  expect(screen.getByText(/Declared pack rights:/).textContent).toBe("Declared pack rights:  unknown rights ");
  expect(screen.getByText(/Signature: unsigned · publisher claim unverified/)).toBeTruthy();
  expect(screen.getAllByText('source-definition', { selector: 'code' }).length).toBeGreaterThan(0);
  expect(screen.getAllByText('source-revision', { selector: 'code' }).length).toBeGreaterThan(0);
  fireEvent.change(screen.getByLabelText("Pack decision basis"), { target: { value: "Reviewed inert catalog installation." } });
  fireEvent.click(screen.getByRole("button", { name: "Install selected version" }));
  await screen.findByText("1: install · version 1.0");
  fireEvent.click(screen.getByRole("checkbox", { name: /Adopt.*item/ }));
  fireEvent.change(screen.getByLabelText("Pack decision basis"), { target: { value: "Create an independent editable draft." } });
  fireEvent.click(screen.getByRole("button", { name: "Adopt selected entries" }));
  expect(await screen.findByText("New local definition new-definition · draft new-draft")).toBeTruthy();
  expect(screen.getByText(/Open this definition in Identity/)).toBeTruthy();
});

test("registered model file retains exact path and declared rights as inert metadata", async () => {
  let captured: Manifest | null = null;
  vi.stubGlobal("fetch", vi.fn(async (path: string, init?: RequestInit) => {
    const base = common(path); if (base) return base;
    if (path.startsWith("/api/v0/catalog-packs/projects/project-1?")) return response({ results: [], next_after: null });
    if (path === "/api/v0/operations") { captured = JSON.parse(String(init?.body)).payload.manifest; return response({ error: { message: "Synthetic inspection stop." } }, 422); }
    throw new Error(`Unexpected path ${path}`);
  }));
  render(<MantineProvider><CatalogPacksWorkspace projectId="project-1" /></MantineProvider>);
  await screen.findByRole("option", { name: "Source item · part" }); fillRegistration();
  fireEvent.change(screen.getByLabelText("Entry 1 category"), { target: { value: "model" } });
  await screen.findByRole("option", { name: /Model sources · revision 3/ });
  fireEvent.change(screen.getByLabelText(/Entry 1 exact registered file/), { target: { value: "9" } });
  fireEvent.click(screen.getByRole("button", { name: "Register exact version" }));
  await screen.findByText("Synthetic inspection stop.");
  expect(captured!.entries[0]!.source).toEqual({ source_bundle_revision_id: "bundle-3", source_path: "models/model.step ", sha256: sha, rights: " declared file rights " });
  expect(captured!.entries[0]!.category).toBe("model"); expect(captured!.requested_authority).toEqual([]);
});

test("denied same-pack reread clears history, source options and adoption controls", async () => {
  let denied = false;
  vi.stubGlobal("fetch", vi.fn(async (path: string) => {
    const base = common(path); if (base) return base;
    if (path.startsWith("/api/v0/catalog-packs/projects/project-1?")) return response({ results: [initialPack], next_after: null });
    if (path === "/api/v0/catalog-packs/packs/pack-1") return denied ? response({ error: { message: "Source history access changed." } }, 404) : response(initialPack);
    if (path.includes("/packs/pack-1/history")) return response({ results: [], next_after: null });
    if (path === "/api/v0/catalog-packs/versions/version-1") return response(version);
    throw new Error(`Unexpected path ${path}`);
  }));
  render(<MantineProvider><CatalogPacksWorkspace projectId="project-1" /></MantineProvider>);
  fireEvent.click(await screen.findByRole("button", { name: "Inspect pack" }));
  await screen.findByText(/Canonical manifest SHA-256/); denied = true;
  fireEvent.click(screen.getByRole("button", { name: "Inspect pack" }));
  expect(await screen.findByText("Source history access changed.")).toBeTruthy();
  expect(screen.queryByText(/Definition source-definition/)).toBeNull();
  expect(screen.queryByRole("button", { name: "Adopt selected entries" })).toBeNull();
  expect(screen.queryByRole("option", { name: "Source item · part" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Register exact version" })).toBeNull();
});

test("focus refresh clears retained decisions before rereading revoked scope", async () => {
  let revoked = false;
  vi.stubGlobal("fetch", vi.fn(async (path: string) => {
    if (revoked) return response({ error: { message: "Project not found." } }, 404);
    const base = common(path); if (base) return base;
    if (path.startsWith("/api/v0/catalog-packs/projects/project-1?")) return response({ results: [initialPack], next_after: null });
    if (path === "/api/v0/catalog-packs/packs/pack-1") return response(initialPack);
    if (path.includes("/packs/pack-1/history")) return response({ results: [], next_after: null });
    if (path === "/api/v0/catalog-packs/versions/version-1") return response(version);
    throw new Error(`Unexpected path ${path}`);
  }));
  render(<MantineProvider><CatalogPacksWorkspace projectId="project-1" /></MantineProvider>);
  fireEvent.click(await screen.findByRole("button", { name: "Inspect pack" })); await screen.findByText(/Canonical manifest SHA-256/);
  revoked = true; fireEvent(window, new Event("focus"));
  expect(await screen.findByText("Project not found.")).toBeTruthy();
  expect(screen.queryByText(/Canonical manifest SHA-256/)).toBeNull();
  expect(screen.queryByRole("button", { name: "Install selected version" })).toBeNull();
});
