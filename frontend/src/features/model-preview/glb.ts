// SPDX-License-Identifier: AGPL-3.0-only
import * as THREE from 'three';

const BYTE_LIMIT = 12 * 1024 * 1024;
const VERTICES = 800_000;
type Row = Record<string, any>;
const fail = (message: string): never => { throw new Error(`GLB preview: ${message}`); };
function integer(value: unknown, maximum: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > maximum) fail('invalid or excessive resource count.');
  return value as number;
}
/** Validate before GLTFLoader allocates or creates image URLs. This is deliberately a
 * bounded static subset, with no decoders, external resources, animation or skinning. */
export type GlbBudget = { bytes: number; vertices: number; pixels: number };
export function validateGlb(bytes: Uint8Array, budget?: GlbBudget): Row {
  if (bytes.length < 28 || bytes.length > BYTE_LIMIT) fail('invalid or excessive file length.');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0, true) !== 0x46546c67 || view.getUint32(4, true) !== 2 || view.getUint32(8, true) !== bytes.length || view.getUint32(16, true) !== 0x4e4f534a) fail('expected an exact GLB 2 container.');
  const jsonLength = integer(view.getUint32(12, true), bytes.length - 28);
  const binaryOffset = 20 + jsonLength;
  if (jsonLength % 4 || binaryOffset + 8 > bytes.length || view.getUint32(binaryOffset + 4, true) !== 0x004e4942) fail('expected one embedded binary chunk.');
  const binaryLength = view.getUint32(binaryOffset, true);
  if (binaryLength % 4 || binaryOffset + 8 + binaryLength !== bytes.length) fail('binary chunk length mismatch.');
  let parsed: unknown;
  try { parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(20, binaryOffset))); } catch { return fail('invalid JSON chunk.'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) fail('invalid asset document.');
  const doc = parsed as Row;
  if (doc.asset?.version !== '2.0') fail('unsupported asset version.');
  // A depth budget also prevents hostile recursive extras/extensions and node graphs.
  const scan = (value: unknown, depth = 0) => {
    if (depth > 64) fail('JSON nesting budget exceeded.');
    if (typeof value === 'number' && !Number.isFinite(value)) fail('non-finite numeric value.');
    if (!value || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value)) {
      if (key === 'uri') fail('external and data URI resources are unsupported.');
      if (key === 'extensions' && child && typeof child === 'object') for (const extension of Object.keys(child)) if (extension !== 'KHR_mesh_quantization') fail('unsupported extension or decoder.');
      scan(child, depth + 1);
    }
  };
  scan(doc);
  for (const extension of [...(doc.extensionsUsed ?? []), ...(doc.extensionsRequired ?? [])]) if (extension !== 'KHR_mesh_quantization') fail('unsupported extension or decoder.');
  const list = (key: string, max: number): Row[] => {
    const rows = doc[key] ?? [];
    if (!Array.isArray(rows) || rows.length > max || rows.some(row => !row || typeof row !== 'object' || Array.isArray(row))) fail(`${key} budget or structure invalid.`);
    return rows;
  };
  const buffers = list('buffers', 1);
  if (buffers.length !== 1 || integer(buffers[0]!.byteLength, binaryLength) < binaryLength - 3) fail('embedded buffer length mismatch.');
  const views = list('bufferViews', 8192);
  const region = (index: unknown) => {
    const row = views[integer(index, views.length - 1)]!;
    if (row.buffer !== 0) fail('invalid buffer reference.');
    const start = integer(row.byteOffset ?? 0, binaryLength), length = integer(row.byteLength, binaryLength - start);
    if (start + length > buffers[0]!.byteLength) fail('buffer view exceeds payload.');
    return { row, start, length };
  };
  views.forEach((_, index) => region(index));
  const accessors = list('accessors', 8192);
  let allocation = 0;
  for (const accessor of accessors) {
    if (accessor.sparse) fail('sparse accessors are unsupported.');
    const count = integer(accessor.count, 2_400_000);
    const components = ({ SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 } as Row)[accessor.type];
    const size = ({ 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 } as Row)[accessor.componentType];
    if (!components || !size) fail('unsupported accessor type.');
    allocation += count * components * 4;
    if (allocation > 64 * 1024 * 1024) fail('decoded allocation budget exceeded.');
    const { row, length } = region(accessor.bufferView), offset = integer(accessor.byteOffset ?? 0, length);
    const stride = integer(row.byteStride ?? size * components, 252);
    if (stride < size * components || (count && offset + (count - 1) * stride + size * components > length)) fail('accessor exceeds its buffer view.');
  }
  const meshes = list('meshes', 2048);
  let vertices = 0, primitives = 0, indices = 0;
  const meshIndices: number[] = [];
  const meshVertices = meshes.map(mesh => {
    const beforeIndices = indices;
    if (!Array.isArray(mesh.primitives) || mesh.primitives.length > 2048) fail('invalid primitive budget.');
    let total = 0;
    for (const primitive of mesh.primitives) {
      if (++primitives > 4096 || primitive.targets || (primitive.mode !== undefined && primitive.mode !== 4)) fail('only bounded static triangles are supported.');
      const position = accessors[integer(primitive.attributes?.POSITION, accessors.length - 1)]!;
      if (position.type !== 'VEC3') fail('invalid position accessor.');
      total += position.count;
      indices += primitive.indices === undefined ? position.count : accessors[integer(primitive.indices, accessors.length - 1)]!.count;
      if (indices > 2_400_000) fail('triangle index budget exceeded.');
    }
    vertices += total; meshIndices.push(indices - beforeIndices);
    return total;
  });
  const nodes = list('nodes', 4096), parents = new Set<number>();
  let instances = 0, instanceIndices = 0;
  nodes.forEach(node => { if (node.mesh !== undefined) { const index = integer(node.mesh, meshes.length - 1); instances += meshVertices[index]!; instanceIndices += meshIndices[index]!; } });
  if (instanceIndices > 2_400_000) fail('occurrence triangle index budget exceeded.');
  const visit = (index: number, depth: number, visiting: Set<number>) => {
    if (depth > 64 || visiting.has(index)) fail('node cycle or depth budget exceeded.');
    const node = nodes[index]!;
    for (const key of ['matrix', 'translation', 'rotation', 'scale']) if (node[key] !== undefined && (!Array.isArray(node[key]) || node[key].length !== (key === 'matrix' ? 16 : key === 'rotation' ? 4 : 3) || node[key].some((v: unknown) => typeof v !== 'number' || !Number.isFinite(v) || Math.abs(v) > 1e12))) fail('invalid node transform.');
    if (!Array.isArray(node.children ?? [])) fail('invalid children.');
    for (const child of node.children ?? []) {
      integer(child, nodes.length - 1);
      if (parents.has(child)) fail('nodes cannot have multiple parents.');
      parents.add(child); visit(child, depth + 1, new Set([...visiting, index]));
    }
  };
  // Each node's children are visited once. Walking only roots would miss detached cycles.
  nodes.forEach(node => { for (const child of node.children ?? []) integer(child, nodes.length - 1); });
  if (nodes.some(node => !Array.isArray(node.children ?? []))) fail('invalid node children.');
  const childIds = new Set<number>(nodes.flatMap(node => node.children ?? []));
  nodes.forEach((_, index) => { if (!childIds.has(index)) visit(index, 0, new Set()); });
  if (parents.size !== childIds.size || (nodes.length && childIds.size === nodes.length)) fail('detached cyclic node graph.');
  if (vertices > VERTICES || instances > VERTICES || !vertices) fail('vertex or occurrence budget exceeded.');
  list('materials', 2048); list('textures', 32);
  const scenes = list('scenes', 1);
  if (doc.scene !== undefined) integer(doc.scene, scenes.length - 1);
  for (const scene of scenes) {
    if (!Array.isArray(scene.nodes) || new Set(scene.nodes).size !== scene.nodes.length) fail('invalid scene roots.');
    for (const root of scene.nodes) { integer(root, nodes.length - 1); if (childIds.has(root)) fail('scene roots must have no parent.'); }
  }
  if ((doc.animations?.length ?? 0) || (doc.skins?.length ?? 0)) fail('animation and skinning are unsupported.');
  let pixels = 0; const imagePixels: number[] = [];
  for (const image of list('images', 32)) {
    const { start, length } = region(image.bufferView);
    const data = bytes.subarray(binaryOffset + 8 + start, binaryOffset + 8 + start + length);
    // PNG dimensions precede decompression; JPEG/WebP/etc require separately qualified decoders.
    if (image.mimeType !== 'image/png' || data.length < 24 || ![137,80,78,71,13,10,26,10].every((b, i) => data[i] === b) || new TextDecoder().decode(data.subarray(12, 16)) !== 'IHDR') fail('only embedded bounded PNG textures are supported.');
    const header = new DataView(data.buffer, data.byteOffset, data.byteLength), width = integer(header.getUint32(16), 4096), height = integer(header.getUint32(20), 4096);
    pixels += width * height; imagePixels.push(width * height);
    if (!width || !height || pixels > 16_777_216) fail('decoded texture budget exceeded.');
  }
  const texturePixels = list('textures', 32).reduce((total, texture) => total + imagePixels[integer(texture.source, imagePixels.length - 1)]!, 0);
  if (texturePixels > 16_777_216) fail('texture instance budget exceeded.');
  pixels = Math.max(pixels, texturePixels);
  if (budget) {
    budget.bytes += bytes.length; budget.vertices += Math.max(vertices, instances); budget.pixels += pixels;
    if (budget.bytes > 24 * 1024 * 1024 || budget.vertices > VERTICES || budget.pixels > 16_777_216) fail('combined scene resource budget exceeded.');
  }
  return doc;
}

