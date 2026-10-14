import { Alert, Button, Card, Checkbox, Group, Select, Stack, Tabs, Text, TextInput, Title } from '@mantine/core';
import { Component, lazy, Suspense, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { Address, Feature, SceneNode } from '../shared-scene/api';
import type { Inspection as BomInspection, Purpose } from '../bom/api';
import { SourceError } from '../sources/api';
import { ContextSelectionProvider, useContextSelection } from './ContextSelectionProvider';
import { exactKey, sameOccurrence, selectedFeature, selectedNode } from './selection';
import { groupBomRows, readBom, validBomContext } from './reads';
import type { LoadedBom } from './reads';
import { RevisionLabel } from "../../lib/IdentityLabel";
import { useSceneMark } from '../probe';

const Viewport = lazy(() => import('../shared-scene/SceneViewport'));
const viewNames = ['tree', 'board', 'cable', 'scene', 'inspector', 'schematic', 'bom'] as const;
type View = typeof viewNames[number];
const labels: Record<View, string> = { tree: 'Context tree', board: 'Context board', cable: 'Context cable', scene: 'Context scene', inspector: 'Context inspector', schematic: 'Schematic context', bom: 'BOM context' };

class ViewerBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() { return this.state.failed ? <Alert role="alert" color="yellow">Scene viewer unavailable. Exact selection and other views remain inspectable. <Button onClick={() => window.location.reload()}>Reload contextual viewer</Button></Alert> : this.props.children; }
}

export function ConnectedViews() {
  const { state, controller, clearSelection } = useContextSelection();
  const [view, setView] = useState<View>('tree'), [visited, setVisited] = useState(() => new Set<View>(['tree']));
  if (!state.scene || state.status !== 'ready') return null;
  const selection = state.selection, node = selectedNode(state);
  return <Stack>
    <Text size="xs"><RevisionLabel id={state.scene.root.revision_id} role="root" snapshotId={state.scene.snapshot_id} sha256={state.scene.sha256} /></Text>
    <Card withBorder role="region" aria-label="Shared contextual selection">
      {selection?.kind === 'occurrence' ? <><Text>Selected occurrence: {selection.address.path.join('/')}</Text><Text size="sm">Stable feature: {selection.address.feature_id ?? 'Whole occurrence'}</Text><Text size="xs">Context identity: {exactKey(selection.address)}</Text></>
        : selection?.kind === 'revision' ? <Text><RevisionLabel id={selection.revision_id} role="Independent reusable" />. No contextual occurrence is selected.</Text>
          : <Text>No contextual occurrence selected.</Text>}
      <Group><Button variant="subtle" onClick={clearSelection}>Clear shared selection</Button>
        {node && <Button variant="subtle" onClick={() => controller.selectRevision(node.revision_id)}>Select reusable revision independently</Button>}</Group>
    </Card>
    <Tabs keepMountedMode="display-none" value={view} onChange={next => { if (next) { setView(next as View); setVisited(prior => new Set([...prior, next as View])); } }}>
      <Tabs.List aria-label="Connected contextual views">{viewNames.map(name => <Tabs.Tab value={name} key={name}>{labels[name]}</Tabs.Tab>)}</Tabs.List>
      {viewNames.map(name => <Tabs.Panel value={name} key={name}>{visited.has(name) && <section aria-label={labels[name]}>
        {name === 'tree' ? <TreeView /> : name === 'board' ? <BoardView /> : name === 'cable' ? <CableView /> : name === 'scene' ? <SceneView /> : name === 'inspector' ? <InspectorView /> : name === 'schematic' ? <SchematicView /> : <BomView />}
      </section>}</Tabs.Panel>)}
    </Tabs>
    <Text size="sm">View filters, grouping and display arrangements change no canonical placement or engineering state. Fit, clearance, electrical compatibility and physical qualification are not evaluated.</Text>
  </Stack>;
}

