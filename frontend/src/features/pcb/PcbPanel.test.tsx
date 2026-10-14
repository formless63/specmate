import { PermissionsProvider } from "../../lib/permissions";
import { MantineProvider } from "@mantine/core";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { PcbPanel, ReportView } from "./PcbPanel";
import { associationTargets, command, getIntake, listIntakes, listPopulations, PcbRequestError, type Intake, type NativeReport } from "./api";

vi.mock("./api", async (original) => ({
  ...(await original<typeof import("./api")>()),
  command: vi.fn(), getIntake: vi.fn(), listIntakes: vi.fn(), listPopulations: vi.fn(), associationTargets: vi.fn(), preserveFiles: vi.fn(),
}));

const report: NativeReport = {
  source_sha256: "a".repeat(64), tool_version: "10.0.6", units: "mm",
  coordinate_frame: "KiCad absolute: x right, y down; angles native degrees",
  components: [{ id: "native-component", reference: "R1", value: "1k", footprint: "Synthetic:R",
    position: [25, 10], rotation_deg: 0, side: "front", dnp: false }],
  pads: [{ id: "native-pad", component_id: "native-component", terminal: "R1.1", net: "N1", position: [25, 10], type: "smd" }],
  copper_nets: { N1: ["R1.1"] }, outline: [[[0, 0], [40, 0], [40, 25], [0, 25]]], cutouts: [],
  mounting_holes: [], coverage: { nets: "pad-membership-not-connectivity-proof" },
  unsupported: ["schematic parity not extracted", "component passages require review"],
  physical_qualification: false,
};
const intake: Intake = {
  intake_id: "intake", board_path: "board.kicad_pcb", source_revision_id: "revision",
  workspace_id: "project-a", source_manifest_sha256: "b".repeat(64),
  available_recipe_id: "approved-intake",
  files: [{ path: "board.kicad_pcb", sha256: "a".repeat(64), size: 1024, rights: "synthetic-original", coverage: "parsed-native-subset", unsupported: [] }],
  attempts: [], interpretations: [{ interpretation_id: "interpretation", attempt_id: "attempt", output_id: "output", sha256: "c".repeat(64), report }],
};

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  HTMLElement.prototype.scrollIntoView = vi.fn();
  vi.mocked(listIntakes).mockResolvedValue([intake]);
  vi.mocked(getIntake).mockResolvedValue(intake);
  vi.mocked(listPopulations).mockResolvedValue([]);
  vi.mocked(associationTargets).mockResolvedValue({ revisions: [], models: [], truncated: { revisions: false, models: false } });
  vi.mocked(command).mockResolvedValue({});
});
afterEach(() => { cleanup(); vi.resetAllMocks(); vi.unstubAllGlobals(); });

function panel(workspaceId = "project-a", permissions = ["workspace.read"]) {
  return <MantineProvider env="test"><PermissionsProvider permissions={permissions}><PcbPanel workspaceId={workspaceId} /></PermissionsProvider></MantineProvider>;
}
async function selectIntake() {
  await waitFor(() => expect(listIntakes).toHaveBeenCalled());
  fireEvent.click(screen.getByRole("combobox", { name: "Preserved PCB intake" }));
  fireEvent.click(await screen.findByText("board.kicad_pcb · revision"));
  await screen.findByText("Extracted interpretation");
}

test("viewer can inspect native facts and original provenance with honest coverage", async () => {
  render(panel());
  await selectIntake();
  expect(screen.queryByText("Preserve sources")).toBeNull();
  expect(screen.getByText("1 components")).toBeTruthy();
  expect(screen.getByText(/pad-membership-not-connectivity-proof/)).toBeTruthy();
  expect(screen.getByText("component passages require review")).toBeTruthy();
  expect(screen.getByRole("link", { name: "board.kicad_pcb" }).getAttribute("href")).toContain("/original?path=board.kicad_pcb");
  expect(screen.getByRole("img", { name: "Extracted board outline and native placements" })).toBeTruthy();
});

test("scope change discards captured reports and file names", async () => {
  const view = render(panel());
  await selectIntake();
  vi.mocked(listIntakes).mockResolvedValue([]);
  view.rerender(panel("project-b"));
  expect(screen.queryByText("1 components")).toBeNull();
  expect(screen.queryByRole("link", { name: "board.kicad_pcb" })).toBeNull();
  await waitFor(() => expect(listIntakes).toHaveBeenLastCalledWith("project-b", expect.anything()));
});

test("revoked access removes report counts and filenames on failed refresh", async () => {
  render(panel());
  await selectIntake();
  vi.mocked(getIntake).mockRejectedValue(new PcbRequestError(404, "Project not found."));
  vi.mocked(listIntakes).mockRejectedValue(new PcbRequestError(404, "Project not found."));
  fireEvent.click(screen.getByRole("button", { name: "Refresh intake" }));
  await screen.findByRole("alert");
  expect(screen.queryByText("1 components")).toBeNull();
  expect(screen.queryByRole("link", { name: "board.kicad_pcb" })).toBeNull();
});

test("native execution requires an explicit request with an approved recipe", async () => {
  render(panel("project-a", ["workspace.read", "build.execute"]));
  await selectIntake();
  expect(command).not.toHaveBeenCalled();
  const button = screen.getByRole("button", { name: "Request native extraction" });
  expect(button.hasAttribute("disabled")).toBe(false);
  fireEvent.click(button);
  await waitFor(() => expect(command).toHaveBeenCalledWith("pcb.request_extraction", { intake_id: "intake", recipe_id: "approved-intake" }, expect.anything()));
});

test("unavailable native execution preserves sources and cannot be requested", async () => {
  vi.mocked(getIntake).mockResolvedValue({ ...intake, available_recipe_id: null });
  render(panel("project-a", ["workspace.read", "build.execute"]));
  await selectIntake();
  expect(screen.getByText(/Native extraction is unavailable/)).toBeTruthy();
  expect(screen.getByRole("button", { name: "Request native extraction" }).hasAttribute("disabled")).toBe(true);
  expect(command).not.toHaveBeenCalled();
});

test("unknown outline stays unresolved and receives no invented preview", () => {
  render(<MantineProvider><ReportView report={{ ...report, outline: [], coverage: { outline: "unsupported" } }} /></MantineProvider>);
  expect(screen.getByText(/Outline: Unresolved/)).toBeTruthy();
  expect(screen.queryByRole("img")).toBeNull();
});
