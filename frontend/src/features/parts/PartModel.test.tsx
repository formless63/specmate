import { createHash } from 'node:crypto';
import { MantineProvider } from '@mantine/core';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { Representation } from '../identity/api';
import { modelFormat, PartModel, readModelFile, validateStlInput } from './PartModel';
const gpu = vi.hoisted(() => ({ constructFails: false, renderFails: false, disposed: vi.fn(), lost: vi.fn(), rendered: vi.fn() }));
vi.mock('three', async importOriginal => {
  const actual = await importOriginal<typeof import('three')>();
  return { ...actual, WebGLRenderer: class {
    domElement = document.createElement('canvas'); constructor() { if (gpu.constructFails) throw new Error('Synthetic WebGL unavailable'); }
    setPixelRatio() {} setSize() {} dispose() { gpu.disposed(); } forceContextLoss() { gpu.lost(); }
    render() { gpu.rendered(); if (gpu.renderFails) throw new Error('Synthetic render failure'); }
  } };
});
const imageBytes = new TextEncoder().encode('original synthetic image bytes');
const meshBytes = new TextEncoder().encode('solid synthetic\nfacet normal 0 0 1\nouter loop\nvertex 0 0 0\nvertex 1 0 0\nvertex 0 1 0\nendloop\nendfacet\nendsolid synthetic');
const row = (id: string, bytes = imageBytes, path = 'model.png'): Representation => ({ representation_id: id, kind: 'model', label: `Synthetic ${id}`, revision_id: 'part-r1', revision_number: 1, definition_id: 'part', definition_name: 'Synthetic part', definition_kind: 'part', source_bundle_revision_id: `source-${id}`, source_path: path, sha256: createHash('sha256').update(bytes).digest('hex'), media_type: 'application/octet-stream', rights: 'synthetic-original', rights_status: 'unknown' });
const originalUrl = URL, made = vi.fn(() => 'blob:synthetic-preview'), revoked = vi.fn();
beforeEach(() => { gpu.constructFails = false; gpu.renderFails = false; gpu.disposed.mockClear(); gpu.lost.mockClear(); gpu.rendered.mockClear(); made.mockClear(); revoked.mockClear(); vi.stubGlobal('URL', class extends originalUrl { static createObjectURL = made; static revokeObjectURL = revoked; }); vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} unobserve() {} }); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
function mount(rows: Representation[], changes: { active?: boolean; scopeKey?: string } = {}) {
  const props = { active: true, rows, scopeKey: 'owner:workspace', onAccessLost: vi.fn(), ...changes };
  const tree = (next = props) => <MantineProvider env="test"><PartModel {...next} /></MantineProvider>;
  const view = render(tree()); return { ...view, props, rerender: (next: Partial<typeof props>) => view.rerender(tree({ ...props, ...next })) };
}
test('held old source bytes cannot appear under a replacement row; hide revokes active object URL', async () => {
  let releaseA!: (value: Response) => void; const requests: AbortSignal[] = [];
  vi.stubGlobal('fetch', vi.fn((path: string, options: RequestInit) => { requests.push(options.signal as AbortSignal); return path.includes('source-a') ? new Promise<Response>(resolve => { releaseA = resolve; }) : Promise.resolve(new Response(imageBytes)); }));
  const view = mount([row('a')]); view.rerender({ rows: [row('b')] }); await screen.findByAltText('Synthetic b');
  await act(async () => releaseA(new Response(imageBytes))); expect(screen.queryByAltText('Synthetic a')).toBeNull(); expect(made).toHaveBeenCalledTimes(1); expect(requests[0]!.aborted).toBe(true);
  view.rerender({ active: false }); expect(screen.queryByRole('img')).toBeNull(); expect(revoked).toHaveBeenCalledWith('blob:synthetic-preview');
});
test('principal replacement immediately withdraws same-ID bytes and reauthorizes source', async () => {
  let release!: (value: Response) => void, count = 0;
  vi.stubGlobal('fetch', vi.fn(() => ++count === 1 ? Promise.resolve(new Response(imageBytes)) : new Promise<Response>(resolve => { release = resolve; })));
  const view = mount([row('same')]); await screen.findByAltText('Synthetic same'); view.rerender({ scopeKey: 'viewer:workspace' }); expect(screen.queryByRole('img')).toBeNull(); expect(revoked).toHaveBeenCalledTimes(1);
  await act(async () => release(new Response(imageBytes))); await screen.findByAltText('Synthetic same'); expect(count).toBe(2);
});
test('denial after successful image removes bytes, names and download metadata', async () => {
  let denied = false; vi.stubGlobal('fetch', vi.fn(async () => denied ? new Response('', { status: 403 }) : new Response(imageBytes)));
  const view = mount([row('protected')]); await screen.findByAltText('Synthetic protected'); view.rerender({ active: false }); denied = true; view.rerender({ active: true });
  await screen.findByText('The selected model source is unavailable.'); expect(screen.queryByRole('img')).toBeNull(); expect(screen.queryByDisplayValue('Synthetic protected')).toBeNull(); expect(screen.queryByRole('link', { name: 'Download exact source' })).toBeNull(); expect(view.props.onAccessLost).toHaveBeenCalledTimes(1);
});
test('parsed geometry/materials release when WebGL constructor fails', async () => {
  const THREE = await import('three'), geometry = vi.spyOn(THREE.BufferGeometry.prototype, 'dispose'), material = vi.spyOn(THREE.Material.prototype, 'dispose'); gpu.constructFails = true;
  vi.stubGlobal('fetch', vi.fn(async () => new Response(meshBytes))); const view = mount([row('mesh', meshBytes, 'mesh.stl')]); await screen.findByText('Synthetic WebGL unavailable'); expect(geometry).toHaveBeenCalledTimes(1); expect(material).toHaveBeenCalledTimes(1); view.unmount(); expect(geometry).toHaveBeenCalledTimes(1);
});
test('render failure and hidden/unmounted meshes release renderer and context without an animation loop', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(meshBytes))); gpu.renderFails = true;
  const failed = mount([row('mesh', meshBytes, 'mesh.stl')]); await screen.findByText('Synthetic render failure'); expect(gpu.disposed).toHaveBeenCalledTimes(1); expect(gpu.lost).toHaveBeenCalledTimes(1); failed.unmount();
  gpu.renderFails = false; gpu.disposed.mockClear(); gpu.lost.mockClear(); const view = mount([row('mesh', meshBytes, 'mesh.stl')]); await waitFor(() => expect(screen.getByLabelText('Source model preview')).toBeTruthy()); view.rerender({ active: false }); expect(gpu.disposed).toHaveBeenCalledTimes(1); expect(gpu.lost).toHaveBeenCalledTimes(1); view.unmount(); expect(gpu.disposed).toHaveBeenCalledTimes(1);
});
test('file bound/hash guards reject bytes and unsupported CAD has no invented preview', async () => {
  const reference = row('hash'); vi.stubGlobal('fetch', vi.fn(async () => new Response(imageBytes, { headers: { 'Content-Length': String(13 * 1024 * 1024) } })));
  await expect(readModelFile(reference, new AbortController().signal)).rejects.toThrow('12 MiB');
  vi.stubGlobal('fetch', vi.fn(async () => new Response(new TextEncoder().encode('different')))); await expect(readModelFile(reference, new AbortController().signal)).rejects.toThrow('exact representation hash');
  expect(modelFormat('part.step')).toBeNull(); expect(modelFormat('part.obj')).toBe('obj'); expect(modelFormat('part.svg')).toBeNull();
});
test('binary STL counts and payloads are bounded before the loader can allocate geometry', async () => {
  const huge = new Uint8Array(84); new DataView(huge.buffer).setUint32(80, 0xffff_ffff, true);
  expect(() => validateStlInput(huge)).toThrow('vertex budget');
  const short = huge.slice(); new DataView(short.buffer).setUint32(80, 1, true); expect(() => validateStlInput(short)).toThrow('payload length');
  const binary = new Uint8Array(134); binary.set(new TextEncoder().encode('solid binary header')); new DataView(binary.buffer).setUint32(80, 1, true);
  expect(() => validateStlInput(binary)).not.toThrow(); expect(() => validateStlInput(meshBytes)).not.toThrow(); expect(() => validateStlInput(new Uint8Array(40))).toThrow('too short');
  const { STLLoader } = await import('three/examples/jsm/loaders/STLLoader.js'), parse = vi.spyOn(STLLoader.prototype, 'parse');
  vi.stubGlobal('fetch', vi.fn(async () => new Response(huge))); mount([row('oversized', huge, 'huge.stl')]); await screen.findByText('STL exceeds the bounded preview vertex budget.'); expect(parse).not.toHaveBeenCalled(); expect(gpu.rendered).not.toHaveBeenCalled();
});

test('quantized GLB uses the exact authenticated source and releases geometry on hide', async () => {
  const { tetraGlb } = await import('../model-preview/test-fixtures'); const bytes = tetraGlb();
  const THREE = await import('three'), release = vi.spyOn(THREE.BufferGeometry.prototype, 'dispose');
  const fetch = vi.fn(async () => new Response(bytes)); vi.stubGlobal('fetch', fetch);
  const view = mount([row('glb', bytes, 'tetra.glb')]);
  await waitFor(() => expect(screen.getByLabelText('Source model preview')).toBeTruthy());
  expect(modelFormat('MODEL.GLB')).toBe('glb'); expect(fetch).toHaveBeenCalledTimes(1);
  expect(fetch.mock.calls[0]).toEqual([expect.stringContaining('/sources/revisions/source-glb/file'),expect.objectContaining({credentials:'same-origin',cache:'no-store'})]);
  view.rerender({active:false}); expect(release).toHaveBeenCalledTimes(1); expect(gpu.disposed).toHaveBeenCalledTimes(1);
});
