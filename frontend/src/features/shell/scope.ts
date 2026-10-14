import type { LibraryFamily, ReferenceKind } from "../workspace/api";
import { AREAS, areaOfTool } from "./areas";

/**
 * What a lens lists from the workspace library. Items live in workspace collections; a project
 * only references them, so library rows have no owning project. At Library scope a lens shows its
 * collection; at project scope the project's referenced items come first.
 */
export type LibraryView = {
  family: LibraryFamily;
  /** Definition kinds (or role/origin/dimension filters for other families); empty lists every kind. */
  kinds: string[];
  title: string;
  noun: string;
};

const definitions = (kinds: string[], title: string, noun: string): LibraryView => ({ family: "definition", kinds, title, noun });

/** Lenses with a library list. Lenses not listed here work on project-held records or on one record at a time. */
export const LIBRARY_VIEWS: Record<string, LibraryView> = {
  identity: definitions([], "Definitions", "definition"),
  "wire-stock": definitions(["wire_stock"], "Wire stock", "stock record"),
  "workshop-profiles": definitions(["workshop_profile"], "Workshop profiles", "workshop profile"),
  assemblies: definitions(["assembly"], "Assemblies", "assembly"),
  interfaces: definitions(["connector_body", "pinout", "interface_map", "interface_assessment"], "Interfaces", "interface record"),
  cables: definitions(["cable"], "Cables", "cable"),
  harnesses: definitions(["harness"], "Harnesses", "harness"),
  "passive-passages": definitions(["passage_model"], "Passive models", "passive model"),
  // Boards and their populations as workspace items; PCB intake below works on one native source.
  pcb: definitions(["board", "pcb_population"], "Boards", "board record"),
  "pcb-disagreement": definitions(["pcb_assertion", "pcb_comparison"], "PCB source reviews", "PCB review"),
  "occurrence-firmware": definitions(["firmware"], "Firmware", "firmware definition"),
  configurations: definitions(["option_set", "configuration"], "Options and configurations", "configuration"),
  "mechanical-sources": definitions(["mechanical_source"], "Mechanical sources", "mechanical source"),
  bom: definitions(["bom_plan"], "BOM plans", "BOM plan"),
  "material-accounting": definitions(["material_plan"], "Material plans", "material plan"),
  preparation: definitions(["preparation_profile"], "Cut preparation profiles", "preparation profile"),
  "end-preparation": definitions(["end_preparation_profile"], "End preparation profiles", "end preparation profile"),
  "cable-test-intent": definitions(["cable_test_plan"], "Cable test plans", "cable test plan"),
  sources: { family: "source_bundle", kinds: [], title: "Source bundles", noun: "source bundle" },
  inventory: { family: "stock_account", kinds: [], title: "Stock accounts", noun: "stock account" },
  "physical-units": { family: "physical_unit", kinds: [], title: "Physical units", noun: "physical unit" },
  facts: { family: "fact_subject", kinds: [], title: "Fact ledgers", noun: "fact ledger" },
};

/** The library view for a lens, or null when the lens has none. */
export function libraryView(toolId: string): LibraryView | null {
  return LIBRARY_VIEWS[toolId] ?? null;
}

/** The lens that owns a definition kind; kinds without a dedicated lens open in Identities. */
export function toolForKind(kind: string | null): string {
  for (const [tool, view] of Object.entries(LIBRARY_VIEWS)) {
    if (view.family === "definition" && kind && view.kinds.includes(kind)) return tool;
  }
  return "identity";
}

/** The lens that lists a reference target. */
export function toolForReference(kind: ReferenceKind, itemKind: string | null): string {
  if (kind === "definition" || kind === "revision") return toolForKind(itemKind);
  return { source_bundle: "sources", physical_unit: "physical-units", work_batch: "inventory", release: "releases" }[kind];
}

/** The reference kind a library row is used through, or null when projects cannot reference it. */
export function floatingKind(family: LibraryFamily): ReferenceKind | null {
  return family === "definition" || family === "source_bundle" || family === "physical_unit" ? family : null;
}

/** Kinds the Identities kind filter offers: every kind with a lens plus common library kinds. */
export const KNOWN_KINDS: string[] = [...new Set([
  "part", "hardware", "material", "board",
  ...Object.values(LIBRARY_VIEWS).flatMap((view) => view.family === "definition" ? view.kinds : []),
])].sort();

/** Area id for each reference, so a project's references group by the area that opens them. */
export function areaForReference(kind: ReferenceKind, itemKind: string | null): string {
  return areaOfTool(toolForReference(kind, itemKind)).id;
}

export const AREA_ORDER = AREAS.map((area) => area.id);
