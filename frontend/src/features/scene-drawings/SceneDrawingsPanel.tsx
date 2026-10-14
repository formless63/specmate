import { Alert, Button, Card, Group, Select, Stack, Text, TextInput, Title } from '@mantine/core';
import { useEffect, useRef, useState } from 'react';
import { randomUUID } from '../../lib/random-id';
import { request, selectionKey, type Address, type SharedScene } from '../shared-scene/api';
import { DisplayControls, openingInput } from '../shared-scene/DisplayControls';
import { closedDisplay, type CameraView } from '../shared-scene/display';
import { assertDetail, createDrawing, drawingBytes, readDrawing, type Detail, type Options } from './api';
import { RevisionLabel } from "../../lib/IdentityLabel";

/** Root keys by current principal/project; this optional key also fences retained host mounts. */
export function SceneDrawingsPanel({ projectId = null, principalKey = '', active = true }: { projectId?: string | null; principalKey?: string; active?: boolean }) {
  if (!active) return <Text>Open drawings to begin a fresh inspection.</Text>;
  return <Workspace key={JSON.stringify([principalKey, projectId ?? 'library'])} projectId={projectId} />;
}
function Workspace({ projectId }: { projectId: string | null }) {
  const [snapshot, setSnapshot] = useState(''), [retained, setRetained] = useState('');
  const [scene, setScene] = useState<SharedScene | null>(null), [selected, setSelected] = useState<Address | null>(null);
  const [display, setDisplay] = useState(closedDisplay), [input, setInput] = useState(openingInput);
  const [view, setView] = useState<CameraView>('top');
  const [detail, setDetail] = useState<Detail | null>(null), [preview, setPreview] = useState<string | null>(null);
  const [error, setError] = useState(''), [busy, setBusy] = useState(false), [retryAvailable, setRetryAvailable] = useState(false);
  const active = useRef<AbortController | null>(null), mounted = useRef(false), url = useRef<string | null>(null);
  const intent = useRef<{ identity: string; key: string } | null>(null);
  const attempted = useRef<{ snapshotId: string; sceneHash: string; options: Options; key: string } | null>(null);
  function clearOutput() { if (url.current) URL.revokeObjectURL(url.current); url.current = null; setPreview(null); setDetail(null); }
  function invalidate() { active.current?.abort(); active.current = null; clearOutput(); setBusy(false); }
  function begin() { invalidate(); const controller = new AbortController(); active.current = controller; setBusy(true); setError(''); return controller; }
  const current = (controller: AbortController) => mounted.current && !controller.signal.aborted && active.current === controller;
  function fail(controller: AbortController, reason: unknown) { if (!current(controller)) return; clearOutput(); setScene(null); setSelected(null); setError(reason instanceof Error ? reason.message : 'Drawing request failed.'); }
  useEffect(() => {
    mounted.current = true;
    // Retained blobs have no authority. Hide them when the host loses or regains focus.
    const fence = () => { invalidate(); setScene(null); setSelected(null); };
    window.addEventListener('focus', fence); window.addEventListener('blur', fence); document.addEventListener('visibilitychange', fence);
    return () => { mounted.current = false; active.current?.abort(); if (url.current) URL.revokeObjectURL(url.current); window.removeEventListener('focus', fence); window.removeEventListener('blur', fence); document.removeEventListener('visibilitychange', fence); };
  }, []);
  const options: Options = { ...display, view, opening: display.opening ? { path: display.opening.address.path, axis: display.opening.axis, angle_deg: display.opening.angle_deg, pivot_local_mm: display.opening.pivot_local_mm } : null };
  function changeOptions(change: () => void) { invalidate(); change(); intent.current = null; attempted.current = null; setRetryAvailable(false); }
  async function inspectScene() {
    const controller = begin(); setScene(null); setSelected(null); intent.current = null;
    try {
      const next = await request<SharedScene>(`shared-scenes/drawing-scenes/${encodeURIComponent(snapshot.trim())}`, { signal: controller.signal, cache: 'no-store' });
      if (!current(controller)) return;
      if (next.snapshot_id !== snapshot.trim()) throw new Error('Scene response does not match the requested snapshot.');
      setScene(next); setDisplay(closedDisplay()); setInput(openingInput()); setView('top');
    } catch (reason) { fail(controller, reason); } finally { if (current(controller)) setBusy(false); }
  }
  async function generate(retry = false) {
    if (!retry && !scene) return;
    if (retry && !attempted.current) return;
    const controller = begin();
    if (!retry && scene) {
      const identity = JSON.stringify([projectId, scene.snapshot_id, options]);
      if (intent.current?.identity !== identity) intent.current = { identity, key: randomUUID() };
      attempted.current = { snapshotId: scene.snapshot_id, sceneHash: scene.sha256, options, key: intent.current.key };
    }
    const captured = attempted.current!;
    setRetryAvailable(false);
    try {
      const generated = await createDrawing(captured.snapshotId, captured.options, captured.key);
      if (!current(controller)) return;
      const next = await readDrawing(generated.drawing_id, controller.signal);
      if (!current(controller)) return;
      assertDetail(next, generated.drawing_id, captured.snapshotId, captured.sceneHash, captured.options);
      setDetail(next); setRetained(next.drawing_id);
    } catch (reason) { if (current(controller)) setRetryAvailable(true); fail(controller, reason); }
    finally { if (current(controller)) setBusy(false); }
  }
  async function inspectRetained() {
    const controller = begin(); setScene(null); setSelected(null);
    try {
      const next = await readDrawing(retained.trim(), controller.signal);
      if (!current(controller)) return; assertDetail(next, retained.trim()); setDetail(next);
    } catch (reason) { fail(controller, reason); } finally { if (current(controller)) setBusy(false); }
  }
  async function output(part: 'preview' | 'svg' | 'manifest' | 'package') {
    if (!detail) return;
    const captured = detail, controller = begin();
    try {
      const next = await readDrawing(captured.drawing_id, controller.signal);
      if (!current(controller)) return; assertDetail(next, captured.drawing_id, captured.snapshot_id);
      if (next.svg_sha256 !== captured.svg_sha256 || next.manifest_sha256 !== captured.manifest_sha256) throw new Error('Retained drawing identity changed.');
      const blob = await drawingBytes(next, part === 'preview' ? 'svg' : part, controller.signal);
      if (!current(controller)) return;
      setDetail(next);
      const objectUrl = URL.createObjectURL(blob);
      if (part === 'preview') { url.current = objectUrl; setPreview(objectUrl); }
      else {
        const anchor = document.createElement('a'); anchor.href = objectUrl; anchor.download = part === 'package' ? 'scene-inspection.zip' : part === 'svg' ? 'drawing.svg' : 'manifest.json';
        anchor.click(); URL.revokeObjectURL(objectUrl);
      }
    } catch (reason) { fail(controller, reason); } finally { if (current(controller)) setBusy(false); }
  }
  return <Stack><Title order={2}>Scene inspection drawings</Title>
    <Text>Generate a retained internal inspection SVG and provenance manifest from an exact frozen scene. This writes only a derived inspection record; engineering state is unchanged. Source rights do not grant distribution or release authority.</Text>
    <Text>Accepted PCB outlines and declared stock axes are supported. Full cable sections, installed routes and native mechanical shapes are unavailable. Missing models never establish validated fit. PNG and native drawing formats are not provided.</Text>
    <Group align="end"><TextInput label="Drawing frozen scene snapshot ID" value={snapshot} onChange={event => { invalidate(); setScene(null); setSelected(null); setSnapshot(event.currentTarget.value); intent.current = null; attempted.current = null; setRetryAvailable(false); }} /><Button disabled={busy || !snapshot.trim()} onClick={() => void inspectScene()}>Inspect drawing scene</Button></Group>
    <Group align="end"><TextInput label="Retained drawing ID" value={retained} onChange={event => { invalidate(); setRetained(event.currentTarget.value); }} /><Button disabled={busy || !retained.trim()} onClick={() => void inspectRetained()}>Inspect retained drawing</Button></Group>
    {error && <Alert color="red" role="alert">{error}</Alert>}
    {retryAvailable && <Button disabled={busy} onClick={() => void generate(true)}>Retry exact inspection request</Button>}{busy && <Text>Checking current authority and drawing integrity…</Text>}
    {scene && !busy && <Card withBorder><Stack><Text size="xs"><RevisionLabel id={scene.root.revision_id} role="Root" snapshotId={scene.snapshot_id} sha256={scene.sha256} /></Text>
      <Select label="Drawing orthographic view" allowDeselect={false} data={['top', 'front', 'end', 'isometric']} value={view} onChange={value => changeOptions(() => setView(value as CameraView))} />
      <Text>Choose an exact occurrence to open its displayed branch. Unknown world placements stay unknown and cannot supply a pivot.</Text>
      {scene.nodes.map(node => <Button key={node.node_id} variant="light" aria-pressed={selected !== null && selectionKey(selected) === selectionKey(node.address)} onClick={() => setSelected(node.address)}>{node.address.path.join('/')} · {node.world_status}</Button>)}
      <DisplayControls scene={scene} arrangement="canonical" selected={selected} display={display} setDisplay={next => changeOptions(() => setDisplay(next))} input={input} setInput={next => changeOptions(() => setInput(next))} restore={() => changeOptions(() => { setDisplay(closedDisplay()); setInput(openingInput()); setView('top'); })} />
      <Button disabled={busy || !Number.isFinite(display.explosion.spacing_mm) || !Number.isFinite(display.section.offset_mm)} onClick={() => void generate()}>Generate inspection SVG and manifest</Button>
    </Stack></Card>}
    {detail && <Card withBorder><Stack><Title order={3}>Retained inspection output</Title><Text size="xs">Drawing {detail.drawing_id} · exact scene {detail.snapshot_id} · SHA-256 {detail.manifest.scene_snapshot_sha256}</Text>
      <Text size="xs">SVG {detail.svg_sha256} · manifest {detail.manifest_sha256} · renderer {detail.renderer_version}</Text><Text>Fit, clearance, manufacturing and physical qualification: not evaluated. Print scale: unknown, screen fit only.</Text>
      <Text>{detail.manifest.source_rights}</Text>{detail.limitations.map((text, index) => <Text size="sm" key={index}>{text}</Text>)}
      <Text size="xs">Retained display options: {JSON.stringify(detail.options)}</Text>
      <Group>{(['preview', 'svg', 'manifest', 'package'] as const).map(part => <Button disabled={busy} key={part} onClick={() => void output(part)}>{part === 'preview' ? 'Preview authorized SVG' : `Download authorized ${part === 'package' ? 'SVG and manifest package' : part.toUpperCase()}`}</Button>)}</Group>
      {preview && <img src={preview} alt="Authorized internal scene inspection SVG" style={{ width: '100%', maxHeight: 640, objectFit: 'contain' }} />}
      <Title order={4}>Unresolved illustrations</Title>{detail.manifest.unresolved.map((item, index) => <Text size="sm" key={index}>{item.address.path.join('/')} {item.address.feature_id ?? ''}: {item.reason}</Text>)}
      <Title order={4}>Exact source and geometry provenance</Title>{detail.manifest.geometry_provenance.map(geometry => <Text size="xs" key={geometry.geometry_id}>{geometry.geometry_id} · {geometry.role} · {JSON.stringify(geometry.source)}</Text>)}
      <Text size="sm">Canonical transforms, contextual features, firmware pins and full provenance remain in the manifest; SVG line coordinates are rounded to six decimals.</Text>
    </Stack></Card>}
  </Stack>;
}
