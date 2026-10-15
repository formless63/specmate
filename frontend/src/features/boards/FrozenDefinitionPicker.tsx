import { Alert, Button, Group, Select, Stack, TextInput } from '@mantine/core';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { listLibraryTable } from '../library-gallery/table-api';
import { requestJson } from '../workspace/api';
import type { Identity } from '../identity/api';

export type FrozenChoice = { revision_id: string; number: number; definition_id: string; name: string; kind: string };
/** One bounded metadata page and one selected definition's history, never a read per row. */
export function FrozenDefinitionPicker({ label, kinds, principalKey, active, onPick }: {
  label: string; kinds: string[]; principalKey: string; active: boolean; onPick: (choice: FrozenChoice) => void;
}) {
  const [query, setQuery] = useState(''); const [after, setAfter] = useState<string | null>(null);
  const [definition, setDefinition] = useState<FrozenChoice | null>(null); const [offset, setOffset] = useState(0);
  const rows = useQuery({ queryKey: ['board-picker', principalKey, kinds, query, after], enabled: active, retry: false,
    queryFn: () => listLibraryTable({ kinds, query, after, projectFilterId: null }) });
  const history = useQuery({ queryKey: ['board-picker-history', principalKey, definition?.definition_id, offset], enabled: active && !!definition, retry: false,
    queryFn: ({ signal }) => requestJson<Identity>(`/api/v0/catalog/definitions/${definition!.definition_id}?offset=${offset}&limit=50`, { signal }) });
  const available = rows.isError || rows.isFetching ? [] : rows.data?.results.filter(row => row.latest_revision_id && row.latest_revision !== null) ?? [];
  const revisionRows = history.isError || history.isFetching ? [] : [...new Map([...(definition ? [{ revision_id: definition.revision_id, number: definition.number }] : []), ...(history.data?.revisions ?? [])].map(row => [row.revision_id, row])).values()].sort((a, b) => b.number - a.number);
  return <Stack gap="xs"><TextInput size="xs" label={`Search ${label}`} value={query} onChange={event => { setQuery(event.currentTarget.value); setAfter(null); }} />
    {(rows.isError || history.isError) && <Alert color="yellow">Selection metadata unavailable. No retained choices are offered.</Alert>}
    <Select size="xs" label={label} placeholder="Choose a frozen definition" value={rows.isError ? null : definition?.definition_id ?? null}
      data={available.map(row => ({ value: row.record_id, label: row.label }))} onChange={id => {
        const row = available.find(item => item.record_id === id); if (!row?.latest_revision_id || row.latest_revision === null || !row.kind) return;
        const choice = { revision_id: row.latest_revision_id, number: row.latest_revision, definition_id: row.record_id, name: row.label, kind: row.kind };
        setDefinition(choice); setOffset(0); onPick(choice);
      }} />
    <Group gap="xs"><Button size="xs" variant="quiet" disabled={!after} onClick={() => setAfter(null)}>First choices</Button><Button size="xs" variant="quiet" disabled={rows.isError || !rows.data?.next_after} onClick={() => setAfter(rows.data!.next_after)}>More choices</Button></Group>
    {definition && <><Select size="xs" label={`Exact ${label} revision`} value={history.isError ? null : definition.revision_id} data={revisionRows.map(row => ({ value: row.revision_id, label: `${definition.name} · r${row.number}` }))} onChange={id => {
      const row = revisionRows.find(item => item.revision_id === id); if (!row) return; const choice = { ...definition, ...row }; setDefinition(choice); onPick(choice);
    }} /><Group gap="xs"><Button size="xs" variant="quiet" disabled={!offset} onClick={() => setOffset(value => Math.max(0, value - 50))}>Earlier revisions</Button><Button size="xs" variant="quiet" disabled={history.isError || (history.data?.revisions.length ?? 0) < 50} onClick={() => setOffset(value => value + 50)}>Later revisions</Button></Group></>}
  </Stack>;
}
