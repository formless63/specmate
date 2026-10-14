import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { DEFAULT_DIRECTION, FRAME_FILL, frameBox, projectedCorners, VIEW_DIRECTIONS } from '../../../../packages/wire-geometry/src/framing';

// Boxes are synthetic: a long thin cable, a short thick one, and an exploded (offset) model.
const boxes = {
  'long cable': new THREE.Box3(new THREE.Vector3(0, -2.1, -2.1), new THREE.Vector3(104, 2.1, 2.1)),
  'short coax': new THREE.Box3(new THREE.Vector3(0, -1.6, -1.6), new THREE.Vector3(12, 1.6, 1.6)),
  'offset exploded': new THREE.Box3(new THREE.Vector3(30, -6, -3), new THREE.Vector3(180, 9, 3)),
};
const directions = { default: DEFAULT_DIRECTION, ...VIEW_DIRECTIONS };

describe('3D camera framing', () => {
  for (const [boxName, box] of Object.entries(boxes)) for (const [view, dir] of Object.entries(directions)) for (const aspect of [1050 / 360, 1, 390 / 360]) {
    it(`${boxName}, ${view} view, aspect ${aspect.toFixed(2)}: whole model in view, centred and filling the canvas`, () => {
      const fov = 30;
      const framing = frameBox(box, new THREE.Vector3(...dir), fov, aspect);
      const ndc = projectedCorners(box, framing, fov, aspect);
      const minX = Math.min(...ndc.map(p => p.x)), maxX = Math.max(...ndc.map(p => p.x));
      const minY = Math.min(...ndc.map(p => p.y)), maxY = Math.max(...ndc.map(p => p.y));
      // Every corner inside the canvas, with the breathing room the fill leaves.
      for (const p of ndc) { expect(Math.abs(p.x)).toBeLessThanOrEqual(FRAME_FILL + 1e-6); expect(Math.abs(p.y)).toBeLessThanOrEqual(FRAME_FILL + 1e-6); }
      // Centred: the picture's extents are balanced about the middle of the canvas.
      expect(Math.abs(minX + maxX) / 2).toBeLessThan(0.01);
      expect(Math.abs(minY + maxY) / 2).toBeLessThan(0.01);
      // Filling: the limiting axis reaches the fill share, so the model never sits small in the middle.
      expect(Math.max(maxX - minX, maxY - minY) / 2).toBeGreaterThan(FRAME_FILL - 0.02);
      expect(framing.near).toBeGreaterThan(0);
      expect(framing.far).toBeGreaterThan(framing.position.distanceTo(framing.target));
    });
  }
  it('default view shows a long cable running across the canvas, not along a steep diagonal', () => {
    const box = boxes['long cable'], aspect = 1050 / 360, fov = 30;
    const framing = frameBox(box, new THREE.Vector3(...DEFAULT_DIRECTION), fov, aspect);
    const ends = projectedCorners(new THREE.Box3(new THREE.Vector3(0, 0, 0), new THREE.Vector3(104, 0, 0)), framing, fov, aspect);
    const a = ends[0]!, b = ends.at(-1)!;
    const slope = Math.abs((b.y - a.y) / aspect) / Math.abs(b.x - a.x);
    expect(Math.abs(b.x - a.x)).toBeGreaterThan(1.5);
    expect(slope).toBeLessThan(0.2);
  });
});
