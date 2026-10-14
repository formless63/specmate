import { MantineProvider } from "@mantine/core";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { PermissionsProvider } from "../../lib/permissions";
import { command, getIntake, listIntakes, listPopulations, type FormatUpgradeProvenance, type Intake } from "./api";
import { PcbPanel } from "./PcbPanel";

vi.mock("./api", async (original) => ({
  ...(await original<typeof import("./api")>()),
  command: vi.fn(), getIntake: vi.fn(), listIntakes: vi.fn(), listPopulations: vi.fn(), preserveFiles: vi.fn(),
}));

const original: Intake = {
  intake_id: "original-intake", board_path: "hw/board.kicad_pcb", source_revision_id: "original-revision",
  workspace_id: "ws", source_manifest_sha256: "b".repeat(64), available_recipe_id: "approved-intake",
  files: [{ path: "hw/board.kicad_pcb", sha256: "a".repeat(64), size: 64, rights: "synthetic", coverage: "native-extraction-available-not-parsed", unsupported: null }],
  attempts: [{ attempt_id: "extract-1", build_id: "b1", state: "failed", diagnostic: "KiCad 7 board format 20221018 must be upgraded first: request the recorded KiCad 10 format upgrade." }],
  interpretations: [], format_upgrade: null,
  upgrade: { available_recipe_id: "approved-upgrade", upgradable_kicad_majors: [6, 7, 8, 9], attempts: [] },
};
const provenance: FormatUpgradeProvenance = {
  upgrade_id: "u", label: "Upgraded from KiCad 7 format", from_kicad_major: 7,
  from_format_version: 20221018, to_format_version: 20260206, tool_version: "10.0.6",
  image: "kicad/kicad:10.0.6@sha256:" + "f".repeat(64), recipe_id: "approved-upgrade", build_id: "upgrade-build",
  upgrade_attempt_id: "upgrade-1", original_intake_id: "original-intake",
  original_source_revision_id: "original-revision", original_manifest_sha256: "b".repeat(64),
  report_sha256: "d".repeat(64), accepted_at: "2026-10-14T00:00:00Z",
  unsupported: ["companion files preserved unchanged"],
  files: [{ path: "hw/board.kicad_pcb", kind: "board", output_path: "upgraded/hw/board.kicad_pcb",
    source_sha256: "a".repeat(64), output_sha256: "e".repeat(64), from_format_version: 20221018,
    from_kicad_major: 7, to_format_version: 20260206, argv: ["kicad-cli", "pcb", "upgrade", "/tmp/specmate-upgrade/0/board.kicad_pcb"] }],
};
const derived: Intake = {
  ...original, intake_id: "derived-intake", source_revision_id: "derived-revision", attempts: [],
  files: original.files.map((file) => ({ ...file, sha256: "e".repeat(64) })), format_upgrade: provenance, upgrade: null,
};

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  HTMLElement.prototype.scrollIntoView = vi.fn();
  vi.mocked(listIntakes).mockResolvedValue([
    { intake_id: "original-intake", board_path: "hw/board.kicad_pcb", source_revision_id: "original-revision", upgraded_from_kicad: null },
    { intake_id: "derived-intake", board_path: "hw/board.kicad_pcb", source_revision_id: "derived-revision", upgraded_from_kicad: 7 },
  ]);
  vi.mocked(getIntake).mockImplementation(async (id) => (id === "derived-intake" ? derived : original));
  vi.mocked(listPopulations).mockResolvedValue([]);
  vi.mocked(command).mockResolvedValue({});
});
afterEach(() => { cleanup(); vi.resetAllMocks(); vi.unstubAllGlobals(); });

function panel(permissions: string[]) {
  return <MantineProvider env="test"><PermissionsProvider permissions={permissions}><PcbPanel workspaceId="ws" /></PermissionsProvider></MantineProvider>;
}
async function choose(label: string) {
  await waitFor(() => expect(listIntakes).toHaveBeenCalled());
  fireEvent.click(screen.getByRole("combobox", { name: "Preserved PCB intake" }));
  fireEvent.click(await screen.findByText(label));
}

test("older board shows the specific diagnostic and an explicit upgrade request", async () => {
  render(panel(["workspace.read", "build.execute", "source.register"]));
  await choose("hw/board.kicad_pcb · original");
  expect(await screen.findByText(/KiCad 7 board format 20221018 must be upgraded first/)).toBeTruthy();
  expect(screen.getByText(/this original stays unchanged/)).toBeTruthy();
  expect(command).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Request KiCad 10 format upgrade" }));
  await waitFor(() => expect(command).toHaveBeenCalledWith("pcb.request_upgrade", { intake_id: "original-intake", recipe_id: "approved-upgrade" }, expect.anything()));
});

test("a succeeded upgrade is registered deliberately and opens the derivative intake", async () => {
  vi.mocked(getIntake).mockImplementation(async (id) => (id === "derived-intake" ? derived : {
    ...original, upgrade: { ...original.upgrade!, attempts: [{ upgrade_attempt_id: "upgrade-1", build_id: "ub", state: "succeeded", diagnostic: null, derived_intake_id: null, derived_source_revision_id: null }] },
  }));
  vi.mocked(command).mockResolvedValue({ intake_id: "derived-intake" });
  render(panel(["workspace.read", "build.execute", "source.register"]));
  await choose("hw/board.kicad_pcb · original");
  fireEvent.click(await screen.findByRole("button", { name: "Register upgraded derivative" }));
  await waitFor(() => expect(command).toHaveBeenCalledWith("pcb.accept_upgrade", { upgrade_attempt_id: "upgrade-1" }, expect.anything()));
  expect(await screen.findByText(/Upgraded from KiCad 7 format \(20221018 → 20260206\) by KiCad 10.0.6/)).toBeTruthy();
  expect(getIntake).toHaveBeenLastCalledWith("derived-intake", expect.anything());
});

test("viewer sees upgrade provenance and exact argv but no request or register actions", async () => {
  render(panel(["workspace.read"]));
  await choose("hw/board.kicad_pcb · derived- · upgraded from KiCad 7");
  expect(await screen.findByText(/Upgraded from KiCad 7 format/)).toBeTruthy();
  expect(screen.getByText("kicad-cli pcb upgrade /tmp/specmate-upgrade/0/board.kicad_pcb")).toBeTruthy();
  expect(screen.getByText("KiCad 7 board 20221018")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Request KiCad 10 format upgrade" })).toBeNull();
  cleanup();
  render(panel(["workspace.read"]));
  await choose("hw/board.kicad_pcb · original");
  expect(await screen.findByText(/must be upgraded to the KiCad 10 format/)).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Request KiCad 10 format upgrade" })).toBeNull();
  expect(document.querySelector('[data-readonly-note="build.execute"]')).toBeTruthy();
});
