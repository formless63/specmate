import { useCallback, useEffect, useState } from "react";
import { areaOfTool } from "../shell/areas";
import { probeNavigateOptions, useNavigation } from "./NavigationProvider";
import type { ProbeTarget } from "./url";

type ScopeLike = { projectId: string | null; projects: { project_id: string }[]; setProjectContext: (projectId: string | null) => void };

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
 * truth for lens and probe. Project filters never change workspace authority or editor identity.
 */
export function useWorkspaceUrl(scope: ScopeLike): WorkspaceUrl {
  const navigation = useNavigation();
  if (!navigation) throw new Error("useWorkspaceUrl needs a NavigationProvider.");
  const { location, navigate } = navigation;
  const [projectLost, setProjectLost] = useState(false);
  const { projectId, projects } = scope;
  // Project query parameters filter lists. Only explicit project pages select a project context.
  useEffect(() => {
    const explicitPage = ["overview", "knowledge"].includes(location.lens);
    if (location.project && !projects.some((project) => project.project_id === location.project)) {
      setProjectLost(true);
      navigate({ project: null }, { replace: true });
      return;
    }
    const next = explicitPage ? location.project : null;
    if (projectId !== next) scope.setProjectContext(next);
  }, [location.project, location.lens, projectId, projects, scope, navigate]);

  const probe = location.probe;
  const openLens = useCallback((toolId: string) => {
    const area = areaOfTool(toolId).id;
    const projectPage = ["overview", "knowledge"].includes(location.lens) && ["overview", "knowledge"].includes(toolId);
    const sameList = ["library", "designs"].includes(area) && location.area === area && !location.probe;
    navigate({ area, lens: toolId, project: projectPage || sameList ? location.project : null });
  }, [navigate, location.area, location.lens, location.project, location.probe]);
  const setProbe = useCallback((target: ProbeTarget | null) => navigate({ probe: target }, probeNavigateOptions(probe, target)), [navigate, probe]);
  const openInProject = useCallback((target: string, toolId: string, object?: string) => {
    setProjectLost(false);
    navigate({ area: areaOfTool(toolId).id, lens: toolId, project: target, ...(object ? { probe: { object, rev: null, path: [] } } : {}) });
  }, [navigate]);
  const dismissProjectLost = useCallback(() => setProjectLost(false), []);

  return { lens: location.lens, probe, malformed: location.malformed, projectLost, dismissProjectLost, openLens, setProbe, openInProject };
}
