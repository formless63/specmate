import { Alert, Button, Group, Select, Stack, TextInput } from '@mantine/core';
import { useQuery } from '@tanstack/react-query';
import { authorityDenied, read, type Definition, type Identity } from './api';
import { revisionOptionLabel, newestFirst } from "../../lib/revision-labels";
import { useLatestRevisionDefault } from '../../lib/useLatestRevisionDefault';

export type ReferenceSelection = { definition: string | null; offset: number };
export type ReferenceSelections = Record<string, ReferenceSelection>;
export const referenceKey = (selection: ReferenceSelection, generation: number) => ['material-reference', selection.definition, selection.offset, generation];

export function ReferenceChoice({ label, kinds, value, onChange, definitions, selection, onSelection, generation, onDenied }: {
  label: string; kinds: string[]; value: string; onChange: (id: string) => void; definitions: Definition[];
  selection: ReferenceSelection; onSelection: (selection: ReferenceSelection) => void; generation: number; onDenied: () => void;
}) {
  const result = useQuery({ queryKey: referenceKey(selection, generation), queryFn: async () => {
    // This callback belongs to the genuine editor generation that started the read.
    try { return await read<Identity>(`catalog/definitions/${selection.definition}?offset=${selection.offset}`); }
    catch (error) { if (authorityDenied(error)) onDenied(); throw error; }
  }, enabled: !!selection.definition });
  const available = !result.isError && !result.isFetching;
  useLatestRevisionDefault(selection.definition, available ? result.data : undefined, selection.offset === 0 && (result.data?.revisions.length ?? 50) < 50, value, onChange);
  return <Stack gap="xs"><Select label={`${label} definition`} searchable data={definitions.filter(d => kinds.includes(d.kind)).map(d => ({ value: d.definition_id, label: d.name }))} value={selection.definition} onChange={definition => onSelection({ definition, offset: 0 })} />
    <Select label={`${label} revision`} value={available ? value || null : null} disabled={!available} data={newestFirst(available ? result.data?.revisions ?? [] : []).map((r) => ({ value: r.revision_id, label: revisionOptionLabel(result.data?.name, r.number) }))} onChange={id => onChange(id ?? '')} />
    <TextInput label={`${label} exact revision ID`} value={value} onChange={e => onChange(e.currentTarget.value)} />
    {result.data && available && <Group><Button disabled={!selection.offset} onClick={() => onSelection({ ...selection, offset: Math.max(0, selection.offset - 50) })}>Earlier {label} revisions</Button><Button disabled={result.data.revisions.length < 50} onClick={() => onSelection({ ...selection, offset: selection.offset + 50 })}>Later {label} revisions</Button></Group>}
    {result.isError && <Alert color="red">{result.error.message}</Alert>}
  </Stack>;
}
