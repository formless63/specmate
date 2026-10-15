import { Alert, Button, Card, Group, Select, Stack, Table, Text, TextInput, Title } from '@mantine/core';
import { useMediaQuery } from '@mantine/hooks';
import './history.css';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useNavigation } from '../navigation';
import { KNOWN_KINDS, toolForKind } from '../shell/scope';
import { areaOfTool } from '../shell/areas';
import { requestJson } from '../workspace/api';
import { useHistoryIdentity } from './HistoryScope';

type Source = 'retained' | 'receipts' | 'revisions' | 'current_drafts';
type Filters = { kind: string | null; actor: string | null; from: string; to: string; source: Source };
type Touch = { definition_id: string; kind: string; name: string; basis: 'exact_revision' | 'current_draft'; revision_id: string | null; number: number | null; draft_id: string | null; state: string | null };
type Event = { event_id: string; evidence: 'receipt' | 'revision' | 'draft'; at: string; actor: { id: string; name: string }; operation: string | null; touched: Touch[] };
type Page = { workspace_id: string; source: Source; hint: string; complete_audit: false; results: Event[]; next_after: string | null; scan_limit_reached: boolean };
const initial: Filters = { kind: null, actor: null, from: '', to: '', source: 'retained' };
const sources = [{ value: 'retained', label: 'Recorded changes and revisions' }, { value: 'receipts', label: 'Recorded changes' }, { value: 'revisions', label: 'Frozen revisions' }, { value: 'current_drafts', label: 'Current drafts' }];
const kinds = KNOWN_KINDS;
const evidenceLabel = { receipt: 'Recorded change', revision: 'Frozen revision', draft: 'Current draft' };

