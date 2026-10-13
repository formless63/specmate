import { MantineProvider } from "@mantine/core";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { PopulationReviewPanel } from "./PopulationReview";
import {
  getPopulationDraftReview, getPopulationRevisionReview, PcbRequestError,
  type FrozenPopulationReview,
} from "./api";

vi.mock("./api", async (original) => ({
  ...(await original<typeof import("./api")>()),
  getPopulationDraftReview: vi.fn(), getPopulationRevisionReview: vi.fn(),
}));

const componentId = "11111111-1111-4111-8111-111111111111";
const frozen: FrozenPopulationReview = {
  revision_id: "revision-old", definition_id: "definition", name: "Bench options", number: 1,
  snapshot_id: "snapshot-old", snapshot_sha256: "d".repeat(64), frozen_at: "2026-10-13T00:00:00Z",
  population: {
    schema_version: "1", interpretation_id: "interpretation-old", interpretation_sha256: "b".repeat(64),
    source_revision_id: "source-old", source_manifest_sha256: "a".repeat(64),
    options: [{ local_id: "default", name: "Default", decisions: [{ component_id: componentId, status: "omit", basis: "Leave R1 out." }] }],
    associations: [{ local_id: "model-r1", kind: "model", component_id: componentId,
      pad_id: null, target_revision_id: null, target_contact_id: null,
      representation_id: "representation-exact", review: "accepted", basis: "Model source reviewed.",
      evidence: { kind: "source_file", source_revision_id: "source-old", path: "evidence.txt", sha256: "e".repeat(64), rights: "synthetic-rights" },
    }],
  },
  interpretation: { interpretation_id: "interpretation-old", sha256: "b".repeat(64),
    attempt_id: "attempt-old", output_id: "output-old", source_revision_id: "source-old",
    source_manifest_sha256: "a".repeat(64), board_path: "board.kicad_pcb" },
  report: {
    source_sha256: "c".repeat(64), tool_version: "10.0.6", units: "mm", coordinate_frame: "KiCad absolute",
    components: [{ id: componentId, reference: "R1", value: "10k", footprint: "R_0805", position: [1, 2], rotation_deg: 0, side: "front", dnp: true }],
    pads: [], copper_nets: {}, outline: [], cutouts: [], mounting_holes: [], coverage: {}, unsupported: [], physical_qualification: false,
  },
  associations: [{ association: { local_id: "model-r1", kind: "model", component_id: componentId,
    pad_id: null, target_revision_id: null, target_contact_id: null, representation_id: "representation-exact",
    review: "accepted", basis: "Model source reviewed.", evidence: { kind: "source_file", source_revision_id: "source-old", path: "evidence.txt", sha256: "e".repeat(64), rights: "synthetic-rights" },
  }, target: { revision_id: "part-revision", definition_name: "Synthetic resistor", definition_kind: "part",
    representation_id: "representation-exact", representation_label: "Exact STEP",
    source_revision_id: "model-source", source_path: "models/r1.step", source_sha256: "f".repeat(64), source_rights: "model-rights" } }],
};

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  HTMLElement.prototype.scrollIntoView = vi.fn();
  vi.mocked(getPopulationRevisionReview).mockResolvedValue(frozen);
  vi.mocked(getPopulationDraftReview).mockResolvedValue({
    ...frozen, draft_id: "draft", state: "draft-v3",
    population: { ...frozen.population, options: [{ ...frozen.population.options[0]!, decisions: [{ component_id: componentId, status: "populate", basis: "Later alternative." }] }] },
    associations: frozen.associations,
  });
});
afterEach(() => { cleanup(); vi.resetAllMocks(); vi.unstubAllGlobals(); });

test("frozen inspector uses exact old snapshot and shows target plus evidence provenance", async () => {
  render(<MantineProvider env="test"><PopulationReviewPanel kind="revision" id="revision-old" onAccessLost={vi.fn()} /></MantineProvider>);
  expect(await screen.findByText("Frozen population revision #1")).toBeTruthy();
  expect(screen.getByText("Leave R1 out.")).toBeTruthy();
  expect(screen.getByText("Omit")).toBeTruthy();
  expect(screen.getByText(/models\/r1.step/)).toBeTruthy();
  expect(screen.getByText(/representation-exact/)).toBeTruthy();
  expect(screen.getByText(/evidence.txt/)).toBeTruthy();
  expect(screen.queryByText("Later alternative.")).toBeNull();
  expect(getPopulationDraftReview).not.toHaveBeenCalled();
});

test("current draft review shows its own decisions and exact association provenance", async () => {
  render(<MantineProvider env="test"><PopulationReviewPanel kind="draft" id="draft" onAccessLost={vi.fn()} /></MantineProvider>);
  expect(await screen.findByText("Current draft review")).toBeTruthy();
  expect(screen.getByText("Later alternative.")).toBeTruthy();
  expect(screen.getByText(/models\/r1.step/)).toBeTruthy();
  expect(screen.getByText(/evidence.txt/)).toBeTruthy();
  expect(screen.queryByText("Leave R1 out.")).toBeNull();
  expect(getPopulationRevisionReview).not.toHaveBeenCalled();
});

test("denied recheck removes retained frozen provenance", async () => {
  const onAccessLost = vi.fn();
  render(<MantineProvider env="test"><PopulationReviewPanel kind="revision" id="revision-old" onAccessLost={onAccessLost} /></MantineProvider>);
  await screen.findByText("Leave R1 out.");
  vi.mocked(getPopulationRevisionReview).mockRejectedValue(new PcbRequestError(404, "Revision not found."));
  fireEvent(window, new Event("focus"));
  await waitFor(() => expect(onAccessLost).toHaveBeenCalledWith(expect.objectContaining({ status: 404 })));
  expect(screen.queryByText("Leave R1 out.")).toBeNull();
  expect(screen.queryByText(/models\/r1.step/)).toBeNull();
});
