export type ToolDef = { id: string; label: string };
export type AreaDef = { id: string; label: string; key: string; tools: ToolDef[] };

/**
 * Every tool belongs to exactly one area. Keys 1-7 select areas from the keyboard; the
 * first tool listed is the area's default lens. Every area is reachable at Library scope
 * and at project scope; scope changes navigation and filtering, never access.
 */
export const AREAS: AreaDef[] = [
  { id: "project", label: "Project", key: "1", tools: [
    { id: "overview", label: "Overview" },
    { id: "knowledge", label: "Notes & files" },
    { id: "access", label: "Workspace access" },
    { id: "preferences", label: "Preferences" },
    { id: "agent-capabilities", label: "Agent access" },
    { id: "diagnostics", label: "Status & recovery" },
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
    { id: "configurations", label: "Options & choices" },
    { id: "shared-scene", label: "Shared scene" },
    { id: "context-selection", label: "Connected views" },
    { id: "scene-drawings", label: "Scene drawings" },
    { id: "mechanical-proposals", label: "Parametric proposals" },
  ] },
  { id: "sources", label: "Sources", key: "4", tools: [
    { id: "sources", label: "Sources" },
    { id: "mechanical-sources", label: "Mechanical sources" },
    { id: "builds", label: "Builds" },
  ] },
  { id: "make", label: "Make", key: "5", tools: [
    { id: "bom", label: "BOM planning" },
    { id: "material-accounting", label: "Material accounting" },
    { id: "preparation", label: "Cut preparation" },
    { id: "end-preparation", label: "End preparation" },
    { id: "preparation-documents", label: "Bench documents" },
    { id: "selected-packages", label: "Selected packages" },
    { id: "export-packages", label: "Export packages" },
  ] },
  { id: "inventory", label: "Inventory", key: "6", tools: [
    { id: "inventory", label: "Inventory" },
    { id: "physical-units", label: "Physical units" },
  ] },
  { id: "evidence", label: "Evidence", key: "7", tools: [
    { id: "facts", label: "Facts" },
    { id: "evidence-kinds", label: "Evidence kinds" },
    { id: "cable-test-intent", label: "Cable test intent" },
    { id: "releases", label: "Releases" },
  ] },
];

/** The shell opens on the Project area: the project list at Library scope, the overview in a project. */
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

const ROLE_LABELS: Record<string, string> = { viewer: "Viewer", contributor: "Contributor", editor: "Editor", admin: "Admin" };

/**
 * Plain-words summary of the signed-in principal's workspace role. The server reports the role
 * with the permissions; without it the role is inferred from the reported atoms.
 */
export function describeAccess(permissions: string[], role?: string | null): { label: string; known: boolean; grants: number } {
  const has = (...names: string[]) => names.some((name) => permissions.includes(name));
  const grants = permissions.length;
  if (role && ROLE_LABELS[role]) return { label: ROLE_LABELS[role], known: true, grants };
  if (has("workspace.admin")) return { label: "Admin", known: true, grants };
  if (has("design.edit")) return { label: "Editor", known: true, grants };
  if (has("item.create", "project.edit")) return { label: "Contributor", known: true, grants };
  if (has("workspace.read")) return { label: "Viewer", known: true, grants };
  return { label: "Not reported", known: false, grants };
}

/** True only when permissions are reported and allow no change at all; unreported is not read-only. */
export function isReadOnly(permissions: string[] | undefined): boolean {
  if (!permissions || permissions.length === 0) return false;
  return !["design.edit", "item.create", "project.edit", "workspace.admin"].some((name) => permissions.includes(name));
}
