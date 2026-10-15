import { Alert, Button, Card, Checkbox, Group, NumberInput, Stack, Text, TextInput } from '@mantine/core';
import { useState } from 'react';
import type { Occurrence } from './api';
import { RevisionLabel } from "../../lib/IdentityLabel";

export function PlacementEditor({ occurrence, busy, onSave, onRemove, authorized = true }: { occurrence: Occurrence; busy: boolean; onSave: (changes: Partial<Occurrence>) => void; onRemove: () => void; authorized?: boolean }) {
  const [displayRef, setDisplayRef] = useState(occurrence.display_ref);
  const [known, setKnown] = useState(occurrence.placement?.status === 'known');
  const [translation, setTranslation] = useState<(number | string)[]>(occurrence.placement?.translation ?? ['', '', '']);
  const [rotation, setRotation] = useState<(number | string)[]>(occurrence.placement?.rotation_xyzw ?? ['', '', '', '']);
  const finite = (values: (number | string)[]) => values.every(value => typeof value === 'number' && Number.isFinite(value));
  const norm = finite(rotation) ? Math.hypot(...rotation.map(Number)) : null;
  const valid = finite(translation) && norm !== null && Math.abs(norm * norm - 1) <= 1e-6;
  function save() {
    if (known && !valid) return;
    onSave({ display_ref: displayRef, placement: known ? { status: 'known', unit: 'mm', frame: 'right_handed_z_up',
      translation: translation as [number, number, number], rotation_xyzw: rotation as [number, number, number, number] } : { status: 'unknown' } });
  }
  if (!authorized) return null;
  return <Card withBorder><Stack gap="xs">
    <Text>Local ID: {occurrence.local_id} · <RevisionLabel id={occurrence.revision_id} /></Text>
    <TextInput label={`Display reference for ${occurrence.local_id}`} value={displayRef} onChange={event => setDisplayRef(event.currentTarget.value)} />
    <Checkbox label={`Known placement for ${occurrence.local_id}`} checked={known} onChange={event => setKnown(event.currentTarget.checked)} />
    <Text>Canonical frame: right handed, Z up, millimeters in the containing assembly. Unknown placement stores no coordinates or rotation.</Text>
    {known && <>
      <Group>{['X', 'Y', 'Z'].map((axis, index) => <NumberInput key={axis} label={`${occurrence.local_id} ${axis} (mm)`} value={translation[index]} onChange={value => setTranslation(current => current.map((old, i) => i === index ? value : old))} />)}</Group>
      <Group>{['X', 'Y', 'Z', 'W'].map((axis, index) => <NumberInput key={axis} label={`${occurrence.local_id} rotation ${axis}`} value={rotation[index]} onChange={value => setRotation(current => current.map((old, i) => i === index ? value : old))} />)}</Group>
      <Text>Rotation quaternion order: X, Y, Z, W. Enter a unit quaternion or explicitly normalize a finite nonzero quaternion.</Text>
      <Button disabled={busy || norm === null || !Number.isFinite(norm) || norm === 0} onClick={() => { if (norm) setRotation(rotation.map(value => Number(value) / norm)); }}>Normalize rotation for {occurrence.local_id}</Button>
      {!valid && <Alert color="yellow">Enter all three coordinates and a normalized rotation before saving known placement.</Alert>}
    </>}
    <Group><Button size="xs" loading={busy} disabled={known && !valid} onClick={save}>Save {occurrence.local_id}</Button><Button size="xs" color="red" disabled={busy} onClick={onRemove}>Remove {occurrence.local_id}</Button></Group>
  </Stack></Card>;
}
