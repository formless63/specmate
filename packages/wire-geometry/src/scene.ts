// SPDX-License-Identifier: AGPL-3.0-only
// Annular sweep adapted from WireHub by formless63, commit
// cbf919edf30a9d906a791971d3a40e22cb78b67e, packages/editor-react/src/wire-scene.ts.
// Kept parallel transport, wall winding, ring/disk caps; model/material boundary changed.
import * as THREE from 'three';
import type { TubePiece, WireModel } from './model';

export function sweepPiece(piece: TubePiece): THREE.BufferGeometry {
  if (piece.points.length < 2 || piece.points.some(p => p.some(v => !Number.isFinite(v))) ||
      !Number.isFinite(piece.rOuter) || piece.rOuter <= 0 || !Number.isFinite(piece.rInner) ||
      piece.rInner < 0 || piece.rInner >= piece.rOuter || !Number.isInteger(piece.radialSegments) ||
      piece.radialSegments < 3 || piece.radialSegments > 128 || piece.points.length > 1024) {
    throw new Error('Invalid or unbounded sweep geometry.');
  }
  const pts = piece.points.map(([x, y, z]) => new THREE.Vector3(x, y, z));
  const n = pts.length;
  const radial = Math.max(3, piece.radialSegments);
  const rO = piece.rOuter;
  const rI = piece.rInner;
  const along = Math.max(2 * Math.PI * rO, 1e-3);

  // tangents, and parallel-transported normals
  const tangents: THREE.Vector3[] = pts.map((_, i) => {
    const a = pts[Math.max(0, i - 1)] as THREE.Vector3;
    const b = pts[Math.min(n - 1, i + 1)] as THREE.Vector3;
    const t = b.clone().sub(a);
    return t.lengthSq() < 1e-12 ? new THREE.Vector3(1, 0, 0) : t.normalize();
  });
  const t0 = tangents[0] as THREE.Vector3;
  const seed = Math.abs(t0.y) < 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(0, 0, 1);
  let normal = seed.sub(t0.clone().multiplyScalar(seed.dot(t0))).normalize();
  const normals: THREE.Vector3[] = [];
  const binormals: THREE.Vector3[] = [];
  for (let i = 0; i < n; i += 1) {
    const t = tangents[i] as THREE.Vector3;
    normal = normal.sub(t.clone().multiplyScalar(normal.dot(t)));
    if (normal.lengthSq() < 1e-12) normal = new THREE.Vector3(0, 1, 0).cross(t);
    normal.normalize();
    normals.push(normal.clone());
    binormals.push(t.clone().cross(normal).normalize());
  }
  const lengths: number[] = [0];
  for (let i = 1; i < n; i += 1) lengths.push((lengths[i - 1] as number) + (pts[i] as THREE.Vector3).distanceTo(pts[i - 1] as THREE.Vector3));

  const position: number[] = [];
  const norm: number[] = [];
  const uv: number[] = [];
  const index: number[] = [];
  const dir = new THREE.Vector3();
  const vertex = (p: THREE.Vector3, nx: number, ny: number, nz: number, u: number, v: number): number => {
    position.push(p.x, p.y, p.z);
    norm.push(nx, ny, nz);
    uv.push(u, v);
    return position.length / 3 - 1;
  };
  const wall = (r: number, inward: boolean): void => {
    const base = position.length / 3;
    for (let i = 0; i < n; i += 1) {
      const p = pts[i] as THREE.Vector3;
      const N = normals[i] as THREE.Vector3;
      const B = binormals[i] as THREE.Vector3;
      for (let j = 0; j <= radial; j += 1) {
        const a = (j / radial) * Math.PI * 2;
        dir.copy(N).multiplyScalar(Math.cos(a)).addScaledVector(B, Math.sin(a));
        const s = inward ? -1 : 1;
        vertex(p.clone().addScaledVector(dir, r), dir.x * s, dir.y * s, dir.z * s, (lengths[i] as number) / along, j / radial);
      }
    }
    for (let i = 0; i < n - 1; i += 1) {
      for (let j = 0; j < radial; j += 1) {
        const a = base + i * (radial + 1) + j;
        const b = a + radial + 1;
        // counter-clockwise seen from the side the normal faces: an outer wall
        // faces out, a bore faces in (: these were swapped,
        // so the near wall was culled and every tube looked hollow)
        if (inward) index.push(a, b, a + 1, b, b + 1, a + 1);
        else index.push(a, a + 1, b, b, a + 1, b + 1);
      }
    }
  };
  const cap = (at: number, facing: 1 | -1, kind: 'ring' | 'disk' | 'none'): void => {
    if (kind === 'none') return;
    const p = pts[at] as THREE.Vector3;
    const t = (tangents[at] as THREE.Vector3).clone().multiplyScalar(facing);
    const N = normals[at] as THREE.Vector3;
    const B = binormals[at] as THREE.Vector3;
    const inner = kind === 'ring' && rI > 0 ? rI : 0;
    const base = position.length / 3;
    for (let j = 0; j <= radial; j += 1) {
      const a = (j / radial) * Math.PI * 2;
      dir.copy(N).multiplyScalar(Math.cos(a)).addScaledVector(B, Math.sin(a));
      vertex(p.clone().addScaledVector(dir, rO), t.x, t.y, t.z, 1, j / radial);
      vertex(p.clone().addScaledVector(dir, inner), t.x, t.y, t.z, 0, j / radial);
    }
    for (let j = 0; j < radial; j += 1) {
      const o0 = base + j * 2;
      const i0 = o0 + 1;
      const o1 = o0 + 2;
      const i1 = o0 + 3;
      // wind so the face looks along `t`; a disk is one fan triangle per segment
      if (inner === 0) {
        if (facing === 1) index.push(o0, o1, i0);
        else index.push(o0, i0, o1);
      } else if (facing === 1) index.push(o0, o1, i0, i0, o1, i1);
      else index.push(o0, i0, o1, i0, i1, o1);
    }
  };

  wall(rO, false);
  if (rI > 0) wall(rI, true);
  cap(0, -1, piece.caps.start);
  cap(n - 1, 1, piece.caps.end);

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(position, 3));
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(norm, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geometry.setIndex(index);
  geometry.computeBoundingSphere();
  return geometry;
}

/** Allocate only the displayed meshes, retaining element identity for inspection. */
export function buildWireObject(model: WireModel): { group: THREE.Group; dispose: () => void } {
  const group = new THREE.Group();
  const geometries: THREE.BufferGeometry[] = [];
  const materials: THREE.Material[] = [];
  for (const piece of model.pieces) {
    const geometry = piece.shape === 'tube' ? sweepPiece(piece) : new THREE.BoxGeometry(...piece.size);
    const fallback = piece.kind === 'conductor' || piece.kind === 'pigtail' || piece.kind === 'drain' ? '#b58152' : piece.kind === 'shield' ? '#949da6' : '#d6d8da';
    const material = new THREE.MeshStandardMaterial({ color: piece.color && /^#[0-9a-f]{6}$/i.test(piece.color) ? piece.color : fallback, roughness: 0.6 });
    const mesh = new THREE.Mesh(geometry, material);
    if (piece.shape === 'web') mesh.position.set(...piece.center);
    mesh.name = piece.id;
    mesh.userData.elementPath = piece.elementPath;
    group.add(mesh); geometries.push(geometry); materials.push(material);
  }
  let disposed = false;
  return { group, dispose: () => {
    if (disposed) return;
    disposed = true;
    geometries.forEach(g => g.dispose()); materials.forEach(m => m.dispose()); group.clear();
  } };
}
