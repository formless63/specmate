import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { sectionLayout } from '../../../../packages/section-layout/src';
import { modelSummary, unpreparedProfile, wireModel } from '../../../../packages/wire-geometry/src/model';
import { createMaterials, patternPixels, pieceAppearance } from '../../../../packages/wire-geometry/src/materials';
import { buildWireObject } from '../../../../packages/wire-geometry/src/scene';
import { braidedCoax, shieldedPair, unrecordedCoax } from './fixtures';

const model = (stock = braidedCoax()) => wireModel(sectionLayout(stock), 40, unpreparedProfile());

describe('wire viewer materials', () => {
  it('uses the recorded color and physically based hints from the shared appearance model', () => {
    const jacket = model().pieces.find(p => p.elementPath === 'stock.jacket')!;
    expect(pieceAppearance(jacket)).toMatchObject({ base: '#6b4423', family: 'polyurethane', finish: 'gloss' });
    const materials = createMaterials({ environment: true });
    const m = materials.materialFor(jacket) as THREE.MeshPhysicalMaterial;
    expect(m.color.getHexString()).toBe('6b4423');
    expect(m.clearcoat).toBeGreaterThan(0);
    const wire = model().pieces.find(p => p.elementPath === 'stock.center')!;
    expect((materials.materialFor(wire) as THREE.MeshPhysicalMaterial).metalness).toBe(1);
    materials.dispose();
  });
  it('tones metals down when no environment light is available', () => {
    const wire = model().pieces.find(p => p.elementPath === 'stock.center')!;
    const m = createMaterials({ environment: false }).materialFor(wire) as THREE.MeshPhysicalMaterial;
    expect(m.metalness).toBeLessThanOrEqual(0.35);
  });
  it('gives textured elements a generated map and smooth ones none', () => {
    const materials = createMaterials({ environment: true });
    const pieces = model().pieces;
    const braid = materials.materialFor(pieces.find(p => p.elementPath === 'stock.braid')!) as THREE.MeshPhysicalMaterial;
    const solid = materials.materialFor(pieces.find(p => p.elementPath === 'stock.center')!) as THREE.MeshPhysicalMaterial;
    expect(braid.map).not.toBeNull();
    expect(solid.map).toBeNull();
    materials.dispose();
  });
  it('generates deterministic pixels with real variation, or none for smooth surfaces', () => {
    const a = patternPixels('braid')!;
    expect(patternPixels('braid')).toEqual(a);
    expect(new Set(a.filter((_, i) => i % 4 === 0)).size).toBeGreaterThan(4);
    expect(patternPixels('solid-metal')).toBeNull();
    expect(patternPixels('none')).toBeNull();
  });
  it('shows unrecorded color as neutral with a hatch map, never a guessed hue', () => {
    const piece = model(unrecordedCoax()).pieces.find(p => p.elementPath === 'stock.jacket')!;
    expect(pieceAppearance(piece)).toMatchObject({ fillSource: 'unknown', texture: 'unknown' });
  });
  it('disposes everything it built exactly once', () => {
    const object = buildWireObject(model(shieldedPair()), { environment: true });
    expect(object.group.children.length).toBeGreaterThan(5);
    object.dispose(); object.dispose();
    expect(object.group.children).toHaveLength(0);
  });
});

describe('3D text alternative', () => {
  it('names every drawn element with recorded material and color, and what is not drawn', () => {
    const text = modelSummary(model());
    expect(text).toContain('Straight wire preview of 40 mm');
    expect(text).toContain('stock.jacket: Polyurethane, color #6b4423');
    expect(text).toContain('stock.braid: Tinned copper');
  });
  it('states unknowns instead of inventing them', () => {
    const text = modelSummary(model(unrecordedCoax()));
    expect(text).toContain('stock.jacket: material unknown, color unknown (drawn neutral)');
  });
});
