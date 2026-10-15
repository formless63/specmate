import { lazy, Suspense, useMemo, useState } from 'react';
import { Alert, Group, NumberInput, SegmentedControl, Select, Slider, Stack, Text } from '@mantine/core';
import { wireModel, unpreparedProfile } from '../../../../packages/wire-geometry/src/model';
import type { DisplayProfile, End } from '../../../../packages/wire-geometry/src/model';
import type { Section } from '../../../../packages/section-layout/src';
import { cutValue, layerPaths, withLayerCut, type StripLayer } from './display-controls';
const WireViewport = lazy(() => import('./WireViewport'));

export function StockDisplay({ section, active, preset }: { section: Section; active: boolean; preset?: DisplayProfile }) {
  const [local, setLocal] = useState<DisplayProfile | null>(null);
  const profile = local ?? preset ?? unpreparedProfile();
  const [length, setLength] = useState(100);
  const [end, setEnd] = useState<End>('a');
  const [shown, setShown] = useState<'a' | 'b' | 'both'>('both');
  const jacket = cutValue(profile, layerPaths(section, 'jacket'), end);
  const screen = cutValue(profile, layerPaths(section, 'screen'), end);
  const keep = jacket !== null && jacket > 0 && screen !== null ? Math.max(0, Math.min(100, 100 * (jacket - screen) / jacket)) : null;
  const model = useMemo(() => wireModel(section, length, profile), [section, length, profile]);
  const layers: { key: StripLayer; label: string }[] = [{ key: 'jacket', label: 'Jacket' }, { key: 'sheath', label: 'Sheath' }, { key: 'screen', label: 'Screen' }, { key: 'insulation', label: 'Insulation' }];
  const displayControls = <>
    <Group gap="xs" align="flex-end" wrap="wrap"><Select size="xs" w={150} label="Strip preset" value={local?.id === "unprepared" ? "unprepared" : local ? "custom" : preset?.id ?? "unprepared"} data={[{ value: "unprepared", label: "Bare cut" }, ...(preset ? [{ value: preset.id, label: preset.label }] : []), ...(local ? [{ value: "custom", label: "Custom display" }] : [])]} onChange={value => { if (value === "unprepared") setLocal(unpreparedProfile()); else if (value === preset?.id) setLocal(null); }} /><SegmentedControl size="xs" aria-label="End shown" value={shown} onChange={value => { setShown(value as typeof shown); if (value !== 'both') setEnd(value as End); }} data={[{ value: 'a', label: 'End A' }, { value: 'b', label: 'End B' }, { value: 'both', label: 'Full' }]} />
      <NumberInput size="xs" w={135} label="Preview length mm" min={1} max={20000} value={length} onChange={value => { if (typeof value === 'number' && value > 0) setLength(value); }} />
      <SegmentedControl size="xs" aria-label="Cut controls for end" value={end} onChange={value => setEnd(value as End)} data={[{ value: 'a', label: 'Cut A' }, { value: 'b', label: 'Cut B' }]} />
    </Group>
    <Text size="xs" className="sb-dash-note">{profile.label}. Cuts and preview length change the illustration only; stock construction and recorded practices stay unchanged.</Text>
  </>;
  return <Stack gap="xs" className="stock-record-display">
    {model.unknown.length > 0 && <details><summary>{model.unknown.length} geometry item{model.unknown.length === 1 ? '' : 's'} unknown</summary>{model.unknown.map((message, index) => <Text size="xs" key={index}>{message}</Text>)}</details>}
    {model.pieces.length === 0 ? <>{displayControls}<Alert color="yellow">No complete geometry to draw. Unknown dimensions remain unknown; use the section drawing and construction inspector.</Alert></> : active ? <Suspense fallback={<Text role="status">Loading wire model…</Text>}><WireViewport model={model} active={active} shownEnd={shown} displayControls={displayControls} compactControls /></Suspense> : null}
    <details><summary>Layer cut controls</summary><Text size="xs">Jacket controls top-level jackets; Sheath controls nested jackets. Drain entries remain separate.</Text>    <Group gap="xs" align="flex-end" wrap="wrap">{layers.map(layer => {
      const paths = layerPaths(section, layer.key);
      const value = cutValue(profile, paths, end);
      return paths.length > 0 && <Stack key={layer.key} gap={3} w={135}><NumberInput size="xs" label={`${layer.label} cut mm`} placeholder="Varies / unknown" min={0} max={length} value={value ?? ''} onChange={next => setLocal(withLayerCut(profile, paths, end, typeof next === 'number' ? next : null))} /><Slider size="xs" aria-label={`${layer.label} display cut`} min={0} max={length} value={value ?? 0} label={value === null ? 'Unknown' : null} onChange={next => setLocal(withLayerCut(profile, paths, end, next))} /></Stack>;
    })}</Group>
    {layerPaths(section, 'screen').length > 0 && <Stack gap={3} w={180}><Text size="xs">Screen keep: {keep === null ? 'Unknown · set jacket cut first' : `${Math.round(keep)}%`}</Text><Slider size="xs" aria-label="Screen keep percent" min={0} max={100} disabled={jacket === null || jacket <= 0} value={keep ?? 0} label={null} onChange={value => { if (jacket !== null && jacket > 0) setLocal(withLayerCut(profile, layerPaths(section, 'screen'), end, jacket * (1 - value / 100))); }} /></Stack>}
</details>
    {local && <button className="sb-ws-open" type="button" onClick={() => setLocal(null)}>Reset display cuts</button>}
  </Stack>;
}
