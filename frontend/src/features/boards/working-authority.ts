import { ApiError, requestJson } from '../workspace/api';
import { associationTargets } from '../pcb/api';
export type WorkingPins = { revisions: string[]; sources: string[]; models?: string[] };
export const exactUuid = (value: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
export function uniquePins(pins: WorkingPins): WorkingPins { return { revisions: [...new Set(pins.revisions)].sort(), sources: [...new Set(pins.sources)].sort(), models: [...new Set(pins.models ?? [])].sort() }; }
/** Reuses the existing batched closure read; no content fetch per selector row. */
export async function authorizeWorkingPins(pins: WorkingPins, workspaceId: string, signal?: AbortSignal) {
  for (let at = 0; at < Math.max(pins.revisions.length, pins.sources.length); at += 50) {
    const revisions = pins.revisions.slice(at, at + 50); const sources = pins.sources.slice(at, at + 50); const query = new URLSearchParams();
    revisions.forEach(id => query.append('revision_ids', id)); sources.forEach(id => query.append('source_revision_ids', id));
    const result = await requestJson<{ labels: { revision_id: string; readable: boolean }[]; source_labels: { revision_id: string; readable: boolean }[] }>(`/api/v0/catalog/revision-labels?${query}`, { signal });
    if (revisions.some(id => !result.labels.some(row => row.revision_id === id && row.readable)) || sources.some(id => !result.source_labels.some(row => row.revision_id === id && row.readable))) throw new ApiError(403, 'A working reference is unavailable. Local edits and the original editing token are retained.');
  }
  if (pins.models?.length) { const targets = await associationTargets(workspaceId, signal); if (pins.models.some(id => !targets.models.some(row => row.representation_id === id))) throw new ApiError(403, 'A working model reference is unavailable.'); }
  return true;
}
