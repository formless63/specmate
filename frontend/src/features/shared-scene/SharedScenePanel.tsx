import { Alert, Badge, Button, Card, Group, Select, Stack, Table, Text, TextInput, Title } from '@mantine/core';
import { Component, lazy, Suspense, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { request, selectionKey } from './api';
import type { Address, Geometry, SceneChoices, SceneNode, SharedScene } from './api';
import { RevisionLabel } from "../../lib/IdentityLabel";
import { useSceneMark, useSceneProbe, useSceneRelated } from "../probe";

const Viewport = lazy(() => import('./SceneViewport'));
const none: SceneChoices = { assemblies: [], window: 'latest_50_frozen_revisions' };

class ViewerBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() {
    return this.state.failed ? <Alert color="yellow" role="alert">Scene viewer could not load. Occurrence inspection remains available. <Button onClick={() => window.location.reload()}>Reload viewer page</Button></Alert> : this.props.children;
  }
}

export function SharedScenePanel({ projectId = null }: { projectId?: string | null }) {
  return <Workspace key={projectId ?? 'library'} projectId={projectId} />;
}

function Workspace({ projectId }: { projectId: string | null }) {
  const [choices, setChoices] = useState<SceneChoices>(none);
  const [snapshot, setSnapshot] = useState<string | null>(null);
  const [exact, setExact] = useState('');
  const [scene, setScene] = useState<SharedScene | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [show3d, setShow3d] = useState(false);
  const [arrangement, setArrangement] = useState<'canonical' | 'inspection'>('canonical');
  // The selected use is the shared probe inside the shell (so other views and the URL follow it).
  const [selected, setSelected, forgetSelection] = useSceneProbe(scene, choices.assemblies.find(a => a.snapshot_id === snapshot)?.number ?? null);
  const related = useSceneRelated(scene);
  const generation = useRef(0), mounted = useRef(false);
  const currentSnapshot = useRef<string | null>(null);

  async function refresh(target = currentSnapshot.current) {
    const token = ++generation.current;
    // Hide previously authorized information during every explicit authority check.
    setScene(null); setChoices(none); forgetSelection(); setShow3d(false); setError(''); setLoading(true);
    try {
      const [nextChoices, nextScene] = await Promise.all([
        request<SceneChoices>('shared-scenes/workspace'),
        target ? request<SharedScene>(`shared-scenes/snapshots/${target}`) : Promise.resolve(null),
      ]);
      if (!mounted.current || token !== generation.current) return;
      if (nextScene && nextScene.snapshot_id !== target) throw new Error('Scene response does not match the selected snapshot.');
      setChoices(nextChoices); setScene(nextScene);
    } catch (reason) {
      if (!mounted.current || token !== generation.current) return;
      // A denial invalidates all in-flight reads; a stale success cannot reopen the scene.
      generation.current += 1; setScene(null); setChoices(none); forgetSelection(); setShow3d(false);
      setError(reason instanceof Error ? reason.message : 'Scene request failed.'); setLoading(false);
    } finally { if (mounted.current && token === generation.current) setLoading(false); }
  }
  useEffect(() => {
    mounted.current = true;
    void refresh();
    const visible = () => { if (document.visibilityState !== 'hidden') void refresh(); };
    window.addEventListener('focus', visible); document.addEventListener('visibilitychange', visible);
    return () => { mounted.current = false; generation.current += 1; window.removeEventListener('focus', visible); document.removeEventListener('visibilitychange', visible); };
  }, [projectId]);
  function inspect(id: string | null) { currentSnapshot.current = id; setSnapshot(id); setArrangement('canonical'); void refresh(id); }
  const node = scene?.nodes.find(n => selected && n.address.snapshot_id === selected.snapshot_id && JSON.stringify(n.address.path) === JSON.stringify(selected.path));
  return <Stack>
    <Title order={2}>Shared scene</Title>
    <Text>Inspect an exact frozen assembly across disciplines. Every nested use retains its own selection, placements, source pins and firmware assignment. Unknown geometry and unplaced items remain in the occurrence list.</Text>
    <Button loading={loading} onClick={() => void refresh()}>Refresh scene access</Button>
    {error && <Alert color="red" role="alert">{error}</Alert>}
    <Select label="Frozen assembly scene" aria-label="Frozen assembly scene" searchable value={snapshot} data={choices.assemblies.map(a => ({ value: a.snapshot_id, label: `${a.name} · revision ${a.number}` }))} onChange={inspect} disabled={loading} />
    <Text size="xs">Choices cover the latest 50 frozen assembly revisions and current readable closures. An older exact snapshot can be opened below.</Text>
    <Group align="end"><TextInput label="Exact frozen assembly snapshot ID" value={exact} onChange={e => setExact(e.currentTarget.value)} /><Button disabled={!exact.trim() || loading} onClick={() => inspect(exact.trim())}>Inspect exact scene</Button></Group>
    {loading && <Text>Checking current scene and source access…</Text>}
    {scene && <>
      <Text size="xs"><RevisionLabel id={scene.root.revision_id} role="Root" snapshotId={scene.snapshot_id} sha256={scene.sha256} /></Text>
      <Text size="sm">Canonical frame: {scene.frame} · {scene.units} · {scene.matrix_convention}</Text>
      <Text size="sm">Fit, clearance and manufacturing: not evaluated. Physical qualification: false.</Text>
      <Group><Button onClick={() => setShow3d(v => !v)}>{show3d ? 'Close scene view' : 'Open scene view'}</Button><Select label="Display arrangement" value={arrangement} allowDeselect={false} data={[{ value: 'canonical', label: 'Canonical placed illustrations' }, { value: 'inspection', label: 'Separate local illustrations for inspection' }]} onChange={value => setArrangement(value as 'canonical' | 'inspection')} /></Group>
      <Text size="sm">The inspection arrangement uses separate display spacing. It does not assign missing placements, route wires, establish model correspondence or change frozen state. Board drawings have unknown depth; stock illustrations have unknown installed routes.</Text>
      {show3d && <ViewerBoundary><Suspense fallback={<Text>Loading scene viewer…</Text>}><Viewport scene={scene} arrangement={arrangement} selected={selected} related={related} onSelect={setSelected} onRestoreCanonical={() => setArrangement('canonical')} /></Suspense></ViewerBoundary>}
      <OccurrenceList scene={scene} selected={selected} onSelect={setSelected} />
      {node && <SceneInspector key={node.node_id} node={node} selected={selected} geometry={scene.geometry} onSelect={setSelected} />}
      <Title order={3}>Contextual relationships</Title>
      {scene.relationships.map(r => <Text size="sm" key={JSON.stringify([r.context_path, r.local_id])}>{r.context_path.join('/') || 'Root'} / {r.local_id} · {r.kind} · {JSON.stringify(r)}</Text>)}
    </>}
  </Stack>;
}

