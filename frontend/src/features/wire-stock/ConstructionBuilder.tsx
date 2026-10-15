import { Autocomplete, Button, Checkbox, ColorInput, Group, SegmentedControl, Select, SimpleGrid, Stack, Table, Text, TextInput } from '@mantine/core';
import { useMemo, useState } from 'react';
import { SbQuantity } from '../../components/sb';
import { InspectionScope, usePermission } from '../../lib/permissions';
import { rowLook, Swatch } from '../cable-views/Swatch';
import type { FitReport, Section, StockSpecification } from '../../../../packages/section-layout/src';
import { coaxLooks, coaxName, areaDiameterMm, awgAreaMm2, awgDiameterMm, awgForArea, coreLooks, hasDrain, hasJacket, hasWeb, TEMPLATES } from './builder';
import type { BuilderSpec, Known, ShieldKind } from './builder';
import { contentDiameter, derivedLayup, fitFixes, fitOverlay, jacketPath, stockMeters, OD_STEP_MM } from './builder-visual';
import { DimRow, Stepper } from './BuilderParts';
import { FitFindings, fitWord } from './FitFindings';
import { SectionCanvas } from './SectionCanvas';

const CONDUCTOR_MATERIALS = ['copper', 'tinned copper', 'silver-plated copper', 'aluminum', 'copper-clad aluminum', 'copper-clad steel (CCS)'];
const INSULATION_MATERIALS = ['PVC', 'PE (polyethylene)', 'foam PE', 'XLPE', 'FEP', 'PTFE', 'PP (polypropylene)', 'TPE', 'silicone', 'LSZH'];
const JACKET_MATERIALS = ['PVC', 'PE (polyethylene)', 'foam PE', 'PUR (polyurethane)', 'TPE', 'silicone', 'PTFE', 'FEP', 'PP (polypropylene)', 'XLPE', 'LSZH'];
const SHIELD_MATERIALS = ['aluminum foil', 'Cu braid', 'tinned copper braid', 'copper', 'tinned copper'];
const SWATCHES = ['#d62728', '#1f1f1f', '#f2d21b', '#1f5fbf', '#2e8b3a', '#8b5a2b', '#7f7f7f', '#f2f2f2', '#ff7f0e', '#303030'];
const shown = (v: Known): Known => v === null ? null : Number(v.toFixed(4));
const cell = (label: string, value: Known, note?: string, unit = 'mm') => <div className="sb-cell" key={label}>
  <dt className="sb-silk">{label}</dt><dd data-unknown={value === null}><SbQuantity value={shown(value)} unit={unit} />{note && <Text span size="xs" c="dimmed"> {note}</Text>}</dd>
</div>;
const FIT_LED = { problems: 'failed', incomplete: 'not-evaluated', ok: 'active', nothing_to_check: 'idle' } as const;

