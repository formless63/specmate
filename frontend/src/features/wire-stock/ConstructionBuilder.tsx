import { Autocomplete, Checkbox, ColorInput, Fieldset, Group, NumberInput, SegmentedControl, Select, SimpleGrid, Stack, Table, Text, TextInput } from '@mantine/core';
import { useState } from 'react';
import { SbQuantity } from '../../components/sb';
import { InspectionScope } from '../../lib/permissions';
import { areaDiameterMm, awgAreaMm2, awgDiameterMm, awgForArea, coreLooks, drainPlacement, hasDrain, hasJacket, hasWeb, layup, TEMPLATES } from './builder';
import type { BuilderSpec, Known, ShieldKind } from './builder';
import { MmEntry } from './MmEntry';

const CONDUCTOR_MATERIALS = ['copper', 'tinned copper', 'silver-plated copper', 'aluminium', 'copper-clad aluminium'];
const INSULATION_MATERIALS = ['PVC', 'polyethylene', 'foam polyethylene', 'XLPE', 'FEP', 'PTFE', 'silicone', 'polypropylene'];
const JACKET_MATERIALS = ['PVC', 'polyurethane (PUR)', 'TPE', 'silicone', 'polyethylene'];
const SHIELD_MATERIALS = ['aluminium foil', 'tinned copper', 'copper'];
const SWATCHES = ['#d62728', '#1f1f1f', '#f2d21b', '#1f5fbf', '#2e8b3a', '#8b5a2b', '#7f7f7f', '#f2f2f2', '#ff7f0e', '#303030'];
const shown = (v: Known): Known => v === null ? null : Number(v.toFixed(4));
const cell = (label: string, value: Known, note?: string) => <div className="sb-cell" key={label}>
  <dt className="sb-silk">{label}</dt><dd data-unknown={value === null}><SbQuantity value={shown(value)} unit="mm" />{note && <Text span size="xs" c="dimmed"> {note}</Text>}</dd>
</div>;

