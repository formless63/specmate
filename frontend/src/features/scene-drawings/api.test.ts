import { afterEach, expect, test, vi } from 'vitest';
import { assertDetail, drawingBytes, drawingUrl, type Detail } from './api';
import { sha256Hex } from '../../lib/sha256';
afterEach(() => vi.unstubAllGlobals());
test('byte reads are no-store and reject a false digest before creating a Blob', async () => {
  const bytes = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>');
  const hash = await sha256Hex(bytes.buffer);
  const detail = { drawing_id: 'drawing/one', workspace_id: 'workspace-one', svg_sha256: hash, manifest_sha256: 'manifest' } as Detail;
  const fetcher = vi.fn(async () => new Response(bytes, { headers: { 'X-Content-SHA256': hash } })); vi.stubGlobal('fetch', fetcher);
  const signal = new AbortController().signal;
  const blob = await drawingBytes(detail, 'svg', signal);
  expect(blob.size).toBe(bytes.length); expect(blob.type).toBe('image/svg+xml');
  expect(fetcher).toHaveBeenCalledWith('/api/v0/shared-scenes/drawings/drawing%2Fone/svg', { credentials: 'same-origin', cache: 'no-store', signal });
  fetcher.mockResolvedValueOnce(new Response(bytes, { headers: { 'X-Content-SHA256': 'false' } }));
  await expect(drawingBytes(detail, 'svg', signal)).rejects.toThrow('integrity');
  fetcher.mockResolvedValueOnce(new Response(JSON.stringify({ error: { message: 'Source denied.' } }), { status: 404 }));
  await expect(drawingBytes(detail, 'svg', signal)).rejects.toThrow('Source denied.');
});
test('encoding has no unscoped URLs and nested option identity ignores key order only', () => {
  expect(drawingUrl('x')).toBe('shared-scenes/drawings/x');
  expect(drawingUrl('a/b', 'svg')).toBe('shared-scenes/drawings/a%2Fb/svg');
  const options = { view: 'top', opening: null };
  const detail = { drawing_id: 'x', workspace_id: 'w', snapshot_id: 's', purpose: 'internal_inspection', renderer_version: 'scene-line-svg-v1', options,
    svg_sha256: 'hash', qualification: { physical: false }, manifest: { scene_snapshot_id: 's', scene_snapshot_sha256: 'exact', options: { opening: null, view: 'top' }, outputs: [{ sha256: 'hash' }] } } as Detail;
  expect(() => assertDetail(detail, 'x', 's', 'exact')).not.toThrow();
  for (const changes of [{ drawing_id: 'other' }, { snapshot_id: 'other' }, { options: { view: 'front' } }, { svg_sha256: 'false' }, { qualification: { physical: true } }]) {
    expect(() => assertDetail({ ...detail, ...changes } as Detail, 'x', 's', 'exact')).toThrow();
  }
});
