import { describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { sectionLayout } from '../../../../packages/section-layout/src';
import { unpreparedProfile, wireModel } from '../../../../packages/wire-geometry/src/model';
import { explodeOffsets, outerLayerPaths, XRAY_OPACITY } from '../../../../packages/wire-geometry/src/explode';
import { applyOffsets, applyXray, buildWireObject } from '../../../../packages/wire-geometry/src/scene';
import { braidedCoax, shieldedPair } from './fixtures';

const coax = () => wireModel(sectionLayout(braidedCoax()), 40, unpreparedProfile());
const pair = () => wireModel(sectionLayout(shieldedPair()), 40, unpreparedProfile());

describe('explode offsets', () => {
  it('is empty at zero or for non-finite input and bounded by the recorded length', () => {
    expect(explodeOffsets(coax(), 0, 'axial').size).toBe(0);
    expect(explodeOffsets(coax(), Number.NaN, 'axial').size).toBe(0);
    const over = explodeOffsets(coax(), 5, 'axial');
    const max = Math.max(...[...over.values()].map(v => v[0]));
    expect(max).toBeLessThanOrEqual(40 * 0.5 + 1e-9);
    expect(max).toBeCloseTo(20, 6);
  });
  it('steps layers axially, outermost fixed and deeper layers further out, in proportion to the amount', () => {
    const m = coax();
    const half = explodeOffsets(m, 0.5, 'axial'), full = explodeOffsets(m, 1, 'axial');
    const at = (o: Map<string, readonly number[]>, path: string) => o.get(m.pieces.find(p => p.elementPath === path)!.id)![0]!;
    expect(at(full, 'stock.jacket')).toBe(0);
    expect(at(full, 'stock.center')).toBeGreaterThan(at(full, 'stock.jacket')!);
    expect(at(half, 'stock.center')).toBeCloseTo(at(full, 'stock.center')! / 2, 9);
    for (const v of full.values()) expect([v[1], v[2]]).toEqual([0, 0]);
  });
  it('radial moves only recorded off-axis elements, outward; on-axis elements stay and nothing is invented', () => {
    const m = pair();
    const offsets = explodeOffsets(m, 1, 'radial');
    for (const piece of m.pieces) {
      const o = offsets.get(piece.id);
      const [y, z] = piece.shape === 'tube' ? [piece.points[0]![1], piece.points[0]![2]] : [piece.center[1], piece.center[2]];
      if (Math.hypot(y, z) < 1e-9) expect(o).toBeUndefined();
      else { expect(o![0]).toBe(0); expect(o![1] * y + o![2] * z).toBeGreaterThan(0); }
    }
    expect(explodeOffsets(coax(), 1, 'radial').size).toBe(0);
  });
});

describe('x-ray and display application', () => {
  it('names only layers with a recorded bore that wholly encloses another element', () => {
    const outer = outerLayerPaths(coax());
    expect(outer.has('stock.jacket')).toBe(true);
    expect(outer.has('stock.center')).toBe(false);
  });
  it('moves meshes without rebuilding geometry, restores rest, and fades then restores outer layers', () => {
    const m = coax();
    const built = buildWireObject(m);
    const geometryBefore = (built.group.children[0] as THREE.Mesh).geometry;
    applyOffsets(built.group, explodeOffsets(m, 1, 'axial'));
    const moved = built.group.children.some(c => c.position.x > 0);
    expect(moved).toBe(true);
    expect((built.group.children[0] as THREE.Mesh).geometry).toBe(geometryBefore);
    applyOffsets(built.group, new Map());
    expect(built.group.children.every(c => c.position.x === (c.userData.rest as number[])[0])).toBe(true);
    const outer = outerLayerPaths(m);
    applyXray(built.group, outer, true);
    for (const c of built.group.children) {
      const mat = (c as THREE.Mesh).material as THREE.Material;
      if (outer.has(c.userData.elementPath)) expect([mat.transparent, mat.opacity, mat.depthWrite]).toEqual([true, XRAY_OPACITY, false]);
      else expect([mat.transparent, mat.opacity]).toEqual([false, 1]);
    }
    applyXray(built.group, outer, false);
    expect(built.group.children.every(c => ((c as THREE.Mesh).material as THREE.Material).opacity === 1)).toBe(true);
    const spies = built.group.children.map(c => vi.spyOn(((c as THREE.Mesh).material as THREE.Material), 'dispose'));
    const geo = vi.spyOn(geometryBefore, 'dispose');
    built.dispose();
    expect(geo).toHaveBeenCalled();
    spies.forEach(s => expect(s).toHaveBeenCalled());
  });
});
