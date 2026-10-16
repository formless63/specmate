import { ApiError, requestJson, runOperation } from '../workspace/api';
export type Content = Record<string, unknown>;
export type Fit = { revision_id: string; basis: string };
export type Part = { schema_version: '1'; category: string | null; value: string | null; package: string | null; fits: Fit[] };
export type Quantity = { amount: string; unit: 'ea' | 'mm' | 'm' | 'cm' | 'g' | 'kg' };
export type KitLine = { local_id: string; revision_id: string; quantity: Quantity | null; note: string | null };
export type Kit = { schema_version: '1'; semantics: 'catalog_grouping'; lines: KitLine[] };
export type Draft = { kind: 'draft'; draft_id: string; state: string; content: Content; base_revision_id: string | null };
export type Frozen = { kind: 'revision'; revision_id: string; number: number; snapshot_id: string; sha256: string; content: Content };
export type PartRecord = { definition_id: string; workspace_id: string; name: string; kind: string; selected: Draft | Frozen };
export type KitMembership = { definition_id: string; name: string; revision_id: string; number: number; lines: KitLine[] };
export type KitPage = { results: KitMembership[]; next_after: string | null; scan_limit_reached: boolean };
export const PART_KINDS = ['part', 'material', 'hardware', 'mechanical_source', 'kit'];
export const blankPart = (hardware = false): Content => ({ part: { schema_version: '1', category: hardware ? 'hardware' : null, value: null, package: null, fits: [] } satisfies Part });
export const blankKit = (): Content => ({ kit: { schema_version: '1', semantics: 'catalog_grouping', lines: [] } satisfies Kit });
export const partValue = (content: Content): Part | null => content.part && typeof content.part === 'object' && (content.part as Part).schema_version === '1' ? content.part as Part : null;
export const kitValue = (content: Content): Kit | null => content.kit && typeof content.kit === 'object' && (content.kit as Kit).schema_version === '1' ? content.kit as Kit : null;
/** Object order is not a draft edit. Authored array order and strings remain exact. */
export const canonical = (value: unknown): string => JSON.stringify(value, (_key, field) => field && typeof field === 'object' && !Array.isArray(field) ? Object.fromEntries(Object.entries(field).sort(([a], [b]) => a.localeCompare(b))) : field);
export function readRecord(id: string, revision: number | null, working: boolean, draftId?: string | null) {
  const params = new URLSearchParams();
  if (revision !== null) params.set('revision_number', String(revision));
  else if (draftId) params.set('draft_id', draftId);
  else if (working) params.set('working', 'true');
  return requestJson<PartRecord>(`/api/v0/catalog/definitions/${encodeURIComponent(id)}/record?${params}`, { cache: 'no-store' });
}
export const command = <T,>(operation: string, payload: unknown, state: string | undefined, key: string) => runOperation<T>(operation, payload, { expectedState: state, idempotencyKey: key }).then(response => response.result);
export function references(content: Content): string[] {
  const family = content.product_family as { variants?: { design_revision_id: string }[] } | undefined;
  const mechanical = content.mechanical_source as { targets?: { revision_id: string }[]; models?: { revision_id: string }[] } | undefined;
  return [...new Set([...(family?.variants?.map(row => row.design_revision_id) ?? []), ...(partValue(content)?.fits.map(row => row.revision_id) ?? []), ...(kitValue(content)?.lines.map(row => row.revision_id) ?? []), ...(mechanical?.targets?.map(row => row.revision_id) ?? []), ...(mechanical?.models?.map(row => row.revision_id) ?? [])])].sort();
}
export const sourceReferences = (content: Content): string[] => [...new Set(((content.mechanical_source as { sources?: { source_revision_id: string }[] } | undefined)?.sources ?? []).map(row => row.source_revision_id))].sort();
export const referenceSignature = (content: Content) => [...references(content), ...sourceReferences(content)].join(',');
export async function authorizeReferences(content: Content) {
  const ids = references(content);
  for (let offset = 0; offset < ids.length; offset += 50) {
    const batch = ids.slice(offset, offset + 50), params = new URLSearchParams();
    batch.forEach(id => params.append('revision_ids', id));
    const result = await requestJson<{ labels: { revision_id: string; readable: boolean }[] }>(`/api/v0/catalog/revision-labels?${params}`, { cache: 'no-store' });
    if (batch.some(id => !result.labels.some(row => row.revision_id === id && row.readable))) throw new ApiError(403, 'A selected exact reference is unavailable.');
  }
  for (const id of sourceReferences(content)) await requestJson(`/api/v0/sources/revisions/${encodeURIComponent(id)}`, { cache: 'no-store' });
}