/** The rail and a record's own History use precisely the same authorized projection. */
export function HistoryPage({ active, workspaceId, principalKey }: { active: boolean; workspaceId: string; principalKey: string }) {
  const navigation = useNavigation(), values = navigation?.location.filters ?? {};
  const source = sources.some(row => row.value === values.history_source) ? values.history_source as Source : 'retained';
  const filters: Filters = { kind: values.kind || null, actor: values.actor || null, from: values.from || '', to: values.to || '', source };
  return <Stack><Title order={1}>History</Title><HistoryRows key={`${principalKey}:${workspaceId}`} active={active} workspaceId={workspaceId} principalKey={principalKey} filters={filters} onFilters={next => {
    const updated = { ...values }; for (const key of ['kind', 'actor', 'from', 'to', 'history_source']) delete updated[key];
    if (next.kind) updated.kind = next.kind; if (next.actor) updated.actor = next.actor; if (next.from) updated.from = next.from; if (next.to) updated.to = next.to; if (next.source !== 'retained') updated.history_source = next.source;
    navigation?.navigate({ filters: updated });
  }} /></Stack>;
}
export function RecordHistory({ definitionId, active }: { definitionId: string; active: boolean }) {
  const identity = useHistoryIdentity();
  return identity ? <HistoryRows key={`${identity.principalKey}:${identity.workspaceId}:${definitionId}`} {...identity} definitionId={definitionId} active={active} /> : null;
}
export function RecordHistoryDisclosure({ definitionId, active }: { definitionId: string; active: boolean }) {
  const [open, setOpen] = useState(false);
  return <details onToggle={event => setOpen(event.currentTarget.open)}><summary>History</summary>{open && <RecordHistory definitionId={definitionId} active={active} />}</details>;
}
function HistoryRows({ workspaceId, principalKey, definitionId, active, filters: controlled, onFilters }: {
  workspaceId: string; principalKey: string; definitionId?: string; active: boolean; filters?: Filters; onFilters?: (filters: Filters) => void;
}) {
  const phone = useMediaQuery('(max-width: 48em)');
  const compact = phone || !!definitionId;
  const navigation = useNavigation();
  const [local, setLocal] = useState(initial);
  const filters = controlled ?? local;
  const filterKey = JSON.stringify([principalKey, workspaceId, definitionId, filters]);
  const [paging, setPaging] = useState({ key: filterKey, positions: [null] as (string | null)[], generation: 0 });
  // External URL changes (Back/Forward and deep links) cannot reuse another filter's cursor.
  const positions = paging.key === filterKey ? paging.positions : [null];
  const after = positions.at(-1) ?? null;
  const generation = paging.generation + (paging.key !== filterKey ? 1 : 0);
  if (paging.key !== filterKey) setPaging({ key: filterKey, positions: [null], generation });
  const [activation, setActivation] = useState({ active, generation: 0 });
  const activationGeneration = activation.generation + (activation.active !== active ? 1 : 0);
  if (activation.active !== active) setActivation({ active, generation: activationGeneration });
  const firstPage = () => setPaging(current => ({ key: filterKey, positions: [null], generation: current.generation + 1 }));
  const query = useQuery({ queryKey: ['history', principalKey, workspaceId, definitionId, filters, after, generation, activationGeneration], enabled: active, retry: false, refetchOnWindowFocus: 'always',
    queryFn: ({ signal }) => { const params = new URLSearchParams({ workspace_id: workspaceId, limit: '25', source: filters.source }); if (definitionId) params.set('definition_id', definitionId); if (filters.kind) params.set('kind', filters.kind); if (filters.actor) params.set('actor_id', filters.actor); if (filters.from) params.set('from_date', filters.from+'T00:00:00Z'); if (filters.to) params.set('to_date', filters.to+'T23:59:59.999999Z'); if (after) params.set('after', after); return requestJson<Page>('/api/v0/workspace/history?'+params, { signal, cache: 'no-store' }); } });
  useEffect(() => { if (!active) return; const focus = () => { void query.refetch(); }; window.addEventListener('focus', focus); return () => window.removeEventListener('focus', focus); }, [active, query.refetch]);
  const change = (patch: Partial<Filters>) => { const next = { ...filters, ...patch }; if (onFilters) onFilters(next); else setLocal(next); };
  if (!active) return null;
  const readable = !query.isError && !query.isFetching && query.data?.workspace_id === workspaceId && query.data?.source === filters.source;
  const rows = readable ? query.data!.results : [];
  const actors = [...new Map(rows.map(row => [row.actor.id, { value: row.actor.id, label: row.actor.name }])).values()];
  const open = (touch: Touch) => { const lens = toolForKind(touch.kind); navigation?.navigate({ area: areaOfTool(lens).id, lens, project: null, probe: { object: touch.definition_id, rev: touch.basis === 'exact_revision' ? touch.number : null, path: [] }, filters: touch.basis === 'current_draft' ? { status: 'draft' } : {} }); };
  const touched = (row: Event) => row.touched.map(touch => <Stack gap={2} key={touch.definition_id}><Button className="history-record-link" variant="quiet" size="xs" onClick={() => open(touch)}>{touch.name}{touch.basis === 'exact_revision' ? ` · r${touch.number}` : ' · current item'}</Button><Text size="xs">{touch.basis === 'exact_revision' ? 'Exact retained revision' : `Current draft ${touch.state ?? 'token unavailable'}; earlier content is not retained here`}</Text></Stack>);
  return <Stack gap="sm"><Text size="sm">{filters.source === 'current_drafts' ? 'Current drafts can change or disappear while paging. Refresh to start again.' : 'This is not a complete edit log. Some recorded changes do not retain earlier draft content; frozen revisions keep their exact content.'}</Text>
    <Group className={compact ? "history-filters history-filters-compact" : "history-filters"} align="end" gap="xs"><Select className="history-source" miw={compact ? undefined : 260} comboboxProps={{ withinPortal: false }} label="Evidence source" value={filters.source} data={sources} onChange={value => value && change({ source: value as Source })} /><Select comboboxProps={{ withinPortal: false }} label="Kind" clearable value={filters.kind} data={[...new Set([...kinds, ...rows.flatMap(row => row.touched.map(touch => touch.kind))])].map(kind => ({ value: kind, label: kind.replaceAll('_', ' ') }))} onChange={kind => change({ kind })} /><Select comboboxProps={{ withinPortal: false }} key={readable ? 'readable' : 'hidden'} label="Person" description="People in this readable page" disabled={!readable} clearable value={readable ? filters.actor : null} data={filters.actor && !actors.some(actor => actor.value === filters.actor) ? [...actors, { value: filters.actor, label: 'Selected person' }] : actors} onChange={actor => change({ actor })} /><TextInput label="From date" description="UTC" type="date" value={filters.from} onChange={event => change({ from: event.currentTarget.value })} /><TextInput label="To date" description="UTC" type="date" value={filters.to} onChange={event => change({ to: event.currentTarget.value })} /><Button className="history-clear" variant="quiet" onClick={() => { firstPage(); if (onFilters) onFilters(initial); else setLocal(initial); }}>Clear history filters</Button></Group>
    {query.isError ? <Alert color="red">History unavailable. Retained rows and names are hidden. <Button variant="quiet" onClick={firstPage}>Retry history from first page</Button></Alert> : !readable ? <Text role="status">Rechecking history access…</Text> : <><details><summary>About these records</summary><Text size="sm">{query.data!.hint}</Text></details>{compact ? <Stack gap="xs" role="list" aria-label={definitionId ? 'Record history' : 'Workspace history'}>{rows.map(row => <Card key={row.event_id} withBorder padding="sm" component="article" role="listitem" className="history-entry"><Stack gap={6}>{touched(row)}<Text size="sm">{evidenceLabel[row.evidence]}{row.operation && <Text span size="xs"> · {row.operation.replaceAll('_', ' ').replace('.', ' · ')}</Text>}</Text><Group gap="xs"><Text size="xs" component="time" dateTime={row.at}>{new Date(row.at).toLocaleString()}</Text><Text size="xs">{row.actor.name}</Text></Group></Stack></Card>)}</Stack> : <Table.ScrollContainer minWidth={620}><Table aria-label={definitionId ? 'Record history' : 'Workspace history'}><Table.Thead><Table.Tr><Table.Th>When</Table.Th><Table.Th>Who</Table.Th><Table.Th>Evidence</Table.Th><Table.Th>Touched records</Table.Th></Table.Tr></Table.Thead><Table.Tbody>{rows.map(row => <Table.Tr key={row.event_id}><Table.Td>{new Date(row.at).toLocaleString()}</Table.Td><Table.Td>{row.actor.name}</Table.Td><Table.Td>{evidenceLabel[row.evidence]}<Text size="xs">{row.operation?.replaceAll('_', ' ').replace('.', ' · ')}</Text></Table.Td><Table.Td>{touched(row)}</Table.Td></Table.Tr>)}</Table.Tbody></Table></Table.ScrollContainer>}{rows.length === 0 && <Text>No readable history entries on this page.</Text>}{query.data!.scan_limit_reached && <Text size="xs">This bounded scan ended. Continue to inspect more readable evidence.</Text>}</>}
    <Group gap="xs"><Button variant="quiet" disabled={positions.length === 1 || query.isFetching} onClick={() => setPaging(current => ({ key: filterKey, positions: positions.slice(0, -1), generation: current.generation }))}>Previous history page</Button><Button variant="quiet" disabled={!readable || !query.data?.next_after} onClick={() => setPaging(current => ({ key: filterKey, positions: [...positions, query.data!.next_after], generation: current.generation }))}>Next history page</Button><Button variant="quiet" onClick={firstPage}>Refresh history</Button></Group>
  </Stack>;
}
