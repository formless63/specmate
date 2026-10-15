import { Autocomplete, Checkbox, ColorInput, Fieldset, Group, NumberInput, SegmentedControl, Select, SimpleGrid, Stack, Table, Text, TextInput } from '@mantine/core';
import { useState } from 'react';
import { SbQuantity } from '../../components/sb';
import { InspectionScope } from '../../lib/permissions';
import { coaxLooks, coaxName, multiUnit, areaDiameterMm, awgAreaMm2, awgDiameterMm, awgForArea, coreLooks, drainPlacement, hasDrain, hasJacket, hasWeb, layup, TEMPLATES } from './builder';
import type { BuilderSpec, Known, ShieldKind } from './builder';
import { MmEntry } from './MmEntry';

const CONDUCTOR_MATERIALS = ['copper', 'tinned copper', 'silver-plated copper', 'aluminum', 'copper-clad aluminum', 'copper-clad steel (CCS)'];
const INSULATION_MATERIALS = ['PVC', 'PE (polyethylene)', 'foam PE', 'XLPE', 'FEP', 'PTFE', 'PP (polypropylene)', 'TPE', 'silicone', 'LSZH'];
const JACKET_MATERIALS = ['PVC', 'PE (polyethylene)', 'foam PE', 'PUR (polyurethane)', 'TPE', 'silicone', 'PTFE', 'FEP', 'PP (polypropylene)', 'XLPE', 'LSZH'];
const SHIELD_MATERIALS = ['aluminum foil', 'Cu braid', 'tinned copper braid', 'copper', 'tinned copper'];
const SWATCHES = ['#d62728', '#1f1f1f', '#f2d21b', '#1f5fbf', '#2e8b3a', '#8b5a2b', '#7f7f7f', '#f2f2f2', '#ff7f0e', '#303030'];
const shown = (v: Known): Known => v === null ? null : Number(v.toFixed(4));
const cell = (label: string, value: Known, note?: string) => <div className="sb-cell" key={label}>
  <dt className="sb-silk">{label}</dt><dd data-unknown={value === null}><SbQuantity value={shown(value)} unit="mm" />{note && <Text span size="xs" c="dimmed"> {note}</Text>}</dd>
</div>;

