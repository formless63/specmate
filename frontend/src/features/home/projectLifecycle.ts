import { readProjectDetail, runOperation } from "../workspace/api";

const DEPENDENT_LABELS: Record<string, [string, string]> = {
  "knowledge.knowledgeitem": ["note or decision", "notes and decisions"],
  "knowledge.knowledgelink": ["link", "links"],
  "collaboration.changereview": ["review", "reviews"],
  "collaboration.internalnotification": ["notification", "notifications"],
  "inventory.reservation": ["reservation", "reservations"],
  "inventory.workbatch": ["work batch", "work batches"],
  "builds.buildattempt": ["build", "builds"],
  "facts.factsubject": ["fact ledger", "fact ledgers"],
};

/** Plain words for the records that keep a project from being deleted. */
export function describeDependents(dependents: Record<string, number> | undefined): string[] {
  return Object.entries(dependents ?? {}).sort(([a], [b]) => a.localeCompare(b)).map(([key, count]) => {
    const [one, many] = DEPENDENT_LABELS[key] ?? [key.split(".").pop() ?? key, `${key.split(".").pop() ?? key} records`];
    return `${count} ${count === 1 ? one : many}`;
  });
}

/** Archiving hides a project from default lists and makes it read-only; references and history stay. */
export async function setArchived(projectId: string, archived: boolean) {
  const project = await readProjectDetail(projectId);
  return runOperation("project.archive", { project_id: projectId, archived }, { expectedState: project.state });
}

/** Deletes a project nothing depends on; referenced items stay in the library. */
export async function deleteProject(projectId: string) {
  const project = await readProjectDetail(projectId);
  return runOperation("project.delete", { project_id: projectId }, { expectedState: project.state });
}

/** Why deletion is unavailable, or null when it is offered. */
export function deleteBlocker(project: { can_delete?: boolean; dependents?: Record<string, number> }, canEdit: boolean): string | null {
  if (project.can_delete) return null;
  const dependents = describeDependents(project.dependents);
  if (dependents.length) return `Records depend on this project (${dependents.join(", ")}); archive it instead`;
  if (!canEdit) return "Read-only access: requires Project editing";
  return "Only the project's creator or an admin can delete it";
}
