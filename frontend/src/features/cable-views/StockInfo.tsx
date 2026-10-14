import { Alert, Stack, Table, Text, Title } from '@mantine/core';
import type { Section, StockSpecification } from '../../../../packages/section-layout/src';
import { SbQuantity, SbUnknown } from '../../components/sb';
import { rowLook, Swatch } from './Swatch';

const mm = (v: number | null) => <SbQuantity value={v === null ? null : Number(v.toFixed(4))} unit="mm" />;
const SIGNIFICANT = new Set(['conductor', 'drain', 'shield']);

/**
 * Datasheet-style presentation of a stock: identity, overall size, a layer table in the drawn
 * colours and recorded engineering facts. Every unrecorded value reads "Unknown".
 */
export function StockInfo({ stock, section, name, revisionId }: { stock: StockSpecification; section: Section; name: string; revisionId?: string | null }) {
  const conductors = section.rows.filter(r => r.kind === 'conductor').length;
  const screens = section.rows.filter(r => SIGNIFICANT.has(r.kind) && r.kind !== 'conductor').length;
  const jacket = section.rows.filter(r => r.kind === 'jacket');
  const facts = Object.entries(stock.facts);
  return <Stack gap="xs" aria-label="Stock information">
    <Title order={4}>{name}</Title>
    <Table aria-label="Stock summary"><Table.Tbody>
      <Table.Tr><Table.Th>Construction</Table.Th><Table.Td>{stock.construction}</Table.Td></Table.Tr>
      <Table.Tr><Table.Th>Revision</Table.Th><Table.Td>{revisionId ?? 'Unfrozen draft'}</Table.Td></Table.Tr>
      <Table.Tr><Table.Th>Overall size</Table.Th><Table.Td>{mm(section.widthMm)} × {mm(section.heightMm)}</Table.Td></Table.Tr>
      <Table.Tr><Table.Th>Conductors</Table.Th><Table.Td>{conductors}</Table.Td></Table.Tr>
      <Table.Tr><Table.Th>Screens and drains</Table.Th><Table.Td>{screens}</Table.Td></Table.Tr>
      <Table.Tr><Table.Th>Outer jacket</Table.Th><Table.Td>{jacket.length === 0 ? 'None recorded' : jacket.map(j => `${j.material ?? 'Unknown material'}, ${j.color ?? 'Unknown colour'}`).join('; ')}</Table.Td></Table.Tr>
      <Table.Tr><Table.Th>Drawn from end</Table.Th><Table.Td>{stock.viewed_from === 'unknown' ? 'Unknown' : stock.viewed_from.toUpperCase()}</Table.Td></Table.Tr>
    </Table.Tbody></Table>
    {section.unknown.length > 0 && <Alert color="yellow">Incomplete geometry: {section.unknown.join('; ')}</Alert>}
    <Table.ScrollContainer minWidth={560}><Table aria-label="Layer information">
      <Table.Thead><Table.Tr><Table.Th>Tag</Table.Th><Table.Th>Element</Table.Th><Table.Th>Material</Table.Th><Table.Th>Colour</Table.Th><Table.Th>Construction</Table.Th><Table.Th>Outer / inner</Table.Th></Table.Tr></Table.Thead>
      <Table.Tbody>{section.rows.map(row => {
        const look = rowLook(row);
        return <Table.Tr key={row.path}>
          <Table.Td>{row.tag}</Table.Td><Table.Td>{row.label} <Text span size="xs">({row.kind})</Text></Table.Td>
          <Table.Td>{look.materialLabel}{look.family !== 'unrecorded' && look.family !== 'unrecognized' ? <Text span size="xs"> · {look.family}</Text> : null}</Table.Td>
          <Table.Td><Swatch look={look} />{look.colorLabel}{look.fillSource === 'material-typical' ? <Text span size="xs"> (drawn typical)</Text> : null}</Table.Td>
          <Table.Td>{row.construction ?? 'Unknown'}</Table.Td>
          <Table.Td>{row.kind === 'web' ? <>{mm(row.widthMm)} × {mm(row.heightMm)}</> : <>{mm(row.outerDiameterMm)} / {mm(row.innerDiameterMm)}</>}</Table.Td>
        </Table.Tr>;
      })}</Table.Tbody></Table></Table.ScrollContainer>
    {facts.length > 0 && <Table aria-label="Stock facts"><Table.Thead><Table.Tr><Table.Th>Fact</Table.Th><Table.Th>Value</Table.Th><Table.Th>Status</Table.Th><Table.Th>Source</Table.Th></Table.Tr></Table.Thead>
      <Table.Tbody>{facts.map(([key, fact]) => <Table.Tr key={key}><Table.Td>{key}</Table.Td><Table.Td><SbQuantity value={fact.value} unit={fact.unit ?? undefined} /></Table.Td><Table.Td>{fact.status}</Table.Td><Table.Td>{fact.source ?? <SbUnknown />}</Table.Td></Table.Tr>)}</Table.Tbody></Table>}
    <Text size="xs">Drawn colours are the recorded colours; hatched or typical-material fills are display choices, not recorded facts. Nothing here is a qualification.</Text>
  </Stack>;
}
