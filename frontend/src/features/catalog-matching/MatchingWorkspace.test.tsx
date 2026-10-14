import { MantineProvider } from "@mantine/core";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { MatchingWorkspace } from "./MatchingWorkspace";
import type { Candidate } from "./api";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const evidence = { status: "registered_file" as const, source_bundle_revision_id: "bundle-revision", source_path: "docs/part.txt ", sha256: "a".repeat(64), rights: " declared rights " };
const candidate: Candidate = {
  candidate_id: "candidate-1", source: { revision_id: "revision-source", definition_id: "def-source", workspace_id: "w1", name: "Source item", kind: "part", number: 2, sha256: "b".repeat(64) },
  target: { revision_id: "revision-target", definition_id: "def-target", workspace_id: "w1", name: "Target item", kind: "model", number: 3, sha256: "c".repeat(64) },
  association_kind: "supplier", observed_source_identifier: "SYN-100", observed_target_identifier: "SYN100",
  basis: "Similar identifiers require review.", evidence, state: "match-v0", decision: "unreviewed",
  meaning: "reviewed_correspondence_only", created_at: "2026-01-01T00:00:00Z", proposed_by_id: 1, reviews: [],
};
function initial(path: string) {
  if (path.startsWith("/api/v0/catalog/definitions?")) {
    // The library, ordered for the optional project context; never limited to it.
    expect(new URL(path, "http://test.local").searchParams.get("project_id")).toBe("p1");
    return reply({ workspace_id: "w1", project_id: "p1", results: [{ definition_id: "def-source", name: "Source item", kind: "part" }, { definition_id: "def-target", name: "Target item", kind: "model" }], next_after: null });
  }
  if (path.startsWith("/api/v0/catalog/definitions/")) {
    const source = path.includes("def-source");
    return reply({ definition_id: source ? "def-source" : "def-target", name: source ? "Source item" : "Target item", kind: "part", revisions: [{ revision_id: source ? "revision-source" : "revision-target", number: source ? 2 : 3 }], drafts: [] });
  }
  if (path.startsWith("/api/v0/catalog-matching/evidence-files")) return reply({ results: [{ file_id: 7, bundle_name: "Supplier sheet", bundle_number: 4, ...evidence, media_type: "text/plain" }], next_after: null });
  return null;
}
async function selectSource() {
  await screen.findAllByRole("option", { name: "Source item · part" });
  fireEvent.change(screen.getByLabelText("Source definition"), { target: { value: "def-source" } });
  await screen.findByRole("option", { name: "Source item · r2" });
  fireEvent.change(screen.getByLabelText("Source exact revision"), { target: { value: "revision-source" } });
}
async function selectTarget() {
  fireEvent.change(screen.getByLabelText("Target definition"), { target: { value: "def-target" } });
  await screen.findByRole("option", { name: "Target item · r3" });
  fireEvent.change(screen.getByLabelText("Target exact revision"), { target: { value: "revision-target" } });
}

