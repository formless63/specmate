export type ToolDef = { id: string; label: string };
export type AreaDef = { id: string; label: string; key: string; tools: ToolDef[] };
const tool = (id: string, label: string): ToolDef => ({ id, label });

/** The fixed workspace rail. Existing tools remain reachable here during record migration. */
export const AREAS: AreaDef[] = [
  { id: "designs", label: "Designs", key: "1", tools: [tool("designs", "All designs"), tool("new-cable", "New cable"), tool("new-harness", "New harness"), tool("new-assembly", "New device"), tool("cables", "Cables"), tool("harnesses", "Harnesses"), tool("assemblies", "Devices"), tool("occurrence-firmware", "Board firmware"), tool("firmware-impact", "Firmware impact"), tool("configurations", "Options & choices"), tool("shared-scene", "Shared scene"), tool("context-selection", "Connected views"), tool("scene-drawings", "Scene drawings"), tool("mechanical-proposals", "Enclosure proposals"), tool("preparation-documents", "Bench documents"), tool("cable-test-intent", "Cable test plans"), tool("selected-packages", "Selected packages"), tool("export-packages", "Export packages")] },
  { id: "library", label: "Library", key: "2", tools: [tool("library-home", "Library home"), tool("interfaces", "Connectors"), tool("pcb", "Boards"), tool("wire-stock", "Wire stocks"), tool("identity", "Parts"), tool("hardware", "Shells & hardware"), tool("kits", "Kits"), tool("signals", "Vocabulary"), tool("ports", "Device ports"), tool("end-assemblies", "Saved end stacks"), tool("conventions", "Conductor conventions"), tool("workshop-profiles", "Workshop profiles"), tool("evidence-kinds", "Evidence kinds"), tool("discovery", "Where used"), tool("revision-upgrades", "Revision upgrades"), tool("matching", "Reviewed matching"), tool("pcb-disagreement", "Source review"), tool("passive-passages", "Paths and parts"), tool("copper", "Copper graph"), tool("mechanical-sources", "Mechanical sources"), tool("sources", "Source bundles"), tool("preparation", "Cut preparation"), tool("end-preparation", "End preparation"), tool("facts", "Facts")] },
  { id: "make", label: "Make", key: "3", tools: [tool("inventory", "Inventory"), tool("physical-units", "Physical units"), tool("material-accounting", "Material plans"), tool("bom", "Procurement BOMs"), tool("printing", "3D printing")] },
  { id: "jobs", label: "Jobs", key: "4", tools: [tool("builds", "Builds"), tool("agent-runs", "Agent runs"), tool("runner", "Runner")] },
  { id: "history", label: "History", key: "5", tools: [tool("history", "History")] },
  { id: "products", label: "Products & releases", key: "6", tools: [tool("releases", "Releases")] },
  { id: "projects", label: "Projects", key: "7", tools: [tool("overview", "Projects"), tool("knowledge", "Notes & files")] },
  { id: "extensions", label: "Extensions", key: "8", tools: [tool("catalog-packs", "Packs"), tool("integrations", "Integrations"), tool("agent-capabilities", "Agents")] },
  { id: "settings", label: "Settings", key: "9", tools: [tool("settings-documents", "Documents"), tool("settings-engineering", "Engineering"), tool("part-numbering", "Part numbering"), tool("validation-rules", "Validation rules"), tool("access", "People"), tool("preferences", "Preferences"), tool("diagnostics", "System"), tool("webhooks", "Webhooks")] },
];
export const DEFAULT_TOOL = "designs";
export function areaOfTool(toolId: string): AreaDef { return AREAS.find(area => area.tools.some(tool => tool.id === toolId)) ?? AREAS[0]!; }
export function toolLabel(toolId: string): string { return AREAS.flatMap(area => area.tools).find(tool => tool.id === toolId)?.label ?? toolId; }

/** Fixed Library navigation; record-specific tools live in Advanced. */
export const LIBRARY_TABS = ["interfaces", "pcb", "wire-stock", "identity", "hardware", "kits", "signals"];
export function primaryTools(area: AreaDef): ToolDef[] {
  if (area.id === "library") return area.tools.filter(tool => LIBRARY_TABS.includes(tool.id));
  if (area.id === "designs" || area.id === "history") return [];
  return area.tools;
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
