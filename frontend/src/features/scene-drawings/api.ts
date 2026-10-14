import { command, request, SourceError } from '../sources/api';
import { sha256Hex } from '../../lib/sha256';
import type { SharedScene } from '../shared-scene/api';
import type { CameraView, Display } from '../shared-scene/display';
export type Options = Omit<Display, 'opening'> & { view: CameraView; opening: { path: string[]; axis: 'x' | 'y' | 'z'; angle_deg: number; pivot_local_mm: [number, number, number] } | null };
export type Drawing = {
  drawing_id: string; workspace_id: string; snapshot_id: string; renderer_version: 'scene-line-svg-v1';
  purpose: 'internal_inspection'; options: Options; svg_sha256: string; manifest_sha256: string;
  svg_bytes: number; manifest_bytes: number; created_at: string; limitations: string[];
  qualification: SharedScene['qualification'];
};
export type Manifest = {
  scene_snapshot_id: string; scene_snapshot_sha256: string; root: SharedScene['root']; options: Options;
  source_rights: string; nodes: SharedScene['nodes']; geometry_provenance: SharedScene['geometry'];
  unresolved: { address: { path: string[]; feature_id?: string }; reason: string }[];
  outputs: { path: string; size: number; sha256: string }[];
};
export type Detail = Drawing & { manifest: Manifest };
export const drawingUrl = (id: string, part = '') => `shared-scenes/drawings/${encodeURIComponent(id)}${part ? `/${part}` : ''}`;
export const createDrawing = (snapshotId: string, options: Options, key: string) => command<Drawing>('shared_scene.create_drawing', { snapshot_id: snapshotId, options }, { idempotencyKey: key });
export const readDrawing = (id: string, signal: AbortSignal) => request<Detail>(drawingUrl(id), { signal, cache: 'no-store' });
/** Every byte request independently reauthorizes the retained full source closure. */
export async function drawingBytes(detail: Detail, part: 'svg' | 'manifest' | 'package', signal: AbortSignal) {
  const response = await fetch(`/api/v0/${drawingUrl(detail.drawing_id, part)}`, { credentials: 'same-origin', cache: 'no-store', signal });
  if (!response.ok) {
    const body = await response.json();
    throw new SourceError(response.status, body?.error?.message ?? 'Drawing unavailable.');
  }
  const bytes = await response.arrayBuffer();
  const hash = await sha256Hex(bytes);
  const expected = part === 'svg' ? detail.svg_sha256 : part === 'manifest' ? detail.manifest_sha256 : response.headers.get('X-Content-SHA256');
  if (!expected || hash !== expected || hash !== response.headers.get('X-Content-SHA256')) throw new Error('Drawing output integrity check failed.');
  return new Blob([bytes], { type: part === 'svg' ? 'image/svg+xml' : part === 'manifest' ? 'application/json' : 'application/zip' });
}
const canonical = (value: unknown): string => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item) ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
export function assertDetail(detail: Detail, id?: string, snapshotId?: string, sceneHash?: string, expectedOptions?: Options) {
  if ((id && detail.drawing_id !== id) || (snapshotId && detail.snapshot_id !== snapshotId) ||
      detail.manifest.scene_snapshot_id !== detail.snapshot_id || (sceneHash && detail.manifest.scene_snapshot_sha256 !== sceneHash) ||
      detail.manifest.outputs[0]?.sha256 !== detail.svg_sha256 || detail.purpose !== 'internal_inspection' ||
      canonical(detail.options) !== canonical(detail.manifest.options) || (expectedOptions && canonical(detail.options) !== canonical(expectedOptions)) ||
      detail.renderer_version !== 'scene-line-svg-v1' || detail.qualification.physical !== false) throw new Error('Drawing response does not match the requested inspection.');
}
