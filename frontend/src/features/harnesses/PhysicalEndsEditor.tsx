import { Button, Card, MultiSelect, Select, Stack, Text, TextInput } from '@mantine/core';
import { useState } from 'react';
import type { Harness, PhysicalEnd, Section } from './api';

export function PhysicalEndsEditor({ section, segments, endpoints, hidden, onChange }: { section: Section; segments: Harness['segments']; endpoints: Harness['endpoints']; hidden: boolean; onChange: (ends: PhysicalEnd[]) => void }) {
  const [id, setId] = useState('');
  const ends = section.physical_ends ?? [];
  const choices = segments.filter(s => s.section_id === section.local_id).flatMap(s => (['a', 'b'] as const).map(end => ({ value: JSON.stringify({ segment_id: s.local_id, end }), label: `${s.local_id} / ${end}` })));
  const update = (index: number, patch: Partial<PhysicalEnd>) => onChange(ends.map((end, i) => i === index ? { ...end, ...patch } : end));
  if (hidden) return null;
  return <Stack><Text>Physical end declarations for section {section.local_id}. Choose segment ends deliberately; this records material identity, never electrical connectivity. Repeated labels do not identify ends.</Text>
    {ends.map((end, i) => <Card withBorder key={end.local_id}><Stack><Text>Physical end {end.local_id}</Text>
      <TextInput label={`Physical end ${section.local_id}/${end.local_id} label`} value={end.label ?? ''} onChange={e => update(i, { label: e.currentTarget.value || null })} />
      <MultiSelect label={`Physical end ${section.local_id}/${end.local_id} segment ends`} data={choices} value={end.segment_ends.map(({ segment_id, end }) => JSON.stringify({ segment_id, end }))} onChange={values => update(i, { segment_ends: values.map(v => JSON.parse(v)) })} />
      <Select clearable label={`Physical end ${section.local_id}/${end.local_id} endpoint association`} data={endpoints.map(e => ({ value: e.local_id, label: `${e.local_id} · body ${e.body_revision_id} · pinout ${e.pinout_revision_id}` }))} value={end.endpoint_id} onChange={endpoint_id => update(i, { endpoint_id })} />
      <TextInput label={`Physical end ${section.local_id}/${end.local_id} basis`} value={end.basis} onChange={e => update(i, { basis: e.currentTarget.value })} />
      <Select label={`Physical end ${section.local_id}/${end.local_id} review`} data={['unreviewed', 'reviewed']} value={end.review} onChange={review => update(i, { review: review as PhysicalEnd['review'] })} />
      <Button variant="subtle" onClick={() => onChange(ends.filter((_, index) => index !== i))}>Remove physical end {section.local_id}/{end.local_id}</Button>
    </Stack></Card>)}
    <TextInput label={`New physical end ID for ${section.local_id}`} value={id} onChange={e => setId(e.currentTarget.value)} /><Button disabled={!id || ends.length >= 64 || ends.some(end => end.local_id === id)} onClick={() => { onChange([...ends, { local_id: id, label: null, segment_ends: [], endpoint_id: null, basis: '', review: 'unreviewed' }]); setId(''); }}>Add physical end to {section.local_id}</Button>
    {ends.length !== 2 && <Text>Two-end preparation mapping is unresolved for {ends.length} declared physical ends. Save explicit declarations; no ends will be inferred.</Text>}
  </Stack>;
}