function OccurrenceButton({ node, prefix }: { node: SceneNode; prefix: string }) {
  const { state, controller } = useContextSelection();
  const selected = state.selection?.kind === 'occurrence' && sameOccurrence(node.address, state.selection.address);
  const mark = useSceneMark(state.scene!, node.address);
  return <Button className="sb-probe-mark" data-probe={mark ?? undefined} variant="light" aria-pressed={selected} onClick={() => controller.selectOccurrence(node.address)}>{prefix} {node.address.path.join('/')} · {node.display_ref || node.name}{mark === 'related' && <span className="sb-tag" style={{ marginLeft: 6 }}>related</span>}</Button>;
}
function OccurrenceChoices({ nodes, prefix }: { nodes: SceneNode[]; prefix: string }) {
  const [page, setPage] = useState(0);
  return <Stack>{nodes.slice(page * 50, (page + 1) * 50).map(node => <OccurrenceButton key={node.node_id} node={node} prefix={prefix} />)}
    {nodes.length > 50 && <Group><Button disabled={!page} onClick={() => setPage(p => p - 1)}>Previous {prefix.toLowerCase()} uses</Button><Button disabled={(page + 1) * 50 >= nodes.length} onClick={() => setPage(p => p + 1)}>Next {prefix.toLowerCase()} uses</Button></Group>}
  </Stack>;
}
function FeatureButton({ feature }: { feature: Feature }) {
  const { state, controller } = useContextSelection();
  const mark = useSceneMark(state.scene!, feature.address);
  return <Button className="sb-probe-mark" data-probe={mark ?? undefined} variant="light" aria-pressed={state.selection?.kind === 'occurrence' && exactKey(state.selection.address) === exactKey(feature.address)}
    onClick={() => controller.selectOccurrence(feature.address)}>Select feature {feature.feature_id} · {feature.label}{mark === 'related' && <span className="sb-tag" style={{ marginLeft: 6 }}>related</span>}</Button>;
}
function FeatureButtons({ node, features = node.features }: { node: SceneNode; features?: Feature[] }) {
  const [page, setPage] = useState(0);
  return <Stack>{features.slice(page * 50, (page + 1) * 50).map(feature => <FeatureButton key={feature.feature_id} feature={feature} />)}
    {features.length > 50 && <Group><Button disabled={!page} onClick={() => setPage(p => p - 1)}>Previous contextual features</Button><Button disabled={(page + 1) * 50 >= features.length} onClick={() => setPage(p => p + 1)}>Next contextual features</Button></Group>}
  </Stack>;
}
function TreeView() {
  const { state } = useContextSelection();
  const [filter, setFilter] = useState(''), [page, setPage] = useState(0);
  const rows = state.scene!.nodes.filter(node => `${node.address.path.join('/')} ${node.display_ref} ${node.name}`.toLowerCase().includes(filter.toLowerCase()));
  const node = selectedNode(state);
  return <Stack><Title order={3}>Occurrence tree</Title><TextInput label="Filter contextual tree" value={filter} onChange={e => { setFilter(e.currentTarget.value); setPage(0); }} />
    {node && !rows.some(n => sameOccurrence(n.address, node.address)) && <Text>Selected occurrence is hidden by this tree filter; selection is retained.</Text>}
    {rows.slice(page * 50, (page + 1) * 50).map(n => <OccurrenceButton key={n.node_id} node={n} prefix="Tree" />)}
    {rows.length > 50 && <Group><Button disabled={!page} onClick={() => setPage(p => p - 1)}>Previous tree occurrences</Button><Button disabled={(page + 1) * 50 >= rows.length} onClick={() => setPage(p => p + 1)}>Next tree occurrences</Button></Group>}
  </Stack>;
}

