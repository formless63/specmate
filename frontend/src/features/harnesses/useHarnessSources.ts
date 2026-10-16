import { useQueries } from '@tanstack/react-query';
import { readConnectorRevision } from '../interfaces/connector-api';
import { ApiError } from '../workspace/api';
import { loadFrozenStock } from '../wire-stock/viewer-api';
import { resolveEnd, stackComplete } from '../end-assemblies/api';
import type { Harness } from './api';
import type { HarnessCanvasData } from './canvas-model';
/** Resolve complete exact pins; incomplete authoring fields remain editable. */
export function useHarnessSources(value: Harness, active: boolean, scope: string) {
  const ids = [...new Set(value.sections.map(section => section.stock_revision_id).filter(Boolean))].sort();
  const complete = value.endpoints.map(endpoint => !!endpoint.end_assembly_revision_id || !!endpoint.stack && stackComplete(endpoint.stack));
  const stocks = useQueries({ queries: ids.map(id => ({ queryKey: ['harness-stock', scope, id], queryFn: () => loadFrozenStock(id), enabled: active, retry: false, refetchOnWindowFocus: 'always' as const })) });
  const ends = useQueries({ queries: value.endpoints.map((endpoint, index) => ({ queryKey: ['harness-end', scope, endpoint.end_assembly_revision_id, endpoint.stack], queryFn: () => resolveEnd(endpoint.end_assembly_revision_id ? { end_assembly_revision_id: endpoint.end_assembly_revision_id } : { stack: endpoint.stack! }), enabled: active && complete[index], retry: false, refetchOnWindowFocus: 'always' as const })) });
  const bodyIds = [...new Set(ends.flatMap(query => query.data?.layers.filter(layer => layer.kind === 'connector').flatMap(layer => layer.body_revision_id ? [layer.body_revision_id] : query.data?.body_revision_id ? [query.data.body_revision_id] : []) ?? []))].sort();
  const bodies = useQueries({ queries: bodyIds.map(id => ({ queryKey: ['harness-body', scope, id], enabled: active, retry: false, refetchOnWindowFocus: 'always' as const, queryFn: async () => { const result = await readConnectorRevision(id); if (result.interface.kind !== 'connector_body') throw new ApiError(404, 'The exact connector body is unavailable.'); return result.interface; } })) });
  const pending = bodies.some(query => query.isPending || query.isFetching) || stocks.some(query => query.isPending || query.isFetching) || ends.some((query, index) => complete[index] && (query.isPending || query.isFetching));
  const failed = [...stocks, ...ends, ...bodies].find(query => query.isError);
  const data: HarnessCanvasData = { bodies: Object.fromEntries(bodyIds.flatMap((id, index) => bodies[index]?.data ? [[id, bodies[index]!.data!]] : [])), stocks: Object.fromEntries(ids.flatMap((id, index) => stocks[index]?.data ? [[id, stocks[index]!.data!]] : [])), ends: Object.fromEntries(value.endpoints.flatMap((end, index) => ends[index]?.data ? [[end.local_id, ends[index]!.data!]] : [])) };
  return { data, pending, error: failed?.error, refresh: async () => { await Promise.all([...bodies, ...stocks, ...ends.filter((_, index) => complete[index])].map(query => query.refetch({ throwOnError: true }))); } };
}
