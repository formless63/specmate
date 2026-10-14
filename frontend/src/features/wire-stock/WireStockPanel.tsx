import { randomUUID } from "../../lib/random-id";
import { ReadOnlyNote, usePermission } from "../../lib/permissions";
import { useEffect, useMemo, useState } from 'react';
import { Alert, Button, Checkbox, Group, NumberInput, Select, Stack, Table, Text, TextInput, Title } from '@mantine/core';
import { renderPreviewSvg, renderSectionSvg, sectionLayout, stockGeometry } from '../../../../packages/section-layout/src';
import type { Fact, GroupElement, StockElement, StockSpecification } from '../../../../packages/section-layout/src';
import { freezeStock, listStocks, saveStock } from './api';
import { addProjectReference } from '../identity/api';
import type { StockRecord } from './api';
import { stockPresets } from './presets';
import { WirePreparationPreview } from './WirePreparationPreview';
import { FrozenWirePreview } from './FrozenWirePreview';
import { CableViews } from '../cable-views/CableViews';
import { StockSectionView } from '../cable-views/StockSectionView';
import { rowLook, Swatch } from '../cable-views/Swatch';

const clone = <T,>(value: T): T => structuredClone(value);
const dimension = (value: number | null): string => value === null ? 'Unknown' : `${Number(value.toFixed(4))} mm`;
function download(name: string, body: string, type: string): void {
  const url = URL.createObjectURL(new Blob([body], { type }));
  const link = document.createElement('a'); link.href = url; link.download = name; link.click();
  URL.revokeObjectURL(url);
}
function editNode(root: GroupElement, path: string, patch: Partial<StockElement>): GroupElement {
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
function ElementEditor({ node, path, onChange }: { node: StockElement; path: string; onChange: (path: string, patch: Partial<StockElement>) => void }) {
  const [addKind, setAddKind] = useState<StockElement['kind']>('conductor');
  const structure = usePermission('item.create');
  const numberField = (label: string, key: string, value: number | null) => <NumberInput label={`${path} ${label}`} value={value ?? ''} min={0} step={0.1} onChange={v => onChange(path, { [key]: typeof v === 'number' ? v : null })} />;
  return <Stack gap="xs" style={{ borderLeft: '2px solid #aaa', paddingLeft: 12 }}>
    <Text fw={600}>{path} · {node.kind}</Text>
    <Group align="flex-end">
      <TextInput label={`${path} label`} value={node.label} onChange={e => onChange(path, { label: e.target.value })} />
      <TextInput label={`${path} material`} value={node.material ?? ''} placeholder="Unknown" onChange={e => onChange(path, { material: e.target.value || null })} />
      <TextInput label={`${path} source`} value={node.source ?? ''} placeholder="Unknown" onChange={e => onChange(path, { source: e.target.value || null })} />
      <NumberInput label={`${path} x offset mm`} value={node.x_mm} onChange={v => typeof v === 'number' && onChange(path, { x_mm: v })} />
      <NumberInput label={`${path} y offset mm`} value={node.y_mm} onChange={v => typeof v === 'number' && onChange(path, { y_mm: v })} />
    </Group>
    {node.kind === 'group' ? <>
      <Group><Select label={`${path} arrangement`} value={node.arrangement} data={['concentric', 'ring', 'linear', 'figure-eight']} onChange={v => v && onChange(path, { arrangement: v as GroupElement['arrangement'] })} />
        {node.arrangement !== 'concentric' && numberField('pitch mm', 'pitch_mm', node.pitch_mm)}
      </Group>
      <Group><Select label={`${path} add element kind`} value={addKind} data={['group', 'conductor', 'dielectric', 'insulation', 'shield', 'drain', 'filler', 'web', 'jacket']} onChange={v => v && setAddKind(v as StockElement['kind'])} />
        <Button variant="light" onClick={() => onChange(path, { children: [...node.children, newElement(addKind, node.children)] })} {...structure.props}>Add element to {path}</Button></Group>
      {node.children.map(child => <Stack key={child.id}><ElementEditor node={child} path={`${path}.${child.id}`} onChange={onChange} />
        <Button color="red" variant="subtle" size="xs" onClick={() => onChange(path, { children: node.children.filter(c => c.id !== child.id) })} {...structure.props}>Remove {path}.{child.id}</Button></Stack>)}
    </> : <>
      <Group>
        {node.kind === 'web' ? <>{numberField('width mm', 'width_mm', node.width_mm)}{numberField('height mm', 'height_mm', node.height_mm)}</> : <>{numberField('outer diameter mm', 'outer_diameter_mm', node.outer_diameter_mm)}{numberField('inner diameter mm', 'inner_diameter_mm', node.inner_diameter_mm)}</>}
        <TextInput label={`${path} color`} value={node.color ?? ''} placeholder="Unknown (#RRGGBB)" onChange={e => onChange(path, { color: e.target.value || null })} />
      </Group>
    </>}
  </Stack>;
}

/** Library wire stock. `projectId` is optional context, never the stock's owner; no connector or PCB prerequisite. */
export function WireStockPanel({ projectId }: { projectId?: string | null }) {
  const [stocks, setStocks] = useState<StockRecord[]>([]);
  const [current, setCurrent] = useState<StockRecord | null>(null);
  const [name, setName] = useState('Synthetic coax');
  const [stock, setStock] = useState<StockSpecification>(() => clone(stockPresets.coax!));
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [dirty, setDirty] = useState(true);
  const [busy, setBusy] = useState(false);
  const [length, setLength] = useState(100);
  const edit = usePermission('item.create');
  const [useHere, setUseHere] = useState(true);
  const freezeGate = usePermission('design.freeze');
  const section = useMemo(() => sectionLayout(stock), [stock]);
  const geometry = useMemo(() => stockGeometry(section, length), [section, length]);
  useEffect(() => {
    let live = true;
    setCurrent(null); setStocks([]); setError(''); setMessage(''); setDirty(true);
    listStocks(projectId).then(v => { if (live) setStocks(v); }).catch(e => { if (live) setError(String(e.message)); });
    return () => { live = false; };
  }, [projectId]);
  const save = async () => {
    setBusy(true); setError(''); setMessage('');
    try {
      const created = current === null;
      const saved = await saveStock(name, stock, current);
      setCurrent(saved); setDirty(false); setStock(clone(saved.content.stock!));
      let note = '';
      if (created && projectId && useHere) {
        try { await addProjectReference(projectId, 'definition', saved.definition_id, 'stock'); }
        catch (e) { note = ` Not added to this project: ${e instanceof Error ? e.message : String(e)}`; }
      }
      setStocks(await listStocks(projectId));
      setMessage(`Saved ${saved.name} (${saved.state}).${note}`);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };
  const freeze = async () => {
    if (!current || dirty) return;
    setBusy(true); setError('');
    try { const result = await freezeStock(current); setMessage(`Frozen revision ${result.number}. Further edits create a new draft state.`); setCurrent({ ...current, state: result.draft.state }); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };
  return <Stack>
    <Title order={2}>Wire stock</Title>
    <Text>Describe reusable stock independently of finished cables. Unknown values remain unknown.</Text>
    {error && <Alert color="red" role="alert">{error}</Alert>}{message && <Alert color="green">{message}</Alert>}
    <Group>
      <Select label="Saved stock" data={stocks.map(item => ({ value: item.draft_id, label: item.in_project ? `${item.name} · in this project` : item.name }))} value={current?.draft_id ?? null} onChange={id => {
        const record = stocks.find(item => item.draft_id === id); if (!record?.content.stock) return;
        setCurrent(record); setDirty(false); setName(record.name); setStock(clone(record.content.stock)); setMessage('');
      }} />
      <Select label="New construction" value={null} placeholder="Choose a synthetic starting point" data={Object.keys(stockPresets)} onChange={key => {
        if (key && stockPresets[key]) { setStock(clone(stockPresets[key])); setName(`Synthetic ${key}`); setCurrent(null); setDirty(true); setMessage(''); }
      }} />
      <TextInput label="Stock name" value={name} disabled={current !== null} onChange={e => setName(e.target.value)} />
      <Select label="Viewed from" data={['a', 'b', 'unknown']} value={stock.viewed_from} onChange={v => { if (v) { setStock({ ...stock, viewed_from: v as StockSpecification['viewed_from'] }); setDirty(true); } }} />
    </Group>
    {projectId && current === null && <Checkbox label="Use in this project" checked={useHere} onChange={e => setUseHere(e.currentTarget.checked)} />}
    <Group><Button onClick={save} loading={busy} {...edit.props}>Save stock</Button><Button variant="light" onClick={freeze} disabled={!current || busy || dirty} {...freezeGate.props}>Freeze saved stock</Button>
      <Button variant="light" onClick={() => download('stock.json', JSON.stringify({ name, stock, section, geometry }, null, 2), 'application/json')}>Export specification</Button>
      <Button variant="light" onClick={() => download('stock-section.svg', renderSectionSvg(section, name), 'image/svg+xml')}>Export section SVG</Button>
    </Group>
    <ReadOnlyNote permission="item.create">Saving, freezing and adding or removing elements are unavailable; the local section and exports still work.</ReadOnlyNote>
    {dirty && <Text size="sm">Unsaved construction. Save before freezing.</Text>}
    <Button variant="subtle" disabled={busy} onClick={async () => {
      try {
        const fresh = await listStocks(projectId); setStocks(fresh);
        const saved = fresh.find(item => item.draft_id === current?.draft_id);
        if (saved?.content.stock) { setCurrent(saved); setStock(clone(saved.content.stock)); setDirty(false); setMessage('Reloaded saved construction.'); }
      } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    }}>Reload saved stock (discard local edits)</Button>
    <Text>Section: {dimension(section.widthMm)} × {dimension(section.heightMm)} · {section.rows.length} material elements · view {section.viewedFrom}</Text>
    {section.unknown.length > 0 && <Alert color="yellow">Incomplete geometry: {section.unknown.join('; ')}</Alert>}
    <Group align="flex-start" grow>
      <StockSectionView section={section} title={name} label="Stock section drawing" />
      <Stack style={{ maxWidth: 440 }}><NumberInput label="Preview extrusion length mm" value={length} min={1} onChange={v => typeof v === 'number' && v >= 1 && setLength(v)} />
        <div aria-label="Stock geometry preview" className="sb-viewer" style={{ color: 'var(--sb-text-primary)' }} dangerouslySetInnerHTML={{ __html: renderPreviewSvg(geometry, name) }} />
        <Text size="sm">Axial length is compressed in the preview. Display colors for unknown materials are illustrative.</Text>
      </Stack>
    </Group>
    <WirePreparationPreview key={current?.draft_id ?? name} section={section} lengthMm={length} />
    <Table><Table.Thead><Table.Tr><Table.Th>Tag / element</Table.Th><Table.Th>Material / color</Table.Th><Table.Th>Dimensions</Table.Th><Table.Th>Source</Table.Th></Table.Tr></Table.Thead><Table.Tbody>
      {section.rows.map(row => <Table.Tr key={row.path}><Table.Td>{row.tag} · {row.path}<br />{row.label} ({row.kind})</Table.Td><Table.Td><Swatch look={rowLook(row)} />{row.material ?? 'Unknown'} / {row.color ?? 'Unknown'}</Table.Td><Table.Td>{dimension(row.widthMm)} × {dimension(row.heightMm)}{row.outerDiameterMm !== null && ` · bore ${dimension(row.innerDiameterMm)}`}</Table.Td><Table.Td>{row.source ?? 'Unknown'}</Table.Td></Table.Tr>)}
    </Table.Tbody></Table>
    <Text>{Object.entries(stock.facts).map(([key, fact]) => `${key}: ${fact.value ?? 'Unknown'}${fact.unit ? ` ${fact.unit}` : ''} (${fact.status})`).join(' · ')}</Text>
    <Title order={3}>End faces and information</Title>
    <CableViews stock={stock} name={name} tabs={['end-a', 'end-b', 'info']} />
    <FrozenWirePreview key={projectId ?? 'library'} projectId={projectId} />
    <Title order={3}>Engineering facts</Title>
    {Object.entries(stock.facts).map(([key, fact]) => <Group key={key} align="flex-end">
      <Text>{key}{fact.unit ? ` (${fact.unit})` : ''}</Text>
      <Select label={`${key} status`} value={fact.status} data={['unknown', 'documented', 'measured', 'inferred']} onChange={v => {
        if (!v) return; const status = v as Fact['status'];
        setStock({ ...stock, facts: { ...stock.facts, [key]: { ...fact, status, value: status === 'unknown' ? null : fact.value ?? '' } } }); setDirty(true);
      }} />
      <TextInput label={`${key} value`} disabled={fact.status === 'unknown'} value={fact.value ?? ''} onChange={e => { setStock({ ...stock, facts: { ...stock.facts, [key]: { ...fact, value: e.target.value || null } } }); setDirty(true); }} />
      <TextInput label={`${key} source`} value={fact.source ?? ''} onChange={e => { setStock({ ...stock, facts: { ...stock.facts, [key]: { ...fact, source: e.target.value || null } } }); setDirty(true); }} />
    </Group>)}
    <Title order={3}>Construction editor</Title>
    <ElementEditor node={stock.structure} path={stock.structure.id} onChange={(path, patch) => { setStock({ ...stock, structure: editNode(stock.structure, path, patch) }); setDirty(true); setMessage('Unsaved changes.'); }} />
  </Stack>;
}
