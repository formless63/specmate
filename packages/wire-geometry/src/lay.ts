// SPDX-License-Identifier: AGPL-3.0-only
// Helix phase/sampling adapted from WireHub by formless63, commit
// cbf919edf30a9d906a791971d3a40e22cb78b67e, packages/layout/src/wire-model.ts.
// Explicit practice only: no default lay, handedness or stock dimension inference.
import type { Section, StockSpecification } from '../../section-layout/src';
import type { TubePiece, Vec3, WirePiece } from './model';

export interface IllustrationLay {
  lengthMm: number | null;
  direction: 'positive' | 'negative' | null;
  construction: StockSpecification['construction'];
  unsupportedReason?: string;
}
export interface IllustrationStatus { layApplied: boolean; message: string }
export const LAY_SAMPLES_PER_TURN = 24;
export const LAY_MAX_PIECE_SEGMENTS = 256;
export const LAY_MAX_TOTAL_SEGMENTS = 16384;
// Retain meaningful phase arithmetic even if cuts hide most of a very long preview.
const MAX_PHASE_TURNS = 1e6;
const straight = (reason: string): IllustrationStatus => ({ layApplied: false, message: `Straight illustration: ${reason}` });
const rotate = ([x, y, z]: Vec3, phase: number): Vec3 => [x,
  y * Math.cos(phase) - z * Math.sin(phase), y * Math.sin(phase) + z * Math.cos(phase)];

/** One global display-axis rotation, not nested engineering lay or an electrical model. */
export function illustrateLay(section: Section, pieces: WirePiece[], length: number, lay?: IllustrationLay): { pieces: WirePiece[]; status: IllustrationStatus } {
  const retain = (reason: string) => ({ pieces, status: straight(reason) });
  if (!lay) return retain('no lay practice selected.');
  if (lay.lengthMm === null || lay.direction === null) return retain('illustration lay length or direction is unknown; no twist inferred.');
  if (!Number.isFinite(lay.lengthMm) || lay.lengthMm <= 0 || !['positive', 'negative'].includes(lay.direction))
    return retain('invalid illustration lay; a finite positive period and explicit direction are required.');
  if (!['pair', 'bundle'].includes(lay.construction) || lay.unsupportedReason || section.features.some(f => f.shape.type !== 'ring'))
    return retain(`lay is supported only for round pair/bundle constructions${lay.unsupportedReason ? ` (${lay.unsupportedReason})` : ''}; the requested lay is not applied.`);
  if (section.unknown.length) return retain('construction geometry is unresolved; the requested lay is not applied.');
  if (length / lay.lengthMm > MAX_PHASE_TURNS) return retain('illustration lay exceeds the phase budget; the requested lay is not applied.');
  if (!pieces.length) return retain('no displayed material remains for lay.');
  const period = lay.lengthMm;
  const sign = lay.direction === 'positive' ? 1 : -1;
  const phase = (x: number) => sign * 2 * Math.PI * (x / period);
  const counts = new Map<string, number>();
  let total = 0;
  // Complete preflight before allocating any curved centerlines. Never undersample
  // a small period by clamping its requested sample count to the budget.
  for (const piece of pieces) {
    if (piece.shape !== 'tube') return retain('non-round material is unsupported; the requested lay is not applied.');
    const first = piece.points[0]!, last = piece.points.at(-1)!;
    const count = piece.kind === 'pigtail' ? piece.points.length - 1
      : Math.hypot(first[1], first[2]) === 0 ? 1
      : Math.max(1, Math.ceil((last[0] - first[0]) / period * LAY_SAMPLES_PER_TURN));
    if (!Number.isFinite(count) || count > LAY_MAX_PIECE_SEGMENTS)
      return retain(`illustration lay exceeds ${LAY_MAX_PIECE_SEGMENTS} segments per piece; the requested lay is not applied.`);
    total += count;
    if (total > LAY_MAX_TOTAL_SEGMENTS) return retain(`illustration lay exceeds the ${LAY_MAX_TOTAL_SEGMENTS}-segment total budget; the requested lay is not applied.`);
    counts.set(piece.id, count);
  }
  const bodies = new Map<string, TubePiece[]>();
  const transformed = pieces.map(piece => {
    if (piece.shape !== 'tube' || piece.kind === 'pigtail') return piece;
    const first = piece.points[0]!, last = piece.points.at(-1)!, count = counts.get(piece.id)!;
    const points = Array.from({ length: count + 1 }, (_, i): Vec3 => {
      const x = i === count ? last[0] : first[0] + (last[0] - first[0]) * i / count;
      return rotate([x, first[1], first[2]], phase(x));
    });
    const body = { ...piece, points };
    bodies.set(piece.elementPath, [...(bodies.get(piece.elementPath) ?? []), body]);
    return body;
  });
  const features = new Map(section.features.map(feature => [feature.path, feature]));
  const result = transformed.map(piece => {
    if (piece.shape !== 'tube' || piece.kind !== 'pigtail') return piece;
    const root = piece.points[0]!;
    const body = bodies.get(piece.elementPath)?.find(p => (piece.end === 'a' ? p.points[0]! : p.points.at(-1)!)[0] === root[0]);
    const atStart = piece.end === 'a';
    const feature = features.get(piece.elementPath)!;
    const center = body ? (atStart ? body.points[0]! : body.points.at(-1)!)
      : rotate([root[0], feature.x, feature.y], phase(root[0]));
    const adjacent = body ? (atStart ? body.points[1]! : body.points.at(-2)!) : undefined;
    // The body may be entirely occluded while its separate lead is displayed.
    // Use the known feature's analytic tangent then; do not leave that lead straight.
    const tangent: Vec3 = adjacent ? center.map((v, axis) => v - adjacent[axis]!) as unknown as Vec3
      : [period / (2 * Math.PI), -sign * center[2], sign * center[1]];
    const norm = Math.hypot(...tangent);
    const t = tangent.map(v => v / norm) as unknown as Vec3;
    const rotated = piece.points.map(p => rotate(p, phase(root[0])));
    const offset = rotated[0]!.map((v, axis) => v - center[axis]!) as unknown as Vec3;
    const lip = Math.hypot(...offset);
    // Screen starts on its sampled annular cut face, not in free space beside a
    // tilted cap. Preserve the midpoint lip radius and translate the separate lead.
    const dot = offset.reduce((sum, v, axis) => sum + v * t[axis]!, 0);
    const planar = offset.map((v, axis) => v - dot * t[axis]!) as unknown as Vec3;
    const planarNorm = Math.hypot(...planar);
    const anchor = center.map((v, axis) => v + (lip === 0 ? 0 : planar[axis]! * lip / planarNorm)) as unknown as Vec3;
    const shift = anchor.map((v, axis) => v - rotated[0]![axis]!) as unknown as Vec3;
    return { ...piece, points: rotated.map(p => p.map((v, axis) => v + shift[axis]!) as unknown as Vec3) };
  });
  return { pieces: result, status: { layApplied: true,
    message: `Helical illustration: ${period} mm axial period, ${lay.direction} rotation about +x; phase zero at end A. This is not measured lay or physical wire length.` } };
}
