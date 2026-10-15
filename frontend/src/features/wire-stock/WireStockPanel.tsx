import { randomUUID } from "../../lib/random-id";
import { ReadOnlyNote, usePermission } from "../../lib/permissions";
import { useEffect, useMemo, useState } from 'react';
import { Alert, Button, Checkbox, Group, NumberInput, Select, Stack, Table, Text, TextInput, Title } from '@mantine/core';
import { evaluateFit, renderPreviewSvg, renderSectionSvg, sectionLayout, stockGeometry } from '../../../../packages/section-layout/src';
import type { Fact, GroupElement, StockElement, StockSpecification } from '../../../../packages/section-layout/src';
import { freezeStock, listStocks, saveStock } from './api';
import type { StockRecord } from './api';
import { stockPresets } from './presets';
import { WirePreparationPreview } from './WirePreparationPreview';
import { FrozenWirePreview } from './FrozenWirePreview';
import { CableViews } from '../cable-views/CableViews';
import { StockSectionView } from '../cable-views/StockSectionView';
import { SbQuantity, SbUnknown } from '../../components/sb';
import { rowLook, Swatch } from '../cable-views/Swatch';
import { FromPreference, usePreferenceDefaults } from '../preferences/usePreferenceDefaults';
import { useOpenProbed } from '../scope/openProbed';
import { blankSpec, exampleCoax, generate, illustrate, readBuilder, TEMPLATES } from './builder';
import type { BuilderSpec } from './builder';
import { ConstructionBuilder } from './ConstructionBuilder';
import { FitFindings } from './FitFindings';
import { MmEntry } from './MmEntry';
import './wire-stock.css';

export { MmEntry };

/** Element kinds whose display color a wire-color preference may pre-fill. */
const COLOR_KINDS: StockElement['kind'][] = ['conductor', 'insulation', 'jacket'];
type Marks = Record<string, string>;

