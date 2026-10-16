import { Alert, Button, Group, Select, Stack, Text, TextInput } from '@mantine/core';
import { useState } from 'react';
import { InspectionScope, ReadOnlyNote } from '../../lib/permissions';
import { RevisionLabel } from '../../lib/IdentityLabel';
import { RevisionPicker } from '../cables/RevisionPicker';
import { exactUuid } from '../boards/working-authority';
import { PlacementEditor } from './PlacementEditor';
import { relationship, type Assembly, type Occurrence, type RelationshipKind } from './api';

export function WorkingTree({ assembly, selected, onSelect }: { assembly: Assembly; selected: string | null; onSelect: (id: string) => void }) {
  return <Stack gap="xs" className="device-tree" aria-label="Working occurrence tree"><Text size="xs">Working declaration · exact child revisions. Nested saved uses become available after Capture saved assembly; working placements are never inferred.</Text>
    {!assembly.occurrences.length && <div className="device-empty"><Text>No occurrences declared.</Text><Text size="sm">Add a board, cable, enclosure or other exact item in the Occurrence inspector.</Text></div>}
    {assembly.occurrences.map(row => <div className="device-tree-row" key={row.local_id}><Button variant={selected === row.local_id ? 'filled' : 'quiet'} aria-pressed={selected === row.local_id} onClick={() => onSelect(row.local_id)}>{row.display_ref || row.local_id}</Button><RevisionLabel id={row.revision_id} /><Text size="xs">{row.local_id} · placement {row.placement?.status ?? 'unknown'}</Text></div>)}
  </Stack>;
}
const childKinds = ['pcb_population', 'board', 'cable', 'harness', 'assembly', 'mechanical_source', 'part', 'connector_body', 'end_assembly', 'wire_stock', 'firmware'];
export function OccurrenceControls({ assembly, selected, onSelect, editable, onChange, onStaged, onApplied, staged, epoch, newRecord = false }: {
  assembly: Assembly; selected: string | null; onSelect: (id: string | null) => void; editable: boolean; onChange: (value: Assembly) => void;
  newRecord?: boolean; onStaged: (id: string) => void; onApplied: (id: string) => void; staged: Set<string>; epoch: number;
}) {
  const [kind, setKind] = useState('pcb_population'), [revision, setRevision] = useState(''), [localId, setLocalId] = useState(''), [reference, setReference] = useState('');
  const [visited, setVisited] = useState(new Set<string>()); const [resets, setResets] = useState<Record<string, number>>({});
  if (selected && !visited.has(selected)) setVisited(prior => new Set([...prior, selected]));
  const update = (id: string, changes: Partial<Occurrence>) => { onChange({ ...assembly, occurrences: assembly.occurrences.map(row => row.local_id === id ? { ...row, ...changes } : row) }); onApplied(id); };
  const discard = (id: string) => { setResets(prior => ({ ...prior, [id]: (prior[id] ?? 0) + 1 })); onApplied(id); };
  return <Stack gap="xs"><Select size="xs" label="Selected occurrence" clearable value={selected} data={assembly.occurrences.map(row => ({ value: row.local_id, label: `${row.display_ref || row.local_id} · ${row.local_id}` }))} onChange={onSelect} />
    {assembly.occurrences.filter(row => visited.has(row.local_id)).map(row => <div key={row.local_id} hidden={selected !== row.local_id} inert={selected !== row.local_id}><InspectionScope permission={newRecord ? "item.create" : "design.edit"}><fieldset className="device-fields" disabled={!editable}><PlacementEditor key={`${row.local_id}:${epoch}:${resets[row.local_id] ?? 0}`} occurrence={row} busy={false} actionLabel={`Apply ${row.local_id} to working tree`} onStaged={() => onStaged(row.local_id)} onSave={value => update(row.local_id, value)} onRemove={() => { onChange({ ...assembly, occurrences: assembly.occurrences.filter(other => other.local_id !== row.local_id) }); onApplied(row.local_id); onSelect(null); }} />
      {staged.has(row.local_id) && <Button size="xs" variant="quiet" onClick={() => discard(row.local_id)}>Discard unapplied {row.local_id} fields</Button>}</fieldset></InspectionScope></div>)}
    <ReadOnlyNote permission={newRecord ? "item.create" : "design.edit"} />{!selected && <Text size="sm">Select a use in Tree or Scene to inspect its exact identity and placement.</Text>}
    {editable && <details><summary>Add exact occurrence</summary><Stack gap="xs"><Select size="xs" label="Child kind" value={kind} data={childKinds.map(value => ({ value, label: value.replaceAll('_', ' ') }))} onChange={value => { setKind(value ?? 'part'); setRevision(''); }} /><RevisionPicker key={kind} label="Child" kind={kind} value={revision} onChange={setRevision} />
      <TextInput size="xs" label="Stable local occurrence ID" description="Lowercase ID for this use; it stays distinct from its displayed reference." value={localId} onChange={event => setLocalId(event.currentTarget.value)} /><TextInput size="xs" label="Display reference" value={reference} onChange={event => setReference(event.currentTarget.value)} />
      <Button size="xs" disabled={!/^[a-z][a-z0-9_-]*$/.test(localId) || !exactUuid(revision) || assembly.occurrences.some(row => row.local_id === localId)} onClick={() => { onChange({ ...assembly, occurrences: [...assembly.occurrences, { local_id: localId, revision_id: revision, display_ref: reference, placement: { status: 'unknown' } }] }); onSelect(localId); setLocalId(''); setReference(''); }}>Add occurrence to working tree</Button></Stack></details>}
  </Stack>;
}
export function RelationshipControls({ assembly, editable, onChange, paths }: { assembly: Assembly; editable: boolean; onChange: (value: Assembly) => void; paths: { path: string[]; label: string }[] }) {
  const [kind, setKind] = useState<RelationshipKind>('electrical'), [local, setLocal] = useState(''), [a, setA] = useState(''), [b, setB] = useState(''), [featureA, setFeatureA] = useState(''), [featureB, setFeatureB] = useState('');
  const [targetKind, setTargetKind] = useState('part'); const external = ['procurement', 'source_derivation'].includes(kind);
  const choices = [{ value: '', label: 'Root containing assembly' }, ...paths.map(row => ({ value: row.path.join('/'), label: row.label }))];
  return <Stack gap="xs"><Text size="xs">Typed relationships are declarations. Feature existence, fit and compatibility are not evaluated.</Text>
    {assembly.relationships.map(row => <div key={row.local_id}><Text size="sm">{row.local_id} · {row.kind}</Text><Text size="xs">{Object.entries(row).map(([role, value]) => value && typeof value === 'object' ? `${role}: ${'path' in value ? value.path.join(' / ') || 'Root' : 'exact referenced revision'}${'feature_id' in value && value.feature_id ? ` / ${value.feature_id}` : ''}` : '').filter(Boolean).join(' · ')}</Text>{editable && <Button size="xs" variant="quiet" onClick={() => onChange({ ...assembly, relationships: assembly.relationships.filter(other => other.local_id !== row.local_id) })}>Remove relationship {row.local_id}</Button>}</div>)}
    {editable && <details><summary>Add typed relationship</summary><Stack gap="xs"><Select size="xs" label="Relationship type" value={kind} allowDeselect={false} data={['containment', 'electrical', 'mating', 'mounting', 'source_derivation', 'documentation', 'procurement']} onChange={value => { setKind(value as RelationshipKind); setB(''); }} /><TextInput size="xs" label="Relationship local ID" value={local} onChange={event => setLocal(event.currentTarget.value)} />
      <Select size="xs" label="First occurrence" value={a} data={choices} onChange={value => setA(value ?? '')} />
      {external ? <><Select size="xs" label="Referenced item kind" value={targetKind} data={childKinds} onChange={value => { setTargetKind(value ?? 'part'); setB(''); }} /><RevisionPicker key={targetKind} label="Referenced item" kind={targetKind} value={b} onChange={setB} /></> : <Select size="xs" label="Second occurrence" value={b} data={choices} onChange={value => setB(value ?? '')} />}
      {kind !== 'containment' && <><TextInput size="xs" label="First stable feature ID (optional)" value={featureA} onChange={event => setFeatureA(event.currentTarget.value)} /><TextInput size="xs" label="Second stable feature ID (optional)" value={featureB} onChange={event => setFeatureB(event.currentTarget.value)} /></>}
      <Button size="xs" disabled={!local || assembly.relationships.some(row => row.local_id === local) || external && !exactUuid(b)} onClick={() => { onChange({ ...assembly, relationships: [...assembly.relationships, relationship(kind, local, a, b, featureA, featureB)] }); setLocal(''); }}>Add relationship to working tree</Button></Stack></details>}
  </Stack>;
}
export function WorkingFirmware({ assembly, editable, paths, onChange }: { assembly: Assembly; editable: boolean; paths: { path: string[]; label: string }[]; onChange: (value: Assembly) => void }) {
  const [path, setPath] = useState<string | null>(null), [firmware, setFirmware] = useState('');
  return <Stack gap="xs"><Text size="sm">Assignments belong to exact contextual uses. Compilation, flashing and operation are separate evidence.</Text>
    {(assembly.assignments ?? []).map(row => <Group key={JSON.stringify(row.path)}><Text size="sm">{row.path.join(' / ')}</Text>{row.assignments.firmware_revision_id ? <RevisionLabel id={row.assignments.firmware_revision_id} /> : <Text>Unassigned</Text>}{editable && <Button size="xs" variant="quiet" onClick={() => onChange({ ...assembly, assignments: assembly.assignments?.map(other => JSON.stringify(other.path) === JSON.stringify(row.path) ? { ...other, assignments: { ...other.assignments, firmware_revision_id: null } } : other) })}>Clear assignment {row.path.join(' / ')}</Button>}</Group>)}
    {editable && <><Select size="xs" label="Firmware occurrence" value={path} data={paths.map(row => ({ value: JSON.stringify(row.path), label: row.label }))} onChange={setPath} /><RevisionPicker label="Firmware" kind="firmware" value={firmware} onChange={setFirmware} /><Button size="xs" disabled={!path || !exactUuid(firmware)} onClick={() => { if (path) onChange({ ...assembly, assignments: [...(assembly.assignments ?? []).filter(row => JSON.stringify(row.path) !== path), { path: JSON.parse(path) as string[], assignments: { ...assembly.assignments?.find(row => JSON.stringify(row.path) === path)?.assignments, firmware_revision_id: firmware } }] }); }}>Apply firmware to working tree</Button><Alert color="yellow">The server validates the exact owning board and firmware target when saving. No compatible board is inferred from a label.</Alert></>}
  </Stack>;
}
