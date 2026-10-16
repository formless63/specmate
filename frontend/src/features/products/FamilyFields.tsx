import { Button, Card, Group, Select, Stack, Text, TextInput, Textarea } from '@mantine/core';
import { useState } from 'react';
import { RevisionPicker } from '../cables/RevisionPicker';
import { RevisionLabel } from '../../lib/IdentityLabel';
import { useRevisionLabel } from '../../lib/revision-labels';
import { formatLocation } from '../navigation';
import type { Family, OptionAxis, Variant } from './api';
import { ExactLink } from './ExactLink';
const text = (value: string) => value.trim() || null;
const nextId = (prefix: string, rows: { local_id: string }[]) => { let n = 1; while (rows.some(row => row.local_id === `${prefix}-${n}`)) n++; return `${prefix}-${n}`; };
export function FamilyFields({ value, editable, change }: { value: Family; editable: boolean; change: (value: Family) => void }) {
  const [kind, setKind] = useState('cable'), [target, setTarget] = useState('');
  const variant = (row: Variant, patch: Partial<Variant>) => change({ ...value, variants: value.variants.map(item => item === row ? { ...row, ...patch } : item) });
  const axis = (row: OptionAxis, patch: Partial<OptionAxis>) => change({ ...value, options: value.options.map(item => item === row ? { ...row, ...patch } : item) });
  return <Stack>
    <TextInput label="Family number" description="Optional authored number; numbers are not auto-assigned." value={value.number ?? ''} maxLength={200} readOnly={!editable} onChange={e => change({ ...value, number: text(e.currentTarget.value) })} />
    <Text size="sm">Variants describe exact designs. Declared length and options do not change those designs or imply release approval.</Text>
    <Text fw={600}>Options</Text>{!value.options.length && <Text>No option axes declared.</Text>}
    {value.options.map(row => <Card withBorder key={row.local_id}><Stack gap="xs"><Text size="xs">Axis ID: {row.local_id}</Text><TextInput label={`Option ${row.local_id} label`} value={row.label} maxLength={200} readOnly={!editable} onChange={e => axis(row, { label: e.currentTarget.value })} />
      {row.values.map(option => <Group key={option.local_id} align="end"><TextInput label={`Value ${row.local_id}/${option.local_id}`} value={option.label} maxLength={200} readOnly={!editable} onChange={e => axis(row, { values: row.values.map(item => item === option ? { ...item, label: e.currentTarget.value } : item) })} /><Text size="xs">{option.local_id}</Text>{editable && <Button variant="quiet" disabled={row.values.length <= 1 || value.variants.some(v => v.options[row.local_id] === option.local_id)} onClick={() => axis(row, { values: row.values.filter(item => item !== option) })}>Remove value</Button>}</Group>)}
      {editable && <Group><Button variant="quiet" disabled={row.values.length >= 64} onClick={() => axis(row, { values: [...row.values, { local_id: nextId('value', row.values), label: 'New value' }] })}>Add value</Button><Button variant="quiet" onClick={() => change({ ...value, options: value.options.filter(item => item !== row), variants: value.variants.map(v => ({ ...v, options: Object.fromEntries(Object.entries(v.options).filter(([id]) => id !== row.local_id)) })) })}>Remove axis</Button></Group>}
    </Stack></Card>)}
    {editable && <Button variant="quiet" disabled={value.options.length >= 16} onClick={() => change({ ...value, options: [...value.options, { local_id: nextId('option', value.options), label: 'New option', values: [{ local_id: 'value-1', label: 'New value' }] }] })}>Add option axis</Button>}
    <Text fw={600}>Variants</Text>{!value.variants.length && <Text>No variants declared.</Text>}
    {value.variants.map(row => <Card withBorder key={row.local_id}><Stack gap="xs"><Text fw={600}>Variant {row.local_id}</Text><PinnedDesign id={row.design_revision_id} />
      <TextInput label={`Variant ${row.local_id} label`} maxLength={200} value={row.label ?? ''} readOnly={!editable} onChange={e => variant(row, { label: text(e.currentTarget.value) })} />
      <TextInput label={`Variant ${row.local_id} number`} maxLength={200} value={row.number ?? ''} readOnly={!editable} onChange={e => variant(row, { number: text(e.currentTarget.value) })} />
      <TextInput label={`Variant ${row.local_id} declared length (mm)`} description="Blank means unknown; never taken from or written to the pinned design." placeholder="Unknown" value={row.declared_length_mm ?? ''} readOnly={!editable} onChange={e => variant(row, { declared_length_mm: e.currentTarget.value || null })} />
      {value.options.map(option => <Select key={option.local_id} label={`Variant ${row.local_id}: ${option.label}`} data={option.values.map(v => ({ value: v.local_id, label: v.label }))} placeholder="Not declared" clearable disabled={!editable} value={row.options[option.local_id] ?? null} onChange={selected => variant(row, { options: selected ? { ...row.options, [option.local_id]: selected } : Object.fromEntries(Object.entries(row.options).filter(([id]) => id !== option.local_id)) })} />)}
      <Textarea label={`Variant ${row.local_id} note`} maxLength={2000} value={row.note ?? ''} readOnly={!editable} onChange={e => variant(row, { note: text(e.currentTarget.value) })} />
      {editable && <Button variant="quiet" onClick={() => change({ ...value, variants: value.variants.filter(item => item !== row) })}>Remove variant {row.local_id}</Button>}
    </Stack></Card>)}
    {editable && value.variants.length < 100 && <><Select label="Design kind" data={[{ value: 'cable', label: 'Cable' }, { value: 'harness', label: 'Harness' }, { value: 'assembly', label: 'Device / assembly' }]} allowDeselect={false} value={kind} onChange={v => { if (v) { setKind(v); setTarget(''); } }} /><RevisionPicker key={kind} label="Variant design" kind={kind} value={target} onChange={setTarget} />
      <Button disabled={!target} onClick={() => { change({ ...value, variants: [...value.variants, { local_id: nextId('variant', value.variants), label: null, design_revision_id: target, number: null, declared_length_mm: null, options: {}, note: null }] }); setTarget(''); }}>Add exact design variant</Button></>}
  </Stack>;
}

function PinnedDesign({ id }: { id: string }) {
  const label = useRevisionLabel(id).data;
  const href = label?.readable && label.definition_id && label.number ? formatLocation({ area: 'designs', lens: label.kind === 'assembly' ? 'assemblies' : label.kind === 'harness' ? 'harnesses' : 'cables', project: null, probe: { object: label.definition_id, rev: label.number, path: [] } }) : null;
  return <><RevisionLabel id={id} />{href && <ExactLink href={href}>Open exact design</ExactLink>}</>;
}
