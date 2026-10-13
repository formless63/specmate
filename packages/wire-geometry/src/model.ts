/** Pure display projection. This profile is not an engineering preparation record. */
import type { Section, SectionFeature } from '../../section-layout/src';

export type Vec3 = readonly [number, number, number];
export type End = 'a' | 'b';
export type Cap = 'ring' | 'disk' | 'none';
export interface LeadDisplay {
  /** All dimensions are explicit illustration parameters, never inferred stock facts. */
  lengthMm: number | null;
  diameterMm: number | null;
  reachMm: number;
  angleDeg: number;
}
export interface ElementPreparation {
  /** Distance removed from each tip; null means unresolved, not zero. */
  a: number | null;
  b: number | null;
  leads?: Partial<Record<End, LeadDisplay>>;
}
export interface DisplayProfile {
  id: string;
  label: string;
  cuts: Record<string, ElementPreparation>;
  hiddenPaths: string[];
  omitOccluded: boolean;
}
export const unpreparedProfile = (): DisplayProfile => ({
  id: 'unprepared', label: 'Unprepared stock', cuts: {}, hiddenPaths: [], omitOccluded: true,
});
interface PieceBase {
  id: string;
  elementPath: string;
  kind: SectionFeature['kind'] | 'pigtail';
  color: string | null;
  material: string | null;
}
export interface TubePiece extends PieceBase {
  shape: 'tube';
  rOuter: number;
  rInner: number;
  points: Vec3[];
  radialSegments: number;
  caps: { start: Cap; end: Cap };
  end?: End;
}
export interface WebPiece extends PieceBase {
  shape: 'web';
  center: Vec3;
  size: Vec3;
}
export type WirePiece = TubePiece | WebPiece;
export interface WireModel {
  profileId: string;
  lengthMm: number;
  pieces: WirePiece[];
  omitted: { path: string; reason: string }[];
  unknown: string[];
  /** Conservative display bounds; not a clearance envelope. */
  bounds: { min: Vec3; max: Vec3 } | null;
  electricalBonds: readonly [];
}
interface Interval { start: number; end: number }
const finitePositive = (v: number | null): v is number => v !== null && Number.isFinite(v) && v > 0;
const finiteCut = (v: number | null): v is number => v !== null && Number.isFinite(v) && v >= 0;

/** Adapted interval clipping from WireHub wire-model.ts (see NOTICE). */
function subtract(intervals: Interval[], hidden: Interval): Interval[] {
  return intervals.flatMap(iv => {
    if (hidden.start >= iv.end || hidden.end <= iv.start) return [iv];
    const result: Interval[] = [];
    if (hidden.start > iv.start) result.push({ start: iv.start, end: hidden.start });
    if (hidden.end < iv.end) result.push({ start: hidden.end, end: iv.end });
    return result;
  });
}

