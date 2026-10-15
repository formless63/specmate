import { expect, test } from 'vitest';
import * as THREE from 'three';
import { closedDisplay, displayMatrix, openingOperator, retainedPoint, sectionPlane, toMatrix } from './display';
import { buildSceneObject } from './geometry';
import { selectionKey } from './api';
import { identityMatrix, syntheticScene, syntheticStock } from './test-fixtures';

function nested() {
  const scene = syntheticScene();
  const parent = { ...scene.nodes[0]!, address: { snapshot_id: scene.snapshot_id, path: ['left'] }, node_id: 'left-module', kind: 'assembly', geometry_ids: [], features: [],
    world_transform: [[0, -1, 0, 10], [1, 0, 0, 20], [0, 0, 1, 30], [0, 0, 0, 1]] };
  scene.nodes[0]!.world_transform = [[0, -1, 0, 6], [1, 0, 0, 23], [0, 0, 1, 35], [0, 0, 0, 1]];
  scene.nodes.unshift(parent);
  return scene;
}
const origin = (matrix: THREE.Matrix4) => new THREE.Vector3().applyMatrix4(matrix).toArray();

test('chosen local opening composes through rotated nested parent and explosion inherits exact root branch', () => {
  const scene = nested(), before = structuredClone(scene), display = closedDisplay();
  display.opening = { address: scene.nodes[0]!.address, axis: 'x', angle_deg: 90, pivot_local_mm: [0, 2, 0] };
  display.explosion = { enabled: true, axis: 'x', spacing_mm: 20 };
  // Independent local arithmetic: (3,4,5)-(0,2,0) -> Rx90(3,2,5)=(3,-5,2)
  // add local pivot -> (3,-3,2), Rz90 -> (3,3,2), parent translate -> (13,23,32), display -10X.
  const left = displayMatrix(scene, scene.nodes[1]!.address, scene.nodes[1]!.world_transform, display)!;
  expect(origin(left)).toEqual([3, 23, 32]);
  const right = displayMatrix(scene, scene.nodes[2]!.address, scene.nodes[2]!.world_transform, display)!;
  expect(origin(right)).toEqual([70, 0, 0]); expect(scene).toEqual(before);
});

test('closing repeated opening/explosion restores identical canonical matrices and independent geometry dimensions', () => {
  const scene = nested(), before = structuredClone(scene), address = scene.nodes[1]!.address;
  for (let cycle = 0; cycle < 20; cycle++) {
    const display = closedDisplay(); display.explosion.enabled = true;
    display.opening = { address: scene.nodes[0]!.address, axis: 'y', angle_deg: -37, pivot_local_mm: [2, 3, 4] };
    const opened = buildSceneObject(scene, 'canonical', display);
    expect(opened.objects.get(selectionKey(address))!.matrix.elements).not.toEqual(toMatrix(scene.nodes[1]!.world_transform!).elements); opened.dispose();
    const restored = buildSceneObject(scene, 'canonical', closedDisplay());
    expect(restored.objects.get(selectionKey(address))!.matrix.elements).toEqual(toMatrix(scene.nodes[1]!.world_transform!).elements);
    const geometry = (restored.objects.get(selectionKey(address))!.children[0] as THREE.LineLoop).geometry;
    geometry.computeBoundingBox(); expect(geometry.boundingBox!.getSize(new THREE.Vector3()).toArray()).toEqual([40, 25, 0]);
    restored.dispose();
  }
  expect(scene).toEqual(before);
});

test('unplaced occurrences and features remain canonically unplaced under every adjustment', () => {
  const scene = syntheticScene(), display = closedDisplay();
  scene.nodes[1]!.world_transform = null; scene.nodes[1]!.world_status = 'unknown';
  display.explosion.enabled = true;
  display.opening = { address: scene.nodes[1]!.address, axis: 'x', angle_deg: 90, pivot_local_mm: [0, 0, 0] };
  const before = structuredClone(scene);
  expect(openingOperator(scene, display)).toBeNull();
  expect(displayMatrix(scene, scene.nodes[1]!.address, null, display)).toBeNull();
  const canonical = buildSceneObject(scene, 'canonical', display);
  expect(canonical.objects.has(selectionKey(scene.nodes[1]!.address))).toBe(false);
  expect(canonical.unknown.join(' ')).toContain('placement unknown'); canonical.dispose();
  const inspection = buildSceneObject(scene, 'inspection', display);
  expect(inspection.objects.has(selectionKey(scene.nodes[1]!.address))).toBe(true);
  expect(scene).toEqual(before); inspection.dispose();
});

test('opening target uses exact path/snapshot and never a feature label or neighboring repeated branch', () => {
  const scene = syntheticScene(), display = closedDisplay();
  display.opening = { address: scene.nodes[1]!.features[0]!.address, axis: 'x', angle_deg: 90, pivot_local_mm: [0, 0, 0] };
  expect(openingOperator(scene, display)).toBeNull();
  display.opening.address = { snapshot_id: 'another-root', path: ['right', 'board'] };
  expect(openingOperator(scene, display)).toBeNull();
  display.opening.address = { snapshot_id: scene.snapshot_id, path: ['righ'] };
  expect(openingOperator(scene, display)).toBeNull();
  expect(displayMatrix(scene, scene.nodes[1]!.address, identityMatrix(), display)!.elements).toEqual(new THREE.Matrix4().elements);
});

test('world section signed distances retain exactly the rendered half-space and do not alter matrices', () => {
  const scene = syntheticScene(), display = closedDisplay(), before = structuredClone(scene);
  display.section = { enabled: true, axis: 'x', offset_mm: 65, keep: 'positive' };
  const plane = sectionPlane(display)!;
  expect(retainedPoint(new THREE.Vector3(64.99, 0, 0), plane)).toBe(false);
  expect(retainedPoint(new THREE.Vector3(65, 0, 0), plane)).toBe(true);
  expect(retainedPoint(new THREE.Vector3(65.01, 0, 0), plane)).toBe(true);
  display.section.keep = 'negative';
  expect(retainedPoint(new THREE.Vector3(64.99, 0, 0), sectionPlane(display))).toBe(true);
  expect(retainedPoint(new THREE.Vector3(65.01, 0, 0), sectionPlane(display))).toBe(false);
  expect(displayMatrix(scene, scene.nodes[1]!.address, scene.nodes[1]!.world_transform, display)!.elements).toEqual(toMatrix(scene.nodes[1]!.world_transform!).elements);
  display.section.offset_mm = Number.NaN; expect(sectionPlane(display)).toBeNull(); expect(scene).toEqual(before);
});

test('exploded stock keeps exact six-millimeter diameter and twelve-point-five length through restore', () => {
  const scene = syntheticScene(); scene.nodes = [scene.nodes[1]!];
  scene.geometry = [{ ...scene.geometry[0]!, type: 'wire_construction', stock: syntheticStock(), length_mm: '12.5' }];
  const before = structuredClone(scene), display = closedDisplay(); display.explosion.enabled = true;
  for (const mode of [display, closedDisplay()]) {
    const object = buildSceneObject(scene, 'canonical', mode);
    expect(new THREE.Box3().setFromObject(object.group).getSize(new THREE.Vector3()).toArray()).toEqual([12.5, 6, 6]); object.dispose();
  }
  expect(scene).toEqual(before);
});
