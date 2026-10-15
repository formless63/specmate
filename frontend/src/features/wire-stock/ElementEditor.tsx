import { useState } from "react";
import { Button, Group, NumberInput, Select, Stack, Text, TextInput } from "@mantine/core";
import { randomUUID } from "../../lib/random-id";
import { usePermission, type PermissionName } from "../../lib/permissions";
import type { GroupElement, StockElement } from "../../../../packages/section-layout/src";
import { FromPreference } from "../preferences/usePreferenceDefaults";
import { MmEntry } from "./MmEntry";
export type Marks = Record<string, string>;
const clone = <T,>(value: T): T => structuredClone(value);
const COLOR_KINDS: StockElement["kind"][] = ["conductor", "insulation", "jacket"];
export function editStockNode(root: GroupElement, path: string, patch: Partial<StockElement>): GroupElement {
  const result = clone(root);
  const find = (node: StockElement, current: string): void => {
    if (current === path) Object.assign(node, patch);
    else if (node.kind === 'group') node.children.forEach(child => find(child, `${current}.${child.id}`));
  };
  find(result, root.id); return result;
}
function newElement(kind: StockElement['kind'], siblings: StockElement[]): StockElement {
  let id = `${kind}-${randomUUID()}`;
  while (siblings.some(child => child.id === id)) id = `${kind}-${randomUUID()}`;
  const base = { id, label: `New ${kind}`, source: null, material: null, color: null, x_mm: 0, y_mm: 0 };
  if (kind === 'group') return { ...base, kind, role: 'bundle', arrangement: 'concentric', pitch_mm: null, direction: 'ccw', children: [] };
  if (kind === 'web') return { ...base, kind, width_mm: null, height_mm: null };
  return { ...base, kind, outer_diameter_mm: null, inner_diameter_mm: null, construction: null, area_mm2: null };
}
export function ElementEditor({ node, path, onChange, color, marks, setMarks, permission = "item.create" }: { permission?: PermissionName; node: StockElement; path: string; onChange: (path: string, patch: Partial<StockElement>) => void; color: string | null; marks: Marks; setMarks: (update: (current: Marks) => Marks) => void }) {
  const [addKind, setAddKind] = useState<StockElement['kind']>('conductor');
  const structure = usePermission(permission);
  const numberField = (label: string, key: string, value: number | null) => <MmEntry label={`${path} ${label}`} value={value} onChange={v => onChange(path, { [key]: v })} />;
  return <Stack gap="xs" style={{ borderLeft: '2px solid var(--sb-border-subtle)', paddingLeft: 12 }}>
    <Text fw={600}>{path} · {node.kind}</Text>
    <Group align="flex-end">
      <TextInput label={`${path} label`} value={node.label} onChange={e => onChange(path, { label: e.target.value })} />
      <TextInput label={`${path} material`} value={node.material ?? ''} placeholder="Unknown" onChange={e => onChange(path, { material: e.target.value || null })} />
      <TextInput label={`${path} source`} value={node.source ?? ''} placeholder="Unknown" onChange={e => onChange(path, { source: e.target.value || null })} />
    </Group>
    <details className="sb-builder-advanced">
      <summary>Advanced placement · {path}</summary>
      <Text size="xs" c="dimmed">Offsets move this element from its parent's center. Members of ring, linear and figure-eight groups are already placed by the group pitch; an offset adds to that. Blank is an unknown position.</Text>
      <Group>
        <NumberInput label={`${path} x offset mm`} value={node.x_mm ?? ''} onChange={v => onChange(path, { x_mm: typeof v === 'number' ? v : null })} />
        <NumberInput label={`${path} y offset mm`} value={node.y_mm ?? ''} onChange={v => onChange(path, { y_mm: typeof v === 'number' ? v : null })} />
      </Group>
    </details>
    {node.kind === 'group' ? <>
      <Group><Select label={`${path} arrangement`} value={node.arrangement} data={['concentric', 'ring', 'linear', 'figure-eight']} onChange={v => v && onChange(path, { arrangement: v as GroupElement['arrangement'] })} />
        {node.arrangement !== 'concentric' && numberField('pitch mm', 'pitch_mm', node.pitch_mm)}
      </Group>
      <Group><Select label={`${path} add element kind`} value={addKind} data={['group', 'conductor', 'dielectric', 'insulation', 'shield', 'drain', 'filler', 'web', 'jacket']} onChange={v => v && setAddKind(v as StockElement['kind'])} />
        <Button variant="light" onClick={() => {
          const added = newElement(addKind, node.children);
          // A wire-color preference fills only the display color, and stays marked until edited or cleared.
          if (color && COLOR_KINDS.includes(added.kind)) { added.color = color; setMarks(current => ({ ...current, [added.id]: color })); }
          onChange(path, { children: [...node.children, added] });
        }} {...structure.props}>Add element to {path}</Button></Group>
      {node.children.map(child => <Stack key={child.id}><ElementEditor permission={permission} node={child} path={`${path}.${child.id}`} onChange={onChange} color={color} marks={marks} setMarks={setMarks} />
        <Button color="red" variant="subtle" size="xs" onClick={() => onChange(path, { children: node.children.filter(c => c.id !== child.id) })} {...structure.props}>Remove {path}.{child.id}</Button></Stack>)}
    </> : <>
      <Group>
        {node.kind === 'web' ? <>{numberField('width mm', 'width_mm', node.width_mm)}{numberField('height mm', 'height_mm', node.height_mm)}</> : <>{numberField('outer diameter mm', 'outer_diameter_mm', node.outer_diameter_mm)}{numberField('inner diameter mm', 'inner_diameter_mm', node.inner_diameter_mm)}</>}
        <TextInput label={`${path} color`} value={node.color ?? ''} placeholder="Unknown (#RRGGBB)" onChange={e => { setMarks(({ [node.id]: _gone, ...rest }) => rest); onChange(path, { color: e.target.value || null }); }} />
        {marks[node.id] !== undefined && node.color === marks[node.id] && <FromPreference what={`${path} color`} onClear={() => { setMarks(({ [node.id]: _gone, ...rest }) => rest); onChange(path, { color: null }); }} />}
      </Group>
    </>}
  </Stack>;
}