/** Axis +x; section x/y map to world y/z. No stock or section object is modified. */
export function wireModel(section: Section, lengthMm: number, profile: DisplayProfile): WireModel {
  if (!finitePositive(lengthMm)) throw new Error('Preview length must be finite and positive.');
  const model: WireModel = { profileId: profile.id, lengthMm, pieces: [], omitted: [], unknown: [...section.unknown], bounds: null, electricalBonds: [] };
  const paths = new Set(section.rows.map(r => r.path));
  for (const path of [...Object.keys(profile.cuts), ...profile.hiddenPaths]) {
    if (!paths.has(path)) model.unknown.push(`${path}: profile element is absent from construction`);
  }
  const ranges = new Map<string, Interval>();
  for (const feature of section.features) {
    const cut = profile.cuts[feature.path] ?? { a: 0, b: 0 };
    if (!finiteCut(cut.a) || !finiteCut(cut.b) || cut.a + cut.b > lengthMm) {
      model.unknown.push(`${feature.path}: unresolved or invalid end cuts`);
    } else ranges.set(feature.path, { start: cut.a, end: lengthMm - cut.b });
  }
  for (const feature of section.features) {
    const path = feature.path;
    if (profile.hiddenPaths.includes(path)) {
      model.omitted.push({ path, reason: 'Hidden by explicit display profile; construction retained' });
      continue;
    }
    const range = ranges.get(path);
    if (!range) continue;
    const base = { elementPath: path, kind: feature.kind, color: feature.color, material: feature.material };
    if (range.start === range.end) {
      model.omitted.push({ path, reason: 'Fully cut by preview profile' });
      continue;
    }
    let visible: Interval[] = [range];
    if (profile.omitOccluded && feature.shape.type === 'ring') {
      const radius = feature.shape.rOuter;
      for (const cover of section.features) {
        if (cover.path === path || cover.shape.type !== 'ring' || profile.hiddenPaths.includes(cover.path)) continue;
        const span = ranges.get(cover.path);
        const distance = Math.hypot(cover.x - feature.x, cover.y - feature.y);
        // Only a known enclosing bore can hide this element. Never treat overlap as enclosure.
        if (!span || cover.shape.rInner + 1e-9 < distance + radius || cover.shape.rOuter <= radius) continue;
        const inset = Math.min(0.05, radius * 0.1, (span.end - span.start) / 4);
        visible = subtract(visible, { start: span.start + inset, end: span.end - inset });
      }
      if (visible.length !== 1 || visible[0]?.start !== range.start || visible[0]?.end !== range.end)
        model.omitted.push({ path, reason: 'Occluded interior omitted; end faces and construction retained' });
    }
    if (feature.shape.type === 'web') {
      model.pieces.push({ ...base, id: `${path}:body`, shape: 'web', center: [(range.start + range.end) / 2, feature.x, feature.y], size: [range.end - range.start, feature.shape.width, feature.shape.height] });
    } else {
      const { rOuter, rInner } = feature.shape;
      const cap: Cap = rInner > 0 ? 'ring' : 'disk';
      visible.forEach((iv, i) => model.pieces.push({ ...base, id: `${path}:body:${i}`, shape: 'tube', rOuter, rInner,
        points: [[iv.start, feature.x, feature.y], [iv.end, feature.x, feature.y]], radialSegments: 32,
        caps: { start: iv.start === range.start ? cap : 'none', end: iv.end === range.end ? cap : 'none' } }));
    }
    const leads = profile.cuts[path]?.leads;
    for (const end of ['a', 'b'] as const) {
      const lead = leads?.[end];
      if (!lead) continue;
      const cutLength = end === 'a' ? range.start : lengthMm - range.end;
      if ((feature.kind !== 'shield' && feature.kind !== 'drain') || feature.shape.type !== 'ring' ||
          !finitePositive(lead.lengthMm) || !finitePositive(lead.diameterMm) || lead.lengthMm > cutLength ||
          !Number.isFinite(lead.reachMm) || lead.reachMm < 0 || !Number.isFinite(lead.angleDeg)) {
        model.unknown.push(`${path} end ${end}: unresolved or invalid illustrative lead (requires screen/drain, diameter and length within cut)`);
        continue;
      }
      const angle = lead.angleDeg * Math.PI / 180;
      const start = end === 'a' ? range.start : range.end;
      const direction = end === 'a' ? -1 : 1;
      const lip = feature.kind === 'shield' ? (feature.shape.rOuter + feature.shape.rInner) / 2 : 0;
      const points: Vec3[] = Array.from({ length: 17 }, (_, i) => {
        const t = i / 16;
        const reach = lip + lead.reachMm * t * t * (3 - 2 * t);
        return [start + direction * lead.lengthMm! * t, feature.x + reach * Math.cos(angle), feature.y + reach * Math.sin(angle)];
      });
      model.pieces.push({ ...base, id: `${path}:lead:${end}`, kind: 'pigtail', shape: 'tube', end,
        rOuter: lead.diameterMm / 2, rInner: 0, points, radialSegments: 16, caps: { start: 'disk', end: 'disk' } });
    }
  }
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  const include = (point: Vec3, extents: Vec3) => point.forEach((v, axis) => {
    min[axis] = Math.min(min[axis]!, v - extents[axis]!);
    max[axis] = Math.max(max[axis]!, v + extents[axis]!);
  });
  for (const piece of model.pieces) {
    if (piece.shape === 'web') include(piece.center, piece.size.map(v => v / 2) as unknown as Vec3);
    else for (const point of piece.points) include(point, [piece.rOuter, piece.rOuter, piece.rOuter]);
  }
  if (model.pieces.length) model.bounds = { min: min as unknown as Vec3, max: max as unknown as Vec3 };
  return model;
}