function Color({ label, value, onChange, bare }: { label: string; value: string | null; onChange: (v: string | null) => void; bare?: boolean }) {
  // No preview swatch for an unknown color: an empty swatch would read as white.
  return <ColorInput size="xs" {...(bare ? { 'aria-label': label } : { label })} value={value ?? ''} placeholder="Unknown" format="hex" swatches={SWATCHES} swatchesPerRow={10} withPreview={value !== null}
    onChange={v => onChange(/^#[0-9a-fA-F]{6}$/.test(v) ? v.toLowerCase() : v === '' ? null : value)} />;
}
const text = (v: string) => v.trim() === '' ? null : v;

/**
 * Template-driven stock construction. The user enters real dimensions and colors;
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
  // Derived geometry, shown as discrete cells.
  const unit = mc ? multiUnit(spec) : pairs && count > 1 ? (ins === null ? null : 2 * ins) : ins;
  const lay = mc ? layup(unit, spec.multi.looks.length + spec.cores.length) : t === 'round' || pairs ? (pairs && count === 1 ? layup(ins, 2) : layup(unit, count)) : null;
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
          <Color label="Conductor color" value={spec.conductor.color} onChange={v => conductor({ color: v })} />
        </SimpleGrid>
      </Fieldset>
      <Fieldset legend={t === 'coax' ? 'Dielectric' : mc ? 'Plain core insulation' : 'Core insulation'} variant="unstyled" className="sb-builder-set">
        <SimpleGrid cols={{ base: 1, sm: t === 'coax' ? 3 : 2 }} spacing="xs">
          <MmEntry label={t === 'coax' ? 'Dielectric outer diameter' : 'Insulation outer diameter'} value={shown(ins)} onChange={v => set({ insulation: { ...spec.insulation, od_mm: v } })} />
          <Autocomplete size="xs" label={t === 'coax' ? 'Dielectric material' : 'Insulation material'} placeholder="Unknown" data={INSULATION_MATERIALS} value={spec.insulation.material ?? ''}
            onChange={v => set({ insulation: { ...spec.insulation, material: text(v) } })} />
          {t === 'coax' && <Color label="Dielectric color" value={spec.cores[0]?.color ?? null} onChange={v => set({ cores: [{ label: 'Center', color: v }] })} />}
        </SimpleGrid>
        {hasWeb(t) && <SimpleGrid cols={{ base: 1, sm: 2 }} spacing="xs">
          <MmEntry label={t === 'ribbon' ? 'Pitch (blank: touching)' : 'Center spacing (blank: touching)'} value={shown(spec.spacing_mm)} onChange={v => set({ spacing_mm: v })} />
          <MmEntry label="Web thickness" value={shown(spec.web_thickness_mm)} onChange={v => set({ web_thickness_mm: v })} />
        </SimpleGrid>}
        {t === 'round' && count >= 3 && <Checkbox size="xs" label="Center filler (fills the space between cores)" checked={spec.filler} onChange={e => set({ filler: e.currentTarget.checked })} />}
      </Fieldset>
    </SimpleGrid>
    {mc && <Fieldset legend="Coax units" variant="unstyled" className="sb-builder-set">
      <Group gap="xs" align="flex-end" wrap="wrap">
        <NumberInput size="xs" w={110} label="Coax units" min={1} max={24} allowDecimal={false} value={spec.multi.looks.length}
          onChange={v => { const n = Number(v); if (Number.isInteger(n) && n >= 1 && n <= 24) setCoaxCount(n); }} />
        <NumberInput size="xs" w={130} label="Plain cores" min={0} max={24} allowDecimal={false} value={spec.cores.length}
          onChange={v => { const n = Number(v); if (Number.isInteger(n) && n >= 0 && n <= 24) setPlainCount(n); }} />
        <MmEntry label="Coax center diameter" value={shown(spec.multi.center_mm)} onChange={v => multi({ center_mm: v })} />
        <MmEntry label="Coax dielectric diameter" value={shown(spec.multi.dielectric_od_mm)} onChange={v => multi({ dielectric_od_mm: v })} />
        <Autocomplete size="xs" label="Coax dielectric material" placeholder="Unknown" data={INSULATION_MATERIALS} value={spec.multi.dielectric_material ?? ''} onChange={v => multi({ dielectric_material: text(v) })} />
      </Group>
      <Group gap="xs" align="flex-end" wrap="wrap">
        <Select size="xs" w={130} label="Coax screen" value={spec.multi.screen} data={[{ value: 'none', label: 'None' }, { value: 'foil', label: 'Foil' }, { value: 'braid', label: 'Braid' }]}
          onChange={v => v && multi({ screen: v as BuilderSpec['multi']['screen'] })} />
        {spec.multi.screen !== 'none' && <MmEntry label="Coax screen thickness" value={shown(spec.multi.screen_thickness_mm)} onChange={v => multi({ screen_thickness_mm: v })} />}
        {spec.multi.screen !== 'none' && <Autocomplete size="xs" label="Coax screen material" placeholder="Unknown" data={SHIELD_MATERIALS} value={spec.multi.screen_material ?? ''} onChange={v => multi({ screen_material: text(v) })} />}
        <Checkbox size="xs" label="Own jacket on each coax" checked={spec.multi.jacket} onChange={e => multi({ jacket: e.currentTarget.checked })} />
        {spec.multi.jacket && <MmEntry label="Coax jacket outer diameter" value={shown(spec.multi.jacket_od_mm)} onChange={v => multi({ jacket_od_mm: v })} />}
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
    </Fieldset>}
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
          <Color label="Jacket color" value={spec.jacket.color} onChange={v => set({ jacket: { ...spec.jacket, color: v } })} />
        </SimpleGrid>
        <Text size="xs" c="dimmed">Outer diameter and wall together set the bore; either alone fits the jacket to the screen or cores.</Text>
      </Fieldset>
    </SimpleGrid>}
    {problems.map(p => <Text key={p} size="sm" c="red" role="status">{p}</Text>)}
    <dl className="sb-context" aria-label="Computed lay-up" style={{ borderBottom: 0, padding: 0 }}>
      {lay && cell(lay.arrangement === 'ring' ? 'Ring diameter (centers)' : lay.arrangement === 'linear' ? 'Core spacing' : 'Lay-up', lay.arrangement === 'concentric' ? 0 : lay.pitch, lay.arrangement === 'concentric' ? 'single unit, centerd' : undefined)}
      {lay && cell('Lay-up diameter', lay.outerRadius === null ? null : 2 * lay.outerRadius)}
      {pitch !== null || hasWeb(t) ? cell(t === 'ribbon' ? 'Pitch' : 'Center spacing', pitch) : null}
      {hasJacket(t) && cell(spec.shield === 'none' ? 'Jacket bore (content)' : 'Screen bore', bore)}
      {drain && cell('Drain offset from axis', drain.x === null || drain.y === null ? null : Math.hypot(drain.x, drain.y))}
    </dl>
  </Stack></InspectionScope>;
}