function OccurrenceButton({ scene, node, selected, onSelect }: { scene: SharedScene; node: SceneNode; selected: Address | null; onSelect: (address: Address) => void }) {
  const mark = useSceneMark(scene, node.address);
  return <Button className="sb-probe-mark" data-probe={mark ?? undefined} variant="light" aria-pressed={selected !== null && selectionKey(node.address) === selectionKey({ ...selected, feature_id: undefined })} onClick={() => onSelect(node.address)}>{node.address.path.join('/')} · {node.display_ref || node.name}{mark === 'related' && <span className="sb-tag" style={{ marginLeft: 6 }}>related</span>}</Button>;
}
function OccurrenceList({ scene, selected, onSelect }: { scene: SharedScene; selected: Address | null; onSelect: (address: Address) => void }) {
  const [page, setPage] = useState(0);
  return <Stack><Title order={3}>Occurrence list</Title><Table><Table.Thead><Table.Tr><Table.Th>Context</Table.Th><Table.Th>Discipline</Table.Th><Table.Th>World placement</Table.Th><Table.Th>Geometry</Table.Th></Table.Tr></Table.Thead><Table.Tbody>
    {scene.nodes.slice(page * 50, (page + 1) * 50).map(node => <Table.Tr key={node.node_id}><Table.Td><OccurrenceButton scene={scene} node={node} selected={selected} onSelect={onSelect} /></Table.Td><Table.Td>{node.kind}</Table.Td><Table.Td><Badge color={node.world_status === 'known' ? 'green' : 'yellow'}>{node.world_status}</Badge></Table.Td><Table.Td>{node.geometry_ids.length || node.features.some(f => f.geometry_id) ? 'Inspect exact resources' : 'Unavailable'}</Table.Td></Table.Tr>)}
  </Table.Tbody></Table><Group><Button disabled={!page} onClick={() => setPage(v => v - 1)}>Previous occurrences</Button><Button disabled={(page + 1) * 50 >= scene.nodes.length} onClick={() => setPage(v => v + 1)}>Next occurrences</Button></Group></Stack>;
}

