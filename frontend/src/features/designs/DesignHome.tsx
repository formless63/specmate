import { Button, Group, Stack, Tabs, Text, Title, Alert } from '@mantine/core';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useState, type ComponentProps } from 'react';
import { usePermission } from '../../lib/permissions';
import { useNavigation } from '../navigation';
import { listLibrary } from '../workspace/api';
import { DesignList } from './DesignList';

export function DesignHome(props: ComponentProps<typeof DesignList> & { workspaceId: string }) {
  const navigation = useNavigation(), needs = navigation?.location.filters?.view === 'needs';
  return <Stack gap="sm"><Tabs value={needs ? 'needs' : 'designs'} onChange={value => navigation?.navigate({ filters: { ...navigation.location.filters, view: value === 'needs' ? 'needs' : '' } })}>
    <Tabs.List><Tabs.Tab value="designs">Designs</Tabs.Tab><Tabs.Tab value="needs">Proposals &amp; needs</Tabs.Tab></Tabs.List>
  </Tabs><div hidden={needs}><DesignList {...props} active={props.active && !needs} /></div><div hidden={!needs}><Needs key={`${props.principalKey}:${props.workspaceId}:${props.projectFilterId ?? "all"}`} {...props} active={props.active !== false && needs} /></div></Stack>;
}
function Needs({ active, principalKey, workspaceId, projectFilterId, onCreate }: ComponentProps<typeof DesignList> & { workspaceId: string; active: boolean }) {
  const navigation = useNavigation(), create = usePermission('item.create');
  const [paging, setPaging] = useState({ positions: [null] as (string | null)[], generation: 0 }), [activation, setActivation] = useState({ active, generation: 0 });
  const epoch = activation.generation + (activation.active !== active ? 1 : 0); if (activation.active !== active) setActivation({ active, generation: epoch });
  const query = useQuery({ queryKey: ['design-needs', principalKey, workspaceId, projectFilterId, paging.positions.at(-1), paging.generation, epoch], enabled: active, retry: false, refetchOnWindowFocus: 'always', queryFn: () => listLibrary({ family: 'definition', kinds: ['development_need'], query: '', projectId: projectFilterId, after: paging.positions.at(-1)!, limit: 20 }) });
  useEffect(() => { if (!active) return; const focus = () => { void query.refetch(); }; window.addEventListener('focus', focus); return () => window.removeEventListener('focus', focus); }, [active, query.refetch]);
  const refresh = () => setPaging(previous => ({ positions: [null], generation: previous.generation + 1 }));
  if (!active) return null;
  const readable = !query.isFetching && !query.isError && !!query.data;
  return <Stack gap="sm"><Title order={1}>Proposals &amp; needs</Title><Text size="sm">Needs record work that remains to be designed. A new design does not resolve or accept a need automatically.</Text><Group><Button {...create.props} onClick={() => onCreate()}>Start a design</Button><Button variant="quiet" onClick={() => navigation?.navigate({ area: 'designs', lens: 'mechanical-proposals', project: null, probe: null, filters: {} })}>Review enclosure proposals</Button></Group><Text size="xs">Enclosure proposals have their own explicit review decisions. Need records do not imply physical qualification.</Text>
    {query.isError ? <Alert color="red">Needs are unavailable. Retained names are hidden.<Button onClick={refresh}>Retry needs</Button></Alert> : !readable ? <Text role="status">Rechecking needs…</Text> : <div role="list" aria-label="Development needs">{query.data!.results.map(row => <section role="listitem" key={row.record_id}><Button variant="quiet" onClick={() => navigation?.navigate({ area: 'library', lens: 'identity', project: null, filters: {}, probe: { object: row.record_id, rev: row.latest_revision, path: [] } })}>Open {row.label}</Button><Text size="xs">{row.latest_revision ? `Frozen r${row.latest_revision}` : 'Current draft'} · Need record</Text></section>)}{!query.data!.results.length && <Text>No readable needs on this page.</Text>}</div>}
    <Group><Button variant="quiet" disabled={paging.positions.length < 2 || query.isFetching} onClick={() => setPaging(previous => ({ ...previous, positions: previous.positions.slice(0,-1) }))}>Previous needs</Button><Button variant="quiet" disabled={!readable || !query.data?.next_after} onClick={() => setPaging(previous => ({ ...previous, positions: [...previous.positions, query.data!.next_after] }))}>Next needs</Button><Button variant="quiet" onClick={refresh}>Refresh needs</Button></Group>
  </Stack>;
}