function point(feature: Feature): [number, number] | null {
  const position = feature.data.position;
  if (!['native_component', 'native_pad'].includes(feature.role) || !Array.isArray(position) || position.length !== 2 || !position.every(n => typeof n === 'number' && Number.isFinite(n))) return null;
  return [position[0] as number, -(position[1] as number)];
}
function BoardView() {
  const { state, controller } = useContextSelection();
  const [role, setRole] = useState('native_component');
  const node = selectedNode(state), selected = selectedFeature(state);
  const boards = state.scene!.nodes.filter(n => n.kind === 'pcb_population');
  const geometry = node ? state.scene!.geometry.find(g => node.geometry_ids.includes(g.geometry_id) && g.type === 'pcb_planar' && g.owner.revision_id === node.revision_id) : null;
  const polygons = geometry?.type === 'pcb_planar' ? [...geometry.outline, ...geometry.cutouts] : [];
  const points = polygons.flat(), minX = Math.min(...points.map(p => p[0])), maxX = Math.max(...points.map(p => p[0])), minY = Math.min(...points.map(p => p[1])), maxY = Math.max(...points.map(p => p[1]));
  const features = node?.kind === 'pcb_population' ? node.features.filter(f => f.role === role) : [];
  const width = maxX - minX, height = maxY - minY, radius = Math.max(width, height) / 150;
  return <Stack><Title order={3}>Exact native board context</Title>
    <OccurrenceChoices nodes={boards} prefix="Board" />
    {node?.kind === 'pcb_population' ? <>
      <Text>Board occurrence: {node.address.path.join('/')} · <RevisionLabel id={node.revision_id} /></Text>
      <Text size="sm">Native source and interpretation remain pinned. Illustration X/Y uses native X/−Y; depth and feature correspondence to a schematic remain unknown.</Text>
      <Select label="Board feature display" value={role} allowDeselect={false} data={[{ value: 'native_component', label: 'Native components' }, { value: 'native_pad', label: 'Native pads' }]} onChange={value => setRole(value!)} />
      {polygons.length > 0 && width > 0 && height > 0 && <svg role="img" aria-label={`Native board plane for ${node.address.path.join('/')}`} viewBox={`${minX - radius * 2} ${minY - radius * 2} ${width + radius * 4} ${height + radius * 4}`} style={{ width: '100%', height: 260 }}>
        {polygons.map((polygon, i) => <polygon key={i} points={polygon.map(p => `${p[0]},${p[1]}`).join(' ')} fill="none" stroke="currentColor" strokeWidth={radius / 3} />)}
        {features.slice(0, 50).map(feature => { const location = point(feature); return location && <circle role="button" tabIndex={0} pointerEvents="all" aria-label={`Board marker ${feature.feature_id}`} aria-pressed={selected?.feature_id === feature.feature_id} key={feature.feature_id}
          cx={location[0]} cy={location[1]} r={radius} stroke="currentColor" fill={selected?.feature_id === feature.feature_id ? 'currentColor' : 'none'} strokeWidth={radius / 3}
          onClick={() => controller.selectOccurrence(feature.address)} onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); controller.selectOccurrence(feature.address); } }}><title>{feature.label} · {feature.feature_id}</title></circle>; })}
      </svg>}
      <Text size="xs">Markers show the first 50 features as selection targets, not component or pad envelopes. Other features remain addressable in the paged list and selected by their exact IDs.</Text>
      <FeatureButtons key={node.node_id + role} node={node} features={features} />
      {selected && !features.some(f => f.feature_id === selected.feature_id) && <Text>The selected stable feature is outside this board display filter; selection is retained.</Text>}
    </> : <Text>The shared selection has no native board view. Select a PCB occurrence deliberately; no repeated board is chosen automatically.</Text>}
  </Stack>;
}

