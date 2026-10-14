import { useCallback, useEffect, useRef, useState } from "react";
import { areaOfTool } from "../shell/areas";
import { probeNavigateOptions, useNavigation } from "./NavigationProvider";
import type { ProbeTarget } from "./url";

type ScopeLike = { projectId: string | null; projects: { project_id: string }[]; selectProject: (projectId: string | null) => void };

export type WorkspaceUrl = {
  lens: string;
  probe: ProbeTarget | null;
  /** The link's selection was not a workspace address; shown as access-lost, never named. */
  malformed: boolean;
  /** The link named a project context this member cannot use; the shell fell back to the Library. */
  projectLost: boolean;
  dismissProjectLost: () => void;
  openLens: (toolId: string) => void;
  setProbe: (target: ProbeTarget | null) => void;
  /** Open a lens with a project as context (and optionally an item probed) in one history entry. */
  openInProject: (projectId: string, toolId: string, object?: string) => void;
};

/**
 * Keeps the shell (lens, project context, probe) and the URL in step. The URL is the source of
 * truth for lens and probe. Project context lives in the workspace shell, which validates it and
 * clears private reads on change, so the two are reconciled here in both directions.
 */
export function useWorkspaceUrl(scope: ScopeLike): WorkspaceUrl {
  const navigation = useNavigation();
  if (!navigation) throw new Error("useWorkspaceUrl needs a NavigationProvider.");
  const { location, navigate } = navigation;
  const [projectLost, setProjectLost] = useState(false);
  const { projectId, projects, selectProject } = scope;
  const previous = useRef({ shell: projectId, url: location.project });

  useEffect(() => {
    const shellChanged = projectId !== previous.current.shell;
    const urlChanged = location.project !== previous.current.url;
    previous.current = { shell: projectId, url: location.project };
    if (location.project === projectId) return;
    if (shellChanged && !urlChanged) {
      // The shell changed scope itself (scope control, a new project, a removed project).
      navigate({ project: projectId });
      return;
    }
    // The address changed (a link, reload, back/forward): follow it if the workspace has that project.
    if (location.project === null || projects.some((project) => project.project_id === location.project)) {
      selectProject(location.project);
      return;
    }
    // Not a project of this workspace (or no longer one): Library scope, without naming it.
    setProjectLost(true);
    navigate({ project: null }, { replace: true });
  }, [location.project, projectId, projects, selectProject, navigate]);

  const probe = location.probe;
  const openLens = useCallback((toolId: string) => navigate({ area: areaOfTool(toolId).id, lens: toolId }), [navigate]);
  const setProbe = useCallback((target: ProbeTarget | null) => navigate({ probe: target }, probeNavigateOptions(probe, target)), [navigate, probe]);
  const openInProject = useCallback((target: string, toolId: string, object?: string) => {
    setProjectLost(false);
    navigate({ area: areaOfTool(toolId).id, lens: toolId, project: target, ...(object ? { probe: { object, rev: null, path: [] } } : {}) });
  }, [navigate]);
  const dismissProjectLost = useCallback(() => setProjectLost(false), []);

  return { lens: location.lens, probe, malformed: location.malformed, projectLost, dismissProjectLost, openLens, setProbe, openInProject };
}
