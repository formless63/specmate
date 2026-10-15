import { Alert, Button, Group, Select, Stack, TextInput } from '@mantine/core';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { read, type Definition, type Identity } from './api';
import { revisionOptionLabel, newestFirst } from "../../lib/revision-labels";
import { useLatestRevisionDefault } from '../../lib/useLatestRevisionDefault';

export function RevisionChoice({ label, kinds, value, onChange, definitions }: { label: string; kinds: string[]; value: string; onChange: (v: string) => void; definitions: Definition[] }) {
  const [definition, setDefinition] = useState<string | null>(null);
  const [offset, setOffset] = useState(0);
  const result = useQuery({ queryKey: ['preparation-reference', definition, offset], queryFn: () => read<Identity>(`catalog/definitions/${definition}?offset=${offset}`), enabled: !!definition });
  useLatestRevisionDefault(definition, result.isError ? undefined : result.data, offset === 0 && (result.data?.revisions.length ?? 50) < 50, value, onChange);
  return <Stack gap="xs"><Select label={`${label} definition`} searchable data={definitions.filter(d => kinds.includes(d.kind)).map(d => ({ value: d.definition_id, label: d.name }))} value={definition} onChange={id => { setDefinition(id); setOffset(0); }} />
    <Select label={`${label} revision`} value={result.isError ? null : value || null} disabled={result.isError} data={newestFirst(result.isError ? [] : result.data?.revisions ?? []).map((r) => ({ value: r.revision_id, label: revisionOptionLabel(result.data?.name, r.number) }))} onChange={id => onChange(id ?? '')} />
    <TextInput label={`${label} exact revision ID`} value={value} onChange={e => onChange(e.currentTarget.value)} />
    {result.data && !result.isError && <Group><Button disabled={!offset} onClick={() => setOffset(Math.max(0, offset - 50))}>Earlier {label} revisions</Button><Button disabled={result.data.revisions.length < 50} onClick={() => setOffset(offset + 50)}>Later {label} revisions</Button></Group>}
    {result.isError && <Alert color="red">{result.error.message}</Alert>}
  </Stack>;
}
