export type ToolDef = { id: string; label: string };
export type AreaDef = { id: string; label: string; key: string; tools: ToolDef[] };

/**
 * Every project tool belongs to exactly one area. Keys 1-7 select areas from
 * the keyboard; the first tool listed is the area's default lens.
 */
export const AREAS: AreaDef[] = [
  { id: "project", label: "Project", key: "1", tools: [
    { id: "overview", label: "Overview" },
    { id: "knowledge", label: "Notes & files" },
    { id: "access", label: "Project access" },
  ] },
  { id: "library", label: "Library", key: "2", tools: [
    { id: "identity", label: "Identities" },
    { id: "discovery", label: "Discovery" },
    { id: "revision-upgrades", label: "Revision upgrades" },
    { id: "matching", label: "Reviewed matching" },
    { id: "catalog-packs", label: "Catalog packs" },
    { id: "wire-stock", label: "Wire stock" },
    { id: "workshop-profiles", label: "Workshop profiles" },
  ] },
  { id: "design", label: "Design", key: "3", tools: [
    { id: "assemblies", label: "Assemblies" },
    { id: "interfaces", label: "Interfaces" },
    { id: "cables", label: "Cables" },
    { id: "harnesses", label: "Harness branches" },
    { id: "copper", label: "Copper graph" },
    { id: "passive-passages", label: "Passive models" },
    { id: "pcb", label: "PCB intake" },
    { id: "pcb-disagreement", label: "PCB source review" },
    { id: "occurrence-firmware", label: "Board firmware" },
    { id: "firmware-impact", label: "Firmware impact" },
    { id: "shared-scene", label: "Shared scene" },
    { id: "context-selection", label: "Connected views" },
    { id: "scene-drawings", label: "Scene drawings" },
    { id: "mechanical-proposals", label: "Parametric proposals" },
  ] },
  { id: "sources", label: "Sources", key: "4", tools: [
    { id: "sources", label: "Sources" },
    { id: "mechanical-sources", label: "Mechanical sources" },
  ] },
  { id: "make", label: "Make", key: "5", tools: [
    { id: "bom", label: "BOM planning" },
    { id: "material-accounting", label: "Material accounting" },
    { id: "preparation", label: "Cut preparation" },
    { id: "end-preparation", label: "End preparation" },
    { id: "preparation-documents", label: "Bench documents" },
    { id: "selected-packages", label: "Selected packages" },
  ] },
  { id: "inventory", label: "Inventory", key: "6", tools: [
    { id: "inventory", label: "Inventory" },
    { id: "physical-units", label: "Physical units" },
  ] },
  { id: "evidence", label: "Evidence", key: "7", tools: [
    { id: "facts", label: "Facts" },
    { id: "cable-test-intent", label: "Cable test intent" },
  ] },
];

/** A project opens on its overview, not on a library lens. */
export const DEFAULT_TOOL = "overview";

export function areaOfTool(toolId: string): AreaDef {
  return AREAS.find((area) => area.tools.some((tool) => tool.id === toolId)) ?? (AREAS[0] as AreaDef);
}

export function toolLabel(toolId: string): string {
  for (const area of AREAS) {
    const tool = area.tools.find((item) => item.id === toolId);
    if (tool) return tool.label;
  }
  return toolId;
}

/** Plain-words summary of the grants the signed-in principal holds in this project. */
export function describeAccess(permissions: string[]): { label: string; known: boolean; grants: number } {
  const has = (name: string) => permissions.includes(name);
  const grants = permissions.length;
  if (has("project.admin")) return { label: "Administrator", known: true, grants };
  if (has("design.freeze")) return { label: "Edit and freeze", known: true, grants };
  if (has("design.edit")) return { label: "Edit", known: true, grants };
  if (has("project.read")) return { label: "Read", known: true, grants };
  return { label: "Not reported", known: false, grants };
}

/** True only when permissions are reported and carry neither edit nor administration; unreported is not read-only. */
export function isReadOnly(permissions: string[] | undefined): boolean {
  if (!permissions || permissions.length === 0) return false;
  return !permissions.includes("design.edit") && !permissions.includes("project.admin");
}
