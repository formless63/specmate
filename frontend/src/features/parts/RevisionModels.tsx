import { Alert, Text } from '@mantine/core';
import { useQuery } from '@tanstack/react-query';
import { lazy, Suspense, useEffect, useRef } from 'react';
import type { Catalog } from '../identity/api';
import { ApiError, requestJson } from '../workspace/api';
import './parts.css';

const PartModel = lazy(() => import('./PartModel').then(module => ({ default: module.PartModel })));

/** Exact frozen models use the same source authority, hash and resource lifecycle as Parts. */
export function RevisionModels({ active, revisionId, principalKey, workspaceId, onAccessLost }: {
  active: boolean; revisionId: string | null; principalKey: string; workspaceId: string; onAccessLost: (failure: unknown) => void;
}) {
  const catalog = useQuery({ queryKey: ['record-models', principalKey, workspaceId, revisionId], enabled: active && !!revisionId, retry: false,
    queryFn: ({ signal }) => requestJson<Catalog>(`/api/v0/catalog/revisions/${revisionId}?offset=0&limit=50`, { signal, cache: 'no-store' }) });
  const failure = catalog.error, notified = useRef('');
  const identity = `${principalKey}:${workspaceId}:${revisionId}`;
  // A source denial can leave the record itself readable. Notify once per exact
  // selection so its refresh cannot become a repeated denial/refetch loop.
  const notify = (error: unknown) => { if (notified.current !== identity) { notified.current = identity; onAccessLost(error); } };
  useEffect(() => { if (active && failure instanceof ApiError && [401, 403, 404].includes(failure.status)) notify(failure); }, [active, failure, identity, onAccessLost]);
  if (!active) return null;
  if (!revisionId) return <Text>Choose a frozen revision to inspect its exact linked models.</Text>;
  if (catalog.isError) return <Alert color="red">{catalog.error.message}</Alert>;
  if (catalog.isPending || catalog.isFetching) return <Text role="status">Confirming exact model access…</Text>;
  return <Suspense fallback={<Text>Loading model view…</Text>}><PartModel key={`${principalKey}:${workspaceId}:${revisionId}`} active scopeKey={`${principalKey}:${workspaceId}:${revisionId}`} rows={catalog.data.representations} onAccessLost={() => notify(new ApiError(403, 'Exact model source access is unavailable.'))} /></Suspense>;
}
