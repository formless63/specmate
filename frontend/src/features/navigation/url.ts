import { AREAS, DEFAULT_TOOL, areaOfTool } from "../shell/areas";

/**
 * Where the shell is, as one URL. Items are addressed in the workspace; a project is optional
 * navigation context. The scheme (see docs/UX.md, "Links and selection"):
 *
 *   /                                         Project area, Overview, Library scope
 *   /<area>                                   an area at its default lens
 *   /<area>/<object>                          the probe on a workspace item (latest)
 *   /<area>/<object>@<rev>                    the probe on an exact frozen revision
 *   /<area>/<object>@<rev>/~/<seg>/<seg>      the probe on a path inside that item
 *   ?lens=<tool>&project=<project id>         lens (when not the area default), project context
 *
 * A URL never grants or implies access: the server resolves every object for the signed-in member.
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
  area: string;
  lens: string;
  project: string | null;
  probe: ProbeTarget | null;
  /** The link named a selection that is not a well-formed workspace address. */
  malformed: boolean;
};

const DEFAULT_AREA = areaOfTool(DEFAULT_TOOL).id;
/** Ids are opaque to the client (UUIDs today); the server decides what they name and who may read it. */
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const PATH_MARK = "~";

export const HOME: WorkspaceLocation = { area: DEFAULT_AREA, lens: DEFAULT_TOOL, project: null, probe: null, malformed: false };

function decode(segment: string): string | null {
  try { return decodeURIComponent(segment); } catch { return null; }
}

function defaultLens(area: string): string {
  return AREAS.find((item) => item.id === area)?.tools[0]?.id ?? DEFAULT_TOOL;
}

function lensBelongs(area: string, lens: string): boolean {
  return AREAS.some((item) => item.id === area && item.tools.some((tool) => tool.id === lens));
}

/** Parse "<object>[@<rev>]" and the segments after "~". Null when not a workspace address. */
function parseProbe(head: string, rest: string[]): ProbeTarget | null {
  const at = head.lastIndexOf("@");
  const object = at < 0 ? head : head.slice(0, at);
  const revText = at < 0 ? null : head.slice(at + 1);
  if (!ID.test(object)) return null;
  let rev: number | null = null;
  if (revText !== null) {
    if (!/^[1-9][0-9]{0,8}$/.test(revText)) return null;
    rev = Number(revText);
  }
  if (rest.length > 0 && rest[0] !== PATH_MARK) return null;
  const path = rest.slice(1).filter((segment) => segment !== "");
  return { object, rev, path };
}

/** Read a location; unknown areas and lenses fall back to defaults, a lens selects its own area. */
export function parseLocation(pathname: string, search: string): WorkspaceLocation {
  const raw = pathname.split("/").filter((segment) => segment !== "");
  const segments = raw.map(decode);
  const params = new URLSearchParams(search);
  const lensParam = params.get("lens");
  const projectParam = params.get("project");
  const areaParam = segments[0] ?? null;
  let area = areaParam && AREAS.some((item) => item.id === areaParam) ? areaParam : DEFAULT_AREA;
  let lens = defaultLens(area);
  if (lensParam && AREAS.some((item) => item.tools.some((tool) => tool.id === lensParam))) {
    lens = lensParam;
    if (!lensBelongs(area, lens)) area = areaOfTool(lens).id;
  }
  let probe: ProbeTarget | null = null;
  let malformed = false;
  if (segments.length > 1) {
    const [head, ...rest] = segments.slice(1);
    probe = head && !rest.includes(null) ? parseProbe(head, rest as string[]) : null;
    malformed = probe === null;
  }
  const project = projectParam && ID.test(projectParam) ? projectParam : null;
  return { area, lens, project, probe, malformed: malformed || (!!projectParam && project === null) };
}

/** The canonical href for a location. The default area at Library scope with nothing probed is "/". */
export function formatLocation(location: Omit<WorkspaceLocation, "malformed">): string {
  const params = new URLSearchParams();
  if (location.lens !== defaultLens(location.area)) params.set("lens", location.lens);
  if (location.project) params.set("project", location.project);
  const query = params.toString() ? `?${params.toString()}` : "";
  const { probe } = location;
  if (!probe) return `${location.area === DEFAULT_AREA ? "/" : `/${location.area}`}${query}`;
  const head = `${encodeURIComponent(probe.object)}${probe.rev !== null ? `@${probe.rev}` : ""}`;
  const path = probe.path.length ? `/${PATH_MARK}/${probe.path.map(encodeURIComponent).join("/")}` : "";
  return `/${location.area}/${head}${path}${query}`;
}

export function sameTarget(a: ProbeTarget | null, b: ProbeTarget | null): boolean {
  if (a === null || b === null) return a === b;
  return a.object === b.object && a.rev === b.rev && a.path.length === b.path.length && a.path.every((segment, index) => segment === b.path[index]);
}

/** Stable key for sets and maps of targets. */
export function targetKey(target: ProbeTarget): string {
  return `${target.object}@${target.rev ?? ""}/${target.path.map(encodeURIComponent).join("/")}`;
}
