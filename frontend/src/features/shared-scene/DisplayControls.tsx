import { Button, Checkbox, Group, NumberInput, Select, Stack, Text } from '@mantine/core';
import type { Address, GeometryScene, Vec3 } from './api';
import type { Arrangement } from './geometry';
import type { Axis, Display } from './display';

export type OpeningInput = { axis: Axis; angle_deg: number; pivot_local_mm: Vec3 };
export const openingInput = (): OpeningInput => ({ axis: 'z', angle_deg: 90, pivot_local_mm: [0, 0, 0] });
const axes = [{ value: 'x', label: 'X' }, { value: 'y', label: 'Y' }, { value: 'z', label: 'Z' }];
const number = (value: string | number) => typeof value === 'number' ? value : Number.NaN;
const visible = (value: number) => Number.isFinite(value) ? value : '';

export function DisplayControls({ scene, arrangement, selected, display, setDisplay, input, setInput, restore }: {
  scene: GeometryScene; arrangement: Arrangement; selected: Address | null;
  display: Display; setDisplay: (next: Display) => void; input: OpeningInput; setInput: (next: OpeningInput) => void; restore: () => void;
}) {
  const node = selected && !selected.feature_id && selected.snapshot_id === scene.snapshot_id
    ? scene.nodes.find(node => JSON.stringify(node.address.path) === JSON.stringify(selected.path)) : null;
  const openable = arrangement === 'canonical' && !!node?.world_transform && Number.isFinite(input.angle_deg) && input.pivot_local_mm.every(Number.isFinite);
  return <Stack role="region" aria-label="Transient scene display arrangements">
    <Group><Button onClick={restore}>Restore canonical display</Button>
      <Checkbox label="Exploded display" checked={display.explosion.enabled} onChange={event => setDisplay({ ...display, explosion: { ...display.explosion, enabled: event.currentTarget.checked } })} /></Group>
    <Group><Select label="Exploded world display axis" data={axes} allowDeselect={false} value={display.explosion.axis} onChange={axis => setDisplay({ ...display, explosion: { ...display.explosion, axis: axis as Axis } })} />
      <NumberInput label="Exploded branch display spacing (mm)" value={visible(display.explosion.spacing_mm)} min={0} max={1e9} onChange={value => setDisplay({ ...display, explosion: { ...display.explosion, spacing_mm: number(value) } })} /></Group>
    <Text size="sm">Explosion separates exact root branches for display only; nested descendants share their branch offset. Spacing is not an engineering measurement and never assigns an unknown canonical placement.</Text>
    <Group><Select label="Opening illustrative local axis" data={axes} allowDeselect={false} value={input.axis} onChange={axis => setInput({ ...input, axis: axis as Axis })} />
      <NumberInput label="Opening display angle (degrees)" value={visible(input.angle_deg)} min={-360} max={360} onChange={value => setInput({ ...input, angle_deg: number(value) })} />
      {(['x', 'y', 'z'] as const).map((axis, index) => <NumberInput key={axis} label={`Opening chosen local pivot ${axis.toUpperCase()} (mm)`} value={visible(input.pivot_local_mm[index]!)} min={-1e9} max={1e9} onChange={value => {
        const pivot: Vec3 = [...input.pivot_local_mm]; pivot[index] = number(value); setInput({ ...input, pivot_local_mm: pivot });
      }} />)}</Group>
    <Group><Button disabled={!openable} onClick={() => setDisplay({ ...display, opening: { address: { snapshot_id: node!.address.snapshot_id, path: [...node!.address.path] }, ...input, pivot_local_mm: [...input.pivot_local_mm] } })}>Open displayed occurrence branch</Button>
      <Button disabled={!display.opening} onClick={() => setDisplay({ ...display, opening: null })}>Close displayed branch</Button></Group>
    {display.opening && <Text>Displayed open branch: {display.opening.address.path.join('/')} · chosen local {display.opening.axis.toUpperCase()} axis · {display.opening.angle_deg}° · pivot [{display.opening.pivot_local_mm.join(', ')}] mm</Text>}
    <Text size="sm">Opening is a chosen illustrative rotation, not a physical hinge, motion envelope or verified closed condition. It requires a selected whole occurrence and known canonical world frame; separate local inspection spacing supplies no world pivot.</Text>
    <Checkbox label="Illustrative section clipping" checked={display.section.enabled} onChange={event => setDisplay({ ...display, section: { ...display.section, enabled: event.currentTarget.checked } })} />
    <Group><Select label="Section world display axis" data={axes} allowDeselect={false} value={display.section.axis} onChange={axis => setDisplay({ ...display, section: { ...display.section, axis: axis as Axis } })} />
      <NumberInput label="Section chosen world display offset (mm)" value={visible(display.section.offset_mm)} min={-1e9} max={1e9} onChange={value => setDisplay({ ...display, section: { ...display.section, offset_mm: number(value) } })} />
      <Select label="Section retained half-space" data={[{ value: 'positive', label: 'At or above chosen coordinate' }, { value: 'negative', label: 'At or below chosen coordinate' }]} allowDeselect={false} value={display.section.keep} onChange={keep => setDisplay({ ...display, section: { ...display.section, keep: keep as 'positive' | 'negative' } })} /></Group>
    <Text size="sm">Section clipping is an uncapped illustrative cut in the displayed frame. It creates no native cross-section geometry, manufacturing section, thickness or clearance evidence. Fully clipped selections remain selected through their exact addresses.</Text>
    {(!Number.isFinite(display.explosion.spacing_mm) || !Number.isFinite(display.section.offset_mm)) && <Text>Enter finite display parameters to enable the corresponding adjustment.</Text>}
  </Stack>;
}
