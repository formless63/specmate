import { Alert, Button, Group, Select, Stack, Text } from '@mantine/core';
import { useEffect, useRef, useState } from 'react';
import type { Definition, Identity } from '../identity/api';
import { requestJson } from './api';

export function RevisionChoice({ label, kinds, definitions, value, onChange, onDenied, disabled }: { label: string; kinds: string[]; definitions: Definition[]; value: string | null; onChange: (id: string | null) => void; onDenied: (error: unknown) => void; disabled?: boolean }) {
  const [definition, setDefinition] = useState<string | null>(null), [offset, setOffset] = useState(0);
  const [identity, setIdentity] = useState<Identity | null>(null), [error, setError] = useState<string | null>(null), [busy, setBusy] = useState(false);
  const scope = useRef(0);
  async function load(id: string, start: number) {
    const current = ++scope.current; setIdentity(null); setBusy(true); setError(null);
    try { const result = await requestJson<Identity>(`/api/v0/catalog/definitions/${id}?offset=${start}`); if (scope.current === current) { if (!kinds.includes(result.kind)) throw new Error('Frozen choice kind mismatch.'); setIdentity(result); } }
    catch (e) { if (scope.current === current) { setError(e instanceof Error ? e.message : 'Frozen choice unavailable.'); onDenied(e); } }
    finally { if (scope.current === current) setBusy(false); }
  }
  useEffect(() => () => { scope.current += 1; }, []);
  const available = identity?.revisions.some(r => r.revision_id === value);
  return <Stack gap="xs"><Select label={`${label} definition`} searchable disabled={disabled || busy} data={definitions.filter(d => kinds.includes(d.kind)).map(d => ({ value: d.definition_id, label: `${d.name} (${d.kind})` }))} value={definition} onChange={id => { scope.current += 1; setDefinition(id); setOffset(0); setIdentity(null); onChange(null); if (id) void load(id, 0); }} />
    <Select label={`${label} revision`} disabled={disabled || busy || !identity} clearable data={(identity?.revisions ?? []).map(r => ({ value: r.revision_id, label: `Revision ${r.number} · ${r.revision_id}` }))} value={available ? value : null} onChange={onChange} />
    {value && !available && <Text size="sm">Retained exact pin: {value}. Refresh its owning definition to browse; labels are not inferred.</Text>}
    {error && <Alert color="red">{error}</Alert>}
    {definition && <Group><Button size="xs" disabled={disabled || busy} onClick={() => void load(definition, offset)}>Refresh {label.toLowerCase()} choices</Button><Button size="xs" disabled={disabled || busy || offset === 0} onClick={() => { const next = Math.max(0, offset - 50); setOffset(next); void load(definition, next); }}>Previous {label.toLowerCase()} revisions</Button><Button size="xs" disabled={disabled || busy || (identity?.revisions.length ?? 0) < 50} onClick={() => { setOffset(offset + 50); void load(definition, offset + 50); }}>Next {label.toLowerCase()} revisions</Button></Group>}
  </Stack>;
}
