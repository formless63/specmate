import { Alert, Button, Group, Stack, Text } from '@mantine/core';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { requestJson } from '../workspace/api';
import type { KitPage } from './api';

export function PartRelations({ active, principalKey, workspaceId, revisionId, onOpen }: { active: boolean; principalKey: string; workspaceId: string; revisionId: string; onOpen: (id: string, number: number) => void }) {
  const [after, setAfter] = useState<string | null>(null), [previous, setPrevious] = useState<(string | null)[]>([]);
  const query = useQuery({ queryKey: ['part-kits', principalKey, workspaceId, revisionId, after], enabled: active, retry: false,
    queryFn: ({ signal }) => requestJson<KitPage>(`/api/v0/catalog/revisions/${revisionId}/kits?limit=20${after ? `&after=${encodeURIComponent(after)}` : ''}`, { signal, cache: 'no-store' }) });
  const page = active && !query.isFetching && !query.isError ? query.data : undefined;
  return <Stack><Text size="sm">Exact declared lines in each kit's latest frozen revision at the page anchor. Catalog membership does not imply a physical occurrence.</Text>
    {query.isError && <Alert color="red">{query.error.message}</Alert>}{query.isFetching && <Text role="status">Checking current kit membership…</Text>}
    {page?.results.map(row => <Group key={row.revision_id}><Button variant="quiet" onClick={() => onOpen(row.definition_id, row.number)}>{row.name} · r{row.number}</Button><Text>{row.lines.length} matching line{row.lines.length === 1 ? '' : 's'}</Text></Group>)}
    {page && page.results.length === 0 && <Text>No readable memberships on this page.</Text>}
    <Group><Button size="xs" disabled={!previous.length || query.isFetching} onClick={() => { setAfter(previous.at(-1) ?? null); setPrevious(previous.slice(0, -1)); }}>Previous memberships</Button><Button size="xs" disabled={!page?.next_after || query.isFetching} onClick={() => { setPrevious([...previous, after]); setAfter(page!.next_after); }}>More memberships</Button><Button size="xs" variant="quiet" onClick={() => void query.refetch()}>Refresh memberships</Button></Group>
  </Stack>;
}
