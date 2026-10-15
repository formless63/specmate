import { Alert, Button, Group, Select, Stack, TextInput } from '@mantine/core';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { read, type Definition, type Identity } from './api';
import { revisionOptionLabel, newestFirst } from "../../lib/revision-labels";
import { useLatestRevisionDefault } from '../../lib/useLatestRevisionDefault';

export function RevisionPicker({ label, kind, value, onChange, definitions }: { label: string; kind: string; value: string; onChange: (v: string) => void; definitions: Definition[] }) {
  const [definition, setDefinition] = useState<string | null>(null);
  const [offset, setOffset] = useState(0);
  const identity = useQuery({ queryKey: ["harness-reference", definition, offset], queryFn: () => read<Identity>(`catalog/definitions/${definition}?offset=${offset}`), enabled: !!definition });
  useLatestRevisionDefault(definition, identity.isError ? undefined : identity.data, offset === 0 && (identity.data?.revisions.length ?? 50) < 50, value, onChange);
  const current = !identity.isError && definitions.some(d => d.definition_id === definition) ? identity.data : undefined;
  return <Stack gap="xs"><Select label={`${label} definition`} searchable value={definitions.some(d => d.definition_id === definition) ? definition : null} data={definitions.filter((d) => d.kind === kind).map((d) => ({ value: d.definition_id, label: d.name }))} onChange={(v) => { setDefinition(v); setOffset(0); }} /><Select label={`${label} revision`} value={current ? value || null : null} disabled={!current} onChange={(v) => onChange(v ?? "")} data={newestFirst(current?.revisions ?? []).map((r) => ({ value: r.revision_id, label: revisionOptionLabel(current?.name, r.number) }))} />{current && <Group><Button disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - 50))}>Earlier {label} revisions</Button><Button disabled={current.revisions.length < 50} onClick={() => setOffset(offset + 50)}>Later {label} revisions</Button></Group>}<TextInput label={`${label} exact revision ID`} description="An accessible revision from another project can also be supplied." value={value} onChange={(e) => onChange(e.currentTarget.value)} />{identity.isError && <Alert color="red">{identity.error.message}</Alert>}</Stack>;
}
