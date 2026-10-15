import { ReadOnlyNote, usePermission } from "../../lib/permissions";
import { useEffect, useMemo, useState } from 'react';
import { Alert, Button, Checkbox, Group, NumberInput, Select, Stack, Table, Text, TextInput, Title } from '@mantine/core';
import { evaluateFit, renderPreviewSvg, renderSectionSvg, sectionLayout, stockGeometry } from '../../../../packages/section-layout/src';
import type { Fact, StockSpecification } from '../../../../packages/section-layout/src';
import { freezeStock, listStocks, saveStock } from './api';
import type { StockRecord } from './api';
import { stockPresets } from './presets';
import { WirePreparationPreview } from './WirePreparationPreview';
import { FrozenWirePreview } from './FrozenWirePreview';
import { CableViews } from '../cable-views/CableViews';
import { StockSectionView } from '../cable-views/StockSectionView';
import { SbQuantity, SbUnknown } from '../../components/sb';
import { rowLook, Swatch } from '../cable-views/Swatch';
import { usePreferenceDefaults } from '../preferences/usePreferenceDefaults';
import { useOpenProbed } from '../scope/openProbed';
import { blankSpec, exampleCoax, generate, illustrate, readBuilder, TEMPLATES } from './builder';
import type { BuilderSpec } from './builder';
import { ConstructionBuilder } from './ConstructionBuilder';
import { FitFindings } from './FitFindings';
import { TemplateStrip } from './TemplateStrip';
import { fitOverlay } from './builder-visual';
import { SectionCanvas } from './SectionCanvas';
import { ElementEditor, editStockNode, type Marks } from "./ElementEditor";
import { MmEntry } from './MmEntry';
import './wire-stock.css';

export { MmEntry };

/** Element kinds whose display color a wire-color preference may pre-fill. */

const clone = <T,>(value: T): T => structuredClone(value);
const dimension = (value: number | null) => <SbQuantity value={value === null ? null : Number(value.toFixed(4))} unit="mm" />;
const INITIAL = exampleCoax();
function download(name: string, body: string, type: string): void {
  const url = URL.createObjectURL(new Blob([body], { type }));
  const link = document.createElement('a'); link.href = url; link.download = name; link.click();
  URL.revokeObjectURL(url);
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
    <TemplateStrip onChoose={kind => {
      const spec = blankSpec(kind);
      setStock(generate(spec), spec); setName(`New ${TEMPLATES.find(t => t.value === kind)?.label.toLowerCase()}`);
      setCurrent(null); setDirty(true); setMessage('');
    }} />
    <details className="sb-builder-advanced">
      <summary>Synthetic examples</summary>
      <Group gap="xs">{Object.keys(stockPresets).map(key => <Button key={key} size="xs" variant="light" {...edit.props} onClick={() => {
        setStock(clone(stockPresets[key]!)); setName(`Synthetic ${key}`); setCurrent(null); setDirty(true); setMessage('');
      }}>{key}</Button>)}</Group>
    </details>
    <Group>
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
    {builder
      ? <ConstructionBuilder key={`${current?.draft_id ?? 'new'}:${builder.template}`} spec={builder} onChange={spec => { setStock(generate(spec, stock), spec); changed(); }}
        view={{ stock, section, fit, name, illustration, selected, onSelect: setSelected, onSelectFinding: selectFinding, acknowledged, onAcknowledge: setAcknowledged, canFreeze: freezeGate.allowed }} />
      : <Stack gap="xs">
        <Alert color="yellow" title="Element-by-element construction">This construction was edited element by element, so the builder cannot regenerate it exactly. Edit it in the element editor below, or start again from a template.</Alert>
        <div className="sb-stock-stage">
          <SectionCanvas section={section} title={name} selected={selected} onSelect={setSelected} overlay={fitOverlay(section, fit)} editable={false} />
          <FitFindings report={fit} onSelect={selectFinding} acknowledged={acknowledged} onAcknowledge={setAcknowledged} canFreeze={freezeGate.allowed} />
        </div>
      </Stack>}
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
      <ElementEditor color={preferences.list('wire_colors')[0] ?? null} marks={marks} setMarks={setMarks} node={stock.structure} path={stock.structure.id} onChange={(path, patch) => { setStock({ ...stock, structure: editStockNode(stock.structure, path, patch) }); changed(); }} />
    </details>
  </Stack>;
}
