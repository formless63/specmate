import { grants } from "../../test/grants";
import { PermissionsProvider } from "../../lib/permissions";
import { MantineProvider } from "@mantine/core";
import { StrictMode } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { RevisionUpgradeWorkspace } from "./RevisionUpgradeWorkspace";
import type { Proposal } from "./api";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const impacts = { electrical: { status: "not_evaluated" as const }, mechanical: { status: "not_evaluated" as const }, firmware: { status: "not_evaluated" as const }, manufacturing: { status: "not_evaluated" as const }, evidence: { status: "not_evaluated" as const } };
const proposal: Proposal = {
  proposal_id: "proposal-one", owning_snapshot_id: "snapshot-one", owning_definition_id: "assembly-one", owning_sha256: "a".repeat(64),
  old: { revision_id: "old-one", definition_id: "body-one", name: "Synthetic connector", number: 1, sha256: "b".repeat(64) },
  candidate: { revision_id: "candidate-two", definition_id: "body-one", name: "Synthetic connector", number: 2, sha256: "c".repeat(64) },
  paths: [["left"]], basis: "Review changed contact", state: "upgrade-v0", decision: "unreviewed", impacts,
  compatibility: "not_evaluated", validity: "not_evaluated", qualification: "not_evaluated",
  affected_features: [{ path: ["left"], feature_id: "pin-a" }],
  occurrences: ["left", "right"].map((side) => ({ path: [side], old_revision_id: "old-one", candidate_revision_id: side === "left" ? "candidate-two" : "old-one", selected: side === "left", old_placement: { status: "unknown" }, candidate_placement: { status: "unknown" }, old_assignments: { firmware_revision_id: null }, candidate_assignments: { firmware_revision_id: null } })),
  relationships: [], old_relationships: [{ context_path: [], local_id: "link", kind: "electrical", a: { kind: "occurrence", path: ["left"], feature_id: "pin-a" }, b: { kind: "occurrence", path: ["right"], feature_id: "pin-a" } }], candidate_relationships: [],
  contextual_assignments: [], reviews: [], applications: [], limitations: ["Direct occurrences only"],
};
function view(projectId = "p1", canEdit = true) {
  return <MantineProvider><PermissionsProvider permissions={grants({ edit: canEdit })}><RevisionUpgradeWorkspace projectId={projectId} /></PermissionsProvider></MantineProvider>;
}
async function reload() {
  fireEvent.change(screen.getByLabelText("Saved proposal ID"), { target: { value: "proposal-one" } });
  fireEvent.click(screen.getByRole("button", { name: "Reload proposal" }));
  await screen.findByText("Exact proposal proposal-one");
}

test("selects one repeated occurrence and saves exact proposal pins", async () => {
  const calls: object[] = [];
  vi.stubGlobal("fetch", vi.fn(async (path: string, init?: RequestInit) => {
    if (path.includes("revision-upgrades/snapshots")) return reply({ occurrences: ["left", "right"].map((side) => ({ address: { path: [side] }, revision_id: "old-one", name: "Connector", display_ref: "J1" })) });
    if (path === "/api/v0/operations") {
      const body = JSON.parse(String(init?.body)); calls.push(body);
      expect(body.operation).toBe("upgrade.propose");
      expect(body.payload).toEqual({ owning_snapshot_id: "snapshot-one", old_revision_id: "old-one", candidate_revision_id: "candidate-two", paths: [["left"]], basis: "Review changed contact" });
      return reply({ result: proposal });
    }
    throw new Error(`Unexpected request ${path}`);
  }));
  render(view());
  fireEvent.change(screen.getByLabelText("Owning assembly snapshot ID"), { target: { value: "snapshot-one" } });
  fireEvent.change(screen.getByLabelText("Old revision ID"), { target: { value: "old-one" } });
  fireEvent.change(screen.getByLabelText("Candidate later revision ID"), { target: { value: "candidate-two" } });
  fireEvent.click(screen.getByRole("button", { name: "Inspect owning occurrences" }));
  fireEvent.click(await screen.findByLabelText(/left · Connector/));
  fireEvent.change(screen.getByLabelText("Proposal basis"), { target: { value: "Review changed contact" } });
  fireEvent.click(screen.getByRole("button", { name: "Save upgrade proposal" }));
  expect(await screen.findByText("Exact proposal proposal-one")).toBeTruthy();
  expect(calls).toHaveLength(1);
  expect(screen.getAllByText('old-one', { selector: 'code' }).length).toBeGreaterThan(0);
  expect(screen.getByText(/left \(selected\)/)).toBeTruthy();
  expect(screen.getAllByText(/Unknown → Unknown/)).toHaveLength(2);
});

