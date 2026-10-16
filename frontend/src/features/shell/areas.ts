import { routeTool } from "./registry";

export type ToolDef = { id: string; label: string };
export type AreaDef = { id: string; label: string; key: string; tools: ToolDef[] };
const tool = (id: string): ToolDef => {
  const found = routeTool(id);
  if (!found) throw new Error(`Unknown navigation tool: ${id}`);
  return { id: found.id, label: found.label };
};

/** Fixed visible workspace rail and genuinely global tools. Record routes live in registry.ts. */
export const AREAS: AreaDef[] = [
  { id: "designs", label: "Designs", key: "1", tools: [tool("designs")] },
  { id: "library", label: "Library", key: "2", tools: [tool("library-home"), tool("interfaces"), tool("pcb"), tool("wire-stock"), tool("identity"), tool("hardware"), tool("kits"), tool("signals"), tool("sources"), tool("revision-upgrades"), tool("matching")] },
  { id: "make", label: "Make", key: "3", tools: [tool("inventory"), tool("physical-units"), tool("material-accounting"), tool("bom"), tool("printing")] },
  { id: "jobs", label: "Jobs", key: "4", tools: [tool("builds"), tool("agent-runs"), tool("runner")] },
  { id: "history", label: "History", key: "5", tools: [tool("history")] },
  { id: "products", label: "Products & releases", key: "6", tools: [tool("families"), tool("lineup"), tool("releases")] },
  { id: "projects", label: "Projects", key: "7", tools: [tool("overview"), tool("knowledge")] },
  { id: "extensions", label: "Extensions", key: "8", tools: [tool("catalog-packs"), tool("integrations"), tool("agent-capabilities")] },
  { id: "settings", label: "Settings", key: "9", tools: [tool("settings-documents"), tool("settings-engineering"), tool("part-numbering"), tool("validation-rules"), tool("access"), tool("preferences"), tool("diagnostics"), tool("webhooks")] },
 ];
export const DEFAULT_TOOL = "designs";
export function areaOfTool(toolId: string): AreaDef { return AREAS.find(area => area.id === routeTool(toolId)?.area) ?? AREAS[0]!; }
export function toolLabel(toolId: string): string { return routeTool(toolId)?.label ?? toolId; }

/** The fixed primary Library tabs; other visible collection tools use Advanced. */
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
