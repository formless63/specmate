import { Alert, Button, Group, Select, Stack, TextInput } from '@mantine/core';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { read, type Definition, type Identity } from './api';

export function RevisionPicker({ label, kind, value, onChange, definitions }: { label: string; kind: string; value: string; onChange: (v: string) => void; definitions: Definition[] }) {
  const [definition, setDefinition] = useState<string | null>(null);
  const [offset, setOffset] = useState(0);
  const identity = useQuery({ queryKey: ["harness-reference", definition, offset], queryFn: () => read<Identity>(`catalog/definitions/${definition}?offset=${offset}`), enabled: !!definition });
  const current = !identity.isError && definitions.some(d => d.definition_id === definition) ? identity.data : undefined;
  return <Stack gap="xs"><Select label={`${label} definition`} searchable value={definitions.some(d => d.definition_id === definition) ? definition : null} data={definitions.filter((d) => d.kind === kind).map((d) => ({ value: d.definition_id, label: d.name }))} onChange={(v) => { setDefinition(v); setOffset(0); }} /><Select label={`${label} revision`} value={current ? value || null : null} disabled={!current} onChange={(v) => onChange(v ?? "")} data={(current?.revisions ?? []).map((r) => ({ value: r.revision_id, label: `Revision ${r.number} · ${r.revision_id}` }))} />{current && <Group><Button disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - 50))}>Earlier {label} revisions</Button><Button disabled={current.revisions.length < 50} onClick={() => setOffset(offset + 50)}>Later {label} revisions</Button></Group>}<TextInput label={`${label} exact revision ID`} description="An accessible revision from another project can also be supplied." value={value} onChange={(e) => onChange(e.currentTarget.value)} />{identity.isError && <Alert color="red">{identity.error.message}</Alert>}</Stack>;
}
