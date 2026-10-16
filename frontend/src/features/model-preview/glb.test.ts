import * as THREE from 'three';
import { expect, test, vi } from 'vitest';
import { disposeModel, loadGlb, modelFrame, validateGlb } from './glb';

import { tetraGlb } from './test-fixtures';

test('actual GLTFLoader preserves quantized tetrahedron dimensions, orientation and original bytes', async () => {
  const bytes = tetraGlb(), original = bytes.slice();
  const loaded = await loadGlb(bytes), canonical = new THREE.Group();
  canonical.matrix.copy(modelFrame('mm', 'right_handed_y_up')!); canonical.matrixAutoUpdate = false; canonical.add(loaded);
  canonical.updateMatrixWorld(true);
  const size = new THREE.Box3().setFromObject(canonical).getSize(new THREE.Vector3());
  expect(size.toArray()).toEqual([expect.closeTo(20),expect.closeTo(30),expect.closeTo(40)]);
  canonical.updateMatrixWorld(true); const points: number[][] = [];
  canonical.traverse(child => { if (child instanceof THREE.Mesh) { const positions = child.geometry.getAttribute('position'); for (let i=0;i<positions.count;i++) points.push(new THREE.Vector3().fromBufferAttribute(positions,i).applyMatrix4(child.matrixWorld).toArray().map(value=>Math.round(value) || 0)); } });
  expect(points).toEqual([[0,0,0],[20,0,0],[0,30,0],[0,0,40]]); expect(bytes).toEqual(original); disposeModel(loaded);
});
test('explicit meters/y-up and millimeters/z-up conversions are applied once, unknown frame is refused', () => {
  expect(new THREE.Vector3(.02,.04,-.03).applyMatrix4(modelFrame('m','right_handed_y_up')!).toArray()).toEqual([20,expect.closeTo(30),expect.closeTo(40)]);
  expect(new THREE.Vector3(20,30,40).applyMatrix4(modelFrame('mm','right_handed_z_up')!).toArray()).toEqual([20,30,40]);
  expect(modelFrame(null,'right_handed_y_up')).toBeNull(); expect(modelFrame('mm','unreviewed frame')).toBeNull();
});
test.each([
  ['external buffer', (d: any) => { d.buffers[0].uri = 'https://invalid.example/model.bin'; }, 'URI'],
  ['embedded data URI', (d: any) => { d.images = [{uri:'data:image/png;base64,AAAA'}]; }, 'URI'],
  ['unknown decoder', (d: any) => { d.extensionsUsed.push('KHR_draco_mesh_compression'); }, 'decoder'],
  ['nested extension', (d: any) => { d.meshes[0].primitives[0].extensions = { EXT_meshopt_compression: {} }; }, 'decoder'],
  ['allocation bomb', (d: any) => { d.accessors[0].count = 100_000_000; }, 'count'],
  ['accessor overrun', (d: any) => { d.accessors[0].count = 200; }, 'buffer view'],
  ['cyclic graph', (d: any) => { d.nodes[0].children = [0]; }, 'cyclic'],
  ['repeated root', (d: any) => { d.scenes[0].nodes = [0,0]; }, 'roots'],
  ['animation', (d: any) => { d.animations = [{}]; }, 'animation'],
  ['sparse allocation', (d: any) => { d.accessors[0].sparse = {count:999999999}; }, 'sparse'],
  ['PNG decompression bomb', (d: any, bin: Uint8Array) => { d.images = [{bufferView:0,mimeType:'image/png'}]; bin.set([137,80,78,71,13,10,26,10],0); bin.set(new TextEncoder().encode('IHDR'),12); const v=new DataView(bin.buffer); v.setUint32(16,0xffff); v.setUint32(20,0xffff); }, 'count'],
])('refuses %s before invoking loaders or network', async (_name, mutate, expected) => {
  const fetch = vi.spyOn(globalThis,'fetch'); const bytes = tetraGlb(mutate);
  expect(() => validateGlb(bytes)).toThrow(expected); await expect(loadGlb(bytes)).rejects.toThrow(expected); expect(fetch).not.toHaveBeenCalled(); fetch.mockRestore();
});
test('container length and combined scene budgets are checked before allocation', () => {
  const bad = tetraGlb(); new DataView(bad.buffer).setUint32(8,99999,true); expect(()=>validateGlb(bad)).toThrow('container');
  expect(()=>validateGlb(tetraGlb(),{bytes:0,vertices:800_000,pixels:0})).toThrow('combined scene');
});
test('aborted parse yields no retained mesh; disposing shared materials/textures happens once', async () => {
  const controller = new AbortController(); controller.abort(); await expect(loadGlb(tetraGlb(),controller.signal)).rejects.toThrow('Aborted');
  const root=new THREE.Group(), geometry=new THREE.BoxGeometry(), texture=new THREE.Texture(), material=new THREE.MeshStandardMaterial({map:texture});
  root.add(new THREE.Mesh(geometry,material),new THREE.Mesh(geometry,material));
  const g=vi.spyOn(geometry,'dispose'),m=vi.spyOn(material,'dispose'),t=vi.spyOn(texture,'dispose'); disposeModel(root);
  expect(g).toHaveBeenCalledTimes(1); expect(m).toHaveBeenCalledTimes(1); expect(t).toHaveBeenCalledTimes(1);
});