function relationshipsFor(node: SceneNode | null, featureOnly: string | null = null) {
  return (relationship: Record<string, unknown>) => !!node && Object.values(relationship).some(value => {
    if (!value || typeof value !== 'object' || !('kind' in value) || value.kind !== 'occurrence' || !('path' in value) || !Array.isArray(value.path)) return false;
    const prefix = Array.isArray(relationship.context_path) ? relationship.context_path : [];
    return JSON.stringify([...prefix, ...value.path]) === JSON.stringify(node.address.path) && (!featureOnly || ('feature_id' in value && value.feature_id === featureOnly));
  });
}
function CableView() {
  const { state } = useContextSelection();
  const node = selectedNode(state), feature = selectedFeature(state);
  const cables = state.scene!.nodes.filter(n => ['cable', 'harness'].includes(n.kind));
  const relationships = state.scene!.relationships.filter(relationshipsFor(node));
  return <Stack><Title order={3}>Cable and harness context</Title>
    <OccurrenceChoices nodes={cables} prefix="Cable" />
    {node && ['cable', 'harness'].includes(node.kind) ? <><Text>Selected cable/harness use: {node.address.path.join('/')}</Text><FeatureButtons key={node.node_id} node={node} />{node.limitations.map((text, i) => <Text size="sm" key={i}>{text}</Text>)}</>
      : <Text>The shared selection is retained; no cable or harness occurrence is selected automatically.</Text>}
    <Title order={4}>Relationships at the selected occurrence</Title>
    {relationships.map(rel => <Text size="sm" key={JSON.stringify([rel.context_path, rel.local_id])}>{rel.local_id} · {rel.kind} · {JSON.stringify(rel)}</Text>)}
    {feature && !relationships.some(relationshipsFor(node, feature.feature_id)) && <Text>No relationship addresses the exact selected feature. Occurrence-context relationships do not prove terminal correspondence.</Text>}
    <Text size="sm">Section and stock-element identities do not establish installed routes, endpoint placement or physical continuity.</Text>
  </Stack>;
}

function SceneView() {
  const { state, controller } = useContextSelection();
  const [open, setOpen] = useState(false), [arrangement, setArrangement] = useState<'canonical' | 'inspection'>('canonical');
  const node = selectedNode(state), feature = selectedFeature(state);
  const address = state.selection?.kind === 'occurrence' ? state.selection.address : null;
  const drawable = feature?.geometry_id && feature.world_transform !== null;
  const visualAddress: Address | null = address && feature && !drawable ? { snapshot_id: address.snapshot_id, path: address.path } : address;
  return <Stack><Title order={3}>Connected scene</Title>
    <Text>Scene selection: {node?.address.path.join('/') ?? 'No occurrence'} · feature {feature?.feature_id ?? 'Whole occurrence'}</Text>
    {feature && !drawable && <Text>The selected feature has no drawable 3D geometry. The containing occurrence illustration is highlighted; the exact feature selection remains unchanged.</Text>}
    <Group><Button onClick={() => setOpen(v => !v)}>{open ? 'Close connected scene' : 'Open connected scene'}</Button><Select label="Connected scene arrangement" value={arrangement} allowDeselect={false} data={[{ value: 'canonical', label: 'Canonical' }, { value: 'inspection', label: 'Local inspection' }]} onChange={next => setArrangement(next as 'canonical' | 'inspection')} /></Group>
    {open && <ViewerBoundary><Suspense fallback={<Text>Loading connected scene…</Text>}><Viewport scene={state.scene!} arrangement={arrangement} selected={visualAddress} onSelect={address => controller.selectOccurrence(address)} onRestoreCanonical={() => setArrangement('canonical')} /></Suspense></ViewerBoundary>}
  </Stack>;
}
function InspectorView() {
  const { state } = useContextSelection();
  const node = selectedNode(state), feature = selectedFeature(state);
  return <Stack><Title order={3}>Exact contextual inspector</Title>
    {node ? <><Text>Inspector occurrence: {node.address.path.join('/')}</Text><Text size="xs"><RevisionLabel id={node.revision_id} extraPins={[{ label: 'Definition ID', value: node.definition_id }]} snapshotId={node.snapshot_sha256} /></Text>
      <Text size="sm">Firmware for this use: {node.firmware?.revision_id ?? 'Unassigned'}</Text><Text size="sm">Canonical placement {node.placement.status} · world placement {node.world_status}</Text>
      <Text size="xs">{JSON.stringify(node.local_transform)} · {JSON.stringify(node.world_transform)}</Text>
      {feature && <><Text>Inspector feature: {feature.feature_id} · {feature.role}</Text><Text size="xs">{JSON.stringify(feature.data)}</Text></>}
      <FeatureButtons key={node.node_id} node={node} />
      {node.provenance.map((row, i) => <Text size="xs" key={i}>{JSON.stringify(row)}</Text>)}
    </> : <Text>No occurrence inspector is selected. A reusable revision selection has no containing placement or contextual firmware assignment.</Text>}
  </Stack>;
}
function SchematicView() {
  const { state } = useContextSelection();
  const node = selectedNode(state), feature = selectedFeature(state);
  const relationships = state.scene!.relationships.filter(rel => rel.kind === 'electrical').filter(relationshipsFor(node));
  return <Stack><Title order={3}>Exact schematic context</Title>
    <Text>Schematic occurrence context: {node?.address.path.join('/') ?? 'No occurrence'}</Text>
    <Text>Selected stable feature context: {feature?.feature_id ?? 'Whole occurrence or none'}</Text>
    <Alert color="yellow">Native schematic geometry and board-to-schematic feature correspondence are unavailable in this connected view. Reference/pin labels do not identify matching symbols or terminals.</Alert>
    <Title order={4}>Declared electrical relationships in this occurrence context</Title>
    {relationships.map(rel => <Text size="sm" key={JSON.stringify([rel.context_path, rel.local_id])}>{rel.local_id} · {JSON.stringify(rel)}</Text>)}
    {!relationships.length && <Text>No declared electrical relationships address this occurrence.</Text>}
    <Text size="sm">These exact assembly relationships record intent; they do not establish native net connectivity or physical continuity.</Text>
  </Stack>;
}

