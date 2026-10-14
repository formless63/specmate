// SPDX-License-Identifier: AGPL-3.0-only
// Behavior reference: cab-stu packages/layout/src/wire-model.ts (explode: radial splay and
// axial pull) and packages/editor-react/src/wire-scene.ts (x-ray as translucent, non-depth-writing
// materials), commit 6bbf79655deb572df9f11490ca38e4f739ce71fb. Re-implemented here as display-only
// translations of existing meshes; no code is copied (see NOTICE).
import type { Vec3, WireModel, WirePiece } from './model';

export type ExplodeMode = 'axial' | 'radial';
/** Display-only bound: the axial pull never exceeds this fraction of the recorded preview length. */
export const MAX_AXIAL_FRACTION = 0.5;
/** Display-only bound: a radial splay never exceeds this multiple of the model's largest recorded outer radius. */
export const MAX_RADIAL_RADII = 1;
export const XRAY_OPACITY = 0.28;
const EPS = 1e-9;

const clamp01 = (v: number): number => (Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0);
const radiusOf = (p: WirePiece): number => (p.shape === 'tube' ? p.rOuter : Math.hypot(p.size[1], p.size[2]) / 2);
const centreOf = (p: WirePiece): [number, number] => (p.shape === 'tube' ? [p.points[0]![1], p.points[0]![2]] : [p.center[1], p.center[2]]);

/**
 * Explode offsets by piece id. Layers are ordered by the largest recorded outer radius of their element
 * (outermost first, rank 0). Axial: each deeper layer is pulled out along +x by one equal step, so a
 * nested construction reads like a stepped cutaway. Radial: only elements recorded off the cable axis
 * move, outward along their own recorded direction; an on-axis element has no direction and stays put.
 * Nothing is invented: offsets derive only from recorded radii, positions and the preview length.
 */
export function explodeOffsets(model: WireModel, amount: number, mode: ExplodeMode): Map<string, Vec3> {
  const out = new Map<string, Vec3>();
  const t = clamp01(amount);
  if (t === 0 || model.pieces.length === 0) return out;
  const radius = new Map<string, number>();
  for (const piece of model.pieces) radius.set(piece.elementPath, Math.max(radius.get(piece.elementPath) ?? 0, radiusOf(piece)));
  if (mode === 'axial') {
    const order = [...radius.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).map(([path]) => path);
    const step = order.length > 1 ? (model.lengthMm * MAX_AXIAL_FRACTION) / (order.length - 1) : 0;
    const rank = new Map(order.map((path, i) => [path, i]));
    for (const piece of model.pieces) out.set(piece.id, [t * step * (rank.get(piece.elementPath) ?? 0), 0, 0]);
  } else {
    const reach = Math.max(...radius.values()) * MAX_RADIAL_RADII;
    for (const piece of model.pieces) {
      const [y, z] = centreOf(piece);
      const d = Math.hypot(y, z);
      if (d <= EPS) continue;
      out.set(piece.id, [0, (y / d) * reach * t, (z / d) * reach * t]);
    }
  }
  return out;
}

/**
 * Element paths of tubes with a recorded bore that wholly encloses another element (strictly larger
 * outer radius, straight and coaxial with the bore for the covering tube). Only a known enclosure counts;
 * overlap is never treated as enclosure and an element with unknown geometry is never an outer layer.
 */
export function outerLayerPaths(model: WireModel): Set<string> {
  const outer = new Set<string>();
  for (const cover of model.pieces) {
    if (cover.shape !== 'tube' || cover.rInner <= 0 || cover.kind === 'pigtail') continue;
    const [cy, cz] = [cover.points[0]![1], cover.points[0]![2]];
    if (cover.points.some(p => Math.abs(p[1] - cy) > EPS || Math.abs(p[2] - cz) > EPS)) continue;
    const spanStart = Math.min(...cover.points.map(p => p[0])), spanEnd = Math.max(...cover.points.map(p => p[0]));
    for (const inner of model.pieces) {
      if (inner.elementPath === cover.elementPath || inner.shape !== 'tube' || inner.rOuter >= cover.rOuter) continue;
      const within = inner.points.every(p => p[0] >= spanStart - EPS && p[0] <= spanEnd + EPS &&
        Math.hypot(p[1] - cy, p[2] - cz) + inner.rOuter <= cover.rInner + EPS);
      if (within) { outer.add(cover.elementPath); break; }
    }
  }
  return outer;
}
