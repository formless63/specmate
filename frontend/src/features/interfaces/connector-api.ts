import { ApiError, requestJson, runOperation } from "../workspace/api";
import type { Identity } from "../identity/api";
import type { Body, Pinout, Port, Inspection } from "./api";
import type { EndAssembly, EndAssemblyInspection } from "../end-assemblies/api";
export type ConnectorKind = "connector_body" | "pinout" | "port" | "end_assembly";
export type ConnectorValue = Body | Pinout | Port | EndAssembly;
export type ConnectorDraft = { definition_id?: string; draft_id: string; state: string; content: { interface: ConnectorValue } };
export type ConnectorInspection = Omit<Inspection, 'interface'> & { interface: ConnectorValue; end_stack?: EndAssemblyInspection['end_stack'] };
export type Relation = { definition_id: string; name: string; kind: Exclude<ConnectorKind, 'connector_body'>; revision_id: string; number: number; body_revision_ids: string[]; uses_selected_body_revision: boolean; uses_other_body_revision: boolean };
export type RelationPage = { body_definition_id: string; body_revision_id: string; body_revision_number: number; basis: 'latest_frozen_at_page_anchor'; as_of: string; results: Relation[]; next_after: string | null; scan_limit_reached: boolean; compatibility: 'not_evaluated' };
export const connectorKind = (value: string | null): value is ConnectorKind => value !== null && ['connector_body', 'pinout', 'port', 'end_assembly'].includes(value);
export const readConnectorIdentity = (id: string, offset = 0) => requestJson<Identity>(`/api/v0/catalog/definitions/${id}?offset=${offset}`, { cache: 'no-store' });
export const readConnectorDraft = (id: string) => requestJson<ConnectorDraft>(`/api/v0/interfaces/drafts/${id}`, { cache: 'no-store' });
export const readConnectorRevision = (id: string) => requestJson<ConnectorInspection>(`/api/v0/interfaces/revisions/${id}`, { cache: 'no-store' });
export const readConnectorRelations = (id: string, after: string | null = null, kind?: Relation['kind']) => requestJson<RelationPage>(`/api/v0/interfaces/revisions/${id}/related?limit=20${kind ? `&kind=${kind}` : ''}${after ? `&after=${encodeURIComponent(after)}` : ''}`, { cache: 'no-store' });
export const connectorCommand = <T,>(operation: string, payload: unknown, state: string | undefined, key: string) => runOperation<T>(operation, payload, { expectedState: state, idempotencyKey: key }).then(result => result.result);

/** Only currently selected exact references are read, never rows of a collection. */
export async function authorizeConnectorReferences(value: ConnectorValue) {
  const revisions = new Set<string>(), sources = new Set<string>();
  function visit(item: unknown) {
    if (!item || typeof item !== 'object') return;
    for (const [key, field] of Object.entries(item)) {
      if (typeof field === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(field) && key.endsWith('_revision_id')) (['source_bundle_revision_id', 'source_revision_id'].includes(key) ? sources : revisions).add(field);
      else visit(field);
    }
  }
  visit(value);
  const design = [...revisions], source = [...sources];
  for (let offset = 0; offset < Math.max(design.length, source.length); offset += 50) {
    const ids = design.slice(offset, offset + 50), sourceIds = source.slice(offset, offset + 50);
    const params = new URLSearchParams();
    ids.forEach(id => params.append('revision_ids', id)); sourceIds.forEach(id => params.append('source_revision_ids', id));
    const labels = await requestJson<{ labels: { revision_id: string; readable: boolean }[]; source_labels: { revision_id: string; readable: boolean }[] }>(`/api/v0/catalog/revision-labels?${params}`, { cache: 'no-store' });
    if (ids.some(id => !labels.labels.some(row => row.revision_id === id && row.readable)) || sourceIds.some(id => !labels.source_labels.some(row => row.revision_id === id && row.readable))) throw new ApiError(403, 'A selected exact reference is unavailable. Prepared source content is hidden until current access is confirmed.');
  }
}