function BomView() {
  const { state, controller } = useContextSelection();
  const [id, setId] = useState(''), [purpose, setPurpose] = useState<Purpose>('assembly_contents');
  const [loaded, setLoaded] = useState<LoadedBom | null>(null), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const [grouped, setGrouped] = useState(false), [filter, setFilter] = useState(''), [page, setPage] = useState(0);
  const serial = useRef(0), mounted = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; serial.current += 1; }; }, []);
  async function load() {
    const current = ++serial.current, ticket = controller.capture();
    setLoaded(null); setError(''); setBusy(true);
    try {
      const next = await readBom(id.trim(), purpose);
      if (!mounted.current || current !== serial.current || !controller.current(ticket)) return;
      if (!validBomContext(state.scene!, next)) { setError('BOM plan does not pin this exact root revision and snapshot. Context was not remapped.'); return; }
      setLoaded(next); setPage(0);
    } catch (reason) {
      if (!mounted.current || current !== serial.current || !controller.current(ticket)) return;
      const message = reason instanceof Error ? reason.message : 'BOM context unavailable.';
      if (reason instanceof SourceError && [401, 403, 404].includes(reason.status)) controller.unavailable(ticket, message);
      else setError(message);
    } finally { if (mounted.current && current === serial.current && controller.current(ticket)) setBusy(false); }
  }
  const node = selectedNode(state), rows = loaded?.inspection.rows.filter(row => `${row.address.path.join('/')} ${row.name}`.toLowerCase().includes(filter.toLowerCase())) ?? [];
  const groups = groupBomRows(rows, grouped);
  return <Stack><Title order={3}>Occurrence-preserving BOM context</Title>
    <Text>BOM selected context: {node?.address.path.join('/') ?? 'No occurrence'} · feature {selectedFeature(state)?.feature_id ?? 'Whole occurrence or none'}</Text>
    <Text>The occurrence contents below are exact retained uses, with no invented quantities or procurement policy. A frozen BOM plan is an independent optional input.</Text>
    {!loaded && <OccurrenceChoices nodes={state.scene!.nodes} prefix="Contents" />}
    <TextInput label="Exact contextual BOM plan revision ID" value={id} onChange={e => { serial.current += 1; setId(e.currentTarget.value); setLoaded(null); setBusy(false); }} />
    <Select label="Contextual BOM purpose" value={purpose} allowDeselect={false} data={['assembly_contents', 'procurement', 'pcb_fabrication', 'pcb_population', 'consumables']} onChange={next => { serial.current += 1; setPurpose(next as Purpose); setLoaded(null); setBusy(false); }} />
    <Button disabled={!id.trim()} loading={busy} onClick={() => void load()}>Read exact contextual BOM</Button>
    {error && <Alert color="red" role="alert">{error}</Alert>}
    {loaded && <><Text size="xs"><RevisionLabel id={loaded.inspection.revision_id} role="BOM" /> · <RevisionLabel id={loaded.root.revision_id} role="assembly" snapshotId={loaded.root.snapshot_id} /></Text>
      <Checkbox label="Group BOM rows by reusable revision" checked={grouped} onChange={e => { setGrouped(e.currentTarget.checked); setPage(0); }} />
      <TextInput label="Filter contextual BOM rows" value={filter} onChange={e => { setFilter(e.currentTarget.value); setPage(0); }} />
      {node && !rows.some(row => sameOccurrence(row.address, node.address)) && <Text>Selected occurrence is outside this BOM purpose, scope or filter; its exact selection is retained.</Text>}
      {groups.slice(page * 50, (page + 1) * 50).map(group => <BomGroupCard key={JSON.stringify([filter, group.key])} revisionId={group.revision_id} rows={group.rows} />)}
      {groups.length > 50 && <Group><Button disabled={!page} onClick={() => setPage(p => p - 1)}>Previous BOM groups</Button><Button disabled={(page + 1) * 50 >= groups.length} onClick={() => setPage(p => p + 1)}>Next BOM groups</Button></Group>}
      {loaded.inspection.boundaries.map((boundary, i) => <Text size="sm" key={i}>BOM boundary {boundary.address.path.join('/') || 'Root'} · {boundary.decision}</Text>)}
      {loaded.inspection.unresolved.map((row, i) => <Text size="sm" key={i}>Unresolved {row.address.path.join('/') || 'Root'} · {row.reason}</Text>)}
    </>}
  </Stack>;
}
function BomGroupCard({ revisionId, rows }: { revisionId: string; rows: BomInspection['rows'] }) {
  const { state, controller } = useContextSelection();
  const [page, setPage] = useState(0);
  return <Card withBorder><Text><RevisionLabel id={revisionId} /> · {rows.length} contextual rows</Text><Text size="xs">Grouping shares display only. Quantities are not recomputed or combined.</Text>
        {rows.slice(page * 50, (page + 1) * 50).map((row, index) => <Group key={JSON.stringify([row.address, row.need_id, index])}>
          <Button variant="light" disabled={!row.address.path.length} aria-pressed={state.selection?.kind === 'occurrence' && sameOccurrence(row.address, state.selection.address)} onClick={() => controller.selectOccurrence(row.address)}>BOM use {row.address.path.join('/') || 'Root'}{row.need_id ? ` · need ${row.need_id} context` : ''}</Button>
          <Text size="sm">{row.quantity.amount ?? 'Unknown'} {row.quantity.unit} · {row.reason}</Text>
          {row.need_id && <Text size="xs">A supplemental need selects its owning context; it is not a physical occurrence of this revision.</Text>}
        </Group>)}
      {rows.length > 50 && <Group><Button disabled={!page} onClick={() => setPage(p => p - 1)}>Previous BOM uses</Button><Button disabled={(page + 1) * 50 >= rows.length} onClick={() => setPage(p => p + 1)}>Next BOM uses</Button></Group>}
      </Card>;
}

// Re-export the semantic provider for hosts that connect additional exact adapters.
export { ContextSelectionProvider };