const clone = <T,>(value: T): T => structuredClone(value);
const dimension = (value: number | null) => <SbQuantity value={value === null ? null : Number(value.toFixed(4))} unit="mm" />;
const INITIAL = exampleCoax();
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
function ElementEditor({ node, path, onChange, color, marks, setMarks }: { node: StockElement; path: string; onChange: (path: string, patch: Partial<StockElement>) => void; color: string | null; marks: Marks; setMarks: (update: (current: Marks) => Marks) => void }) {
  const [addKind, setAddKind] = useState<StockElement['kind']>('conductor');
  const structure = usePermission('item.create');
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
      {node.children.map(child => <Stack key={child.id}><ElementEditor node={child} path={`${path}.${child.id}`} onChange={onChange} color={color} marks={marks} setMarks={setMarks} />
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

/** Library wire stock. `projectId` is optional context, never the stock's owner; no connector or PCB prerequisite. */
export function WireStockPanel({ projectId, workspaceId }: { projectId?: string | null; workspaceId?: string | null }) {
  const [stocks, setStocks] = useState<StockRecord[]>([]);
  const [current, setCurrent] = useState<StockRecord | null>(null);
  const [name, setName] = useState('Synthetic coax');
  const [builder, setBuilder] = useState<BuilderSpec | null>(() => INITIAL);
  const [stock, setStockState] = useState<StockSpecification>(() => generate(INITIAL, { viewed_from: stockPresets.coax!.viewed_from, facts: clone(stockPresets.coax!.facts) }));
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [dirty, setDirty] = useState(true);
  const [busy, setBusy] = useState(false);
  const [length, setLength] = useState(100);
  const [acknowledged, setAcknowledged] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const edit = usePermission('item.create');
  const [useHere, setUseHere] = useState(true);
  const freezeGate = usePermission('design.freeze');
  const preferences = usePreferenceDefaults(workspaceId);
  const [marks, setMarks] = useState<Marks>({});
  const section = useMemo(() => sectionLayout(stock), [stock]);
  const geometry = useMemo(() => stockGeometry(section, length), [section, length]);
  const fit = useMemo(() => evaluateFit(stock), [stock]);
  // An incomplete builder construction is drawn with placeholder proportions, clearly labeled.
  const illustration = useMemo(() => {
    if (!builder || section.unknown.length === 0) return null;
    const drawn = illustrate(builder);
    return { section: sectionLayout(generate(drawn.spec, stock)), substituted: drawn.substituted };
  }, [builder, section, stock]);
  /** Replace the construction; the builder follows whenever the tree is one it can regenerate. */
  const setStock = (next: StockSpecification, spec?: BuilderSpec | null) => {
    setStockState(next); setBuilder(spec !== undefined ? spec : readBuilder(next)); setAcknowledged(false);
  };
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
      const saved = await saveStock(name, stock, current, created && useHere ? projectId : null);
      setCurrent(saved); setDirty(false); setStock(clone(saved.content.stock!));
      setStocks(await listStocks(projectId));
      const failed = saved.geometry?.failed ?? 0;
      setMessage(`Saved ${saved.name} (${saved.state}).${failed ? ` Fit: ${failed} problem${failed === 1 ? '' : 's'}; review them before freezing.` : ''}`);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };
  const needsAck = fit.failed > 0;
  const freeze = async () => {
    if (!current || dirty || (needsAck && !acknowledged)) return;
    setBusy(true); setError('');
    try { const result = await freezeStock(current, needsAck && acknowledged); setMessage(`Frozen revision ${result.number}. Further edits create a new draft state.`); setCurrent({ ...current, state: result.draft.state }); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };
  // A Library row or deep link opens that stock's saved draft, as choosing it under "Saved stock" does.
  useOpenProbed(stocks.length ? id => stocks.some(item => item.definition_id === id) : null, id => {
    const record = stocks.find(item => item.definition_id === id); if (!record?.content.stock) return;
    setCurrent(record); setDirty(false); setName(record.name); setStock(clone(record.content.stock)); setMessage('');
  });
  const selectFinding = (path: string) => {
    const inside = section.rows.filter(row => row.path === path || row.path.startsWith(`${path}.`));
    setSelected(inside.at(-1)?.path ?? null);
  };
  const changed = (note = 'Unsaved changes.') => { setDirty(true); setMessage(note); };
  return <Stack>
    <Title order={2}>Wire stock</Title>
    <Text>Describe reusable stock independently of finished cables. Unknown values remain unknown.</Text>
    {error && <Alert color="red" role="alert">{error}</Alert>}{message && <Alert color="green">{message}</Alert>}
    <Group>
      <Select label="Saved stock" data={stocks.map(item => ({ value: item.draft_id, label: item.in_project ? `${item.name} · in this project` : item.name }))} value={current?.draft_id ?? null} onChange={id => {
        const record = stocks.find(item => item.draft_id === id); if (!record?.content.stock) return;
        setCurrent(record); setDirty(false); setName(record.name); setStock(clone(record.content.stock)); setMessage('');
      }} />
      <Select label="New construction" value={null} placeholder="Choose a template" data={[
        { group: 'Templates', items: TEMPLATES.map(t => ({ value: `template:${t.value}`, label: t.label })) },
        { group: 'Synthetic examples', items: Object.keys(stockPresets).map(key => ({ value: `example:${key}`, label: key })) },
      ]} onChange={key => {
        if (!key) return;
        const [kind, value] = key.split(':') as [string, string];
        if (kind === 'template') {
          const spec = blankSpec(value as BuilderSpec['template']);
          setStock(generate(spec), spec); setName(`New ${TEMPLATES.find(t => t.value === value)?.label.toLowerCase()}`);
        } else if (stockPresets[value]) { setStock(clone(stockPresets[value])); setName(`Synthetic ${value}`); }
        setCurrent(null); setDirty(true); setMessage('');
      }} />
      <TextInput label="Stock name" value={name} disabled={current !== null} onChange={e => setName(e.target.value)} />
      <Select label="Viewed from" data={['a', 'b', 'unknown']} value={stock.viewed_from} onChange={v => { if (v) { setStock({ ...stock, viewed_from: v as StockSpecification['viewed_from'] }, builder); setDirty(true); } }} />
    </Group>
    {projectId && current === null && <Checkbox label="Use in this project" checked={useHere} onChange={e => setUseHere(e.currentTarget.checked)} />}
    <Group><Button onClick={save} loading={busy} {...edit.props}>Save stock</Button><Button variant="light" onClick={freeze} disabled={!current || busy || dirty || (needsAck && !acknowledged)} {...freezeGate.props}>Freeze saved stock</Button>
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
    <Title order={3}>Construction</Title>
    <Group align="flex-start" wrap="wrap" gap="md">
      <Stack style={{ flex: '3 1 520px', minWidth: 0 }}>
        {builder
          ? <ConstructionBuilder key={`${current?.draft_id ?? 'new'}:${builder.template}`} spec={builder} onChange={spec => { setStock(generate(spec, stock), spec); changed(); }} />
          : <Alert color="yellow" title="Element-by-element construction">This construction was edited element by element, so the builder cannot regenerate it exactly. Edit it in the element editor below, or start again from a template.</Alert>}
      </Stack>
      <Stack gap="xs" style={{ flex: '2 1 360px', maxWidth: 460, minWidth: 0 }}>
        <FitFindings report={fit} onSelect={selectFinding} acknowledged={acknowledged} onAcknowledge={setAcknowledged} canFreeze={freezeGate.allowed} />
        {illustration
          ? <>
            <div className="sb-illustrative" role="note"><strong>Illustrative</strong> · placeholder proportions for unknown {illustration.substituted.join(', ')}; not dimensions.</div>
            <StockSectionView section={illustration.section} title={`${name} (illustrative)`} label="Illustrative section drawing" />
          </>
          : <StockSectionView section={section} title={name} label="Stock section drawing" selected={selected} onSelect={setSelected} />}
      </Stack>
    </Group>
    <Text>Section: {dimension(section.widthMm)} × {dimension(section.heightMm)} · {section.rows.length} material elements · view {section.viewedFrom}</Text>
    {section.unknown.length > 0 && <Alert color="yellow">Incomplete geometry: {section.unknown.join('; ')}</Alert>}
    <Group align="flex-start" grow>
      {illustration && <StockSectionView section={section} title={name} label="Stock section drawing" selected={selected} onSelect={setSelected} />}
      <Stack style={{ maxWidth: 440 }}><NumberInput label="Preview extrusion length mm" value={length} min={1} onChange={v => typeof v === 'number' && v >= 1 && setLength(v)} />
        <div aria-label="Stock geometry preview" className="sb-viewer" style={{ color: 'var(--sb-text-primary)' }} dangerouslySetInnerHTML={{ __html: renderPreviewSvg(geometry, name) }} />
        <Text size="sm">Axial length is compressed in the preview. Display colors for unknown materials are illustrative.</Text>
      </Stack>
    </Group>
    <WirePreparationPreview key={current?.draft_id ?? name} section={section} lengthMm={length} />
    <Table><Table.Thead><Table.Tr><Table.Th>Tag / element</Table.Th><Table.Th>Material / color</Table.Th><Table.Th>Dimensions</Table.Th><Table.Th>Source</Table.Th></Table.Tr></Table.Thead><Table.Tbody>
      {section.rows.map(row => <Table.Tr key={row.path}><Table.Td>{row.tag} · {row.path}<br />{row.label} ({row.kind})</Table.Td><Table.Td><Swatch look={rowLook(row)} />{row.material ?? <SbUnknown />} / {row.color ?? <SbUnknown />}</Table.Td><Table.Td><SbQuantity value={row.widthMm === null ? null : Number(row.widthMm.toFixed(4))} unit="mm" /> × <SbQuantity value={row.heightMm === null ? null : Number(row.heightMm.toFixed(4))} unit="mm" />{row.outerDiameterMm !== null && <> · bore <SbQuantity value={row.innerDiameterMm === null ? null : Number(row.innerDiameterMm.toFixed(4))} unit="mm" /></>}</Table.Td><Table.Td>{row.source ?? <SbUnknown />}</Table.Td></Table.Tr>)}
    </Table.Tbody></Table>
    <Text>{Object.entries(stock.facts).map(([key, fact]) => <span key={key}>{key}: <SbQuantity value={fact.value} unit={fact.unit ?? undefined} /> ({fact.status}) </span>)}</Text>
    <Title order={3}>End faces and information</Title>
    <CableViews stock={stock} name={name} tabs={['end-a', 'end-b', 'info']} />
    <FrozenWirePreview key={projectId ?? 'library'} projectId={projectId} />
    <Title order={3}>Engineering facts</Title>
    {Object.entries(stock.facts).map(([key, fact]) => <Group key={key} align="flex-end">
      <Text>{key}{fact.unit ? ` (${fact.unit})` : ''}</Text>
      <Select label={`${key} status`} value={fact.status} data={['unknown', 'documented', 'measured', 'inferred']} onChange={v => {
        if (!v) return; const status = v as Fact['status'];
        setStock({ ...stock, facts: { ...stock.facts, [key]: { ...fact, status, value: status === 'unknown' ? null : fact.value ?? '' } } }, builder); setDirty(true);
      }} />
      <TextInput label={`${key} value`} disabled={fact.status === 'unknown'} value={fact.value ?? ''} onChange={e => { setStock({ ...stock, facts: { ...stock.facts, [key]: { ...fact, value: e.target.value || null } } }, builder); setDirty(true); }} />
      <TextInput label={`${key} source`} value={fact.source ?? ''} onChange={e => { setStock({ ...stock, facts: { ...stock.facts, [key]: { ...fact, source: e.target.value || null } } }, builder); setDirty(true); }} />
    </Group>)}
    <details className="sb-builder-elements" open={builder === null || undefined}>
      <summary><Title order={3} component="span">Element editor (advanced)</Title></summary>
      <Text size="sm" c="dimmed">Every stored element, including ones the builder computes. Editing here can take the construction out of the builder.</Text>
      <ElementEditor color={preferences.list('wire_colors')[0] ?? null} marks={marks} setMarks={setMarks} node={stock.structure} path={stock.structure.id} onChange={(path, patch) => { setStock({ ...stock, structure: editNode(stock.structure, path, patch) }); changed(); }} />
    </details>
  </Stack>;
}
