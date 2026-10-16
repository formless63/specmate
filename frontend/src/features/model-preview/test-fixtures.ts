/** Original tetrahedron: signed-short positions reconstruct 20 x 30 x 40 mm.
 * A y-up GLB root rotates the authored z-up mesh. Independent expected extents
 * and four world vertices catch missing/doubled node transforms and unit conversion. */
export function tetraGlb(change?: (doc: any, bin: Uint8Array) => void): Uint8Array<ArrayBuffer> {
  const bin = new Uint8Array(48), data = new DataView(bin.buffer);
  const coordinates = [0,0,0, 20,0,0, 0,30,0, 0,0,40];
  coordinates.forEach((value, index) => data.setInt16(index * 2, value, true));
  [0,2,1, 0,1,3, 0,3,2, 1,2,3].forEach((value, index) => data.setUint16(24 + index * 2, value, true));
  const doc = { asset: { version: '2.0' }, extensionsUsed: ['KHR_mesh_quantization'], extensionsRequired: ['KHR_mesh_quantization'],
    buffers: [{ byteLength: bin.length }], bufferViews: [{ buffer: 0, byteLength: 24 }, { buffer: 0, byteOffset: 24, byteLength: 24 }],
    accessors: [{ bufferView: 0, componentType: 5122, count: 4, type: 'VEC3', min: [0,0,0], max: [20,30,40] }, { bufferView: 1, componentType: 5123, count: 12, type: 'SCALAR' }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1 }] }],
    nodes: [{ mesh: 0, rotation: [-Math.SQRT1_2,0,0,Math.SQRT1_2] }], scenes: [{ nodes: [0] }], scene: 0 };
  change?.(doc, bin);
  const raw = new TextEncoder().encode(JSON.stringify(doc)), json = new Uint8Array(Math.ceil(raw.length / 4) * 4); json.fill(32); json.set(raw);
  const bytes = new Uint8Array(28 + json.length + bin.length), view = new DataView(bytes.buffer);
  view.setUint32(0, 0x46546c67, true); view.setUint32(4, 2, true); view.setUint32(8, bytes.length, true);
  view.setUint32(12, json.length, true); view.setUint32(16, 0x4e4f534a, true); bytes.set(json,20);
  view.setUint32(20 + json.length, bin.length,true); view.setUint32(24 + json.length,0x004e4942,true); bytes.set(bin,28+json.length);
  return bytes;
}
