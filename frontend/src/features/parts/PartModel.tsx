import { Alert, Button, Group, Select, Stack, Text } from '@mantine/core';
import { useEffect, useRef, useState } from 'react';
import { sha256Hex } from '../../lib/sha256';
import type { Representation } from '../identity/api';
import { ApiError } from '../workspace/api';
export type PreviewRepresentation = Pick<Representation, 'representation_id' | 'kind' | 'label' | 'source_bundle_revision_id' | 'source_path' | 'sha256' | 'rights' | 'rights_status' | 'model_metadata'> & { units?: string | null; frame?: string | null };

const LIMIT = 12 * 1024 * 1024;
const VERTEX_LIMIT = 800_000;
/** Mirror STLLoader's format choice before it allocates from a binary face header. */
export function validateStlInput(bytes: Uint8Array) {
  if (bytes.byteLength < 84) throw new Error('STL source is too short for a supported mesh.');
  const faces = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(80, true), expected = 84 + faces * 50;
  const solid = [115, 111, 108, 105, 100];
  const ascii = expected !== bytes.byteLength && [0, 1, 2, 3, 4].some(offset => solid.every((value, index) => bytes[offset + index] === value));
  if (!ascii) {
    if (!faces || faces * 3 > VERTEX_LIMIT) throw new Error('STL exceeds the bounded preview vertex budget.');
    if (expected !== bytes.byteLength) throw new Error('Binary STL triangle count does not match its exact payload length.');
  } else {
    let vertices = 0;
    for (const _match of new TextDecoder().decode(bytes).matchAll(/\bvertex\s+/g)) if (++vertices > VERTEX_LIMIT) throw new Error('STL exceeds the bounded preview vertex budget.');
  }
}
export const sourceFileUrl = (source: string, path: string) => `/api/v0/sources/revisions/${encodeURIComponent(source)}/file?path=${encodeURIComponent(path)}`;
export const modelFormat = (path: string): 'stl' | 'obj' | 'glb' | 'image' | null => /\.glb$/i.test(path) ? 'glb' : /\.stl$/i.test(path) ? 'stl' : /\.obj$/i.test(path) ? 'obj' : /\.(png|jpe?g|webp)$/i.test(path) ? 'image' : null;
export async function readModelFile(row: PreviewRepresentation, signal: AbortSignal): Promise<Uint8Array> {
  const response = await fetch(sourceFileUrl(row.source_bundle_revision_id, row.source_path), { credentials: 'same-origin', cache: 'no-store', signal });
  if (!response.ok) throw new ApiError(response.status, 'The selected model source is unavailable.');
  if (Number(response.headers.get('Content-Length')) > LIMIT) throw new Error('Preview is limited to 12 MiB. Download this exact source to inspect it separately.');
  const reader = response.body?.getReader(); if (!reader) throw new Error('Model source is unavailable.');
  const chunks: Uint8Array[] = []; let length = 0;
  try { while (true) { const next = await reader.read(); if (next.done) break; length += next.value.length; if (length > LIMIT) throw new Error('Preview is limited to 12 MiB.'); chunks.push(next.value); } }
  finally { await reader.cancel().catch(() => undefined); }
  const bytes = new Uint8Array(length); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  if (await sha256Hex(bytes.slice().buffer) !== row.sha256) throw new Error('The source bytes do not match the exact representation hash.');
  return bytes;
}
/** Source-backed preview only. No dimensions, units or physical fit are inferred. */
export function PartModel({ active, rows, scopeKey, onAccessLost }: { active: boolean; rows: PreviewRepresentation[]; scopeKey: string; onAccessLost?: () => void }) {
  // A containing record may refresh after denial. Repeated denied reads must
  // not restart that refresh; a successful authenticated load resets the guard.
  const notified = useRef('');
  const [chosen, setChosen] = useState<string | null>(null), [data, setData] = useState<{ key: string; bytes?: Uint8Array; image?: string } | null>(null), [failure, setFailure] = useState<{ key: string; message: string; denied: boolean } | null>(null);
  const row = rows.find(item => item.representation_id === chosen) ?? rows.find(item => ['model', 'drawing'].includes(item.kind));
  const format = row ? modelFormat(row.source_path) : null;
  const identity = `${scopeKey}:${row?.representation_id}:${row?.source_bundle_revision_id}:${row?.source_path}:${row?.sha256}`;
  const bytes = active && data?.key === identity ? data.bytes : undefined, image = active && data?.key === identity ? data.image : undefined, error = failure?.key === identity ? failure.message : '';
  useEffect(() => {
    setData(null); setFailure(null); if (!active || !row || !format) return;
    const controller = new AbortController(); let url = '';
    void readModelFile(row, controller.signal).then(bytes => { if (controller.signal.aborted) return; notified.current = ''; if (format === 'image') { url = URL.createObjectURL(new Blob([bytes.slice().buffer], { type: /\.png$/i.test(row.source_path) ? 'image/png' : /\.webp$/i.test(row.source_path) ? 'image/webp' : 'image/jpeg' })); setData({ key: identity, image: url }); } else setData({ key: identity, bytes }); }).catch(failure => { if (!controller.signal.aborted) { const denied = failure instanceof ApiError && [401, 403, 404].includes(failure.status); setFailure({ key: identity, message: failure instanceof Error ? failure.message : 'Model preview unavailable.', denied }); if (denied && notified.current !== identity) { notified.current = identity; onAccessLost?.(); } } });
    return () => { controller.abort(); if (url) URL.revokeObjectURL(url); };
  }, [active, identity, format]);
  if (!active) return <Text>Model view inactive.</Text>;
  if (failure?.key === identity && failure.denied) return <Alert color="red">{failure.message}</Alert>;
  if (!row) return <div className="part-model-empty"><Text fw={600}>Model unknown</Text><Text>No model or drawing is linked to this exact revision. Geometry and physical fit are not evaluated.</Text></div>;
  return <Stack gap="xs"><Select label="Exact model or drawing" value={row.representation_id} data={rows.filter(item => ['model', 'drawing'].includes(item.kind)).map(item => ({ value: item.representation_id, label: item.label }))} onChange={setChosen} />
    <Text size="xs">{row.source_path} · rights {row.rights_status}: {row.rights}</Text>
    {error && <Alert color="red">{error}</Alert>}
    {active && !error && image && <img className="part-model-image" src={image} alt={row.label} />}
    {active && !error && bytes && (format === 'stl' || format === 'obj' || format === 'glb') && <MeshPreview bytes={bytes} format={format} units={row.model_metadata?.units ?? row.units} frame={row.model_metadata?.frame ?? row.frame} />}
    {row.model_metadata && <Text size="xs">Declared model: {row.model_metadata.units ?? 'units unknown'} · {row.model_metadata.frame ?? 'frame unknown'} · {row.model_metadata.purpose} · builder {row.model_metadata.builder_version ?? 'not declared'}. {row.model_metadata.basis}</Text>}
    {format && !bytes && !image && !error && active && <Text role="status">Reading exact model source…</Text>}
    {!format && <Text>This format has no browser preview. Its exact source remains available for download.</Text>}
    <Text size="xs">Preview only · units and accuracy follow the authored source; clearance, fit and manufacturability are not evaluated.</Text>
    <Group><Button size="xs" variant="quiet" component="a" href={sourceFileUrl(row.source_bundle_revision_id, row.source_path)} download>Download exact source</Button></Group>
  </Stack>;
}
function MeshPreview({ bytes, format, units, frame }: { bytes: Uint8Array; format: 'stl' | 'obj' | 'glb'; units?: string | null; frame?: string | null }) {
  const host = useRef<HTMLDivElement>(null), [error, setError] = useState('');
  useEffect(() => {
    let disposed = false; const controller = new AbortController(); const resources: (() => void)[] = [];
    const cleanup = () => { for (const release of resources.splice(0).reverse()) release(); }; setError('');
    void (async () => {
      const [THREE, inspectionView] = await Promise.all([import('three'), import('../model-preview/inspection-view')]);
      const element = host.current; if (disposed || !element) return;
      let object: import('three').Object3D;
      if (format === 'glb') {
        const { loadGlb, disposeModel, modelFrame } = await import('../model-preview/glb');
        const loaded = await loadGlb(bytes, controller.signal); resources.push(() => disposeModel(loaded));
        const group = new THREE.Group(), conversion = modelFrame(units, frame);
        if (conversion) { group.matrix.copy(conversion); group.matrixAutoUpdate = false; }
        group.add(loaded); object = group;
      }
      else if (format === 'stl') { validateStlInput(bytes); const { STLLoader } = await import('three/examples/jsm/loaders/STLLoader.js'); const geometry = new STLLoader().parse(bytes.slice().buffer); object = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ color: '#8096a6', roughness: 0.7 })); }
      else { const { OBJLoader } = await import('three/examples/jsm/loaders/OBJLoader.js'); object = new OBJLoader().parse(new TextDecoder().decode(bytes)); }
      const geometries = new Set<import('three').BufferGeometry>(), materials = new Set<import('three').Material>(); let count = 0;
      object.traverse(child => { if (child instanceof THREE.Mesh) { geometries.add(child.geometry); count += child.geometry.getAttribute('position')?.count ?? 0; (Array.isArray(child.material) ? child.material : [child.material]).forEach(material => materials.add(material)); } });
      const release = () => { geometries.forEach(geometry => geometry.dispose()); materials.forEach(material => material.dispose()); };
      if (format !== 'glb') resources.push(release);
      if (disposed || count > VERTEX_LIMIT || !count) { cleanup(); if (!disposed) throw new Error('This mesh exceeds the bounded preview or contains no supported geometry.'); return; }
      object.updateMatrixWorld(true);
      const bounds = new THREE.Box3().setFromObject(object), center = bounds.getCenter(new THREE.Vector3()), size = bounds.getSize(new THREE.Vector3());
      const span = Math.max(size.x, size.y, size.z); if (!Number.isFinite(span) || span <= 0) { cleanup(); throw new Error('Model bounds are unavailable.'); }
      const centered = new THREE.Group(); centered.position.sub(center); centered.add(object); const scene = new THREE.Scene(); scene.add(centered); const lights = inspectionView.addInspectionLighting(scene);
      const camera = new THREE.PerspectiveCamera(40, 1, span / 1000, span * 100); if (format === 'glb' && units && ['right_handed_y_up', 'right_handed_z_up'].includes(frame ?? '')) camera.up.set(0, 0, 1); camera.position.set(span * 1.5, span, span * 1.5);
      const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true }); resources.push(() => { renderer.dispose(); renderer.forceContextLoss(); renderer.domElement.remove(); }); renderer.setPixelRatio(Math.min(devicePixelRatio, 2)); renderer.domElement.setAttribute('aria-label', 'Source model preview'); element.append(renderer.domElement);
      const controls = inspectionView.createFreeOrbitControls(camera, renderer.domElement); resources.push(() => controls.dispose());
      const render = () => { const width = element.clientWidth || 300; renderer.setSize(width, 360); camera.aspect = width / 360; camera.updateProjectionMatrix(); inspectionView.aimInspectionLighting(lights, camera, new THREE.Vector3(), span); renderer.render(scene, camera); };
      controls.addEventListener('change', render); resources.push(inspectionView.connectFreeOrbitUpdates(controls, () => !disposed));
      const observer = new ResizeObserver(() => { controls.handleResize(); render(); }); resources.push(() => observer.disconnect()); observer.observe(element); render();
      if (disposed) cleanup();
    })().catch(failure => { cleanup(); if (!disposed) setError(failure instanceof Error ? failure.message : 'WebGL preview unavailable.'); });
    return () => { disposed = true; controller.abort(); cleanup(); };
  }, [bytes, format, units, frame]);
  return <>{error && <Alert color="orange">{error}</Alert>}<div ref={host} className="part-model-canvas" /></>;
}
