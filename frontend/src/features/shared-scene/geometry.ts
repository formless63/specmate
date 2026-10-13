// SPDX-License-Identifier: AGPL-3.0-only
// Reuses the preserved WireHub-derived geometry package; its notices remain in NOTICE.
import * as THREE from 'three';
import { sectionLayout } from '../../../../packages/section-layout/src';
import { unpreparedProfile, wireModel } from '../../../../packages/wire-geometry/src/model';
import { buildWireObject } from '../../../../packages/wire-geometry/src/scene';
import type { Address, Geometry, Matrix, SharedScene, Vec3 } from './api';
import { selectionKey } from './api';

export type Arrangement = 'canonical' | 'inspection';
export interface SceneObject {
  group: THREE.Group;
  objects: Map<string, THREE.Object3D>;
  unknown: string[];
  dispose: () => void;
}
const matrix = (value: Matrix) => new THREE.Matrix4().set(...value.flat() as [number, number, number, number, number, number, number, number, number, number, number, number, number, number, number, number]);

function geometryObject(resource: Geometry): { group: THREE.Group; unknown: string[]; dispose: () => void } {
  const group = new THREE.Group();
  const geometries: THREE.BufferGeometry[] = [], materials: THREE.Material[] = [];
  const line = (points: Vec3[]) => {
    const geometry = new THREE.BufferGeometry().setFromPoints(points.map(p => new THREE.Vector3(...p)));
    const material = new THREE.LineBasicMaterial({ color: resource.type === 'pcb_planar' ? '#19705b' : '#b46b25' });
    geometries.push(geometry); materials.push(material); group.add(new THREE.LineLoop(geometry, material));
  };
  let unknown: string[] = [];
  if (resource.type === 'pcb_planar') {
    for (const polygon of [...resource.outline, ...resource.cutouts]) line(polygon);
    if (!resource.outline.length) unknown.push('No accepted board outline.');
  } else if (resource.type === 'wire_construction') {
    const section = sectionLayout(resource.stock);
    unknown = [...section.unknown];
    const length = resource.length_mm === null ? null : Number(resource.length_mm);
    if (length !== null && Number.isFinite(length) && length > 0) {
      const wire = buildWireObject(wireModel(section, length, unpreparedProfile()));
      return { group: wire.group, unknown, dispose: wire.dispose };
    }
    // An unknown length stays a section drawing at its declared illustration plane.
    // There is no default 100 mm extrusion or implied installed cable route.
    for (const feature of section.features) {
      const shape = feature.shape;
      if (shape.type === 'web') {
        const { width: w, height: h } = shape;
        line([[0, feature.x - w / 2, feature.y - h / 2], [0, feature.x + w / 2, feature.y - h / 2], [0, feature.x + w / 2, feature.y + h / 2], [0, feature.x - w / 2, feature.y + h / 2]]);
      } else for (const radius of [shape.rOuter, shape.rInner].filter(r => r > 0)) {
        line(Array.from({ length: 64 }, (_, i): Vec3 => [0, feature.x + radius * Math.cos(i * Math.PI / 32), feature.y + radius * Math.sin(i * Math.PI / 32)]));
      }
    }
    unknown.push('Length unknown: section only.');
  } else unknown.push('Native model remains inert; geometry unavailable.');
  return { group, unknown, dispose: () => { geometries.forEach(g => g.dispose()); materials.forEach(m => m.dispose()); } };
}

/** One resource's geometry is shared by clones, but selection stays occurrence-specific.
 * Inspection layout is ephemeral and never fills in an unknown canonical placement.
 */
export function buildSceneObject(scene: SharedScene, arrangement: Arrangement): SceneObject {
  const group = new THREE.Group(), objects = new Map<string, THREE.Object3D>(), unknown: string[] = [];
  const resources = new Map(scene.geometry.map(g => [g.geometry_id, g]));
  const built = new Map<string, ReturnType<typeof geometryObject>>();
  let nextX = 0;
  const instance = (geometryId: string, address: Address, transform: Matrix | null) => {
    const resource = resources.get(geometryId);
    if (!resource) { unknown.push(`${address.path.join('/')}: geometry resource unavailable.`); return; }
    let original = built.get(geometryId);
    if (!original) { original = geometryObject(resource); built.set(geometryId, original); }
    for (const issue of original.unknown) unknown.push(`${address.path.join('/')}${address.feature_id ? ` / ${address.feature_id}` : ''}: ${issue}`);
    if (!original.group.children.length) return;
    if (arrangement === 'canonical' && transform === null) {
      unknown.push(`${address.path.join('/')}: canonical world placement unknown; use inspection layout to view local illustration.`);
      return;
    }
    const object = original.group.clone(true);
    object.traverse(child => { child.userData.address = address; });
    if (arrangement === 'canonical' && transform) {
      object.matrixAutoUpdate = false; object.matrix.copy(matrix(transform)); object.matrixWorldNeedsUpdate = true;
    } else {
      const bounds = new THREE.Box3().setFromObject(object);
      const width = bounds.max.x - bounds.min.x;
      object.position.set(nextX - bounds.min.x, -bounds.min.y, -bounds.min.z);
      nextX += width + 10;  // Explicit display-only spacing, not an engineering dimension.
    }
    objects.set(selectionKey(address), object); group.add(object);
  };
  for (const node of scene.nodes) {
    for (const gid of node.geometry_ids) instance(gid, node.address, node.world_transform);
    // Feature geometry cannot acquire the containing occurrence's transform: its
    // own placement can be unknown (harness sections and model correspondences).
    for (const feature of node.features) if (feature.geometry_id) instance(feature.geometry_id, feature.address, feature.world_transform);
  }
  return { group, objects, unknown, dispose: () => { for (const resource of built.values()) resource.dispose(); built.clear(); objects.clear(); } };
}
