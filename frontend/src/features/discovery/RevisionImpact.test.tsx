import { MantineProvider } from "@mantine/core";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { RevisionImpact } from "./RevisionImpact";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

test("compares explicit exact pins and clears retained impact after a denied refresh", async () => {
  let denied = false;
  vi.stubGlobal("fetch", vi.fn(async (path: string) => {
    const params = new URL(path, "http://test.local").searchParams;
    expect(params.get("revision_id")).toBe("old");
    expect(params.get("candidate_revision_id")).toBe("new");
    return new Response(JSON.stringify(denied ? { error: { message: "Revision unavailable." } } : {
      revision_id: "old", candidate_revision_id: "new", current_number: 1, candidate_number: 2,
      definition_kind: "part", content_changed: true, dependency_pins_changed: false,
      current_sha256: "first-hash", candidate_sha256: "second-hash", next_after: null,
      results: [{ snapshot_id: "snap", project_id: "p", label: "Retained bracket consumer" }],
    }), { status: denied ? 404 : 200 });
  }));
  render(<MantineProvider><RevisionImpact definition={{ definition_id: "def", name: "Bracket", revisions: [{ revision_id: "old", number: 1 }, { revision_id: "new", number: 2 }] }} /></MantineProvider>);
  fireEvent.change(screen.getByLabelText("Existing pinned revision"), { target: { value: "old" } });
  fireEvent.change(screen.getByLabelText("Proposed later revision"), { target: { value: "new" } });
  fireEvent.click(screen.getByRole("button", { name: "Review upgrade impact" }));
  expect(await screen.findByText("Retained bracket consumer")).toBeTruthy();
  expect(screen.getByText(/Existing pins retained. Compatibility: not evaluated/)).toBeTruthy();
  denied = true;
  fireEvent.click(screen.getByRole("button", { name: "Review upgrade impact" }));
  expect(await screen.findByText("Revision unavailable.")).toBeTruthy();
  expect(screen.queryByText("Retained bracket consumer")).toBeNull();
  expect(screen.queryByText(/first-hash/)).toBeNull();
});