function Colour({ label, value, onChange, bare }: { label: string; value: string | null; onChange: (v: string | null) => void; bare?: boolean }) {
  // No preview swatch for an unknown colour: an empty swatch would read as white.
  return <ColorInput size="xs" {...(bare ? { 'aria-label': label } : { label })} value={value ?? ''} placeholder="Unknown" format="hex" swatches={SWATCHES} swatchesPerRow={10} withPreview={value !== null}
    onChange={v => onChange(/^#[0-9a-fA-F]{6}$/.test(v) ? v.toLowerCase() : v === '' ? null : value)} />;
}
const text = (v: string) => v.trim() === '' ? null : v;

/**
 * Template-driven stock construction. The user enters real dimensions and colours;
 * the lay-up, ring radius, drain position and screen/jacket bores are computed. A
 * value derived from an unknown input stays unknown.
 */
export function ConstructionBuilder({ spec, onChange }: { spec: BuilderSpec; onChange: (next: BuilderSpec) => void }) {
  const [sizeBy, setSizeBy] = useState<'diameter' | 'awg' | 'area'>(() => awgForArea(spec.conductor.area_mm2) !== null ? 'awg' : spec.conductor.area_mm2 !== null && spec.conductor.diameter_mm === null ? 'area' : 'diameter');
  const [awg, setAwg] = useState<number | string>(() => awgForArea(spec.conductor.area_mm2) ?? '');
  const t = spec.template;
  const set = (patch: Partial<BuilderSpec>) => onChange({ ...spec, ...patch });
  const conductor = (patch: Partial<BuilderSpec['conductor']>) => set({ conductor: { ...spec.conductor, ...patch } });
  const stranded = spec.conductor.construction === 'stranded';
  const pairs = t === 'pairs';
  const count = pairs ? spec.cores.length / 2 : spec.cores.length;
  const countLimits = t === 'round' ? [1, 24] : pairs ? [1, 8] : t === 'ribbon' ? [2, 64] : null;
  const setCount = (n: number) => {
    const fresh = coreLooks(t, n);
    set({ cores: fresh.map((look, i) => spec.cores[i] ?? look) });
  };
  const sizeFromAwg = (n: number) => {
    // AWG fixes the nominal area; a stranded conductor's overall diameter is not the solid-equivalent one.
    conductor({ area_mm2: Number(awgAreaMm2(n).toFixed(4)), ...(stranded ? {} : { diameter_mm: Number(awgDiameterMm(n).toFixed(4)) }) });
  };
  const ins = spec.insulation.od_mm, cd = spec.conductor.diameter_mm;
  const problems: string[] = [];
  if (ins !== null && cd !== null && ins <= cd) problems.push(`${t === 'coax' ? 'Dielectric' : 'Insulation'} diameter must exceed the conductor diameter.`);
  if (spec.jacket.od_mm !== null && spec.jacket.wall_mm !== null && spec.jacket.od_mm <= 2 * spec.jacket.wall_mm) problems.push('Jacket wall is too thick for its outer diameter.');
  // Derived geometry, shown as discrete cells.
  const unit = pairs && count > 1 ? (ins === null ? null : 2 * ins) : ins;
  const lay = t === 'round' || pairs ? (pairs && count === 1 ? layup(ins, 2) : layup(unit, count)) : null;
  const drain = lay && spec.drain ? drainPlacement(lay, spec.drain_diameter_mm) : null;
  const bore = lay ? (drain ? (drain.boreRadius === null ? null : 2 * drain.boreRadius) : (lay.outerRadius === null ? null : 2 * lay.outerRadius)) : (t === 'coax' ? ins : null);
  const pitch = hasWeb(t) ? spec.spacing_mm ?? ins : null;
  return <InspectionScope permission="item.create"><Stack gap="xs" aria-label="Construction builder">
    <Group align="flex-end" gap="sm" wrap="wrap">
      <Text size="sm" fw={600}>{TEMPLATES.find(x => x.value === t)?.label}</Text>
      {countLimits && <NumberInput size="xs" w={130} label={pairs ? 'Pairs' : 'Cores'} min={countLimits[0]} max={countLimits[1]} value={count} allowDecimal={false}
        onChange={v => { const n = Number(v); if (Number.isInteger(n) && n >= countLimits[0]! && n <= countLimits[1]!) setCount(n); }} />}
      <TextInput size="xs" style={{ flex: 1, minWidth: 220 }} label="Source of these values" placeholder="Unknown (for example a datasheet and revision)" value={spec.source ?? ''} onChange={e => set({ source: text(e.target.value) })} />
    </Group>
    <SimpleGrid cols={{ base: 1, md: 2 }} spacing="xs">
      <Fieldset legend="Conductor" variant="unstyled" className="sb-builder-set">
        <Group gap="xs" align="flex-end" wrap="wrap">
          <Select size="xs" w={110} label="Construction" value={spec.conductor.construction ?? 'unknown'} data={['unknown', 'solid', 'stranded']}
            onChange={v => conductor({ construction: v === 'solid' || v === 'stranded' ? v : null })} />
          <SegmentedControl size="xs" aria-label="Conductor size by" value={sizeBy} onChange={v => setSizeBy(v as typeof sizeBy)}
            data={[{ value: 'diameter', label: 'Diameter' }, { value: 'awg', label: 'AWG' }, { value: 'area', label: 'Area' }]} />
          {sizeBy === 'awg' && <NumberInput size="xs" w={80} label="AWG" min={0} max={40} allowDecimal={false} value={awg}
            onChange={v => { setAwg(v); const n = Number(v); if (v !== '' && Number.isInteger(n) && n >= 0 && n <= 40) sizeFromAwg(n); }} />}
          {sizeBy === 'area' && <NumberInput size="xs" w={110} label="Area mm²" min={0} decimalScale={4} value={spec.conductor.area_mm2 ?? ''}
            onChange={v => { const a = typeof v === 'number' && v > 0 ? v : null; conductor({ area_mm2: a, ...(stranded || a === null ? {} : { diameter_mm: Number(areaDiameterMm(a).toFixed(4)) }) }); }} />}
        </Group>
        {sizeBy !== 'diameter' && stranded && <Text size="xs" c="dimmed">Stranded: the size sets the nominal area only. Enter the overall conductor diameter from the datasheet.</Text>}
        <SimpleGrid cols={{ base: 1, sm: 3 }} spacing="xs">
          <MmEntry label="Conductor diameter" value={shown(cd)} onChange={v => conductor({ diameter_mm: v })} />
          <Autocomplete size="xs" label="Conductor material" placeholder="Unknown" data={CONDUCTOR_MATERIALS} value={spec.conductor.material ?? ''} onChange={v => conductor({ material: text(v) })} />
          <Colour label="Conductor colour" value={spec.conductor.color} onChange={v => conductor({ color: v })} />
        </SimpleGrid>
      </Fieldset>
      <Fieldset legend={t === 'coax' ? 'Dielectric' : 'Core insulation'} variant="unstyled" className="sb-builder-set">
        <SimpleGrid cols={{ base: 1, sm: t === 'coax' ? 3 : 2 }} spacing="xs">
          <MmEntry label={t === 'coax' ? 'Dielectric outer diameter' : 'Insulation outer diameter'} value={shown(ins)} onChange={v => set({ insulation: { ...spec.insulation, od_mm: v } })} />
          <Autocomplete size="xs" label={t === 'coax' ? 'Dielectric material' : 'Insulation material'} placeholder="Unknown" data={INSULATION_MATERIALS} value={spec.insulation.material ?? ''}
            onChange={v => set({ insulation: { ...spec.insulation, material: text(v) } })} />
          {t === 'coax' && <Colour label="Dielectric colour" value={spec.cores[0]?.color ?? null} onChange={v => set({ cores: [{ label: 'Centre', color: v }] })} />}
        </SimpleGrid>
        {hasWeb(t) && <SimpleGrid cols={{ base: 1, sm: 2 }} spacing="xs">
          <MmEntry label={t === 'ribbon' ? 'Pitch (blank: touching)' : 'Centre spacing (blank: touching)'} value={shown(spec.spacing_mm)} onChange={v => set({ spacing_mm: v })} />
          <MmEntry label="Web thickness" value={shown(spec.web_thickness_mm)} onChange={v => set({ web_thickness_mm: v })} />
        </SimpleGrid>}
        {t === 'round' && count >= 3 && <Checkbox size="xs" label="Centre filler (fills the space between cores)" checked={spec.filler} onChange={e => set({ filler: e.currentTarget.checked })} />}
      </Fieldset>
    </SimpleGrid>
    {t !== 'coax' && <Table className="sb-ws-table" withRowBorders={false} aria-label="Cores">
      <Table.Thead><Table.Tr><Table.Th>Core</Table.Th><Table.Th>Label</Table.Th><Table.Th>Insulation colour</Table.Th></Table.Tr></Table.Thead>
      <Table.Tbody>{spec.cores.map((look, i) => <Table.Tr key={i}>
        <Table.Td className="sb-mono">{pairs ? `${Math.floor(i / 2) + 1}${i % 2 ? 'B' : 'A'}` : i + 1}</Table.Td>
        <Table.Td><TextInput size="xs" aria-label={`Core ${i + 1} label`} value={look.label} onChange={e => set({ cores: spec.cores.map((c, j) => j === i ? { ...c, label: e.target.value || c.label } : c) })} /></Table.Td>
        <Table.Td><Colour bare label={`Core ${i + 1} colour`} value={look.color} onChange={v => set({ cores: spec.cores.map((c, j) => j === i ? { ...c, color: v } : c) })} /></Table.Td>
      </Table.Tr>)}</Table.Tbody>
    </Table>}
    {hasJacket(t) && <SimpleGrid cols={{ base: 1, md: 2 }} spacing="xs">
      <Fieldset legend="Screen" variant="unstyled" className="sb-builder-set">
        <Group gap="xs" align="flex-end" wrap="wrap">
          <Select size="xs" w={130} label="Screen" value={spec.shield} data={[{ value: 'none', label: 'None' }, { value: 'foil', label: 'Foil' }, { value: 'braid', label: 'Braid' }, { value: 'foil+braid', label: 'Foil + braid' }]}
            onChange={v => v && set({ shield: v as ShieldKind })} />
          {(spec.shield === 'foil' || spec.shield === 'foil+braid') && <MmEntry label="Foil thickness" value={shown(spec.foil_thickness_mm)} onChange={v => set({ foil_thickness_mm: v })} />}
          {(spec.shield === 'braid' || spec.shield === 'foil+braid') && <MmEntry label="Braid thickness" value={shown(spec.braid_thickness_mm)} onChange={v => set({ braid_thickness_mm: v })} />}
          {spec.shield !== 'none' && <Autocomplete size="xs" label="Screen material" placeholder="Unknown" data={SHIELD_MATERIALS} value={spec.shield_material ?? ''} onChange={v => set({ shield_material: text(v) })} />}
        </Group>
        {hasDrain(t) && <Group gap="xs" align="flex-end">
          <Checkbox size="xs" label="Drain wire" checked={spec.drain} onChange={e => set({ drain: e.currentTarget.checked })} />
          {spec.drain && <MmEntry label="Drain diameter" value={shown(spec.drain_diameter_mm)} onChange={v => set({ drain_diameter_mm: v })} />}
        </Group>}
      </Fieldset>
      <Fieldset legend="Jacket" variant="unstyled" className="sb-builder-set">
        <SimpleGrid cols={{ base: 1, sm: 2 }} spacing="xs">
          <MmEntry label="Jacket outer diameter" value={shown(spec.jacket.od_mm)} onChange={v => set({ jacket: { ...spec.jacket, od_mm: v } })} />
          <MmEntry label="Jacket wall" value={shown(spec.jacket.wall_mm)} onChange={v => set({ jacket: { ...spec.jacket, wall_mm: v } })} />
          <Autocomplete size="xs" label="Jacket material" placeholder="Unknown" data={JACKET_MATERIALS} value={spec.jacket.material ?? ''} onChange={v => set({ jacket: { ...spec.jacket, material: text(v) } })} />
          <Colour label="Jacket colour" value={spec.jacket.color} onChange={v => set({ jacket: { ...spec.jacket, color: v } })} />
        </SimpleGrid>
        <Text size="xs" c="dimmed">Outer diameter and wall together set the bore; either alone fits the jacket to the screen or cores.</Text>
      </Fieldset>
    </SimpleGrid>}
    {problems.map(p => <Text key={p} size="sm" c="red" role="status">{p}</Text>)}
    <dl className="sb-context" aria-label="Computed lay-up" style={{ borderBottom: 0, padding: 0 }}>
      {lay && cell(lay.arrangement === 'ring' ? 'Ring diameter (centres)' : lay.arrangement === 'linear' ? 'Core spacing' : 'Lay-up', lay.arrangement === 'concentric' ? 0 : lay.pitch, lay.arrangement === 'concentric' ? 'single unit, centred' : undefined)}
      {lay && cell('Lay-up diameter', lay.outerRadius === null ? null : 2 * lay.outerRadius)}
      {pitch !== null || hasWeb(t) ? cell(t === 'ribbon' ? 'Pitch' : 'Centre spacing', pitch) : null}
      {hasJacket(t) && cell(spec.shield === 'none' ? 'Jacket bore (content)' : 'Screen bore', bore)}
      {drain && cell('Drain offset from axis', drain.x === null || drain.y === null ? null : Math.hypot(drain.x, drain.y))}
    </dl>
  </Stack></InspectionScope>;
}
