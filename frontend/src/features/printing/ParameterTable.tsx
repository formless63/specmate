import { Table, Text } from '@mantine/core';
import { SbProvenance, SbUnknown } from '../../components/sb';
import type { ParameterRow, ParameterValue, Source } from './api';

export function valueText(value: ParameterValue | null, unit?: string | null): string {
  if (value === null) return 'Unknown';
  return `${String(value)}${unit ? ` ${unit}` : ''}`;
}

export function SourceLine({ source }: { source: Source }) {
  if (source.kind === 'citation') return <Text size="xs">Citation (unverified): {source.citation}</Text>;
  return <Text size="xs">{source.path} · {source.sha256.slice(0, 12)}… · rights {source.rights}</Text>;
}

/** Effective parameters of a preparation, each with the exact profile revision and provenance it came from. */
export function ParameterTable({ rows }: { rows: ParameterRow[] }) {
  return <Table striped aria-label="Effective parameters">
    <Table.Thead><Table.Tr><Table.Th>Role</Table.Th><Table.Th>Parameter</Table.Th><Table.Th>Value</Table.Th><Table.Th>Basis</Table.Th><Table.Th>From</Table.Th></Table.Tr></Table.Thead>
    <Table.Tbody>{rows.map(row => <Table.Tr key={`${row.role}.${row.key}`}>
      <Table.Td><Text size="sm">{row.role}</Text></Table.Td>
      <Table.Td><Text size="sm">{row.label}</Text>{row.required_for_slicing && <Text size="xs" c="dimmed">required for slicing</Text>}</Table.Td>
      <Table.Td>{row.status === 'declared' ? <Text size="sm" className="sb-mono">{valueText(row.value, row.unit)}</Text>
        : <SbUnknown what={row.label} next={row.slicer_setting ? (row.required_for_slicing ? 'blocks slicing' : 'tool default if sliced') : undefined} />}</Table.Td>
      <Table.Td><Text size="sm">{row.basis}</Text>{row.note && <Text size="xs" c="dimmed">{row.note}</Text>}{row.source && <SourceLine source={row.source} />}</Table.Td>
      <Table.Td>{row.profile_revision_id
        ? <SbProvenance label="Profile" summary={`${row.profile_name ?? 'profile'} r${row.profile_revision_number ?? '?'}`} pins={[{ label: 'Revision ID', value: row.profile_revision_id }]} />
        : <Text size="xs" c="dimmed">draft</Text>}</Table.Td>
    </Table.Tr>)}</Table.Tbody>
  </Table>;
}
