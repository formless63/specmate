import type { StockSpecification } from '../../../../packages/section-layout/src';
import type { ProfileRevision } from '../workshop-profiles/api';
import { allLibraryDefinitions } from '../identity/api';

export interface ViewerDefinition { definition_id: string; name: string; kind: string }
export interface RevisionChoice { revision_id: string; number: number }
async function read<T>(path: string): Promise<T> {
  const response = await fetch(`/api/v0/${path}`, { credentials: 'same-origin' });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error?.message ?? `Preview read failed (${response.status}).`);
  return body as T;
}
/** Library definitions; a project id only lists its references first. */
export const listViewerDefinitions = (projectId?: string | null): Promise<ViewerDefinition[]> =>
  allLibraryDefinitions(projectId);
export async function listStockRevisions(definitionId: string): Promise<RevisionChoice[]> {
  const result: RevisionChoice[] = [];
  for (let offset = 0; ; offset += 100) {
    const page = await read<{ kind: string; revisions: RevisionChoice[] }>(`catalog/definitions/${encodeURIComponent(definitionId)}?offset=${offset}&limit=100`);
    if (page.kind !== 'wire_stock') throw new Error('Selected definition is not wire stock.');
    result.push(...page.revisions);
    if (page.revisions.length < 100) return result;
  }
}
export async function loadFrozenStock(revisionId: string): Promise<StockSpecification> {
  const snapshot = await read<{ content: { stock?: StockSpecification } }>(`revisions/${encodeURIComponent(revisionId)}/snapshot`);
  if (!snapshot.content.stock) throw new Error('Selected revision has no stock construction.');
  return snapshot.content.stock;
}
export async function matchingProfileRevisions(definitions: ViewerDefinition[], stockRevisionId: string): Promise<ProfileRevision[]> {
  const histories = await Promise.all(definitions.filter(d => d.kind === 'workshop_profile').map(d =>
    read<ProfileRevision[]>(`workshop-profile-definitions/${encodeURIComponent(d.definition_id)}/revisions`)));
  return histories.flat().filter(revision => revision.content.profile.stock_revision_id === stockRevisionId);
}
