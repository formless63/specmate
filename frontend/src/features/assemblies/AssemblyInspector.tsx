import { Alert, Button, Card, Checkbox, Group, Stack, Table, Tabs, Text, TextInput, Title } from '@mantine/core';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { RevisionLabel } from '../../lib/IdentityLabel';
import { MountingDetails } from './MountingEditor';
import { addressKey, read, type Projection } from './api';

export function AssemblyInspector({ snapshotId }: { snapshotId: string }) {
  const [selection, setSelection] = useState<string | null>(null);
  const [featureId, setFeatureId] = useState("");
  const [arranged, setArranged] = useState(false);
  const projection = useQuery({ queryKey: ["assembly-projection", snapshotId], queryFn: () => read<Projection>(`assemblies/snapshots/${snapshotId}`) });
  const visible = projection.isError || projection.isFetching ? null : projection.data;
  useEffect(() => { if (projection.isError) { setSelection(null); setFeatureId(''); setArranged(false); } }, [projection.isError]);
  const selected = visible?.occurrences.find((node) => addressKey(node.address.path) === selection);
  return <Stack>
    <Title order={3}>Assembly snapshot</Title>
    <Button disabled={projection.isFetching} onClick={() => { void projection.refetch(); }}>Refresh canonical assembly inspection</Button>
    {projection.isError && <Alert color="red">{projection.error.message}</Alert>}
    {visible && <>
      <Text size="sm">Snapshot {visible.snapshot_id} · SHA-256 {visible.sha256}</Text>
      <Tabs defaultValue="tree"><Tabs.List><Tabs.Tab value="tree">Occurrence tree</Tabs.Tab><Tabs.Tab value="table">Assembly contents</Tabs.Tab><Tabs.Tab value="arrangement">View arrangement</Tabs.Tab></Tabs.List>
        <Tabs.Panel value="tree"><Stack gap="xs">{visible.occurrences.map((node) => <Button key={addressKey(node.address.path)} variant={selection === addressKey(node.address.path) ? "filled" : "light"} aria-pressed={selection === addressKey(node.address.path)} onClick={() => setSelection(addressKey(node.address.path))}>{node.address.path.join("/")} · {node.display_ref || node.name}</Button>)}</Stack></Tabs.Panel>
        <Tabs.Panel value="table"><Table><Table.Thead><Table.Tr><Table.Th>Contextual path</Table.Th><Table.Th>Display reference</Table.Th><Table.Th>Pinned revision</Table.Th></Table.Tr></Table.Thead><Table.Tbody>{visible.occurrences.map((node) => <Table.Tr key={addressKey(node.address.path)} data-selected={selection === addressKey(node.address.path)}><Table.Td><Button variant="subtle" onClick={() => setSelection(addressKey(node.address.path))}>{node.address.path.join("/")}</Button></Table.Td><Table.Td>{node.display_ref}</Table.Td><Table.Td><RevisionLabel id={node.revision_id} /></Table.Td></Table.Tr>)}</Table.Tbody></Table></Tabs.Panel>
        <Tabs.Panel value="arrangement"><Stack><Checkbox label="Spread occurrences for inspection" checked={arranged} onChange={(e) => setArranged(e.currentTarget.checked)} /><Text size="sm">This is a display layout. Canonical placement stays in the pinned snapshot. Geometry and clearances are not evaluated.</Text><Group align="start" style={{ gap: arranged ? 48 : 12 }}>{visible.occurrences.map((node) => <Card key={addressKey(node.address.path)} withBorder><Button variant={selection === addressKey(node.address.path) ? "filled" : "light"} onClick={() => setSelection(addressKey(node.address.path))}>{node.address.path.join("/")}</Button><Text>{node.display_ref || node.name}</Text></Card>)}</Group></Stack></Tabs.Panel>
      </Tabs>
      {selected && <Card withBorder><Stack gap="xs">
        <Title order={4}>Selected occurrence</Title>
        <Text>Context: {selected.address.path.join("/")}</Text><Text>Display reference: {selected.display_ref}</Text>
        <Text><RevisionLabel id={selected.revision_id} extraPins={[{ label: 'Definition ID', value: selected.definition_id }]} /></Text>
        <Text>Child snapshot SHA-256: {selected.snapshot_sha256}</Text>
        <Text>Firmware revision: {selected.assignments.firmware_revision_id ? <RevisionLabel id={selected.assignments.firmware_revision_id} /> : "Unassigned"}</Text>
        <Text>Canonical placement: {selected.placement.status === "known" ? `${selected.placement.translation?.join(", ")} mm` : "Unknown"}</Text>
        <Text>Canonical rotation quaternion (X, Y, Z, W): {selected.placement.status === "known" ? selected.placement.rotation_xyzw?.join(", ") : "Unknown"}</Text>
        <TextInput label="Selected stable feature ID" value={featureId} onChange={(e) => setFeatureId(e.currentTarget.value)} />
        {featureId && <Text>Feature address: {snapshotId} / {selected.address.path.join("/")} / {featureId} · Existence and compatibility not evaluated</Text>}
      </Stack></Card>}
      <MountingDetails relationships={visible.relationships} />
      <Title order={4}>Relationships</Title>
      {visible.relationships.map((r) => <Text key={`${addressKey(r.context_path)}:${r.local_id}`}>{r.context_path.join("/") || "Root"} · {r.local_id} · {r.kind}</Text>)}
    </>}
  </Stack>;
}
