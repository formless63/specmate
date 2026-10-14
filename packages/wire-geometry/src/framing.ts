// SPDX-License-Identifier: AGPL-3.0-only
// Box framing re-implemented from the behaviour of cab-stu packages/editor-react/src/model-scene.ts
// (frameBox: fit every box corner to both fields of view), commit
// 6bbf79655deb572df9f11490ca38e4f739ce71fb (MIT); no code is copied (see NOTICE).
import * as THREE from 'three';

/** Camera presets: end-on at A or B, looking down (top) or at the cable's length (front). */
export type CameraView = 'a' | 'b' | 'top' | 'front';
export const VIEW_DIRECTIONS: Record<CameraView, readonly [number, number, number]> = {
  a: [-1, 0.03, 0.02], b: [1, 0.03, 0.02], top: [0, 1, 0.02], front: [0, 0.03, 1],
};
/**
 * Default view: in front of the cable and a little above it, turned slightly toward end A (x = 0)
 * so its cut face reads, with the cable running across the canvas rather than along a diagonal.
 */
export const DEFAULT_DIRECTION: readonly [number, number, number] = [-0.3, 0.42, 1];
/** Share of the canvas the model may fill along its limiting axis; the rest is breathing room. */
export const FRAME_FILL = 0.88;

export interface Framing { position: THREE.Vector3; target: THREE.Vector3; up: THREE.Vector3; near: number; far: number }

/**
 * Where a perspective camera looking along `-direction` (with world Y up) must stand so every corner
 * of `box` is inside the view and the picture of the box is centred on the canvas. Each corner is
 * solved exactly for perspective (a nearer corner needs more room) and the view is panned until the
 * picture's extents are balanced, filling `FRAME_FILL` of the limiting axis: a long thin cable fills
 * the canvas width instead of its bounding sphere.
 */
export function frameBox(box: THREE.Box3, direction: THREE.Vector3, fovDeg: number, aspect: number, fill = FRAME_FILL): Framing {
  const dir = direction.clone().normalize();
  let right = new THREE.Vector3(0, 1, 0).cross(dir);
  if (right.lengthSq() < 1e-8) right = new THREE.Vector3(1, 0, 0);
  right.normalize();
  const up = dir.clone().cross(right).normalize();
  const radius = box.isEmpty() ? 1 : Math.max(box.getSize(new THREE.Vector3()).length() / 2, 1e-3);
  const tanV = Math.tan((fovDeg * Math.PI) / 360) * fill;
  const tanH = tanV * Math.max(aspect, 1e-3);
  const corners: THREE.Vector3[] = [];
  if (!box.isEmpty()) for (const x of [box.min.x, box.max.x]) for (const y of [box.min.y, box.max.y]) for (const z of [box.min.z, box.max.z]) corners.push(new THREE.Vector3(x, y, z));
  let target = box.isEmpty() ? new THREE.Vector3() : box.getCenter(new THREE.Vector3());
  const fit = (): number => {
    let d = radius * 0.5;
    for (const c of corners) {
      const p = c.clone().sub(target);
      // A corner at depth `toward` (toward the camera) is in view when |side| / (d - toward) <= tan.
      const toward = p.dot(dir);
      d = Math.max(d, toward + Math.abs(p.dot(right)) / tanH, toward + Math.abs(p.dot(up)) / tanV);
    }
    return d;
  };
  // Perspective makes the nearer end look bigger, so the box centre is not the picture's centre.
  // Fit the distance, then pan so the picture's extents are balanced, and repeat until settled.
  let distance = fit();
  for (let round = 0; round < 32 && corners.length > 0; round += 1) {
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const c of corners) {
      const p = c.clone().sub(target), depth = distance - p.dot(dir);
      const sx = p.dot(right) / depth, sy = p.dot(up) / depth;
      minX = Math.min(minX, sx); maxX = Math.max(maxX, sx); minY = Math.min(minY, sy); maxY = Math.max(maxY, sy);
    }
    const mx = (minX + maxX) / 2, my = (minY + maxY) / 2;
    if (Math.abs(mx) < tanH * 1e-3 && Math.abs(my) < tanV * 1e-3) break;
    // Panning by the offset at the nearest depth never overshoots; the loop closes the rest.
    const near = Math.min(...corners.map(c => distance - c.clone().sub(target).dot(dir)));
    target = target.clone().addScaledVector(right, mx * near).addScaledVector(up, my * near);
    distance = fit();
  }
  return {
    position: target.clone().addScaledVector(dir, distance), target, up: new THREE.Vector3(0, 1, 0),
    near: Math.max(distance / 1000, 1e-5), far: distance + radius * 10,
  };
}

/** Normalised device coordinates of every box corner seen by a camera at `framing` (for checks). */
export function projectedCorners(box: THREE.Box3, framing: Framing, fovDeg: number, aspect: number): { x: number; y: number }[] {
  const camera = new THREE.PerspectiveCamera(fovDeg, aspect, framing.near, framing.far);
  camera.position.copy(framing.position); camera.up.copy(framing.up); camera.lookAt(framing.target);
  camera.updateMatrixWorld(); camera.updateProjectionMatrix();
  const out: { x: number; y: number }[] = [];
  for (const x of [box.min.x, box.max.x]) for (const y of [box.min.y, box.max.y]) for (const z of [box.min.z, box.max.z]) {
    const p = new THREE.Vector3(x, y, z).project(camera);
    out.push({ x: p.x, y: p.y });
  }
  return out;
}
