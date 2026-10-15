import { Alert, Button, Group, Select, Stack, TextInput } from '@mantine/core';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { listLibraryTable } from '../library-gallery/table-api';
import { requestJson } from '../workspace/api';
import type { Identity } from '../identity/api';

type Editor = { current: { definition_id: string; draft_id: string } | null; name: string; busy: boolean; frozenId: string | null;
  load: (id: string, label: string) => Promise<void>; inspect: (id: string) => void; failAuthority: (error: unknown) => void };
export function ContextRecordChoices({ kind, label, active, principalKey, scopeKey, editor }: { kind: string; label: string; active: boolean; principalKey: string; scopeKey: string; editor: Editor }) {
  const [query, setQuery] = useState(''); const [after, setAfter] = useState<string | null>(null); const [chosen, setChosen] = useState<{ id: string; name: string } | null>(null); const [offset, setOffset] = useState(0); const [draft, setDraft] = useState<string | null>(null);
  const definition = chosen?.id ?? editor.current?.definition_id; const name = chosen?.name ?? editor.name;
  const rows = useQuery({ queryKey: ['context-record-choices', principalKey, scopeKey, kind, query, after], enabled: active, retry: false, queryFn: () => listLibraryTable({ kinds: [kind], query, after, projectFilterId: null }) });
  const history = useQuery({ queryKey: ['context-record-history', principalKey, scopeKey, kind, definition, offset], enabled: active && !!definition, retry: false,
    queryFn: ({ signal }) => requestJson<Identity>(`/api/v0/catalog/definitions/${definition}?offset=${offset}&limit=50`, { signal }) });
  useEffect(() => { if (rows.isError) editor.failAuthority(rows.error); if (history.isError) editor.failAuthority(history.error); }, [rows.isError, history.isError, rows.error, history.error, editor.failAuthority]);
  const records = rows.isError || rows.isFetching ? [] : rows.data?.results ?? [];
  return <Stack gap="xs"><TextInput size="xs" label={`Search saved ${label}`} value={query} disabled={editor.busy} onChange={event => { setQuery(event.currentTarget.value); setAfter(null); }} />
    {(rows.isError || history.isError) && <Alert color="yellow">Saved record choices unavailable. Retained choices are hidden.</Alert>}
    <Select size="xs" label={`Saved ${label} definition`} value={rows.isError ? null : definition ?? null} disabled={editor.busy} data={records.map(row => ({ value: row.record_id, label: row.label }))} onChange={id => { const row = records.find(item => item.record_id === id); if (row) { setChosen({ id: row.record_id, name: row.label }); setOffset(0); setDraft(null); } }} />
    <Group gap="xs"><Button size="xs" variant="quiet" disabled={editor.busy || !after} onClick={() => setAfter(null)}>First saved records</Button><Button size="xs" variant="quiet" disabled={editor.busy || rows.isError || !rows.data?.next_after} onClick={() => setAfter(rows.data!.next_after)}>More saved records</Button></Group>
    {history.data && !history.isError && !history.isFetching && <><Select size="xs" label={`Saved ${label} draft`} value={draft} disabled={editor.busy} data={history.data.drafts.map(row => ({ value: row.draft_id, label: `${row.state} · ${row.draft_id.slice(0, 8)}` }))} onChange={setDraft} />
      <Button size="xs" variant="quiet" disabled={editor.busy || !draft} onClick={() => draft && void editor.load(draft, name)}>Load selected draft (replace local edits)</Button>
      <Select size="xs" label={`Frozen ${label} revision`} value={editor.frozenId} disabled={editor.busy} data={[...history.data.revisions].sort((a, b) => b.number - a.number).map(row => ({ value: row.revision_id, label: `${name} · r${row.number}` }))} onChange={id => id && editor.inspect(id)} />
      <Group gap="xs"><Button size="xs" variant="quiet" disabled={editor.busy || !offset} onClick={() => setOffset(value => Math.max(0, value - 50))}>Earlier saved history</Button><Button size="xs" variant="quiet" disabled={editor.busy || Math.max(history.data.drafts.length, history.data.revisions.length) < 50} onClick={() => setOffset(value => value + 50)}>Later saved history</Button></Group>
    </>}
  </Stack>;
}
