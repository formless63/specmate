import { AREAS, DEFAULT_TOOL, areaOfTool } from "../shell/areas";

/**
 * Canonical workspace routes use a fixed rail and typed Library sections. Record addresses
 * retain @<revision>/~/<path>; projects are optional context, never ownership or authority.
 * Old area/lens links are interpreted here and rewritten by NavigationProvider.
 */
export type ProbeTarget = {
  /** Workspace record id (a definition, source bundle, physical unit, …). */
  object: string;
  /** Exact frozen revision number; null follows the latest. */
  rev: number | null;
  /** Path inside the object (an occurrence, pin or feature); empty for the object itself. */
  path: string[];
};

export type WorkspaceLocation = {
  /** List facets and editor view, retained when selecting a record. */
  filters?: Record<string, string>;
  area: string;
  lens: string;
  project: string | null;
  probe: ProbeTarget | null;
  /** The link named a selection that is not a well-formed workspace address. */
  malformed: boolean;
};

/** Canonical homes for the existing tools while record editors are migrated. */
export const TOOL_PATHS: Record<string, string> = {
  "new-design": "/designs/new", "new-cable": "/designs/new", "new-harness": "/designs/new", "new-assembly": "/designs/new", designs: "/designs", cables: "/designs", harnesses: "/designs", assemblies: "/designs", intents: "/designs/recipes",
  "library-home": "/library", interfaces: "/library/connectors", ports: "/library/connectors", "end-assemblies": "/library/connectors",
  pcb: "/library/boards", "pcb-disagreement": "/library/boards", copper: "/library/boards", "passive-passages": "/library/boards", sources: "/library", "mechanical-sources": "/library",
  "wire-stock": "/library/wire-stocks", preparation: "/library/wire-stocks", "end-preparation": "/library/wire-stocks",
  identity: "/library/parts", hardware: "/library/hardware", kits: "/library/kits", signals: "/library/vocabulary", conventions: "/library/vocabulary/conventions", "workshop-profiles": "/library/vocabulary/workshop-profiles", "evidence-kinds": "/library/vocabulary/evidence-kinds",
  discovery: "/library", "revision-upgrades": "/library", matching: "/library", facts: "/library",
  inventory: "/make/inventory", "physical-units": "/make/units", "material-accounting": "/make/material", bom: "/make/procurement", printing: "/make/printing",
  builds: "/jobs/builds", "agent-runs": "/jobs/agent-runs", runner: "/jobs/runner", history: "/history", releases: "/products/releases",
  overview: "/projects", knowledge: "/projects/notes", "catalog-packs": "/extensions/packs", integrations: "/extensions/integrations", "agent-capabilities": "/extensions/agents",
  "occurrence-firmware": "/designs", "firmware-impact": "/designs", configurations: "/designs", "shared-scene": "/designs", "context-selection": "/designs", "scene-drawings": "/designs", "mechanical-proposals": "/designs",
  "preparation-documents": "/designs", "cable-test-intent": "/designs", "selected-packages": "/designs", "export-packages": "/designs",
  "settings-documents": "/settings/documents", "settings-engineering": "/settings/engineering", "part-numbering": "/settings/numbering", "validation-rules": "/settings/rules", webhooks: "/settings/webhooks",
  access: "/settings/people", preferences: "/settings/preferences", diagnostics: "/settings/system",
};
const HOME_TOOLS: Record<string, string> = Object.fromEntries(Object.entries(TOOL_PATHS).reverse().map(([tool, path]) => [path, tool]));
Object.assign(HOME_TOOLS, { "/designs": "designs", "/designs/new": "new-design", "/library": "library-home", "/library/connectors": "interfaces", "/library/boards": "pcb", "/library/wire-stocks": "wire-stock" });
const LEGACY_AREAS = new Set(["project", "design", "sources", "inventory", "evidence"]);
const LEGACY_DEFAULTS: Record<string,string> = { project: "overview", design: "assemblies", sources: "sources", inventory: "inventory", evidence: "facts", make: "bom", library: "library-home" };
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
export const BOARD_RECORD_SECTIONS: Record<string, string> = { copper: "more", "passive-passages": "more", "pcb-disagreement": "source-review" };
const FILTERS = ["q", "kind", "status", "from", "to", "stock", "board", "layout", "view", "release", "work_batch", "sheet", "actor", "history_source", "section", "intake", "start"];
export const HOME: WorkspaceLocation = { area: "designs", lens: DEFAULT_TOOL, project: null, probe: null, malformed: false };
function decode(segment: string): string | null { try { return decodeURIComponent(segment); } catch { return null; } }
function knownTool(tool: string | null): tool is string { return !!tool && (["new-design", "intents"].includes(tool) || AREAS.some(area => area.tools.some(item => item.id === tool))); }
function parseProbe(head: string, rest: string[]): ProbeTarget | null {
  const at = head.lastIndexOf("@");
  const object = at < 0 ? head : head.slice(0, at);
  const revText = at < 0 ? null : head.slice(at + 1);
  if (!ID.test(object) || (revText !== null && !/^[1-9][0-9]{0,8}$/.test(revText))) return null;
  if (rest.length > 0 && rest[0] !== "~") return null;
  return { object, rev: revText === null ? null : Number(revText), path: rest.slice(1).filter(Boolean) };
}

