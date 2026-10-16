import { Button, Group, Select, Stack, Table, Text, Textarea, TextInput } from '@mantine/core';
import { useState } from 'react';
import { RevisionPicker } from '../cables/RevisionPicker';
import { RevisionLabel } from '../../lib/IdentityLabel';
import { partValue, kitValue, type Content, type KitLine, type Part, type Quantity } from './api';

const nullable = (text: string) => text.trim() || null;
export function PartFields({ content, editable, change }: { content: Content; editable: boolean; change: (content: Content) => void }) {
  const value = partValue(content), [target, setTarget] = useState(''), [basis, setBasis] = useState(''), [targetKind, setTargetKind] = useState('connector_body');
  const update = (changes: Partial<Part>) => value && change({ ...content, part: { ...value, ...changes } });
  if (!value) return <Stack><Text>Legacy authored contents are retained unchanged.</Text>{['value', 'package', 'category', 'description'].map(key => typeof content[key] === 'string' ? <Text key={key}>{key}: {String(content[key])}</Text> : null)}
    {!content.part && editable && <Button onClick={() => change({ ...content, part: { schema_version: '1', category: null, value: null, package: null, fits: [] } })}>Add typed part details</Button>}
    {!!content.part && <Text>Legacy structured part details are preserved. Typed details have not been declared for this record.</Text>}</Stack>;
  return <Stack gap="sm">
    <TextInput label="Category" maxLength={100} value={value.category ?? ''} readOnly={!editable} onChange={event => update({ category: nullable(event.currentTarget.value) })} />
    <TextInput label="Value" description="Authored description; no electrical model is inferred." maxLength={500} value={value.value ?? ''} readOnly={!editable} onChange={event => update({ value: nullable(event.currentTarget.value) })} />
    <TextInput label="Package" maxLength={200} value={value.package ?? ''} readOnly={!editable} onChange={event => update({ package: nullable(event.currentTarget.value) })} />
    <Text fw={600}>Declared fit</Text><Text size="sm">Exact design references and their authored basis. Physical fit, clearance and compatibility are not evaluated.</Text>
    {value.fits.length === 0 && <Text>Fit unknown · no declarations.</Text>}
    {value.fits.map(row => <Stack key={row.revision_id} gap={4}><RevisionLabel id={row.revision_id} /><Text>{row.basis}</Text>{editable && <Button size="xs" variant="quiet" onClick={() => update({ fits: value.fits.filter(item => item !== row) })}>Remove fit declaration</Button>}</Stack>)}
    {editable && value.fits.length < 100 && <>
      <Select label="Fit target kind" value={targetKind} allowDeselect={false} data={['connector_body', 'part', 'hardware', 'wire_stock', 'board', 'pcb_population', 'mechanical_source', 'assembly', 'end_assembly']} onChange={kind => { if (kind) { setTargetKind(kind); setTarget(''); } }} />
      <RevisionPicker kind={targetKind} label="Fit target" value={target} onChange={setTarget} />
      <Textarea label="Declared fit basis" maxLength={2000} value={basis} onChange={event => setBasis(event.currentTarget.value)} />
      <Button disabled={!target || !basis.trim() || value.fits.some(row => row.revision_id === target)} onClick={() => { update({ fits: [...value.fits, { revision_id: target, basis: basis.trim() }] }); setTarget(''); setBasis(''); }}>Add fit declaration</Button>
    </>}
  </Stack>;
}
export function KitLines({ content, editable, change }: { content: Content; editable: boolean; change: (content: Content) => void }) {
  const value = kitValue(content), [target, setTarget] = useState(''), [kind, setKind] = useState('part');
  if (!value) return <Text>Kit contents unavailable.</Text>;
  const update = (rows: KitLine[]) => change({ ...content, kit: { ...value, lines: rows } });
  return <Stack><Text>Catalog grouping only. These lines do not create a physical assembly, expand a BOM or reserve stock. A blank quantity is unknown.</Text>
    <div className="sb-ws-scroll"><Table><Table.Thead><Table.Tr><Table.Th>Line</Table.Th><Table.Th>Exact part</Table.Th><Table.Th>Quantity</Table.Th><Table.Th>Note</Table.Th>{editable && <Table.Th />}</Table.Tr></Table.Thead><Table.Tbody>
      {value.lines.map((row, index) => <Table.Tr key={row.local_id}><Table.Td>{row.local_id}</Table.Td><Table.Td><RevisionLabel id={row.revision_id} /></Table.Td><Table.Td>{editable ? <Group wrap="nowrap"><TextInput aria-label={`Line ${index + 1} quantity`} placeholder="Unknown" value={row.quantity?.amount ?? ''} onChange={event => update(value.lines.map(item => item === row ? { ...row, quantity: event.currentTarget.value ? { amount: event.currentTarget.value, unit: row.quantity?.unit ?? 'ea' } : null } : item))} /><Select aria-label={`Line ${index + 1} unit`} data={['ea', 'mm', 'cm', 'm', 'g', 'kg']} value={row.quantity?.unit ?? 'ea'} onChange={unit => unit && row.quantity && update(value.lines.map(item => item === row ? { ...row, quantity: { ...row.quantity!, unit: unit as Quantity['unit'] } } : item))} /></Group> : row.quantity ? `${row.quantity.amount} ${row.quantity.unit}` : 'Unknown'}</Table.Td>
        <Table.Td>{editable ? <TextInput aria-label={`Line ${index + 1} note`} maxLength={2000} value={row.note ?? ''} onChange={event => update(value.lines.map(item => item === row ? { ...row, note: nullable(event.currentTarget.value) } : item))} /> : row.note ?? 'Not declared'}</Table.Td>
        {editable && <Table.Td><Button size="xs" variant="quiet" onClick={() => update(value.lines.filter(item => item !== row))}>Remove {row.local_id}</Button></Table.Td>}</Table.Tr>)}
    </Table.Tbody></Table></div>{value.lines.length === 0 && <Text>No parts declared.</Text>}
    {editable && value.lines.length < 256 && <><Select label="Kit part kind" value={kind} allowDeselect={false} data={['part', 'material', 'hardware', 'connector_body', 'wire_stock', 'board', 'pcb_population', 'mechanical_source', 'assembly', 'end_assembly']} onChange={value => { if (value) { setKind(value); setTarget(''); } }} /><RevisionPicker kind={kind} label="Kit part" value={target} onChange={setTarget} />
      <Button disabled={!target} onClick={() => { update(appendLine(value.lines, target)); setTarget(''); }}>Add exact part</Button></>}
  </Stack>;
}
export function appendLine(rows: KitLine[], revision: string): KitLine[] {
  let number = 1; while (rows.some(row => row.local_id === `part-${number}`)) number++;
  return [...rows, { local_id: `part-${number}`, revision_id: revision, quantity: null, note: null }];
}
