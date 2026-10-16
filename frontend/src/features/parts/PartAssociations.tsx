import { Alert, Button, Group, Select, Stack, Table, Text, Textarea, TextInput } from '@mantine/core';
import { useRef, useState } from 'react';
import { ReadOnlyNote, usePermission } from '../../lib/permissions';
import { randomUUID } from '../../lib/random-id';
import { RepresentationsCard } from '../identity/RepresentationsCard';
import type { Catalog } from '../identity/api';
import { canonical, command } from './api';

/** Additive associations use the existing catalog operation layer; no second identity system. */
export function PartAssociations({ revisionId, workspaceId, principalKey, active, catalog, refresh, onFailure }: { revisionId: string; workspaceId: string; principalKey: string; active: boolean; catalog: Catalog | undefined; refresh: () => void; onFailure: (failure: unknown) => void }) {
  const gate = usePermission('item.create');
  const [manufacturer, setManufacturer] = useState(''), [number, setNumber] = useState(''), [basis, setBasis] = useState(''), [lot, setLot] = useState(''), [variant, setVariant] = useState<string | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const keys = useRef(new Map<string, string>()), context = useRef(''); context.current = `${active}:${principalKey}:${workspaceId}:${revisionId}`;
  async function register(kind: string, fields: object) {
    if (!active || !catalog || busy || !gate.allowed) return;
    const selected = context.current, operation = `catalog.register_${kind}`, payload = { revision_id: revisionId, ...fields }, fingerprint = canonical([operation, payload]);
    let key = keys.current.get(fingerprint); if (!key) { key = randomUUID(); keys.current.set(fingerprint, key); }
    setBusy(true); setError('');
    try { await command(operation, payload, undefined, key); if (context.current === selected) { setNotice('Catalog association registered.'); refresh(); } }
    catch (failure) { if (context.current === selected) { setError(failure instanceof Error ? failure.message : 'Registration failed.'); onFailure(failure); } }
    finally { setBusy(false); }
  }
  return <Stack>{error && <Alert color="red">{error}</Alert>}{notice && <Text role="status">{notice}</Text>}<ReadOnlyNote permission="item.create">Catalog registration is unavailable.</ReadOnlyNote>
    <Text fw={600}>Manufacturer variants</Text><div className="sb-ws-scroll"><Table><Table.Thead><Table.Tr><Table.Th>Manufacturer</Table.Th><Table.Th>MPN</Table.Th><Table.Th>Association basis</Table.Th></Table.Tr></Table.Thead><Table.Tbody>{catalog?.variants.map(row => <Table.Tr key={row.variant_id}><Table.Td>{row.manufacturer}</Table.Td><Table.Td>{row.part_number}</Table.Td><Table.Td>{row.association_basis}</Table.Td></Table.Tr>)}</Table.Tbody></Table></div>
    {gate.allowed && <><TextInput label="Manufacturer" value={manufacturer} onChange={event => setManufacturer(event.currentTarget.value)} /><TextInput label="Manufacturer part number" value={number} onChange={event => setNumber(event.currentTarget.value)} /><Textarea label="Manufacturer association basis" value={basis} onChange={event => setBasis(event.currentTarget.value)} /><Button disabled={!active || !catalog || !manufacturer.trim() || !number.trim() || !basis.trim()} loading={busy} onClick={() => void register('variant', { manufacturer, part_number: number, association_basis: basis })}>Register manufacturer variant</Button></>}
    <Text fw={600}>Physical lots</Text><Text size="sm">Lot registration identifies a batch; it does not receive or reserve inventory.</Text>{catalog?.lots.map(row => <Text key={row.lot_id}>{row.label} · {row.variant_id ?? 'Manufacturer variant unknown'}</Text>)}
    {gate.allowed && <><TextInput label="Lot label" value={lot} onChange={event => setLot(event.currentTarget.value)} /><Select label="Lot manufacturer variant" clearable value={variant} data={(catalog?.variants ?? []).map(row => ({ value: row.variant_id, label: `${row.manufacturer} / ${row.part_number}` }))} onChange={setVariant} /><Button disabled={!active || !catalog || !lot.trim()} loading={busy} onClick={() => void register('lot', { label: lot, variant_id: variant })}>Register lot identity</Button></>}
    <RepresentationsCard catalog={catalog} workspaceId={workspaceId} scopeKey={`${principalKey}:${workspaceId}`} active={active} pending={busy || !catalog} register={(operation, fields) => void register(operation, fields)} />
    <Group><Text size="xs">Exact revision {revisionId}</Text></Group>
  </Stack>;
}
