import { Alert, Button, Card, NativeSelect, Stack, Table, Text, TextInput, Title } from '@mantine/core';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { command as sourceCommand } from '../sources/api';
import type { Assembly, Draft, OccurrenceRef, Placement, Relationship } from './api';
import { RevisionLabel } from "../../lib/IdentityLabel";

export type PlacementInputs = { draft_id: string; state: string; occurrences: { path: string[]; revision_id: string; snapshot_sha256: string; name: string; kind: string; display_ref: string; placement: Placement; feature_existence: 'not_evaluated' }[] };
function refLabel(ref: OccurrenceRef) { return `${ref.path.join('/') || 'Root'}${ref.feature_id ? ` / unverified feature ${ref.feature_id}` : ' / whole occurrence'}`; }
export function MountingDetails({ relationships }: { relationships: (Relationship & { context_path?: string[] })[] }) {
  return <Table><Table.Thead><Table.Tr><Table.Th>Mounting declaration</Table.Th><Table.Th>Mounted occurrence</Table.Th><Table.Th>Support occurrence</Table.Th><Table.Th>Engineering status</Table.Th></Table.Tr></Table.Thead><Table.Tbody>
    {relationships.filter(row => row.kind === 'mounting').map(row => <Table.Tr key={`${JSON.stringify(row.context_path ?? [])}:${row.local_id}`}><Table.Td>{row.context_path?.join("/") || "Root"} / {row.local_id}</Table.Td><Table.Td>{refLabel({ ...(row.mounted as OccurrenceRef), path: [...(row.context_path ?? []), ...(row.mounted as OccurrenceRef).path] })}</Table.Td><Table.Td>{refLabel({ ...(row.support as OccurrenceRef), path: [...(row.context_path ?? []), ...(row.support as OccurrenceRef).path] })}</Table.Td><Table.Td>Feature existence/correspondence, fit and clearance: not evaluated</Table.Td></Table.Tr>)}
  </Table.Tbody></Table>;
}
export function MountingEditor({ draft, busy, onSave, onDenied, authorized = true }: { draft: Draft; busy: boolean; onSave: (assembly: Assembly) => void; onDenied: (error: Error) => void; authorized?: boolean }) {
  const [localId, setLocalId] = useState('');
  const [mounted, setMounted] = useState('');
  const [support, setSupport] = useState('');
  const [mountedFeature, setMountedFeature] = useState('');
  const [supportFeature, setSupportFeature] = useState('');
  const choices = useQuery({ queryKey: ['assembly-placement-inputs', draft.draft_id, draft.state], queryFn: () => sourceCommand<PlacementInputs>('assembly.placement_inputs', { draft_id: draft.draft_id }, { idempotent: false }), retry: false, enabled: authorized });
  useEffect(() => { if (choices.error) onDenied(choices.error); }, [choices.error]);
  const inputs = authorized && !choices.isError && !choices.isFetching ? choices.data : null;
  const options = [{ value: '', label: 'Select exact occurrence' }, { value: '[]', label: 'Root containing assembly' }, ...(inputs?.occurrences ?? []).map(row => ({ value: JSON.stringify(row.path), label: `${row.path.join('/')} · ${row.display_ref || row.name} (${row.kind})` }))];
  function save() {
    if (!inputs || inputs.state !== draft.state) return;
    const ref = (path: string, feature: string): OccurrenceRef => ({ kind: 'occurrence', path: JSON.parse(path) as string[], feature_id: feature.trim() || null });
    onSave({ ...draft.content.assembly, relationships: [...draft.content.assembly.relationships, { kind: 'mounting', local_id: localId, mounted: ref(mounted, mountedFeature), support: ref(support, supportFeature) }] });
  }
  if (!authorized) return null;
  return <Card withBorder><Stack>
    <Title order={3}>Canonical mounting declarations</Title>
    <MountingDetails relationships={draft.content.assembly.relationships} />
    <Button disabled={choices.isFetching} onClick={() => { void choices.refetch(); }}>Refresh mounting choices</Button>
    {choices.error && <Alert color="red">{choices.error.message}</Alert>}
    {inputs && inputs.state !== draft.state && <Alert color="yellow">The saved assembly changed. Load its latest draft before authoring new mounting declarations.</Alert>}
    <NativeSelect label="Mounted contextual occurrence" value={mounted} data={options} onChange={event => setMounted(event.currentTarget.value)} />
    <NativeSelect label="Supporting contextual occurrence" value={support} data={options} onChange={event => setSupport(event.currentTarget.value)} />
    <TextInput label="Mounting declaration local ID" value={localId} onChange={event => setLocalId(event.currentTarget.value)} />
    <TextInput label="Mounted unverified stable feature ID (optional)" value={mountedFeature} onChange={event => setMountedFeature(event.currentTarget.value)} />
    <TextInput label="Support unverified stable feature ID (optional)" value={supportFeature} onChange={event => setSupportFeature(event.currentTarget.value)} />
    <Text>Feature identifiers are declarations tied to these exact occurrence paths and frozen revisions. Their existence and correspondence remain unknown here. No solver, placement inference, fit, clearance or physical approval is performed.</Text>
    {inputs && <Table><Table.Thead><Table.Tr><Table.Th>Exact context</Table.Th><Table.Th>Revision</Table.Th><Table.Th>Snapshot</Table.Th><Table.Th>Canonical placement in containing frame</Table.Th></Table.Tr></Table.Thead><Table.Tbody>
      {inputs.occurrences.map(row => <Table.Tr key={JSON.stringify(row.path)}><Table.Td>{row.path.join('/')}</Table.Td><Table.Td><RevisionLabel id={row.revision_id} /></Table.Td><Table.Td>{row.snapshot_sha256}</Table.Td><Table.Td>{row.placement.status === 'unknown' ? 'Unknown' : `${row.placement.translation?.join(', ')} mm; quaternion ${row.placement.rotation_xyzw?.join(', ')}`}</Table.Td></Table.Tr>)}
    </Table.Tbody></Table>}
    <Button disabled={busy || !mounted || !support || !localId || !inputs || inputs.state !== draft.state} onClick={save}>Add mounting declaration</Button>
  </Stack></Card>;
}
