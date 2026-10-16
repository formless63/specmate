import { Alert, Group, Select, Stack, Table, Text, TextInput } from '@mantine/core';
import { useQueries } from '@tanstack/react-query';
import { RevisionLabel } from '../../lib/IdentityLabel';
import { read, type CableEnd, type Port } from './api';
import { EndSignal } from './PortEditor';

/** A logical port grouping real member ports; never draw a fictional combined connector. */
export function ComposedPortEditor({ value, onChange }: { value: Port; onChange: (value: Port) => void }) {
  const members = value.members ?? [];
  const revisions = [...new Set(members.map(member => member.revision_id))];
  const reads = useQueries({ queries: revisions.map(revision => ({ queryKey: ['interface-end', revision], queryFn: () => read<CableEnd>(`interfaces/revisions/${revision}/end`), retry: false })) });
  return <Stack gap="xs">
    <Text fw={600}>Composed device port</Text>
    <Text size="sm">Logical contacts refer to exact individual ports or pinouts. This grouping declares no shared connector body or physical mating.</Text>
    <Group><TextInput label="Device" value={value.device_label} onChange={event => onChange({ ...value, device_label: event.currentTarget.value })} />
      <Select label="Port role" value={value.role} data={['source', 'sink', 'bidirectional', 'unknown']} onChange={role => onChange({ ...value, role: (role ?? 'unknown') as Port['role'] })} /></Group>
    <TextInput label="Composition basis" value={value.composition_basis ?? ''} onChange={event => onChange({ ...value, composition_basis: event.currentTarget.value || null })} />
    {reads.some(read => read.isError) && <Alert color="red">A member is unavailable. Refresh its current source access before reviewing this composition.</Alert>}
    <Table.ScrollContainer minWidth={700}><Table><Table.Thead><Table.Tr><Table.Th>Logical contact</Table.Th><Table.Th>Exact member</Table.Th><Table.Th>Member contact</Table.Th><Table.Th>Signal</Table.Th><Table.Th>Declaration</Table.Th></Table.Tr></Table.Thead><Table.Tbody>
      {(value.contacts ?? []).map(contact => {
        const index = members.findIndex(member => member.local_id === contact.member_id);
        const member = members[index]; const row = reads[revisions.indexOf(member?.revision_id ?? '')]?.data?.rows.find(row => row.contact_id === contact.member_contact_id);
        return <Table.Tr key={contact.contact_id}><Table.Td>{contact.label ?? contact.contact_id}{contact.label && contact.label !== contact.contact_id && <Text size="xs">{contact.contact_id}</Text>}</Table.Td>
          <Table.Td>{member && <RevisionLabel id={member.revision_id} role={member.local_id} />}</Table.Td><Table.Td>{contact.member_contact_id}</Table.Td>
          <Table.Td>{row ? <EndSignal row={row} /> : 'Not available'}</Table.Td><Table.Td>{contact.basis}</Table.Td></Table.Tr>;
      })}
    </Table.Tbody></Table></Table.ScrollContainer>
    <Group><Select label="Port review" value={value.review} data={['unreviewed', 'reviewed']} onChange={review => onChange({ ...value, review: (review ?? 'unreviewed') as Port['review'] })} />
      <TextInput label="Review basis" value={value.review_basis ?? ''} onChange={event => onChange({ ...value, review_basis: event.currentTarget.value || null })} /></Group>
  </Stack>;
}
