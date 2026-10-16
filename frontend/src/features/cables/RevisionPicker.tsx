import { DefinitionPickerScope, DefinitionSelect } from '../../components/library/DefinitionSelect';
import { Alert, Anchor, Button, Group, Select, Stack, TextInput } from '@mantine/core';
import { useQuery } from '@tanstack/react-query';
import { useContext, useEffect, useRef, useState } from 'react';
import { revisionOptionLabel, useRevisionLabel as useLabel, newestFirst } from "../../lib/revision-labels";
import { type Definition, type Identity } from './api';
import { ApiError, requestJson } from '../workspace/api';

/**
 * Picks one exact revision by name: a searchable definition select, then a revision select that
 * defaults to the latest frozen revision (older ones stay selectable). Pasting an exact revision
 * ID, including one from another project, is kept behind an Advanced disclosure.
 */
export function RevisionPicker({ label, title, kind, value, onChange, definitions, nameFilter, error, onAccessDenied }: { onAccessDenied?: (definitionId: string) => void; error?: string; label: string; title?: string; kind: string; value: string; onChange: (v: string) => void; definitions?: Definition[]; nameFilter?: string | null }) {
  const scope = useContext(DefinitionPickerScope), deniedCallback = useRef(onAccessDenied); deniedCallback.current = onAccessDenied;
  const [chosen, setChosen] = useState<string | null>(null);
  const [offset, setOffset] = useState(0);
  const [advanced, setAdvanced] = useState(false);
  const autoPick = useRef<string | null>(null);
  // A value that arrives pinned (a saved draft, a pasted ID) names its own definition.
  const known = useLabel(value || null, scope.active).data;
  const definition = chosen ?? (known?.readable ? known.definition_id ?? null : null);
  const identity = useQuery({ queryKey: ["cable-reference", definition, offset, scope.key], queryFn: ({ signal }) => requestJson<Identity>(`/api/v0/catalog/definitions/${definition}?offset=${offset}`, { signal, cache: 'no-store' }), enabled: scope.active && !!definition, retry: false });
  useEffect(() => { if (scope.active && definition && identity.error instanceof ApiError && [401, 403, 404].includes(identity.error.status)) deniedCallback.current?.(definition); }, [scope.active, definition, identity.error]);
  const available = scope.active && !identity.isFetching && !identity.isError ? identity.data : undefined;
  const revisions = available?.revisions ?? [];
  const single = offset === 0 && revisions.length < 50;
  // Choosing a definition selects its latest frozen revision once; the user may then pick an older one.
  useEffect(() => {
    if (!chosen || autoPick.current !== chosen || available?.definition_id !== chosen) return;
    autoPick.current = null;
    const latest = single ? available.revisions[available.revisions.length - 1] : undefined;
    if (latest) onChange(latest.revision_id);
  }, [chosen, available, single, onChange]);
  const latestId = single ? revisions[revisions.length - 1]?.revision_id : undefined;
  return <Stack gap="xs">
    <Group align="flex-start" gap="xs" grow wrap="wrap">
      <DefinitionSelect label={title ?? `${label} definition`} ariaLabel={`${label} definition`} kind={kind} definitions={definitions} nameFilter={nameFilter} value={definition} onChange={(v) => { setChosen(v); setOffset(0); autoPick.current = v; if (v !== definition) onChange(""); }} />
      <Select label={title ? 'Revision' : `${label} revision`} aria-label={`${label} revision`} value={identity.isError ? null : revisions.some(r => r.revision_id === value) ? value : null} disabled={!scope.active || identity.isError || identity.isFetching || !definition} error={error} onChange={(v) => onChange(v ?? "")}
        data={newestFirst(revisions).map((r) => ({ value: r.revision_id, label: revisionOptionLabel(identity.data?.name, r.number, r.revision_id === latestId ? 'latest' : undefined) }))} />
    </Group>
    {available && (offset > 0 || revisions.length >= 50) && <Group><Button size="xs" variant="subtle" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - 50))}>Earlier {label} revisions</Button><Button size="xs" variant="subtle" disabled={revisions.length < 50} onClick={() => setOffset(offset + 50)}>Later {label} revisions</Button></Group>}
    {identity.isError && <Alert color="red">{identity.error.message}</Alert>}
    <Anchor component="button" type="button" size="xs" w="fit-content" aria-label={`Advanced: paste exact revision ID for ${label}`} aria-expanded={advanced || !!error} onClick={() => setAdvanced(open => !open)}>{advanced || error ? '▾' : '▸'} Advanced: paste exact revision ID</Anchor>
    {(advanced || !!error) && <TextInput label={`${label} exact revision ID`} error={error} description="An accessible revision from another project can also be supplied." value={value} onChange={(e) => onChange(e.currentTarget.value)} />}
  </Stack>;
}