test("supplier suggestions fill exact proposal pins only after deliberate use and creation", async () => {
  const submitted: { operation: string; payload: Record<string, unknown> }[] = [];
  vi.stubGlobal("fetch", vi.fn(async (path: string, init?: RequestInit) => {
    if (path === "/api/v0/operations") {
      submitted.push(JSON.parse(String(init?.body)));
      return reply({ result: candidate });
    }
    const base = initial(path); if (base) return base;
    if (path.includes("supplier-suggestions")) return reply({ results: [{
      source_variant_id: "source-variant", target_variant_id: "target-variant",
      manufacturer: "Synthetic maker", part_number: "SYN-PAIR", target: candidate.target,
      source_association_basis: "Source catalog assertion", target_association_basis: "Target catalog assertion",
      match_basis: "exact_manufacturer_and_part_number", review: "not_reviewed", compatibility: "not_evaluated",
    }], next_after: null, inspection_truncated: false });
    if (path.startsWith("/api/v0/catalog/revisions/")) return reply({ variants: [{ variant_id: "source-variant", manufacturer: "Synthetic maker", part_number: "SYN-PAIR", association_basis: "Source catalog assertion" }] });
    if (path.startsWith("/api/v0/catalog-matching/revisions/")) return reply({ results: [], next_after: null });
    throw new Error(`Unexpected path ${path}`);
  }));
  render(<MantineProvider><MatchingWorkspace projectId="p1" /></MantineProvider>);
  await selectSource();
  fireEvent.click(screen.getByRole("button", { name: "Load source supplier identities" }));
  await screen.findByRole("option", { name: /Synthetic maker · SYN-PAIR/ });
  fireEvent.change(screen.getByLabelText("Exact source supplier identity"), { target: { value: "source-variant" } });
  fireEvent.click(screen.getByRole("button", { name: "Suggest exact identifier matches" }));
  fireEvent.click(await screen.findByRole("button", { name: "Use exact pins in proposal" }));
  expect(submitted).toHaveLength(0);
  expect(screen.getAllByText("revision-target", { selector: 'code' }).length).toBeGreaterThan(0);
  expect(screen.getAllByText("def-target", { selector: 'code' }).length).toBeGreaterThan(0);
  expect((screen.getByLabelText(/^Observed source identifier/) as HTMLInputElement).value).toBe("SYN-PAIR");
  fireEvent.click(screen.getByRole("button", { name: "Create candidate" }));
  await waitFor(() => expect(submitted).toHaveLength(1));
  expect(submitted[0]).toMatchObject({ operation: "catalog.propose_match", payload: {
    source_revision_id: "revision-source", target_revision_id: "revision-target",
    association_kind: "supplier", observed_source_identifier: "SYN-PAIR", observed_target_identifier: "SYN-PAIR", evidence: { status: "unknown" },
  } });
  expect(String(submitted[0]!.payload.basis)).toContain("source association source-variant, target association target-variant");
});

test("proposes exact pins with registered evidence and appends reviewed correspondence history", async () => {
  let created = false;
  let current = candidate;
  vi.stubGlobal("fetch", vi.fn(async (path: string, init?: RequestInit) => {
    if (path === "/api/v0/operations") {
      const envelope = JSON.parse(String(init?.body));
      expect(envelope.idempotency_key).toBeTruthy();
      if (envelope.operation === "catalog.propose_match") {
        expect(envelope.payload).toEqual({ source_revision_id: "revision-source", target_revision_id: "revision-target", association_kind: "supplier", observed_source_identifier: "SYN-100", observed_target_identifier: "SYN100", basis: "Similar identifiers require review.", evidence: { status: "registered_file", source_bundle_revision_id: "bundle-revision", source_path: "docs/part.txt " } });
        created = true;
        return reply({ result: candidate });
      }
      expect(envelope.operation).toBe("catalog.review_match");
      expect(envelope.expected_state).toBe("match-v0");
      expect(envelope.payload.decision).toBe("accepted");
      expect(envelope.payload.evidence).toEqual({ status: "unverified_citation", citation: " Supplier note, page 4 " });
      current = { ...candidate, state: "match-v1", decision: "accepted", reviews: [{ review_id: "review-1", version: 1, decision: "accepted", basis: "Reviewed correspondence only.", evidence: envelope.payload.evidence, reviewed_at: "2026-01-02T00:00:00Z", reviewed_by_id: 2 }] };
      return reply({ result: current });
    }
    const base = initial(path); if (base) return base;
    if (path.startsWith("/api/v0/catalog-matching/revisions/")) return reply({ source_revision_id: "revision-source", results: created ? [current] : [], next_after: null });
    if (path.endsWith("/candidates/candidate-1")) return reply(current);
    throw new Error(`Unexpected path ${path}`);
  }));
  render(<MantineProvider><MatchingWorkspace projectId="p1" /></MantineProvider>);
  await selectSource(); await selectTarget();
  fireEvent.change(screen.getByLabelText(/Observed source identifier/), { target: { value: "SYN-100" } });
  fireEvent.change(screen.getByLabelText(/Observed target identifier/), { target: { value: "SYN100" } });
  fireEvent.change(screen.getByLabelText(/Proposal basis/), { target: { value: "Similar identifiers require review." } });
  fireEvent.change(screen.getByLabelText("Proposal evidence status"), { target: { value: "registered_file" } });
  await screen.findByRole("option", { name: /Supplier sheet · revision 4/ });
  fireEvent.change(screen.getByLabelText(/Proposal exact source file/), { target: { value: "7" } });
  fireEvent.click(screen.getByRole("button", { name: "Create candidate" }));
  expect(await screen.findByText("Correspondence review")).toBeTruthy();
  expect(screen.getByText("Path: docs/part.txt", { exact: false }).textContent).toBe("Path: docs/part.txt ");
  expect(screen.getByText("Declared rights:", { exact: false }).textContent).toBe("Declared rights:  declared rights ");
  expect(screen.getAllByText("def-source", { selector: 'code' }).length).toBeGreaterThan(0);
  expect(screen.getAllByText("revision-source", { selector: 'code' }).length).toBeGreaterThan(0);
  expect(screen.getAllByText('def-target', { selector: 'code' }).length).toBeGreaterThan(0); expect(screen.getAllByText('revision-target', { selector: 'code' }).length).toBeGreaterThan(0);
  fireEvent.change(screen.getByLabelText("Review decision"), { target: { value: "accepted" } });
  fireEvent.change(screen.getByLabelText(/Review basis/), { target: { value: "Reviewed correspondence only." } });
  fireEvent.change(screen.getByLabelText("Review evidence status"), { target: { value: "unverified_citation" } });
  fireEvent.change(screen.getByLabelText(/Review unverified citation/), { target: { value: " Supplier note, page 4 " } });
  fireEvent.click(screen.getByRole("button", { name: "Append review" }));
  expect(await screen.findByText("Review 1: accepted")).toBeTruthy();
  expect(screen.getByText("Supplier note, page 4").textContent).toBe(" Supplier note, page 4 ");
  expect(screen.getByText(/Accepted means reviewed correspondence only/)).toBeTruthy();
});