test("reviews explicit contact mapping and deliberately creates new owning draft", async () => {
  let reviewed = proposal;
  vi.stubGlobal("fetch", vi.fn(async (path: string, init?: RequestInit) => {
    if (path.endsWith("/definitions")) return reply([{ definition_id: "assembly-one" }]);
    if (path.includes("revision-upgrades/proposals")) return reply(reviewed);
    const body = JSON.parse(String(init?.body));
    if (body.operation === "upgrade.review") {
      expect(body.expected_state).toBe("upgrade-v0");
      expect(body.payload.features).toEqual([{ path: ["left"], old_feature_id: "pin-a", candidate_feature_id: "pin-b", basis: "Reviewed synthetic declaration" }]);
      expect(Object.values(body.payload.impacts).every((i) => (i as { status: string }).status === "not_evaluated")).toBe(true);
      reviewed = { ...proposal, state: "upgrade-v1", decision: "accepted", reviews: [{ review_id: "review-one", version: 1, decision: "accepted", basis: "Correspondence only", features: body.payload.features, impacts, evidence: { status: "unknown" } }] };
      return reply({ result: reviewed });
    }
    expect(body.operation).toBe("upgrade.apply");
    expect(body.expected_state).toBe("upgrade-v1");
    expect(body.payload).toEqual({ proposal_id: "proposal-one", mode: "new_draft" });
    return reply({ result: { proposal_id: "proposal-one", application_id: "application-one", draft_id: "new-draft", state: "draft-v1", base_revision_id: "owning-revision" } });
  }));
  render(view()); await reload();
  expect((screen.getByRole("button", { name: "Apply reviewed upgrade to draft" }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.change(screen.getByLabelText("Candidate feature for left pin-a"), { target: { value: "pin-b" } });
  fireEvent.change(screen.getByLabelText("Correspondence basis for left pin-a"), { target: { value: "Reviewed synthetic declaration" } });
  fireEvent.change(screen.getByLabelText("Review decision"), { target: { value: "accepted" } });
  fireEvent.change(screen.getByLabelText("Review basis"), { target: { value: "Correspondence only" } });
  fireEvent.click(screen.getByRole("button", { name: "Append review" }));
  expect(await screen.findByText("Review 1: accepted · Correspondence only")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Apply reviewed upgrade to draft" }));
  expect(await screen.findByText(/Applied to draft new-draft/)).toBeTruthy();
});

test("revoked focus refresh clears proposal and all mutation controls", async () => {
  let revoked = false;
  vi.stubGlobal("fetch", vi.fn(async (path: string) => path.endsWith("/definitions") ? reply([{ definition_id: "assembly-one" }]) : revoked ? reply({ error: { message: "Upgrade proposal unavailable." } }, 404) : reply(proposal)));
  render(view()); await reload();
  revoked = true; fireEvent(window, new Event("focus"));
  await waitFor(() => expect(screen.queryByText("Exact proposal proposal-one")).toBeNull());
  expect(screen.getByText(/cached preview was cleared/)).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Append review" })).toBeNull();
  expect(screen.queryByText(/Synthetic connector revision/)).toBeNull();
});

test("changing project clears retained proposal and stale async results", async () => {
  let resolve: ((value: Response) => void) | undefined;
  vi.stubGlobal("fetch", vi.fn((path: string) => path.endsWith("/definitions") ? Promise.resolve(reply([{ definition_id: "assembly-one" }])) : new Promise<Response>((r) => { resolve = r; })));
  const { rerender } = render(view());
  fireEvent.change(screen.getByLabelText("Saved proposal ID"), { target: { value: "proposal-one" } });
  fireEvent.click(screen.getByRole("button", { name: "Reload proposal" }));
  rerender(view("p2"));
  resolve?.(reply(proposal));
  await waitFor(() => expect((screen.getByLabelText("Saved proposal ID") as HTMLInputElement).value).toBe(""));
  expect(screen.queryByText("Exact proposal proposal-one")).toBeNull();
});

test("readers inspect persisted proposals without enabling mutations", async () => {
  vi.stubGlobal("fetch", vi.fn(async (path: string) => path.endsWith("/definitions") ? reply([{ definition_id: "assembly-one" }]) : reply(proposal)));
  render(view("p1", false)); await reload();
  expect(screen.queryByRole("button", { name: "Append review" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Apply reviewed upgrade to draft" })).toBeNull();
  expect(screen.getByText(/Review history|Immutable review history/)).toBeTruthy();
});

test("existing draft adoption carries a separate draft token and clears a conflicted preview", async () => {
  const accepted = { ...proposal, decision: "accepted" as const, state: "upgrade-v1" };
  vi.stubGlobal("fetch", vi.fn(async (path: string, init?: RequestInit) => {
    if (path.endsWith("/definitions")) return reply([{ definition_id: "assembly-one" }]);
    if (path.includes("revision-upgrades/proposals")) return reply(accepted);
    const body = JSON.parse(String(init?.body));
    expect(body.expected_state).toBe("upgrade-v1");
    expect(body.payload).toEqual({ proposal_id: "proposal-one", mode: "existing_draft", draft_id: "target-draft", draft_expected_state: "draft-v7" });
    return reply({ error: { message: "Selected owning draft changed." } }, 409);
  }));
  render(view()); await reload();
  fireEvent.change(screen.getByLabelText("Adoption target"), { target: { value: "existing_draft" } });
  fireEvent.change(screen.getByLabelText("Existing consuming draft ID"), { target: { value: "target-draft" } });
  fireEvent.change(screen.getByLabelText("Existing draft state token"), { target: { value: "draft-v7" } });
  fireEvent.click(screen.getByRole("button", { name: "Apply reviewed upgrade to draft" }));
  await screen.findByText(/Selected owning draft changed/);
  expect(screen.queryByText("Exact proposal proposal-one")).toBeNull();
});

test("unchanged authorized focus refresh retains unsaved review basis", async () => {
  vi.stubGlobal("fetch", vi.fn(async (path: string) => path.endsWith("/definitions") ? reply([{ definition_id: "assembly-one" }]) : reply(proposal)));
  render(view()); await reload();
  fireEvent.change(screen.getByLabelText("Review basis"), { target: { value: "Unsaved exact correspondence review" } });
  fireEvent(window, new Event("focus"));
  await waitFor(() => expect((screen.getByRole("button", { name: "Reload proposal" }) as HTMLButtonElement).disabled).toBe(false));
  expect((screen.getByLabelText("Review basis") as HTMLTextAreaElement).value).toBe("Unsaved exact correspondence review");
});

test.each(["needs_evidence", "rejected"] as const)("%s review preserves required inputs for later accepted correspondence", async (initialDecision) => {
  let current = proposal;
  let submitted = 0;
  vi.stubGlobal("fetch", vi.fn(async (path: string, init?: RequestInit) => {
    if (path.endsWith("/definitions")) return reply([{ definition_id: "assembly-one" }]);
    if (path.includes("revision-upgrades/proposals")) return reply(current);
    const body = JSON.parse(String(init?.body));
    expect(body.operation).toBe("upgrade.review");
    submitted += 1;
    if (submitted === 1) {
      expect(body.expected_state).toBe("upgrade-v0");
      expect(body.payload.decision).toBe(initialDecision);
      expect(body.payload.features).toEqual([]);
      current = { ...proposal, decision: initialDecision, state: "upgrade-v1", reviews: [{ review_id: "initial-review", version: 1, decision: initialDecision, basis: "Additional correspondence review required", features: [], impacts, evidence: { status: "unknown" } }] };
    } else {
      expect(body.expected_state).toBe("upgrade-v1");
      expect(body.payload.decision).toBe("accepted");
      expect(body.payload.features).toEqual([{ path: ["left"], old_feature_id: "pin-a", candidate_feature_id: "pin-b", basis: "Compared exact contacts" }]);
      current = { ...current, decision: "accepted", state: "upgrade-v2", reviews: [...current.reviews, { review_id: "accepted-review", version: 2, decision: "accepted", basis: "Correspondence reviewed", features: body.payload.features, impacts, evidence: { status: "unknown" } }] };
    }
    return reply({ result: current });
  }));
  render(view()); await reload();
  fireEvent.change(screen.getByLabelText("Review decision"), { target: { value: initialDecision } });
  fireEvent.change(screen.getByLabelText("Review basis"), { target: { value: "Additional correspondence review required" } });
  fireEvent.click(screen.getByRole("button", { name: "Append review" }));
  await screen.findByText(`Review 1: ${initialDecision} · Additional correspondence review required`);
  expect(screen.getByLabelText("Candidate feature for left pin-a")).toBeTruthy();
  fireEvent.change(screen.getByLabelText("Review decision"), { target: { value: "accepted" } });
  fireEvent.change(screen.getByLabelText("Review basis"), { target: { value: "Correspondence reviewed" } });
  expect((screen.getByRole("button", { name: "Append review" }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.change(screen.getByLabelText("Candidate feature for left pin-a"), { target: { value: " " } });
  fireEvent.change(screen.getByLabelText("Correspondence basis for left pin-a"), { target: { value: "Compared exact contacts" } });
  expect((screen.getByRole("button", { name: "Append review" }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.change(screen.getByLabelText("Candidate feature for left pin-a"), { target: { value: "pin-b" } });
  fireEvent.click(screen.getByRole("button", { name: "Append review" }));
  await screen.findByText("Review 2: accepted · Correspondence reviewed");
  expect(submitted).toBe(2);
});


function handoff({ projectId = "p1", principalKey = "actor-one", active = true, initialProposalId = "proposal-one", canEdit = false } = {}) {
  return <MantineProvider><PermissionsProvider permissions={grants({ edit: canEdit })}><RevisionUpgradeWorkspace projectId={projectId} principalKey={principalKey} active={active} initialProposalId={initialProposalId} /></PermissionsProvider></MantineProvider>;
}
function heldReply() {
  let resolve!: (value: Response) => void;
  const promise = new Promise<Response>((done) => { resolve = done; });
  return { promise, resolve };
}

test.each([false, true])("handed off exact proposal is read freshly without review or adoption (can edit: %s)", async (canEdit) => {
  const fetch = vi.fn(async (path: string) => {
    expect(path).toBe("/api/v0/revision-upgrades/proposals/proposal-one");
    return reply({ ...proposal, decision: "accepted" });
  });
  vi.stubGlobal("fetch", fetch); render(handoff({ canEdit }));
  await screen.findByText("Exact proposal proposal-one");
  expect((screen.getByLabelText("Saved proposal ID") as HTMLInputElement).value).toBe("proposal-one");
  expect(screen.getByText("Owning snapshot snapshot-one · SHA-256 " + "a".repeat(64))).toBeTruthy();
  const append = screen.queryByRole("button", { name: "Append review" }) as HTMLButtonElement | null;
  const apply = screen.queryByRole("button", { name: "Apply reviewed upgrade to draft" }) as HTMLButtonElement | null;
  if (canEdit) { expect(append?.disabled).toBe(true); expect(apply?.disabled).toBe(false); } else { expect(append).toBeNull(); expect(apply).toBeNull(); }
  // Only the proposal itself is read: a project never limits which workspace proposals open.
  expect(fetch.mock.calls.map(([path]) => path)).toEqual(["/api/v0/revision-upgrades/proposals/proposal-one"]);
});

test("new handoff fences the prior proposal until the new one is read; any workspace owner is valid", async () => {
  const held = heldReply();
  vi.stubGlobal("fetch", vi.fn(async (path: string) => {
    if (path.endsWith("/definitions")) return reply([{ definition_id: "assembly-one" }]);
    if (path.endsWith("proposal-one")) return reply(proposal);
    return held.promise;
  }));
  const view = render(handoff({ canEdit: true }));
  await screen.findByText("Exact proposal proposal-one");
  view.rerender(handoff({ canEdit: true, initialProposalId: "proposal-other" }));
  expect(screen.queryByText("Exact proposal proposal-one")).toBeNull();
  expect(screen.queryByRole("button", { name: "Append review" })).toBeNull();
  held.resolve(reply({ ...proposal, proposal_id: "proposal-other", owning_definition_id: "assembly-from-another-project" }));
  expect(await screen.findByText("Exact proposal proposal-other")).toBeTruthy();
  expect(screen.queryByText("Exact proposal proposal-one")).toBeNull();
});

test.each(["project", "principal"])("%s transition fences a handed off proposal and rejects its old successful reply", async (scope) => {
  const old = heldReply(), current = heldReply();
  let loads = 0;
  vi.stubGlobal("fetch", vi.fn(async (path: string) => {
    if (path.endsWith("/definitions")) return reply([{ definition_id: "assembly-one" }]);
    return ++loads === 1 ? old.promise : current.promise;
  }));
  const view = render(handoff());
  await waitFor(() => expect(loads).toBe(1));
  view.rerender(handoff({ projectId: scope === "project" ? "p2" : "p1", principalKey: scope === "principal" ? "actor-two" : "actor-one" }));
  await waitFor(() => expect(loads).toBe(2));
  old.resolve(reply(proposal));
  await Promise.resolve();
  expect(screen.queryByText("Exact proposal proposal-one")).toBeNull();
  current.resolve(reply({ error: { message: "Current proposal closure unavailable." } }, 404));
  await screen.findByText(/Current proposal closure unavailable/);
  expect(screen.queryByText(/Synthetic connector revision/)).toBeNull();
});

test("inactive handoff waits and returning to the same proposal requires fresh access", async () => {
  let deny = false;
  const fetch = vi.fn(async (path: string) => path.endsWith("/definitions") ? reply([{ definition_id: "assembly-one" }]) : deny ? reply({ error: { message: "Source access revoked." } }, 404) : reply(proposal));
  vi.stubGlobal("fetch", fetch);
  const view = render(handoff({ active: false }));
  expect(fetch).not.toHaveBeenCalled();
  view.rerender(handoff()); await screen.findByText("Exact proposal proposal-one");
  const loaded = fetch.mock.calls.length;
  view.rerender(handoff({ active: false }));
  expect(screen.queryByText("Exact proposal proposal-one")).toBeNull();
  fireEvent(window, new Event("focus"));
  expect(fetch).toHaveBeenCalledTimes(loaded);
  deny = true; view.rerender(handoff());
  await screen.findByText(/Source access revoked/);
  expect(screen.queryByText("Exact proposal proposal-one")).toBeNull();
  expect(screen.queryByRole("button", { name: "Apply reviewed upgrade to draft" })).toBeNull();
});


test("StrictMode handoff reacquires current proof after cleanup and settles without a write", async () => {
  const fetch = vi.fn(async (path: string) => path.endsWith("/definitions") ? reply([{ definition_id: "assembly-one" }]) : reply(proposal));
  vi.stubGlobal("fetch", fetch); render(<StrictMode>{handoff()}</StrictMode>);
  await screen.findByText("Exact proposal proposal-one");
  expect((screen.getByRole("button", { name: "Reload proposal" }) as HTMLButtonElement).disabled).toBe(false);
  expect(fetch.mock.calls.every(([path]) => path !== "/api/v0/operations")).toBe(true);
});
