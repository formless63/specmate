/**
 * Per-user memory of the project last opened, kept only as a convenience in this
 * browser. It stores a project id (never project content), is keyed by the signed-in
 * user id, and is only ever used to highlight a project the server still lists.
 */
const PREFIX = "specmate.lastProject.";

export function readLastProject(userId: string): string | null {
  try {
    const value = window.localStorage.getItem(PREFIX + userId);
    return value && value.length <= 128 ? value : null;
  } catch {
    return null;
  }
}

export function writeLastProject(userId: string, projectId: string): void {
  try {
    window.localStorage.setItem(PREFIX + userId, projectId);
  } catch { /* Storage can be blocked; the memory is optional. */ }
}

export function forgetLastProject(userId: string): void {
  try {
    window.localStorage.removeItem(PREFIX + userId);
  } catch { /* Storage can be blocked; the memory is optional. */ }
}
