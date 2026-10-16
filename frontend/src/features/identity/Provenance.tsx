import { Alert, Button, Stack, Text } from '@mantine/core';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { requestJson, runOperation } from '../workspace/api';

type Origin = { namespace: string; record_key: string; upstream_revision: string | null; source_status: string; synthetic_example: boolean; converter: string; source_bundle_revision_id: string; source_path: string; sha256: string; rights: string };
type Lifecycle = { definition_id: string; status: string; replacement_revision_id: string | null; basis: string | null };

/** Current disposition and exact frozen provenance have separate identities. */
export function Provenance({ definitionId, revisionId, active, scopeKey }: { definitionId: string; revisionId?: string; active: boolean; scopeKey: string }) {
  const [offset, setOffset] = useState(0);
  useEffect(() => setOffset(0), [definitionId, revisionId, scopeKey]);
  const lifecycle = useQuery({ queryKey: ['catalog-lifecycle', scopeKey, definitionId], queryFn: async () => (await runOperation<Lifecycle>('catalog.lifecycle', { definition_id: definitionId })).result, enabled: active, retry: false });
  const source = useQuery({ queryKey: ['catalog-origins', scopeKey, revisionId, offset], queryFn: ({ signal }) => requestJson<{ source_origins?: Origin[] }>(`/api/v0/catalog/revisions/${revisionId}?offset=${offset}&limit=50`, { signal, cache: 'no-store' }), enabled: active && !!revisionId, retry: false });
  const current = active && !lifecycle.isError && !lifecycle.isFetching ? lifecycle.data : undefined;
  const origins = active && !source.isError && !source.isFetching ? source.data?.source_origins : undefined;
  return <Stack gap="xs">
    <Text fw={600}>Current catalog disposition</Text>
    {lifecycle.isError ? <Alert color="red">Catalog disposition unavailable.</Alert> : current ? <><Text>{current.status}</Text>{current.basis && <Text size="sm">{current.basis}</Text>}{current.replacement_revision_id && <><Text size="sm">Superseded by exact revision {current.replacement_revision_id}. Existing design pins keep their original revisions.</Text></>}</> : <Text>Reading disposition…</Text>}
    <Button size="xs" variant="quiet" disabled={!active} onClick={() => { void lifecycle.refetch(); if (revisionId) void source.refetch(); }}>Refresh provenance</Button>
    <Text fw={600}>Frozen source origins</Text>
    {!revisionId ? <Text size="sm">Select a frozen revision to inspect its recorded source origins.</Text> : source.isError ? <Alert color="red">Exact source provenance unavailable.</Alert> : origins?.length ? origins.map((origin, index) => <div key={`${origin.namespace}:${origin.record_key}:${index}`}>
      <Text size="sm">{origin.namespace} · {origin.record_key}</Text>
      <Text size="xs">Upstream revision: {origin.upstream_revision ?? 'not declared'} · source status: {origin.source_status}{origin.synthetic_example ? ' · synthetic example' : ''}</Text>
      <Text size="xs">Converter: {origin.converter}</Text>
      <Text size="xs" style={{ overflowWrap: 'anywhere' }}>{origin.source_path} · SHA-256 {origin.sha256}</Text>
      <Text size="xs">{origin.rights}</Text>
    </div>) : <Text size="sm">No typed source origins recorded for this revision.</Text>}
    {revisionId && <><Button size="xs" variant="quiet" disabled={!active || offset === 0} onClick={() => setOffset(Math.max(0, offset - 50))}>Previous origins</Button><Button size="xs" variant="quiet" disabled={!active || !origins || origins.length < 50} onClick={() => setOffset(offset + 50)}>More origins</Button></>}
    <Text size="xs" c="dimmed">Conversion provenance records declared inputs. It does not qualify a design or authorize redistribution.</Text>
  </Stack>;
}
