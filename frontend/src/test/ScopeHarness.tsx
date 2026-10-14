import { Fragment, type ReactNode } from "react";
import { WorkspaceHome } from "../features/home/WorkspaceHome";
import { WorkspaceShell, type Project, type ShellChrome, type WorkspaceScope } from "../features/workspace";

/**
 * Test harness: the session/scope owner with the real project list at Library scope and a
 * caller-supplied body at project scope, without mounting every tool.
 */
export function ScopeHarness({ children }: {
  children: (projectId: string, project: Project, refresh: () => Promise<void>, principalKey: string, chrome: ShellChrome, scope: WorkspaceScope) => ReactNode;
}) {
  return <WorkspaceShell>{(scope) => scope.projectId && scope.project
    // Keyed like the application keys its project subtree, so private component state is per project.
    ? <Fragment key={scope.projectId}>{scope.chrome.alert}{children(scope.projectId, scope.project, scope.refresh, scope.principalKey, scope.chrome, scope)}</Fragment>
    : <>
      <span>Signed in as {scope.username}</span>{scope.chrome.projectControl}{scope.chrome.signOutControl}{scope.chrome.alert}
      <WorkspaceHome username={scope.username} role={scope.role} permissions={scope.permissions} projects={scope.projects} lastProjectId={scope.lastProjectId}
        busy={scope.busy} onOpen={scope.selectProject} onCreate={scope.createProject} onChanged={scope.refresh} />
    </>}</WorkspaceShell>;
}
