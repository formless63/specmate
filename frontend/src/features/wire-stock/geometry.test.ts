import { describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { sectionLayout } from '../../../../packages/section-layout/src';
import type { Section } from '../../../../packages/section-layout/src';
import { unpreparedProfile, wireModel } from '../../../../packages/wire-geometry/src/model';
import type { DisplayProfile, TubePiece } from '../../../../packages/wire-geometry/src/model';
import { buildWireObject, sweepPiece } from '../../../../packages/wire-geometry/src/scene';
import { stockPresets } from './presets';

const profile = (patch: Partial<DisplayProfile> = {}): DisplayProfile => ({ ...unpreparedProfile(), ...patch });
const tube = (patch: Partial<TubePiece> = {}): TubePiece => ({ id: 'synthetic', elementPath: 'stock.screen', kind: 'shield', color: null, material: null, shape: 'tube', rOuter: 2, rInner: 1, points: [[0, 0, 0], [10, 0, 0]], radialSegments: 16, caps: { start: 'ring', end: 'ring' }, ...patch });

describe('prepared stock display projection', () => {
  it('keeps asymmetric per-element cuts separate from immutable stock and facts', () => {
    const stock = structuredClone(stockPresets.coax!), before = structuredClone(stock);
    const section = sectionLayout(stock), original = structuredClone(section);
    const model = wireModel(section, 50, profile({ omitOccluded: false, cuts: {
      'stock.jacket': { a: 12, b: 9 }, 'stock.screen': { a: 8, b: 6 },
      'stock.dielectric': { a: 3, b: 2 }, 'stock.center': { a: 1, b: 0 },
    } }));
    expect(model.pieces.filter(p => p.shape === 'tube').map(p => [p.elementPath, p.points[0]![0], p.points.at(-1)![0]])).toEqual([
      ['stock.center', 1, 50], ['stock.dielectric', 3, 48], ['stock.screen', 8, 44], ['stock.jacket', 12, 41],
    ]);
    expect(stock).toEqual(before); expect(section).toEqual(original); expect(model.electricalBonds).toEqual([]);
  });
  it('omits only enclosed interiors, retains end faces, and leaves artificial cuts uncapped', () => {
    const section = sectionLayout(stockPresets.coax!);
    const model = wireModel(section, 1000, profile());
    const center = model.pieces.filter(p => p.elementPath === 'stock.center') as TubePiece[];
    expect(center).toHaveLength(2);
    expect(center[0]!.points[0]![0]).toBe(0);
    expect(center[0]!.points.at(-1)![0]).toBeLessThan(0.1);
    expect(center[0]!.caps).toEqual({ start: 'disk', end: 'none' });
    expect(center[1]!.caps).toEqual({ start: 'none', end: 'disk' });
    expect(model.pieces.filter(p => p.elementPath === 'stock.jacket')).toHaveLength(1);
    const full = wireModel(section, 1000, profile({ omitOccluded: false }));
    expect(full.pieces).toHaveLength(4);
    expect((full.pieces[0] as TubePiece).points.at(-1)![0]).toBe(1000);
  });
  it('preserves explicit foil hiding as a display omission, not deletion', () => {
    const section = sectionLayout(stockPresets.coax!);
    const model = wireModel(section, 50, profile({ hiddenPaths: ['stock.screen'] }));
    expect(model.pieces.some(p => p.elementPath === 'stock.screen')).toBe(false);
    expect(section.rows.find(r => r.path === 'stock.screen')).toBeDefined();
    expect(model.omitted).toContainEqual({ path: 'stock.screen', reason: 'Hidden by explicit display profile; construction retained' });
  });
  it('keeps two screen leads distinct at both ends, bounded and never electrically gathered', () => {
    const section: Section = { ...sectionLayout(stockPresets.coax!), unknown: [], features: [-3, 3].map((x, i) => ({
      path: `screen${i}`, kind: 'shield', x, y: 0, color: null, material: null, shape: { type: 'ring', rOuter: 1, rInner: 0.8 },
    })), rows: [] };
    section.rows = section.features.map(f => ({ ...sectionLayout(stockPresets.coax!).rows[2]!, path: f.path }));
    const cuts = Object.fromEntries(section.features.map(f => [f.path, { a: 10, b: 5, leads: {
      a: { lengthMm: 8, diameterMm: 0.4, reachMm: 2, angleDeg: 0 },
      b: { lengthMm: 4, diameterMm: 0.3, reachMm: 3, angleDeg: 180 },
    } }]));
    const model = wireModel(section, 30, profile({ cuts }));
    const leads = model.pieces.filter(p => p.kind === 'pigtail') as TubePiece[];
    expect(leads.map(p => p.id)).toEqual(['screen0:lead:a', 'screen0:lead:b', 'screen1:lead:a', 'screen1:lead:b']);
    expect(leads[0]!.points[0]).toEqual([10, -2.1, 0]);
    expect(leads[0]!.points.at(-1)![0]).toBe(2);
    expect(leads[0]!.points.at(-1)![1]).toBeCloseTo(-0.1);
    expect(leads[1]!.points.at(-1)![0]).toBe(29);
    expect(model.electricalBonds).toEqual([]);
    for (const piece of model.pieces as TubePiece[]) {
      const geometry = sweepPiece(piece), positions = geometry.getAttribute('position');
      for (let i = 0; i < positions.count; i++) for (let axis = 0; axis < 3; axis++) {
        const value = positions.getComponent(i, axis);
        expect(value).toBeGreaterThanOrEqual(model.bounds!.min[axis]! - 1e-6);
        expect(value).toBeLessThanOrEqual(model.bounds!.max[axis]! + 1e-6);
      }
      geometry.dispose();
    }
  });
  it('never invents cuts, stock dimensions, or lead diameters for unknown values', () => {
    const stock = structuredClone(stockPresets.coax!);
    const screen = stock.structure.children[2]!;
    if (screen.kind !== 'web' && screen.kind !== 'group') screen.inner_diameter_mm = null;
    const model = wireModel(sectionLayout(stock), 50, profile({ cuts: { 'stock.center': { a: null, b: 0 } } }));
    expect(model.pieces.some(p => ['stock.screen', 'stock.center'].includes(p.elementPath))).toBe(false);
    expect(model.unknown).toContain('stock.screen: layer dimensions unknown');
    const unknownLead = wireModel(sectionLayout(stockPresets.coax!), 50, profile({ cuts: {
      'stock.screen': { a: 10, b: 0, leads: { a: { lengthMm: 8, diameterMm: null, reachMm: 2, angleDeg: 0 } } },
    } }));
    expect(unknownLead.pieces.some(p => p.kind === 'pigtail')).toBe(false);
    expect(unknownLead.unknown.join()).toContain('unresolved or invalid illustrative lead');
  });
  it('rejects invalid lengths, overlapping end cuts and stale profile targets', () => {
    const section = sectionLayout(stockPresets.coax!);
    for (const length of [0, -1, Infinity, NaN]) expect(() => wireModel(section, length, profile())).toThrow();
    const model = wireModel(section, 10, profile({ cuts: { 'stock.center': { a: 9, b: 2 }, stale: { a: 0, b: 0 } } }));
    expect(model.pieces.some(p => p.elementPath === 'stock.center')).toBe(false);
    expect(model.unknown.join()).toContain('stale: profile element is absent');
  });
  it('retains flat web extrusion without pretending it is round', () => {
    const section = sectionLayout(stockPresets['figure-eight']!);
    const model = wireModel(section, 80, profile());
    expect(model.pieces.find(p => p.shape === 'web')).toMatchObject({ shape: 'web', size: [80, 1, 0.4] });
  });
});

describe('adapted annular sweep', () => {
  it.each([tube(), tube({ rInner: 0, caps: { start: 'disk', end: 'disk' } }), tube({ points: [[0, 0, 0], [2, 1, 0], [4, 2, 1], [6, 2, 2]] })])('winds every wall and cap toward its normal', piece => {
    const geometry = sweepPiece(piece);
    const positions = geometry.getAttribute('position'), normals = geometry.getAttribute('normal'), index = geometry.getIndex()!;
    for (let i = 0; i < index.count; i += 3) {
      const a = index.getX(i), b = index.getX(i + 1), c = index.getX(i + 2);
      const pa = new THREE.Vector3().fromBufferAttribute(positions, a);
      const edge1 = new THREE.Vector3().fromBufferAttribute(positions, b).sub(pa);
      const edge2 = new THREE.Vector3().fromBufferAttribute(positions, c).sub(pa);
      const normal = new THREE.Vector3().fromBufferAttribute(normals, a);
      expect(edge1.cross(edge2).dot(normal)).toBeGreaterThan(0);
    }
    geometry.dispose();
  });
  it('keeps an open bore through ring caps with independent cap normals', () => {
    const geometry = sweepPiece(tube());
    const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial()); mesh.updateMatrixWorld();
    expect(new THREE.Raycaster(new THREE.Vector3(-1, 0, 0), new THREE.Vector3(1, 0, 0)).intersectObject(mesh)).toHaveLength(0);
    const hits = new THREE.Raycaster(new THREE.Vector3(-1, 1.5, 0), new THREE.Vector3(1, 0, 0)).intersectObject(mesh);
    expect(hits[0]!.point.x).toBe(0); expect(hits[0]!.face!.normal.x).toBe(-1);
    geometry.dispose(); mesh.material.dispose();
  });
  it('rejects invalid and unbounded sweep inputs', () => {
    for (const patch of [{ points: [] }, { rInner: 3 }, { rOuter: NaN }, { radialSegments: 100000 }]) expect(() => sweepPiece(tube(patch))).toThrow();
  });
  it('disposes every geometry/material once and clears object references', () => {
    const object = buildWireObject(wireModel(sectionLayout(stockPresets.coax!), 50, profile()));
    const spies = object.group.children.flatMap(child => {
      const mesh = child as THREE.Mesh<THREE.BufferGeometry, THREE.Material>;
      return [vi.spyOn(mesh.geometry, 'dispose'), vi.spyOn(mesh.material, 'dispose')];
    });
    object.dispose(); object.dispose();
    expect(spies.length).toBeGreaterThan(0); spies.forEach(spy => expect(spy).toHaveBeenCalledTimes(1));
    expect(object.group.children).toHaveLength(0);
  });
});