test("focus rechecks access and clears revoked history, identifiers, options and mutations", async () => {
  let revoked = false;
  vi.stubGlobal("fetch", vi.fn(async (path: string) => {
    if (revoked) return reply({ error: { message: "Not found." } }, 404);
    const base = initial(path); if (base) return base;
    if (path.startsWith("/api/v0/catalog-matching/revisions/")) return reply({ results: [candidate], next_after: null });
    if (path.endsWith("/candidates/candidate-1")) return reply(candidate);
    throw new Error(`Unexpected path ${path}`);
  }));
  render(<MantineProvider><MatchingWorkspace projectId="p1" /></MantineProvider>);
  await selectSource();
  fireEvent.click(await screen.findByRole("button", { name: "Review candidate" }));
  expect(await screen.findByText("Correspondence review")).toBeTruthy();
  revoked = true;
  fireEvent(window, new Event("focus"));
  await waitFor(() => expect(screen.queryByText("Correspondence review")).toBeNull());
  await waitFor(() => expect(screen.getAllByText("Not found.").length).toBeGreaterThan(0));
  expect(screen.queryAllByText('def-target', { selector: 'code' })).toHaveLength(0);
  expect(screen.queryByRole("option", { name: "Source item · part" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Append review" })).toBeNull();
  expect((screen.getByRole("button", { name: "Create candidate" }) as HTMLButtonElement).disabled).toBe(true);
});

test("failed same candidate reread clears previously authorized history", async () => {
  let denied = false;
  vi.stubGlobal("fetch", vi.fn(async (path: string) => {
    const base = initial(path); if (base) return base;
    if (path.startsWith("/api/v0/catalog-matching/revisions/")) return reply({ results: [candidate], next_after: null });
    if (path.endsWith("/candidates/candidate-1")) return denied ? reply({ error: { message: "Evidence access changed." } }, 404) : reply(candidate);
    throw new Error(`Unexpected path ${path}`);
  }));
  render(<MantineProvider><MatchingWorkspace projectId="p1" /></MantineProvider>);
  await selectSource();
  fireEvent.click(await screen.findByRole("button", { name: "Review candidate" }));
  expect(await screen.findByText("Correspondence review")).toBeTruthy();
  denied = true;
  fireEvent.click(screen.getByRole("button", { name: "Review candidate" }));
  expect(await screen.findByText("Evidence access changed.")).toBeTruthy();
  expect(screen.queryByText("Correspondence review")).toBeNull();
  expect(screen.queryAllByText('def-target', { selector: 'code' })).toHaveLength(0);
  expect(screen.queryByRole("option", { name: "Source item · part" })).toBeNull();
  expect((screen.getByRole("button", { name: "Create candidate" }) as HTMLButtonElement).disabled).toBe(true);
});

test("stale review shows current retained decisions and requires a new explicit review", async () => {
  let current = candidate;
  const envelopes: object[] = [];
  vi.stubGlobal("fetch", vi.fn(async (path: string, init?: RequestInit) => {
    const base = initial(path); if (base) return base;
    if (path.startsWith("/api/v0/catalog-matching/revisions/")) return reply({ results: [candidate], next_after: null });
    if (path.endsWith("/candidates/candidate-1")) return reply(current);
    if (path === "/api/v0/operations") {
      const envelope = JSON.parse(String(init?.body));
      envelopes.push(envelope);
      expect(envelope.expected_state).toBe("match-v0");
      current = { ...candidate, state: "match-v1", decision: "needs_evidence", reviews: [{ review_id: "other-review", version: 1, decision: "needs_evidence", basis: "Another reviewer requested a dimensional drawing.", evidence: { status: "unknown" }, reviewed_at: "2026-01-03T00:00:00Z", reviewed_by_id: 3 }] };
      return reply({ error: { message: "Match review changed.", code: "conflict", details: { current } } }, 409);
    }
    throw new Error(`Unexpected path ${path}`);
  }));
  render(<MantineProvider><MatchingWorkspace projectId="p1" /></MantineProvider>);
  await selectSource();
  fireEvent.click(await screen.findByRole("button", { name: "Review candidate" }));
  await screen.findByText("Correspondence review");
  fireEvent.change(screen.getByLabelText(/Review basis/), { target: { value: "Outdated review." } });
  fireEvent.click(screen.getByRole("button", { name: "Append review" }));
  expect(await screen.findByText("Review 1: needs evidence")).toBeTruthy();
  expect(screen.getByText("Match review changed.")).toBeTruthy();
  expect((screen.getByLabelText(/Review basis/) as HTMLTextAreaElement).value).toBe("");
  expect(envelopes).toHaveLength(1);
});

test("contributors may propose but not review; viewers do neither", async () => {
  const { PermissionsProvider } = await import("../../lib/permissions");
  vi.stubGlobal("fetch", vi.fn(async (path: string) => {
    const base = initial(path); if (base) return base;
    if (path.startsWith("/api/v0/catalog-matching/revisions/")) return reply({ results: [candidate], next_after: null });
    if (path.endsWith("/candidates/candidate-1")) return reply(candidate);
    throw new Error(`Unexpected path ${path}`);
  }));
  const view = render(<MantineProvider><PermissionsProvider permissions={["workspace.read", "item.create"]}><MatchingWorkspace projectId="p1" /></PermissionsProvider></MantineProvider>);
  await selectSource(); await selectTarget();
  fireEvent.click(await screen.findByRole("button", { name: "Review candidate" }));
  await screen.findByText("Correspondence review");
  expect((screen.getByRole("button", { name: "Create candidate" }) as HTMLButtonElement).disabled).toBe(false);
  expect((screen.getByRole("button", { name: "Append review" }) as HTMLButtonElement).disabled).toBe(true);
  view.unmount();
  render(<MantineProvider><PermissionsProvider permissions={["workspace.read"]}><MatchingWorkspace projectId="p1" /></PermissionsProvider></MantineProvider>);
  await selectSource(); await selectTarget();
  expect((screen.getByRole("button", { name: "Create candidate" }) as HTMLButtonElement).disabled).toBe(true);
  expect(screen.getByText(/Read only/)).toBeTruthy();
});
