import { expect, test, vi } from 'vitest';
import * as THREE from 'three';
import { buildSceneObject } from './geometry';
import { selectionKey } from './api';
import { syntheticScene, syntheticStock } from './test-fixtures';

test('dimensioned repeated boards share geometry and independent exact contextual selection', () => {
  const scene = syntheticScene(), original = structuredClone(scene);
  const object = buildSceneObject(scene, 'canonical');
  const left = object.objects.get(selectionKey(scene.nodes[0]!.address))!, right = object.objects.get(selectionKey(scene.nodes[1]!.address))!;
  expect(left).not.toBe(right);
  expect(left.children[0]!.userData.address.path).toEqual(['left', 'board']);
  expect(right.children[0]!.userData.address.path).toEqual(['right', 'board']);
  const leftGeometry = (left.children[0] as THREE.LineLoop).geometry, rightGeometry = (right.children[0] as THREE.LineLoop).geometry;
  expect(leftGeometry).toBe(rightGeometry);
  const bounds = new THREE.Box3().setFromObject(object.group);
  expect(bounds.min.toArray()).toEqual([0, -25, 0]); expect(bounds.max.toArray()).toEqual([100, 0, 0]);
  const dispose = vi.spyOn(leftGeometry, 'dispose'); object.dispose();
  expect(dispose).toHaveBeenCalledTimes(1); expect(scene).toEqual(original);
});

test('canonical unknowns stay unplaced while deliberate local inspection never edits placements', () => {
  const scene = syntheticScene(); scene.nodes[1]!.world_transform = null; scene.nodes[1]!.world_status = 'unknown';
  const before = structuredClone(scene), canonical = buildSceneObject(scene, 'canonical');
  expect(canonical.objects.has(selectionKey(scene.nodes[1]!.address))).toBe(false);
  expect(canonical.unknown.join(' ')).toContain('placement unknown'); canonical.dispose();
  const inspection = buildSceneObject(scene, 'inspection');
  expect(inspection.objects.has(selectionKey(scene.nodes[1]!.address))).toBe(true);
  expect(scene).toEqual(before); inspection.dispose();
});

test('stock uses independent 6 mm diameter and 12.5 mm declared length; unknown length is only a section', () => {
  const scene = syntheticScene(); scene.nodes = [scene.nodes[0]!];
  scene.geometry = [{ ...scene.geometry[0]!, type: 'wire_construction', stock: syntheticStock(), length_mm: '12.5' }];
  const object = buildSceneObject(scene, 'canonical'), box = new THREE.Box3().setFromObject(object.group);
  expect(box.min.toArray()).toEqual([0, -3, -3]); expect(box.max.toArray()).toEqual([12.5, 3, 3]); object.dispose();
  const geometry = scene.geometry[0]!; if (geometry.type !== 'wire_construction') throw new Error('Fixture mismatch');
  geometry.length_mm = null;
  const section = buildSceneObject(scene, 'canonical'), sectionBox = new THREE.Box3().setFromObject(section.group);
  expect(sectionBox.min.toArray()).toEqual([0, -3, -3]); expect(sectionBox.max.toArray()).toEqual([0, 3, 3]);
  expect(section.unknown).toContain('left/board: Length unknown: section only.'); section.dispose();
});

test('inert mechanical models and missing geometry remain reported without unit or position guesses', () => {
  const scene = syntheticScene(); scene.geometry = [{ ...scene.geometry[0]!, type: 'unavailable_model', units: null, frame: null, millimetre_factor: null, quality: 'declared_unextracted', role: 'clearance' }];
  const before = structuredClone(scene), object = buildSceneObject(scene, 'inspection');
  expect(object.group.children).toHaveLength(0);
  expect(object.unknown).toContain('right/board: Native model remains inert; geometry unavailable.');
  expect(scene).toEqual(before); object.dispose();
});

test('feature geometry keeps its unknown placement despite a known containing occurrence', () => {
  const scene = syntheticScene();
  for (const node of scene.nodes) {
    const feature = node.features[0]!;
    feature.geometry_id = node.geometry_ids[0]!;
    node.geometry_ids = [];
  }
  const before = structuredClone(scene);
  const canonical = buildSceneObject(scene, 'canonical');
  expect(canonical.objects.size).toBe(0);
  expect(canonical.unknown.filter(reason => reason.includes('placement unknown'))).toHaveLength(2);
  canonical.dispose();
  const inspection = buildSceneObject(scene, 'inspection');
  const left = scene.nodes[0]!.features[0]!.address, right = scene.nodes[1]!.features[0]!.address;
  expect(inspection.objects.size).toBe(2);
  expect(inspection.objects.get(selectionKey(left))).not.toBe(inspection.objects.get(selectionKey(right)));
  expect(inspection.objects.get(selectionKey(left))!.children[0]!.userData.address).toEqual(left);
  expect(inspection.objects.get(selectionKey(right))!.children[0]!.userData.address).toEqual(right);
  expect(scene).toEqual(before);
  inspection.dispose();
});