function Color({ label, value, onChange, bare }: { label: string; value: string | null; onChange: (v: string | null) => void; bare?: boolean }) {
  // No preview swatch for an unknown color: an empty swatch would read as white.
  return <ColorInput size="xs" {...(bare ? { 'aria-label': label } : { label })} value={value ?? ''} placeholder="Unknown" format="hex" swatches={SWATCHES} swatchesPerRow={10} withPreview={value !== null}
    onChange={v => onChange(/^#[0-9a-fA-F]{6}$/.test(v) ? v.toLowerCase() : v === '' ? null : value)} />;
}
const text = (v: string) => v.trim() === '' ? null : v;

export interface BuilderContext {
  stock: StockSpecification; section: Section; fit: FitReport; name: string;
  /** Placeholder-proportion drawing of an incomplete construction, with what was substituted. */
  illustration: { section: Section; substituted: string[] } | null;
  selected: string | null; onSelect: (path: string | null) => void; onSelectFinding: (path: string) => void;
  acknowledged: boolean; onAcknowledge: (value: boolean) => void; canFreeze: boolean;
}

/**
 * Visual-first stock construction. The cross-section is the primary surface: steppers, sliders
 * and a draggable jacket-edge handle edit the real dimensions, and fit findings are drawn on the
 * section. Labels, materials and colors live in the inspector disclosure. A value derived from an
 * unknown input stays unknown; unknown inputs are drawn illustratively and labeled.
 */
export function ConstructionBuilder({ spec, onChange, view }: { spec: BuilderSpec; onChange: (next: BuilderSpec) => void; view: BuilderContext }) {
  const [sizeBy, setSizeBy] = useState<'diameter' | 'awg' | 'area'>(() => awgForArea(spec.conductor.area_mm2) !== null ? 'awg' : spec.conductor.area_mm2 !== null && spec.conductor.diameter_mm === null ? 'area' : 'diameter');
  const [awg, setAwg] = useState<number | string>(() => awgForArea(spec.conductor.area_mm2) ?? '');
  const edit = usePermission('item.create');
  const { stock, section, fit, illustration } = view;
  const t = spec.template;
  const set = (patch: Partial<BuilderSpec>) => onChange({ ...spec, ...patch });
  const conductor = (patch: Partial<BuilderSpec['conductor']>) => set({ conductor: { ...spec.conductor, ...patch } });
  const stranded = spec.conductor.construction === 'stranded';
  const pairs = t === 'pairs';
  const count = pairs ? spec.cores.length / 2 : spec.cores.length;
  const countLimits = t === 'round' ? [1, 24] : pairs ? [1, 8] : t === 'ribbon' ? [2, 64] : null;
  const setCount = (n: number) => set({ cores: coreLooks(t, n).map((look, i) => spec.cores[i] ?? look) });
  const multi = (patch: Partial<BuilderSpec['multi']>) => set({ multi: { ...spec.multi, ...patch } });
  const mc = t === 'multicoax';
  const setCoaxCount = (n: number) => multi({ looks: coaxLooks(n).map((look, i) => spec.multi.looks[i] ?? look) });
  const setPlainCount = (n: number) => set({ cores: coreLooks(t, n).map((look, i) => spec.cores[i] ?? look) });
  const sizeFromAwg = (n: number) => {
    // AWG fixes the nominal area; a stranded conductor's overall diameter is not the solid-equivalent one.
    conductor({ area_mm2: Number(awgAreaMm2(n).toFixed(4)), ...(stranded ? {} : { diameter_mm: Number(awgDiameterMm(n).toFixed(4)) }) });
  };
  const ins = spec.insulation.od_mm, cd = spec.conductor.diameter_mm;
  const problems: string[] = [];
  if (ins !== null && cd !== null && ins <= cd) problems.push(`${t === 'coax' ? 'Dielectric' : 'Insulation'} diameter must exceed the conductor diameter.`);
  if (spec.jacket.od_mm !== null && spec.jacket.wall_mm !== null && spec.jacket.od_mm <= 2 * spec.jacket.wall_mm) problems.push('Jacket wall is too thick for its outer diameter.');

  const { lay, drain, bore, pitch } = derivedLayup(spec);
  const meters = useMemo(() => stockMeters(spec, stock, section), [spec, stock, section]);
  const overlay = useMemo(() => fitOverlay(section, fit), [section, fit]);
  const fixes = useMemo(() => fitFixes(spec, stock, section, fit), [spec, stock, section, fit]);
  // The handle sits on the drawn jacket: the illustrative one while inputs are unknown.
  const drawn = illustration?.section ?? section;
  const jacketFeature = drawn.features.find(f => f.path === jacketPath(stock));
  const drawnContent = contentDiameter(stock, drawn);
  const handle = hasJacket(t) && jacketFeature?.shape.type === 'ring' && drawnContent !== null
    ? { od: Number((jacketFeature.shape.rOuter * 2).toFixed(4)), minOd: Math.max(0.1, Number((drawnContent + OD_STEP_MM).toFixed(4))) } : null;
  const setOd = (od: number) => set({ jacket: { ...spec.jacket, od_mm: od } });

  const controls = <Stack gap="sm" className="sb-stock-controls" aria-label="Construction controls">
    <Group gap="sm" align="flex-end" wrap="wrap">
      <Text size="sm" fw={600}>{TEMPLATES.find(x => x.value === t)?.label}</Text>
      {countLimits && <Stepper label={pairs ? 'Pairs' : 'Cores'} value={count} min={countLimits[0]!} max={countLimits[1]!} onChange={setCount} />}
      {mc && <Stepper label="Coax units" value={spec.multi.looks.length} min={1} max={24} onChange={setCoaxCount} />}
      {mc && <Stepper label="Plain cores" value={spec.cores.length} min={0} max={24} onChange={setPlainCount} />}
    </Group>
    <section className="sb-stock-group" aria-label="Conductor"><h3 className="sb-silk">Conductor</h3>
      <Group gap="xs" align="flex-end" wrap="wrap">
        <SegmentedControl size="xs" aria-label="Conductor size by" value={sizeBy} onChange={v => setSizeBy(v as typeof sizeBy)} disabled={!edit.allowed}
          data={[{ value: 'diameter', label: 'Diameter' }, { value: 'awg', label: 'AWG' }, { value: 'area', label: 'Area' }]} />
        {sizeBy === 'awg' && <TextInput size="xs" w={80} label="AWG" type="number" min={0} max={40} step={1} value={awg}
          onChange={e => { const v = e.target.value; setAwg(v); const n = Number(v); if (v !== '' && Number.isInteger(n) && n >= 0 && n <= 40) sizeFromAwg(n); }} />}
        {sizeBy === 'area' && <TextInput size="xs" w={110} label="Area mm²" type="number" min={0} step={0.01} value={spec.conductor.area_mm2 ?? ''}
          onChange={e => { const v = Number(e.target.value); const a = e.target.value !== '' && v > 0 ? v : null; conductor({ area_mm2: a, ...(stranded || a === null ? {} : { diameter_mm: Number(areaDiameterMm(a).toFixed(4)) }) }); }} />}
      </Group>
      {sizeBy !== 'diameter' && stranded && <Text size="xs" c="dimmed">Stranded: the size sets the nominal area only. Enter the overall conductor diameter from the datasheet.</Text>}
      <DimRow label="Conductor diameter" value={shown(cd)} max={6} onChange={v => conductor({ diameter_mm: v })} />
    </section>
    <section className="sb-stock-group" aria-label={t === 'coax' ? 'Dielectric' : 'Insulation'}><h3 className="sb-silk">{t === 'coax' ? 'Dielectric' : mc ? 'Plain core insulation' : 'Core insulation'}</h3>
      <DimRow label={t === 'coax' ? 'Dielectric outer diameter' : 'Insulation outer diameter'} value={shown(ins)} max={12} onChange={v => set({ insulation: { ...spec.insulation, od_mm: v } })} />
      {hasWeb(t) && <>
        <DimRow label={t === 'ribbon' ? 'Pitch (blank: touching)' : 'Center spacing (blank: touching)'} value={shown(spec.spacing_mm)} max={10} onChange={v => set({ spacing_mm: v })} />
        <DimRow label="Web thickness" value={shown(spec.web_thickness_mm)} max={3} onChange={v => set({ web_thickness_mm: v })} />
      </>}
    </section>
    {mc && <section className="sb-stock-group" aria-label="Coax unit"><h3 className="sb-silk">Each coax unit</h3>
      <DimRow label="Coax center diameter" value={shown(spec.multi.center_mm)} max={3} onChange={v => multi({ center_mm: v })} />
      <DimRow label="Coax dielectric diameter" value={shown(spec.multi.dielectric_od_mm)} max={8} onChange={v => multi({ dielectric_od_mm: v })} />
      <SegmentedControl size="xs" aria-label="Coax screen" value={spec.multi.screen} disabled={!edit.allowed} onChange={v => multi({ screen: v as BuilderSpec['multi']['screen'] })}
        data={[{ value: 'none', label: 'No screen' }, { value: 'foil', label: 'Foil' }, { value: 'braid', label: 'Braid' }]} />
      {spec.multi.screen !== 'none' && <DimRow label="Coax screen thickness" value={shown(spec.multi.screen_thickness_mm)} max={0.6} onChange={v => multi({ screen_thickness_mm: v })} />}
      <Checkbox size="xs" label="Own jacket on each coax" checked={spec.multi.jacket} onChange={e => multi({ jacket: e.currentTarget.checked })} />
      {spec.multi.jacket && <DimRow label="Coax jacket outer diameter" value={shown(spec.multi.jacket_od_mm)} max={10} onChange={v => multi({ jacket_od_mm: v })} />}
    </section>}
    {hasJacket(t) && <section className="sb-stock-group" aria-label="Screen"><h3 className="sb-silk">Screen</h3>
      <SegmentedControl size="xs" aria-label="Screen" value={spec.shield} disabled={!edit.allowed} onChange={v => set({ shield: v as ShieldKind })}
        data={[{ value: 'none', label: 'None' }, { value: 'foil', label: 'Foil' }, { value: 'braid', label: 'Braid' }, { value: 'foil+braid', label: 'Foil + braid' }]} />
      {(spec.shield === 'foil' || spec.shield === 'foil+braid') && <DimRow label="Foil thickness" value={shown(spec.foil_thickness_mm)} max={0.3} onChange={v => set({ foil_thickness_mm: v })} />}
      {(spec.shield === 'braid' || spec.shield === 'foil+braid') && <DimRow label="Braid thickness" value={shown(spec.braid_thickness_mm)} max={0.6} onChange={v => set({ braid_thickness_mm: v })} />}
      {hasDrain(t) && <Checkbox size="xs" label="Drain wire" checked={spec.drain} onChange={e => set({ drain: e.currentTarget.checked })} />}
      {hasDrain(t) && spec.drain && <DimRow label="Drain diameter" value={shown(spec.drain_diameter_mm)} max={2} onChange={v => set({ drain_diameter_mm: v })} />}
    </section>}
    {hasJacket(t) && <section className="sb-stock-group" aria-label="Jacket"><h3 className="sb-silk">Jacket</h3>
      <DimRow label="Jacket outer diameter" value={shown(spec.jacket.od_mm)} max={30} step={OD_STEP_MM / 5} onChange={v => set({ jacket: { ...spec.jacket, od_mm: v } })} />
      <DimRow label="Jacket wall" value={shown(spec.jacket.wall_mm)} max={4} onChange={v => set({ jacket: { ...spec.jacket, wall_mm: v } })} />
      <Text size="xs" c="dimmed">Drag the handle on the jacket edge to set the outer diameter. Outer diameter and wall together set the bore; either alone fits the jacket to the screen or cores.</Text>
    </section>}
    {problems.map(p => <Text key={p} size="sm" c="red" role="status">{p}</Text>)}
  </Stack>;

  const inspector = <details className="sb-builder-inspector">
    <summary>Inspector: source, materials, colors and labels</summary>
    <Stack gap="xs" mt="xs">
      <TextInput size="xs" label="Source of these values" placeholder="Unknown (for example a datasheet and revision)" value={spec.source ?? ''} onChange={e => set({ source: text(e.target.value) })} />
      <SimpleGrid cols={{ base: 1, md: 2 }} spacing="xs">
        <Stack gap="xs">
          <Select size="xs" label="Conductor construction" value={spec.conductor.construction ?? 'unknown'} data={['unknown', 'solid', 'stranded']}
            onChange={v => conductor({ construction: v === 'solid' || v === 'stranded' ? v : null })} />
          <Autocomplete size="xs" label="Conductor material" placeholder="Unknown" data={CONDUCTOR_MATERIALS} value={spec.conductor.material ?? ''} onChange={v => conductor({ material: text(v) })} />
          <Color label="Conductor color" value={spec.conductor.color} onChange={v => conductor({ color: v })} />
        </Stack>
        <Stack gap="xs">
          <Autocomplete size="xs" label={t === 'coax' ? 'Dielectric material' : 'Insulation material'} placeholder="Unknown" data={INSULATION_MATERIALS} value={spec.insulation.material ?? ''}
            onChange={v => set({ insulation: { ...spec.insulation, material: text(v) } })} />
          {t === 'coax' && <Color label="Dielectric color" value={spec.cores[0]?.color ?? null} onChange={v => set({ cores: [{ label: 'Center', color: v }] })} />}
          {t === 'round' && count >= 3 && <Checkbox size="xs" label="Center filler (fills the space between cores)" checked={spec.filler} onChange={e => set({ filler: e.currentTarget.checked })} />}
          {hasJacket(t) && spec.shield !== 'none' && <Autocomplete size="xs" label="Screen material" placeholder="Unknown" data={SHIELD_MATERIALS} value={spec.shield_material ?? ''} onChange={v => set({ shield_material: text(v) })} />}
        </Stack>
      </SimpleGrid>
      {mc && <>
        <Group gap="xs" align="flex-end" wrap="wrap">
          <Autocomplete size="xs" label="Coax dielectric material" placeholder="Unknown" data={INSULATION_MATERIALS} value={spec.multi.dielectric_material ?? ''} onChange={v => multi({ dielectric_material: text(v) })} />
          {spec.multi.screen !== 'none' && <Autocomplete size="xs" label="Coax screen material" placeholder="Unknown" data={SHIELD_MATERIALS} value={spec.multi.screen_material ?? ''} onChange={v => multi({ screen_material: text(v) })} />}
          {spec.multi.jacket && <Autocomplete size="xs" label="Coax jacket material" placeholder="Unknown" data={JACKET_MATERIALS} value={spec.multi.jacket_material ?? ''} onChange={v => multi({ jacket_material: text(v) })} />}
          <Select size="xs" w={260} label="Quick coax color code" placeholder="Choose to fill all coax colors" value={null} clearable={false}
            data={[{ value: 'sequence', label: 'Hook-up sequence (red, black, yellow, ...)' }, { value: 'unknown', label: 'Clear: all colors unknown' }]}
            onChange={v => { if (v === 'sequence' || v === 'unknown') multi({ looks: coaxLooks(spec.multi.looks.length, v).map((look, i) => ({ label: spec.multi.looks[i]?.label ?? look.label, color: look.color })) }); }} />
        </Group>
        <Table className="sb-ws-table" withRowBorders={false} aria-label="Coax units">
          <Table.Thead><Table.Tr><Table.Th>Coax</Table.Th><Table.Th>Label</Table.Th><Table.Th>{spec.multi.jacket ? 'Jacket color' : 'Dielectric color'}</Table.Th><Table.Th>Shown as</Table.Th></Table.Tr></Table.Thead>
          <Table.Tbody>{spec.multi.looks.map((look, i) => <Table.Tr key={i}>
            <Table.Td className="sb-mono">{i + 1}</Table.Td>
            <Table.Td><TextInput size="xs" aria-label={`Coax ${i + 1} label`} value={look.label} onChange={e => multi({ looks: spec.multi.looks.map((c, j) => j === i ? { ...c, label: e.target.value || c.label } : c) })} /></Table.Td>
            <Table.Td><Color bare label={`Coax ${i + 1} color`} value={look.color} onChange={v => multi({ looks: spec.multi.looks.map((c, j) => j === i ? { ...c, color: v } : c) })} /></Table.Td>
            <Table.Td className="sb-mono">{coaxName(look)} center</Table.Td>
          </Table.Tr>)}</Table.Tbody>
        </Table>
      </>}
      {t !== 'coax' && !(mc && spec.cores.length === 0) && <Select size="xs" w={260} label="Quick color code" aria-label="Quick color code" placeholder="Choose to fill all core colors" value={null} clearable={false}
        data={[{ value: 'sequence', label: pairs ? 'Pair sequence (blue/white, orange/white, ...)' : 'Hook-up sequence (red, black, yellow, blue, ...)' }, { value: 'unknown', label: 'Clear: all colors unknown' }]}
        onChange={v => { if (v === 'sequence' || v === 'unknown') set({ cores: coreLooks(t, count, v).map((look, i) => ({ label: spec.cores[i]?.label ?? look.label, color: look.color })) }); }} />}
      {t !== 'coax' && !(mc && spec.cores.length === 0) && <Table className="sb-ws-table" withRowBorders={false} aria-label="Cores">
        <Table.Thead><Table.Tr><Table.Th>Core</Table.Th><Table.Th>Label</Table.Th><Table.Th>Insulation color</Table.Th></Table.Tr></Table.Thead>
        <Table.Tbody>{spec.cores.map((look, i) => <Table.Tr key={i}>
          <Table.Td className="sb-mono">{pairs ? `${Math.floor(i / 2) + 1}${i % 2 ? 'B' : 'A'}` : i + 1}</Table.Td>
          <Table.Td><TextInput size="xs" aria-label={`Core ${i + 1} label`} value={look.label} onChange={e => set({ cores: spec.cores.map((c, j) => j === i ? { ...c, label: e.target.value || c.label } : c) })} /></Table.Td>
          <Table.Td><Color bare label={`Core ${i + 1} color`} value={look.color} onChange={v => set({ cores: spec.cores.map((c, j) => j === i ? { ...c, color: v } : c) })} /></Table.Td>
        </Table.Tr>)}</Table.Tbody>
      </Table>}
      {hasJacket(t) && <SimpleGrid cols={{ base: 1, sm: 2 }} spacing="xs">
        <Autocomplete size="xs" label="Jacket material" placeholder="Unknown" data={JACKET_MATERIALS} value={spec.jacket.material ?? ''} onChange={v => set({ jacket: { ...spec.jacket, material: text(v) } })} />
        <Color label="Jacket color" value={spec.jacket.color} onChange={v => set({ jacket: { ...spec.jacket, color: v } })} />
      </SimpleGrid>}
    </Stack>
  </details>;

  return <InspectionScope permission="item.create"><Stack gap="xs" aria-label="Construction builder">
    <dl className="sb-context sb-stock-meters" aria-label="Computed lay-up">
      {lay && cell(lay.arrangement === 'ring' ? 'Ring diameter (centers)' : lay.arrangement === 'linear' ? 'Core spacing' : 'Lay-up', lay.arrangement === 'concentric' ? 0 : lay.pitch, lay.arrangement === 'concentric' ? 'single unit, centered' : undefined)}
      {lay && cell('Lay-up diameter', meters.layupDiameter)}
      {hasWeb(t) && cell(t === 'ribbon' ? 'Pitch' : 'Center spacing', pitch)}
      {hasJacket(t) && cell(spec.shield === 'none' ? 'Jacket bore (content)' : 'Screen bore', bore)}
      {drain && cell('Drain offset from axis', drain.x === null || drain.y === null ? null : Math.hypot(drain.x, drain.y))}
      {hasJacket(t) && cell('Jacket bore', meters.jacketBore)}
      {hasJacket(t) && cell('Min jacket OD', meters.minJacketOd, meters.wallKnown ? undefined : 'wall unknown')}
      {hasJacket(t) && cell('Jacket OD', meters.jacketOd)}
      {hasJacket(t) && cell('Fill', meters.fillPercent, undefined, '%')}
      <div className="sb-cell" key="fit"><dt className="sb-silk">Fit</dt>
        <dd><span className="sb-led" data-state={FIT_LED[fit.status]} aria-hidden="true" /> {fitWord(fit)}</dd></div>
    </dl>
    <div className="sb-stock-grid">
      <div className="sb-stock-stage">
        {illustration && <div className="sb-illustrative" role="note"><strong>Illustrative</strong> · placeholder proportions for unknown {illustration.substituted.join(', ')}; not dimensions.</div>}
        <SectionCanvas section={drawn} title={illustration ? `${view.name} (illustrative)` : view.name} label={illustration ? 'Illustrative section drawing' : 'Stock section drawing'}
          selected={view.selected} onSelect={view.onSelect} overlay={illustration ? undefined : overlay} handle={edit.allowed ? handle : null} editable={edit.allowed} onOd={setOd} />
        {fixes.length > 0 && <Group gap="xs" className="sb-stock-fixes" aria-label="Fit fixes">
          {fixes.map(fix => <Button key={fix.id} size="xs" variant="light" color="red" title={fix.detail} onClick={() => onChange(fix.apply(spec))} {...edit.props}>{fix.label}</Button>)}
          <Text size="xs" c="dimmed">{fixes[0]!.detail}</Text>
        </Group>}
        <Group gap="xs" role="group" aria-label="Section key">
          {drawn.rows.map(row => {
            const look = rowLook(row), on = view.selected === row.path;
            return <button key={row.path} type="button" aria-pressed={on} className="sb-key-chip" title={look.notes.join('; ') || row.path} onClick={() => view.onSelect(on ? null : row.path)}>
              <Swatch look={look} />{row.tag} {row.label}{look.fillSource === 'unknown' ? ' (color unknown)' : ''}
            </button>;
          })}
        </Group>
        <FitFindings report={fit} onSelect={view.onSelectFinding} acknowledged={view.acknowledged} onAcknowledge={view.onAcknowledge} canFreeze={view.canFreeze} />
      </div>
      {controls}
    </div>
    {inspector}
  </Stack></InspectionScope>;
}
