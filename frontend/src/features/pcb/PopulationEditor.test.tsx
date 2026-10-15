import { PermissionsProvider } from "../../lib/permissions";
import { MantineProvider } from "@mantine/core";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { PopulationEditor } from "./PopulationEditor";
import { associationTargets, command, getPopulationDraftReview, PcbRequestError, type Intake, type PopulationDraft } from "./api";

vi.mock("./api", async (original) => ({
  ...(await original<typeof import("./api")>()),
  associationTargets: vi.fn(), command: vi.fn(), getPopulationDraftReview: vi.fn(),
}));

const componentId = "11111111-1111-4111-8111-111111111111";
const interpretationId = "22222222-2222-4222-8222-222222222222";
const sourceId = "33333333-3333-4333-8333-333333333333";
const intake: Intake = {
  intake_id: "intake", workspace_id: "project", board_path: "board.kicad_pcb",
  source_revision_id: sourceId, source_manifest_sha256: "a".repeat(64),
  available_recipe_id: null, attempts: [], files: [],
  interpretations: [{
    interpretation_id: interpretationId, attempt_id: "attempt", output_id: "output",
    sha256: "b".repeat(64), report: {
      source_sha256: "c".repeat(64), tool_version: "10.0.6", units: "mm",
      coordinate_frame: "KiCad absolute", components: [{
        id: componentId, reference: "R1", value: "10k", footprint: "R_0805",
        position: [1, 2], rotation_deg: 0, side: "front", dnp: true,
      }], pads: [], copper_nets: {}, outline: [], cutouts: [], mounting_holes: [],
      coverage: {}, unsupported: [], physical_qualification: false,
    },
  }],
};
const draft: PopulationDraft = {
  definition_id: "definition", name: "Bench options", draft_id: "draft", state: "draft-v1",
  revisions: [], content: { pcb_population: {
    schema_version: "1", interpretation_id: interpretationId, interpretation_sha256: "b".repeat(64),
    source_revision_id: sourceId, source_manifest_sha256: "a".repeat(64),
    options: [{ local_id: "default", name: "Default", decisions: [{ component_id: componentId, status: null, basis: null }] }],
    associations: [],
  } },
};

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  HTMLElement.prototype.scrollIntoView = vi.fn();
  vi.mocked(associationTargets).mockResolvedValue({ revisions: [], models: [], truncated: { revisions: false, models: false } });
  vi.mocked(getPopulationDraftReview).mockResolvedValue({
    draft_id: "draft", definition_id: "definition", name: "Bench options", state: "draft-v1",
    population: draft.content.pcb_population,
    interpretation: { intake_id: "intake", interpretation_id: interpretationId, sha256: "b".repeat(64), attempt_id: "attempt", output_id: "output", source_revision_id: sourceId, source_manifest_sha256: "a".repeat(64), board_path: "board.kicad_pcb" },
    report: intake.interpretations[0]!.report, associations: [],
  });
  vi.mocked(command).mockResolvedValue({});
});
afterEach(() => { cleanup(); vi.resetAllMocks(); vi.unstubAllGlobals(); });

test("explicit option omission saves a basis against the shared draft token", async () => {
  const onChanged = vi.fn();
  render(<MantineProvider env="test"><PermissionsProvider permissions={["design.edit"]}><PopulationEditor workspaceId="project" intake={intake} drafts={[draft]} onChanged={onChanged} onAccessLost={vi.fn()} /></PermissionsProvider></MantineProvider>);
  fireEvent.click(screen.getByRole("combobox", { name: "R1 population decision" }));
  fireEvent.click(await screen.findByText("Omit"));
  fireEvent.change(screen.getByRole("textbox", { name: "R1 decision basis" }), { target: { value: "Do not fit R1 in this option." } });
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(command).toHaveBeenCalledWith("pcb.population_update", expect.objectContaining({
    draft_id: "draft", population: expect.objectContaining({ options: [expect.objectContaining({
      decisions: [{ component_id: componentId, status: "omit", basis: "Do not fit R1 in this option." }],
    })] }),
  }), undefined, "draft-v1"));
  expect(onChanged).toHaveBeenCalled();
});

test("denied target refresh clears target choices and informs project panel", async () => {
  vi.mocked(associationTargets).mockRejectedValue(new PcbRequestError(404, "Project not found."));
  const onAccessLost = vi.fn();
  render(<MantineProvider env="test"><PermissionsProvider permissions={["design.edit"]}><PopulationEditor workspaceId="project" intake={intake} drafts={[draft]} onChanged={vi.fn()} onAccessLost={onAccessLost} /></PermissionsProvider></MantineProvider>);
  await waitFor(() => expect(onAccessLost).toHaveBeenCalledWith(expect.objectContaining({ status: 404 })));
  expect(screen.getByRole("alert").textContent).toContain("Project not found.");
});
