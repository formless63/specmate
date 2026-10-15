import { Component, lazy, Suspense, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { Alert, Button, NumberInput, Stack, Table, Tabs, Text } from '@mantine/core';
import { sectionLayout } from '../../../../packages/section-layout/src';
import type { StockSpecification } from '../../../../packages/section-layout/src';
import { unpreparedProfile, wireModel } from '../../../../packages/wire-geometry/src/model';
import { EndFaceView } from './EndFaceView';
import type { StockEnd } from '../../../../packages/section-layout/src';
import { SbUnknown } from '../../components/sb';
import { StockInfo } from './StockInfo';
import { StockSectionView } from './StockSectionView';
import { PreparationSource } from './PreparationSource';
import { SideView } from './SideView';
import type { SidePreparation } from './SideView';

// Three.js enters the browser only after the 3D tab is opened and its button pressed.
const WireViewport = lazy(() => import('../wire-stock/WireViewport'));
class Boundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() { return this.state.failed ? <Alert color="yellow">The 3D viewer could not load. The section, end faces and information remain available.</Alert> : this.props.children; }
}
function Wire3d({ stock, lengthMm }: { stock: StockSpecification; lengthMm: number }) {
  const [open, setOpen] = useState(false);
  const model = useMemo(() => wireModel(sectionLayout(stock), lengthMm, unpreparedProfile()), [stock, lengthMm]);
  return <Stack gap="xs">
    <Button variant="light" onClick={() => setOpen(v => !v)} w="fit-content">{open ? 'Close 3D view' : 'Open 3D view'}</Button>
    {model.unknown.length > 0 && <Alert color="yellow">3D incomplete: {model.unknown.join('; ')}</Alert>}
    {open && <Boundary><Suspense fallback={<Text>Loading 3D viewer…</Text>}><WireViewport model={model} /></Suspense></Boundary>}
  </Stack>;
}

/**
 * One cable end as recorded on the cable: the stock end it uses (`unknown` is never guessed) and
 * what each stock element lands on at that end, by element path.
 */
export type CableEnd = { endpointId: string; label: string; stockEnd: 'a' | 'b' | 'unknown'; terminations: Record<string, string> };

/** Ends whose stock end is unknown: not drawn on either face, their landings listed and labeled unknown. */
function UnplacedEnds({ ends }: { ends: CableEnd[] }) {
  if (ends.length === 0) return null;
  return <Stack gap={4} aria-label="Ends not placed on an end face">
    {ends.map(e => <Stack key={e.endpointId} gap={2}>
      <Text size="sm">{e.label} ({e.endpointId}): <SbUnknown what="Stock end" /> Not placed on an end face.</Text>
      {Object.keys(e.terminations).length > 0 && <Table aria-label={`${e.label} landings`}><Table.Tbody>{Object.entries(e.terminations).map(([path, text]) => <Table.Tr key={path}><Table.Td>{path}</Table.Td><Table.Td>{text}</Table.Td></Table.Tr>)}</Table.Tbody></Table>}
    </Stack>)}
  </Stack>;
}

/** Cross-section, side view, both end faces, 3D model and information for one exact stock. */
export type ViewTab = 'section' | 'side' | 'end-a' | 'end-b' | '3d' | 'info';
const ALL: ViewTab[] = ['section', 'side', 'end-a', 'end-b', '3d', 'info'];
/**
 * `preparation` draws the side view's prepared ends; `choosePreparation` (needs a query client and an
 * exact `revisionId`) lets the viewer pick a frozen end preparation profile for this stock instead.
 */
export function CableViews({ stock, name, revisionId, terminationLabels, cableEnds, tabs = ALL, preparation, choosePreparation = false }: { stock: StockSpecification; name: string; revisionId?: string | null; terminationLabels?: Record<string, string>; cableEnds?: CableEnd[]; tabs?: ViewTab[]; preparation?: SidePreparation | null; choosePreparation?: boolean }) {
  const section = useMemo(() => sectionLayout(stock), [stock]);
  // With cable ends, each stock end face shows the cable end recorded on it and only its landings.
  const onEnd = (end: StockEnd) => cableEnds?.find(e => e.stockEnd === end) ?? null;
  const unplaced = cableEnds?.filter(e => e.stockEnd === 'unknown') ?? [];
  const face = (end: StockEnd) => {
    const placed = onEnd(end);
    return <Stack gap="xs">
      <EndFaceView section={section} end={end} labels={placed ? placed.terminations : terminationLabels} selected={selected} placed={cableEnds ? (placed ? { endpointId: placed.endpointId, label: placed.label } : null) : undefined} />
      <UnplacedEnds ends={unplaced} />
    </Stack>;
  };
  const tabName = (end: StockEnd) => { const placed = onEnd(end); return `End ${end.toUpperCase()} face${placed ? ` · ${placed.label}` : ''}`; };
  const [selected, setSelected] = useState<string | null>(null);
  const [length, setLength] = useState(100);
  const [picked, setPicked] = useState<SidePreparation | null>(null);
  const [profileRevision, setProfileRevision] = useState('');
  const prepared = preparation ?? (picked && picked.stockRevisionId === revisionId ? picked : null);
  return <Tabs defaultValue={tabs[0]} keepMounted={false} aria-label="Cable views" style={{ minWidth: 0, maxWidth: '100%' }}>
    <Tabs.List>
      {tabs.includes('section') && <Tabs.Tab value="section">Cross-section</Tabs.Tab>}
      {tabs.includes('side') && <Tabs.Tab value="side">Side view</Tabs.Tab>}
      {tabs.includes('end-a') && <Tabs.Tab value="end-a">{tabName('a')}</Tabs.Tab>}
      {tabs.includes('end-b') && <Tabs.Tab value="end-b">{tabName('b')}</Tabs.Tab>}
      {tabs.includes('3d') && <Tabs.Tab value="3d">3D model</Tabs.Tab>}
      {tabs.includes('info') && <Tabs.Tab value="info">Information</Tabs.Tab>}
    </Tabs.List>
    {tabs.includes('section') && <Tabs.Panel value="section" pt="sm"><StockSectionView section={section} title={name} label="Cable section drawing" selected={selected} onSelect={setSelected} /></Tabs.Panel>}
    {tabs.includes('side') && <Tabs.Panel value="side" pt="sm"><Stack gap="xs">
      {choosePreparation && revisionId && preparation === undefined && <PreparationSource stockRevisionId={revisionId} revisionId={profileRevision} onRevision={setProfileRevision} onChange={setPicked} />}
      <SideView section={section} title={name} preparation={prepared} selected={selected} onSelect={setSelected} />
    </Stack></Tabs.Panel>}
    {tabs.includes('end-a') && <Tabs.Panel value="end-a" pt="sm">{face('a')}</Tabs.Panel>}
    {tabs.includes('end-b') && <Tabs.Panel value="end-b" pt="sm">{face('b')}</Tabs.Panel>}
    {tabs.includes('3d') && <Tabs.Panel value="3d" pt="sm" style={{ minWidth: 0 }}><Stack gap="xs" style={{ minWidth: 0 }}>
      <NumberInput label="Preview length mm" description="A display length for the straight model, not this cable's length." value={length} min={1} w={260} onChange={v => typeof v === 'number' && v >= 1 && setLength(v)} />
      <Wire3d stock={stock} lengthMm={length} />
    </Stack></Tabs.Panel>}
    {tabs.includes('info') && <Tabs.Panel value="info" pt="sm"><StockInfo stock={stock} section={section} name={name} revisionId={revisionId} /></Tabs.Panel>}
  </Tabs>;
}
