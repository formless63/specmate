import { Component, lazy, Suspense, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { Alert, Button, NumberInput, Stack, Tabs, Text } from '@mantine/core';
import { sectionLayout } from '../../../../packages/section-layout/src';
import type { StockSpecification } from '../../../../packages/section-layout/src';
import { unpreparedProfile, wireModel } from '../../../../packages/wire-geometry/src/model';
import { EndFaceView } from './EndFaceView';
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

/** Cross-section, side view, both end faces, 3D model and information for one exact stock. */
export type ViewTab = 'section' | 'side' | 'end-a' | 'end-b' | '3d' | 'info';
const ALL: ViewTab[] = ['section', 'side', 'end-a', 'end-b', '3d', 'info'];
/**
 * `preparation` draws the side view's prepared ends; `choosePreparation` (needs a query client and an
 * exact `revisionId`) lets the viewer pick a frozen end preparation profile for this stock instead.
 */
export function CableViews({ stock, name, revisionId, terminationLabels, tabs = ALL, preparation, choosePreparation = false }: { stock: StockSpecification; name: string; revisionId?: string | null; terminationLabels?: Record<string, string>; tabs?: ViewTab[]; preparation?: SidePreparation | null; choosePreparation?: boolean }) {
  const section = useMemo(() => sectionLayout(stock), [stock]);
  const [selected, setSelected] = useState<string | null>(null);
  const [length, setLength] = useState(100);
  const [picked, setPicked] = useState<SidePreparation | null>(null);
  const [profileRevision, setProfileRevision] = useState('');
  const prepared = preparation ?? (picked && picked.stockRevisionId === revisionId ? picked : null);
  return <Tabs defaultValue={tabs[0]} keepMounted={false} aria-label="Cable views" style={{ minWidth: 0, maxWidth: '100%' }}>
    <Tabs.List>
      {tabs.includes('section') && <Tabs.Tab value="section">Cross-section</Tabs.Tab>}
      {tabs.includes('side') && <Tabs.Tab value="side">Side view</Tabs.Tab>}
      {tabs.includes('end-a') && <Tabs.Tab value="end-a">End A face</Tabs.Tab>}
      {tabs.includes('end-b') && <Tabs.Tab value="end-b">End B face</Tabs.Tab>}
      {tabs.includes('3d') && <Tabs.Tab value="3d">3D model</Tabs.Tab>}
      {tabs.includes('info') && <Tabs.Tab value="info">Information</Tabs.Tab>}
    </Tabs.List>
    {tabs.includes('section') && <Tabs.Panel value="section" pt="sm"><StockSectionView section={section} title={name} label="Cable section drawing" selected={selected} onSelect={setSelected} /></Tabs.Panel>}
    {tabs.includes('side') && <Tabs.Panel value="side" pt="sm"><Stack gap="xs">
      {choosePreparation && revisionId && preparation === undefined && <PreparationSource stockRevisionId={revisionId} revisionId={profileRevision} onRevision={setProfileRevision} onChange={setPicked} />}
      <SideView section={section} title={name} preparation={prepared} selected={selected} onSelect={setSelected} />
    </Stack></Tabs.Panel>}
    {tabs.includes('end-a') && <Tabs.Panel value="end-a" pt="sm"><EndFaceView section={section} end="a" labels={terminationLabels} selected={selected} /></Tabs.Panel>}
    {tabs.includes('end-b') && <Tabs.Panel value="end-b" pt="sm"><EndFaceView section={section} end="b" labels={terminationLabels} selected={selected} /></Tabs.Panel>}
    {tabs.includes('3d') && <Tabs.Panel value="3d" pt="sm" style={{ minWidth: 0 }}><Stack gap="xs" style={{ minWidth: 0 }}>
      <NumberInput label="Preview length mm" description="A display length for the straight model, not this cable's length." value={length} min={1} w={260} onChange={v => typeof v === 'number' && v >= 1 && setLength(v)} />
      <Wire3d stock={stock} lengthMm={length} />
    </Stack></Tabs.Panel>}
    {tabs.includes('info') && <Tabs.Panel value="info" pt="sm"><StockInfo stock={stock} section={section} name={name} revisionId={revisionId} /></Tabs.Panel>}
  </Tabs>;
}
