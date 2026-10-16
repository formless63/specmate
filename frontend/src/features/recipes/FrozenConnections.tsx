import { Alert, Button, Group, Stack, Text } from '@mantine/core';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useNavigation } from '../navigation';
import { requestJson } from '../workspace/api';
type Connection = { definition_id: string; name: string; revision_id: string; number: number; orientation: 'from_to' | 'to_from' | 'same_port_definition'; uses_selected_port_revisions: boolean; uses_other_port_revisions: boolean };
type Page = { results: Connection[]; next_after: string | null; scan_limit_reached: boolean };
export function FrozenConnections(props: { active: boolean; workspaceId: string; principalKey: string; from: string; to: string }) {
  return <ConnectionSession key={`${props.principalKey}:${props.workspaceId}:${props.from}:${props.to}`} {...props} />;
}
function ConnectionSession({ active, principalKey, workspaceId, from, to }: Parameters<typeof FrozenConnections>[0]) {
  const [open, setOpen] = useState(false), [paging, setPaging] = useState({ positions: [null] as (string | null)[], generation: 0 }); const navigation = useNavigation();
  const [activation, setActivation] = useState({ active, generation: 0 }); const epoch = activation.generation+(activation.active !== active ? 1 : 0); if (activation.active !== active) setActivation({ active, generation: epoch });
  const after = paging.positions.at(-1);
  const query = useQuery({ queryKey: ['frozen-connections', principalKey, workspaceId, from, to, after, paging.generation, epoch], enabled: active && open && !!from && !!to, retry: false, refetchOnWindowFocus: 'always', queryFn: ({ signal }) => { const params = new URLSearchParams({ from_revision_id: from, to_revision_id: to, limit: '20' }); if (after) params.set('after', after); return requestJson<Page>('/api/v0/cables/connections?'+params, { signal, cache: 'no-store' }); } });
  useEffect(() => { if (!active || !open || !from || !to) return; const focus = () => { void query.refetch(); }; window.addEventListener('focus', focus); return () => window.removeEventListener('focus', focus); }, [active, open, from, to, query.refetch]);
  const refresh = () => setPaging(previous => ({ positions: [null], generation: previous.generation+1 }));
  if (!active || !from || !to) return null;
  const readable = !query.isError && !query.isFetching && !!query.data;
  return <details onToggle={event => setOpen(event.currentTarget.open)}><summary>Frozen designs connecting these ports</summary>{open && <Stack gap="xs"><Text size="xs">Latest frozen designs with a retained recipe only. Drafts and designs without an intent are not listed; shared ports do not establish compatibility.</Text>{query.isError ? <Alert color="red">Connections unavailable. Retained names are hidden. <Button onClick={refresh}>Retry frozen connections</Button></Alert> : !readable ? <Text role="status">Rechecking frozen designs…</Text> : <>{query.data!.results.map(row => <Group key={row.revision_id}><Button variant="quiet" onClick={() => navigation?.navigate({ area: 'designs', lens: 'cables', project: null, probe: { object: row.definition_id, rev: row.number, path: [] }, filters: {} })}>Open {row.name} r{row.number}</Button><Text size="xs">{row.uses_other_port_revisions ? 'Older or different exact port revisions' : 'Pins the selected port revisions'} · {row.orientation === 'to_from' ? 'reverse orientation' : row.orientation === 'same_port_definition' ? 'same port identity; orientation not inferred' : 'from → to'}</Text></Group>)}{!query.data!.results.length && <Text>No readable frozen connections on this page.</Text>}</>}
    <Group><Button variant="quiet" disabled={paging.positions.length < 2 || query.isFetching} onClick={() => setPaging(previous => ({ ...previous, positions: previous.positions.slice(0,-1) }))}>Previous frozen connections</Button><Button variant="quiet" disabled={!readable || !query.data?.next_after} onClick={() => setPaging(previous => ({ ...previous, positions: [...previous.positions, query.data!.next_after] }))}>Next frozen connections</Button><Button variant="quiet" onClick={refresh}>Refresh frozen connections</Button></Group></Stack>}</details>;
}
