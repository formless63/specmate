import { MantineProvider } from "@mantine/core";
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
  return <MantineProvider><RevisionUpgradeWorkspace projectId={projectId} canEdit={canEdit} /></MantineProvider>;
}
async function reload() {
  fireEvent.change(screen.getByLabelText("Saved proposal ID"), { target: { value: "proposal-one" } });
  fireEvent.click(screen.getByRole("button", { name: "Reload proposal" }));
  await screen.findByText("Exact proposal proposal-one");
}

test("selects one repeated occurrence and saves exact proposal pins", async () => {
  const calls: object[] = [];
  vi.stubGlobal("fetch", vi.fn(async (path: string, init?: RequestInit) => {
    if (path.includes("assemblies/snapshots")) return reply({ occurrences: ["left", "right"].map((side) => ({ address: { path: [side] }, revision_id: "old-one", name: "Connector", display_ref: "J1" })) });
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
  expect(screen.getByText(/old-one ·/)).toBeTruthy();
  expect(screen.getByText(/left \(selected\)/)).toBeTruthy();
  expect(screen.getAllByText(/Unknown → Unknown/)).toHaveLength(2);
});

test("reviews explicit contact mapping and deliberately creates new owning draft", async () => {
  let reviewed = proposal;
  vi.stubGlobal("fetch", vi.fn(async (path: string, init?: RequestInit) => {
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
  vi.stubGlobal("fetch", vi.fn(async () => revoked ? reply({ error: { message: "Upgrade proposal unavailable." } }, 404) : reply(proposal)));
  render(view()); await reload();
  revoked = true; fireEvent(window, new Event("focus"));
  await waitFor(() => expect(screen.queryByText("Exact proposal proposal-one")).toBeNull());
  expect(screen.getByText(/cached preview was cleared/)).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Append review" })).toBeNull();
  expect(screen.queryByText(/Synthetic connector revision/)).toBeNull();
});

test("changing project clears retained proposal and stale async results", async () => {
  let resolve: ((value: Response) => void) | undefined;
  vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>((r) => { resolve = r; })));
  const { rerender } = render(view());
  fireEvent.change(screen.getByLabelText("Saved proposal ID"), { target: { value: "proposal-one" } });
  fireEvent.click(screen.getByRole("button", { name: "Reload proposal" }));
  rerender(view("p2"));
  resolve?.(reply(proposal));
  await waitFor(() => expect((screen.getByLabelText("Saved proposal ID") as HTMLInputElement).value).toBe(""));
  expect(screen.queryByText("Exact proposal proposal-one")).toBeNull();
});

test("readers inspect persisted proposals without enabling mutations", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => reply(proposal)));
  render(view("p1", false)); await reload();
  expect((screen.getByRole("button", { name: "Append review" }) as HTMLButtonElement).disabled).toBe(true);
  expect((screen.getByRole("button", { name: "Apply reviewed upgrade to draft" }) as HTMLButtonElement).disabled).toBe(true);
});

test("existing draft adoption carries a separate draft token and clears a conflicted preview", async () => {
  const accepted = { ...proposal, decision: "accepted" as const, state: "upgrade-v1" };
  vi.stubGlobal("fetch", vi.fn(async (path: string, init?: RequestInit) => {
    if (path.includes("revision-upgrades/proposals")) return reply(accepted);
    const body = JSON.parse(String(init?.body));
    expect(body.expected_state).toBe("upgrade-v1");
    expect(body.payload).toEqual({ proposal_id: "proposal-one", mode: "existing_draft", draft_id: "target-draft", draft_expected_state: "draft-v7" });
    return reply({ error: { message: "Selected owning draft changed." } }, 409);
  }));
  render(view()); await reload();
  fireEvent.change(screen.getByLabelText("Adoption target"), { target: { value: "existing_draft" } });
  fireEvent.change(screen.getByLabelText("Existing owning draft ID"), { target: { value: "target-draft" } });
  fireEvent.change(screen.getByLabelText("Existing draft state token"), { target: { value: "draft-v7" } });
  fireEvent.click(screen.getByRole("button", { name: "Apply reviewed upgrade to draft" }));
  await screen.findByText(/Selected owning draft changed/);
  expect(screen.queryByText("Exact proposal proposal-one")).toBeNull();
});

test("unchanged authorized focus refresh retains unsaved review basis", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => reply(proposal)));
  render(view()); await reload();
  fireEvent.change(screen.getByLabelText("Review basis"), { target: { value: "Unsaved exact correspondence review" } });
  fireEvent(window, new Event("focus"));
  await waitFor(() => expect((screen.getByRole("button", { name: "Reload proposal" }) as HTMLButtonElement).disabled).toBe(false));
  expect((screen.getByLabelText("Review basis") as HTMLTextAreaElement).value).toBe("Unsaved exact correspondence review");
});
