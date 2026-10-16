/** Transient illustration math. Canonical matrices, sources and measurements are inputs only. */
import * as THREE from 'three';
import type { Address, Matrix, GeometryScene, Vec3 } from './api';

export type Axis = 'x' | 'y' | 'z';
export type CameraView = 'isometric' | 'top' | 'front' | 'end';
export type Display = {
  explosion: { enabled: boolean; axis: Axis; spacing_mm: number };
  opening: { address: Address; axis: Axis; angle_deg: number; pivot_local_mm: Vec3 } | null;
  section: { enabled: boolean; axis: Axis; offset_mm: number; keep: 'positive' | 'negative' };
};
export const closedDisplay = (): Display => ({
  explosion: { enabled: false, axis: 'x', spacing_mm: 20 },
  opening: null,
  section: { enabled: false, axis: 'z', offset_mm: 0, keep: 'positive' },
});
export const axisVector = (axis: Axis) => new THREE.Vector3(axis === 'x' ? 1 : 0, axis === 'y' ? 1 : 0, axis === 'z' ? 1 : 0);
export const toMatrix = (value: Matrix) => new THREE.Matrix4().set(...value.flat() as [number, number, number, number, number, number, number, number, number, number, number, number, number, number, number, number]);
const belongs = (path: string[], branch: string[]) => branch.length <= path.length && branch.every((id, i) => path[i] === id);
const validNumber = (value: number) => Number.isFinite(value) && Math.abs(value) <= 1e9;

export function openingOperator(scene: GeometryScene, display: Display): THREE.Matrix4 | null {
  const opening = display.opening;
  if (!opening || opening.address.snapshot_id !== scene.snapshot_id || opening.address.feature_id ||
      !validNumber(opening.angle_deg) || !opening.pivot_local_mm.every(validNumber)) return null;
  const target = scene.nodes.find(n => JSON.stringify(n.address.path) === JSON.stringify(opening.address.path));
  if (!target?.world_transform) return null;
  const frame = toMatrix(target.world_transform), pivot = new THREE.Vector3(...opening.pivot_local_mm);
  const local = new THREE.Matrix4().makeTranslation(...pivot.toArray())
    .multiply(new THREE.Matrix4().makeRotationAxis(axisVector(opening.axis), opening.angle_deg * Math.PI / 180))
    .multiply(new THREE.Matrix4().makeTranslation(...pivot.clone().negate().toArray()));
  return frame.clone().multiply(local).multiply(frame.clone().invert());
}

/** Each call derives a new display matrix from the exact canonical/local input.
 * Descendants inherit one chosen opening and their root branch's world-axis offset.
 * Missing canonical transforms never acquire a position from these adjustments.
 */
export function displayMatrix(scene: GeometryScene, address: Address, transform: Matrix | null,
  display: Display, allowOpening = true): THREE.Matrix4 | null {
  if (transform === null || address.snapshot_id !== scene.snapshot_id) return null;
  const result = toMatrix(transform), opening = allowOpening ? openingOperator(scene, display) : null;
  if (opening && display.opening && belongs(address.path, display.opening.address.path)) result.premultiply(opening);
  const explode = display.explosion;
  if (explode.enabled && validNumber(explode.spacing_mm) && explode.spacing_mm >= 0) {
    const branches = [...new Set(scene.nodes.map(n => n.address.path[0]))].filter((id): id is string => id !== undefined);
    const rank = branches.indexOf(address.path[0]!);
    if (rank >= 0) {
      const offset = axisVector(explode.axis).multiplyScalar((rank - (branches.length - 1) / 2) * explode.spacing_mm);
      result.premultiply(new THREE.Matrix4().makeTranslation(...offset.toArray()));
    }
  }
  return result;
}

/** Positive signed plane distance is the retained half-space, matching Three.js clipping. */
export function sectionPlane(display: Display): THREE.Plane | null {
  const section = display.section;
  if (!section.enabled || !validNumber(section.offset_mm)) return null;
  const sign = section.keep === 'positive' ? 1 : -1;
  return new THREE.Plane(axisVector(section.axis).multiplyScalar(sign), -section.offset_mm * sign);
}
export const retainedPoint = (point: THREE.Vector3, plane: THREE.Plane | null) => !plane || plane.distanceToPoint(point) >= -1e-9;