/** Old addresses are interpreted before canonical routing, retaining their exact selection. */
export function parseLocation(pathname: string, search: string): WorkspaceLocation {
  const raw = pathname.split("/").filter(Boolean);
  const segments = raw.map(decode);
  const params = new URLSearchParams(search);
  let project = params.get("project");
  let malformed = !!project && !ID.test(project);
  if (malformed) project = null;
  const filters = Object.fromEntries(FILTERS.flatMap(key => params.has(key) ? [[key, params.get(key)!]] : []));
  let lens = DEFAULT_TOOL;
  let probe: ProbeTarget | null = null;
  let consumed = 1;
  const legacy = knownTool(params.get("lens")) || LEGACY_AREAS.has(segments[0] ?? "");
  if (legacy) {
    lens = knownTool(params.get("lens")) ? params.get("lens")! : LEGACY_DEFAULTS[segments[0] ?? ""] ?? DEFAULT_TOOL;
    if (raw.length === 1 && segments[0] === "project" && !params.has("lens") && !project) lens = DEFAULT_TOOL;
  } else {
    const home = Object.keys(HOME_TOOLS).sort((a, b) => b.length - a.length).find(path => pathname === path || pathname.startsWith(`${path}/`));
    if (home) { lens = HOME_TOOLS[home]!; consumed = home.split("/").filter(Boolean).length; }
    else if (AREAS.some(area => area.id === segments[0])) lens = AREAS.find(area => area.id === segments[0])!.tools[0]!.id;
    if (segments[0] === "library" && raw.length > 1 && consumed === 1) lens = "identity";
    if (segments[0] === "projects" && raw.length > 1 && consumed === 1 && segments[1] && ID.test(segments[1])) {
      project = segments[1]; consumed = 2;
      if (segments[2] === "notes") { lens = "knowledge"; consumed = 3; } else lens = "overview";
    }
    if (pathname === "/designs/new" && ["cable", "harness", "assembly"].includes(params.get("kind") ?? "")) lens = `new-${params.get("kind")}`;
    if (knownTool(params.get("tool"))) lens = params.get("tool")!;
  }
  if (segments.length > consumed) {
    const [head, ...rest] = segments.slice(consumed);
    probe = head && !rest.includes(null) ? parseProbe(head, rest as string[]) : null;
    malformed ||= probe === null;
  }
  if (legacy && !probe && ["cables", "harnesses", "assemblies"].includes(lens)) lens = "designs";
  if (!probe && ["cables", "preparation-documents", "cable-test-intent", "selected-packages", "export-packages"].includes(lens)) lens = "designs";
  if (legacy && lens === "intents" && !probe) { lens = "new-cable"; filters.kind = "cable"; filters.start = "ports"; }
  if (!probe && BOARD_RECORD_SECTIONS[lens]) { filters.section = BOARD_RECORD_SECTIONS[lens]!; lens = "pcb"; }
  if (lens === "discovery") filters.palette = "open";
  return { area: areaOfTool(lens).id, lens, project, probe, malformed, ...(Object.keys(filters).length ? { filters } : {}) };
}

export function formatLocation(location: Omit<WorkspaceLocation, "malformed">): string {
  let path = TOOL_PATHS[location.lens] ?? "/designs";
  const params = new URLSearchParams();
  const designEditor = ["cables", "harnesses", "assemblies"].includes(location.lens);
  if (location.probe && designEditor) path = "/designs";
  const creating = ["new-cable", "new-harness", "new-assembly"].includes(location.lens);
  const defaultTool = HOME_TOOLS[path];
  if (location.lens !== defaultTool && !(designEditor && location.probe) && !creating) params.set("tool", location.lens);
  if (creating) params.set("kind", location.lens.slice(4));
  if (["overview", "knowledge"].includes(location.lens) && location.project) {
    path = `/projects/${encodeURIComponent(location.project)}${location.lens === "knowledge" ? "/notes" : ""}`;
  } else if (location.project) params.set("project", location.project);
  for (const [key, value] of Object.entries(location.filters ?? {})) if (FILTERS.includes(key) && value && !(creating && key === "kind")) params.set(key, value);
  if (location.probe) {
    const { object, rev, path: inside } = location.probe;
    path += `/${encodeURIComponent(object)}${rev !== null ? `@${rev}` : ""}${inside.length ? `/~/${inside.map(encodeURIComponent).join("/")}` : ""}`;
  }
  return path + (params.size ? `?${params}` : "");
}

export function sameTarget(a: ProbeTarget | null, b: ProbeTarget | null): boolean {
  if (a === null || b === null) return a === b;
  return a.object === b.object && a.rev === b.rev && a.path.length === b.path.length && a.path.every((segment, index) => segment === b.path[index]);
}

/** Stable key for sets and maps of targets. */
export function targetKey(target: ProbeTarget): string {
  return `${target.object}@${target.rev ?? ""}/${target.path.map(encodeURIComponent).join("/")}`;
}