function SceneInspector({ node, selected, geometry, onSelect }: { node: SceneNode; selected: Address | null; geometry: Geometry[]; onSelect: (address: Address) => void }) {
  const [page, setPage] = useState(0);
  const feature = node.features.find(f => selected && selectionKey(f.address) === selectionKey(selected));
  const ids = new Set([...node.geometry_ids, ...node.features.flatMap(f => f.geometry_id ? [f.geometry_id] : [])]);
  return <Card withBorder><Stack gap="xs"><Title order={3}>Selected occurrence</Title>
    <Text>Context: {node.address.path.join('/')} · {node.kind}</Text>
    <Text size="xs"><RevisionLabel id={node.revision_id} extraPins={[{ label: 'Definition ID', value: node.definition_id }]} /> · snapshot SHA-256 {node.snapshot_sha256}</Text>
    <Text size="sm">Local placement: {node.placement.status} · World placement: {node.world_status}. {node.placement_limit}</Text>
    <Text size="xs">Parent from local: {node.local_transform ? JSON.stringify(node.local_transform) : 'Unknown'}</Text>
    <Text size="xs">Root from local: {node.world_transform ? JSON.stringify(node.world_transform) : 'Unknown'}</Text>
    <Text size="sm">Contextual firmware: {node.firmware ? `${node.firmware.revision_id} · snapshot ${node.firmware.snapshot_sha256}` : 'Unassigned'}</Text>
    {node.limitations.map((limit, i) => <Text size="sm" key={i}>Limitation: {limit}</Text>)}
    <Title order={4}>Exact geometry resources</Title>
    {geometry.filter(g => ids.has(g.geometry_id)).map(g => <Card withBorder key={g.geometry_id}><Text>{g.local_id} · {g.role} · {g.quality}</Text><Text size="xs">Geometry {g.geometry_id} · units {g.units ?? 'unknown'} · frame {g.frame ?? 'unknown'}</Text><Text size="xs">Source/model correspondence: {JSON.stringify(g.source)}</Text>{g.limitations.map((limit, i) => <Text size="sm" key={i}>{limit}</Text>)}</Card>)}
    <Title order={4}>Source and target provenance</Title>
    {node.provenance.map((pin, i) => <Text size="xs" key={i}>{JSON.stringify(pin)}</Text>)}
    <Title order={4}>Stable contextual features</Title>
    <Text size="sm">Feature addresses retain native/declaration IDs. A planar coordinate or declared association does not establish a complete 3D placement or verified correspondence.</Text>
    {node.features.slice(page * 50, (page + 1) * 50).map(f => <Button key={f.feature_id} variant="light" aria-pressed={selected !== null && selectionKey(f.address) === selectionKey(selected)} onClick={() => onSelect(f.address)}>{f.feature_id} · {f.label} · {f.role}</Button>)}
    <Group><Button disabled={!page} onClick={() => setPage(v => v - 1)}>Previous features</Button><Button disabled={(page + 1) * 50 >= node.features.length} onClick={() => setPage(v => v + 1)}>Next features</Button></Group>
    {feature && <><Text size="sm">Selected feature {feature.feature_id} · placement unknown</Text><Text size="xs">{JSON.stringify(feature.address)}</Text><Text size="xs">{JSON.stringify(feature.data)}</Text></>}
  </Stack></Card>;
}
