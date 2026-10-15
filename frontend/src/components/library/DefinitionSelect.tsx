import { Alert, Button, Group, Select, Stack } from '@mantine/core';
import { useDebouncedValue } from '@mantine/hooks';
import { useQuery } from '@tanstack/react-query';
import { createContext, useContext, useState } from 'react';
import { listLibraryTable } from '../../features/library-gallery/table-api';
import type { Definition } from '../../features/identity/api';

export const DefinitionPickerScope = createContext({ key: 'standalone', active: true });

/** Source choices are metadata-only, bounded pages, fetched only while the picker is open. */
export function DefinitionSelect({ label, kind, value, onChange, definitions, placeholder = 'Search by name', nameFilter }: {
  label: string; kind: string; value: string | null; onChange: (id: string | null) => void;
  definitions?: Definition[]; placeholder?: string; nameFilter?: string | null;
}) {
  const scope = useContext(DefinitionPickerScope);
  const [open, setOpen] = useState(false), [search, setSearch] = useState('');
  const [query] = useDebouncedValue(search, 200);
  const [after, setAfter] = useState<string | null>(null), [previous, setPrevious] = useState<(string | null)[]>([]);
  const [picked, setPicked] = useState<{ value: string; label: string } | null>(null);
  const page = useQuery({ queryKey: ['definition-picker', scope.key, kind, query, after], enabled: !definitions && open && scope.active, retry: false,
    queryFn: () => listLibraryTable({ kinds: [kind], query: query || nameFilter || '', projectFilterId: null, after }) });
  const choices = definitions ? definitions.filter(row => row.kind === kind && (!nameFilter || row.name.toLowerCase().includes(nameFilter.toLowerCase()))).map(row => ({ value: row.definition_id, label: row.name }))
    : page.isError || page.isFetching || !scope.active ? [] : (page.data?.results ?? []).map(row => ({ value: row.record_id, label: row.label }));
  const options = picked && !page.isError && !page.isFetching && scope.active && !choices.some(row => row.value === picked.value) ? [picked, ...choices] : choices;
  return <Stack gap={4}><Select dropdownOpened={open && scope.active} label={label} searchValue={search} searchable placeholder={placeholder} value={value} data={options} filter={definitions ? undefined : ({ options }) => options}
    onDropdownOpen={() => setOpen(true)} onDropdownClose={() => setOpen(false)}
    onSearchChange={text => { setSearch(text); setAfter(null); setPrevious([]); }}
    onChange={id => { setPicked(options.find(row => row.value === id) ?? null); onChange(id); }}
    nothingFoundMessage={page.isFetching ? 'Loading…' : 'No match'} />
    {scope.active && !definitions && (open || page.data) && <Group gap={4}><Button size="compact-xs" variant="quiet" disabled={!previous.length || page.isFetching} onClick={() => { setOpen(true); setAfter(previous.at(-1) ?? null); setPrevious(previous.slice(0, -1)); }}>Previous choices</Button><Button size="compact-xs" variant="quiet" disabled={!page.data?.next_after || page.isFetching || page.isError} onClick={() => { setOpen(true); setPrevious([...previous, after]); setAfter(page.data!.next_after); }}>More choices</Button></Group>}
    {open && page.isError && <Alert color="red">{page.error.message}</Alert>}
  </Stack>;
}