export function disposeModel(object: THREE.Object3D): void {
  const geometries = new Set<THREE.BufferGeometry>(), materials = new Set<THREE.Material>(), textures = new Set<THREE.Texture>();
  object.traverse(child => {
    const mesh = child as THREE.Mesh;
    if (mesh.geometry) geometries.add(mesh.geometry);
    for (const material of Array.isArray(mesh.material) ? mesh.material : mesh.material ? [mesh.material] : []) {
      materials.add(material);
      for (const value of Object.values(material)) if (value instanceof THREE.Texture) textures.add(value);
    }
  });
  textures.forEach(texture => { const image = texture.source?.data as { close?: () => void } | undefined; if (image && typeof image.close === 'function') image.close(); texture.dispose(); });
  materials.forEach(material => material.dispose()); geometries.forEach(geometry => geometry.dispose());
}
export async function loadGlb(bytes: Uint8Array, signal?: AbortSignal): Promise<THREE.Group> {
  validateGlb(bytes);
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
  const { GLTFLoader } = await import('three/addons/loaders/GLTFLoader.js');
  const manager = new THREE.LoadingManager();
  let resourceFailed = false; manager.onError = () => { resourceFailed = true; };
  // The validator refuses every URI. Only GLTFLoader's own embedded image object URLs may load.
  manager.setURLModifier(url => { if (!url.startsWith('blob:')) fail('external resource request refused.'); return url; });
  const result = await new GLTFLoader(manager).parseAsync(bytes.slice().buffer, '');
  let invalid = false;
  result.scene.traverse(child => {
    if (child instanceof THREE.Mesh) {
      const positions = child.geometry.getAttribute('position');
      if (!positions) { invalid = true; return; }
      for (let index = 0; index < positions.count; index++) if (![positions.getX(index), positions.getY(index), positions.getZ(index)].every(Number.isFinite)) { invalid = true; break; }
      // Accessor min/max are authored hints, not authority for camera framing.
      const indices = child.geometry.index;
      if (indices) for (let index = 0; index < indices.count; index++) if (indices.getX(index) >= positions.count) { invalid = true; break; }
      if (!invalid) child.geometry.computeBoundingBox();
    }
  });
  result.scene.updateMatrixWorld(true);
  const bounds = new THREE.Box3().setFromObject(result.scene);
  if (signal?.aborted || resourceFailed || invalid || bounds.isEmpty() || [...bounds.min.toArray(), ...bounds.max.toArray()].some(value => !Number.isFinite(value) || Math.abs(value) > 1e12)) {
    disposeModel(result.scene);
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    fail('model geometry bounds are invalid.');
  }
  return result.scene;
}
/** Convert an explicitly declared output frame to Specmate's millimeter z-up frame.
 * GLB node transforms already reconstruct quantized coordinates: apply this once,
 * outside the loaded root. Size-based unit guesses are forbidden. */
export function modelFrame(units: string | null | undefined, frame: string | null | undefined): THREE.Matrix4 | null {
  const factor = units === 'mm' ? 1 : units === 'm' ? 1000 : units === 'in' ? 25.4 : null;
  if (factor === null || !['right_handed_y_up', 'right_handed_z_up'].includes(frame ?? '')) return null;
  return new THREE.Matrix4().makeRotationX(frame === 'right_handed_y_up' ? Math.PI / 2 : 0).multiply(new THREE.Matrix4().makeScale(factor, factor, factor));
}
