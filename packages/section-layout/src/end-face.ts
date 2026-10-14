// SPDX-License-Identifier: AGPL-3.0-only
/**
 * End face: one cut end of a stock, as seen looking into that end.
 *
 * Adapted from cab-stu packages/layout/src/end-face.ts at commit
 * 6bbf79655deb572df9f11490ca38e4f739ce71fb (MIT, formless63; see NOTICE). The
 * chirality rule is kept: the section is drawn as seen from `viewed_from`; the
 * opposite end is that drawing mirrored about the vertical axis, so every ring
 * reads the other way round. Rotation is free (the cable can be turned), so it is
 * an input, never a stock fact. Workshop-specific end naming and bond folding are
 * not carried over; terminals exist for every conducting element and no bond is implied.
 *
 * A stock whose viewed-from end is unknown has no end face: drawing one would invent
 * a chirality.
 */
import type { Section, SectionFeature } from './model';

export type StockEnd = 'a' | 'b';
export type Reading = 'cw' | 'ccw';
export interface EndFaceOptions { rotationDeg?: number }
export interface EndFaceTerminal {
  path: string;
  role: 'conductor' | 'shield' | 'drain';
  tag: string;
  label: string;
  /** Screen coordinates (mm, y down) after mirroring and rotation. */
  x: number;
  y: number;
}
export interface EndFaceRingReading { path: string; drawn: Reading; atThisEnd: Reading }
export interface EndFace {
  end: StockEnd;
  viewedFrom: StockEnd;
  mirrored: boolean;
  rotationDeg: number;
  section: Section;
  terminals: EndFaceTerminal[];
  ringReadings: EndFaceRingReading[];
  /** Conducting elements with no known position on this face. */
  unplaced: string[];
}
export type EndFaceResult =
  | { status: 'ok'; face: EndFace }
  | { status: 'unavailable'; reason: string };

const DEG = Math.PI / 180;
const flip = (r: Reading): Reading => r === 'cw' ? 'ccw' : 'cw';
const ROLE: Partial<Record<SectionFeature['kind'], EndFaceTerminal['role']>> = { conductor: 'conductor', shield: 'shield', drain: 'drain' };

/** Mirror about the vertical axis (when needed), then turn counter-clockwise on screen. */
export function placeOnFace(x: number, y: number, mirrored: boolean, rotationDeg: number): { x: number; y: number } {
  const px = mirrored ? -x : x;
  const c = Math.cos(rotationDeg * DEG), s = Math.sin(rotationDeg * DEG);
  const clean = (v: number): number => Math.abs(v) < 1e-12 ? 0 : v;
  return { x: clean(px * c + y * s), y: clean(-px * s + y * c) };
}

/** Steps of the shield pick-up search along its wall, and the clearance it seeks, as a share of the wall radius. */
const PICKUP_STEP = Math.PI / 12;
export const PICKUP_CLEARANCE = 0.45;
/** Least angle, seen from the ring centre, between the pick-up and any off-centre terminal: their leaders leave apart. */
export const PICKUP_SEPARATION = (25 * Math.PI) / 180;

/**
 * The point on a shield wall nearest its preferred angle that stands clear of the other terminals: far
 * enough from each, and at a different bearing from the ring centre, so no two leaders run together.
 * Falls back to the clearest point within a quarter turn.
 */
export function shieldPickup(centre: { x: number; y: number }, mid: number, preferred: number, others: readonly { x: number; y: number }[]): { x: number; y: number } {
  const clean = (v: number): number => Math.abs(v) < 1e-12 ? 0 : v;
  const point = (a: number) => ({ x: clean(centre.x + mid * Math.cos(a)), y: clean(centre.y + mid * Math.sin(a)) });
  const clearance = (p: { x: number; y: number }): number => Math.min(Infinity, ...others.map(o => Math.hypot(o.x - p.x, o.y - p.y)));
  const apart = (a: number): boolean => others.every(o => {
    if (Math.hypot(o.x - centre.x, o.y - centre.y) <= mid * 0.2) return true;
    const d = Math.abs(Math.atan2(Math.sin(Math.atan2(o.y - centre.y, o.x - centre.x) - a), Math.cos(Math.atan2(o.y - centre.y, o.x - centre.x) - a)));
    return d >= PICKUP_SEPARATION - 1e-9;
  });
  let best = point(preferred), bestClear = -1;
  // Upward on screen (y down, so toward negative sine) first, then downward, up to a quarter turn either way.
  const up = Math.sin(preferred + PICKUP_STEP) < Math.sin(preferred - PICKUP_STEP) ? 1 : -1;
  for (let k = 0; k <= 6; k += 1) for (const sign of k === 0 ? [up] : [up, -up]) {
    const angle = preferred + sign * k * PICKUP_STEP;
    const candidate = point(angle);
    const c = clearance(candidate);
    if (c >= PICKUP_CLEARANCE * mid && apart(angle)) return candidate;
    if (c > bestClear + 1e-12) { best = candidate; bestClear = c; }
  }
  return best;
}

export function endFaceLayout(section: Section, end: StockEnd, options: EndFaceOptions = {}): EndFaceResult {
  if (section.viewedFrom === 'unknown') {
    return { status: 'unavailable', reason: 'The end this construction was drawn from is not recorded, so neither end can be drawn without inventing how it is mirrored.' };
  }
  if (section.features.length === 0) {
    return { status: 'unavailable', reason: 'No element has complete geometry yet.' };
  }
  const rotation = options.rotationDeg ?? 0;
  if (!Number.isFinite(rotation)) return { status: 'unavailable', reason: 'Rotation must be a finite number of degrees.' };
  const mirrored = end !== section.viewedFrom;
  // The side this end's connections leave toward: shields are picked up there (drawing convention).
  const outward = end === 'a' ? -1 : 1;
  const terminals: EndFaceTerminal[] = [];
  const unplaced: string[] = [];
  const shields: { row: Section['rows'][number]; feature: SectionFeature; mid: number }[] = [];
  for (const row of section.rows) {
    const role = ROLE[row.kind];
    if (!role) continue;
    const feature = section.features.find(f => f.path === row.path);
    if (!feature) { unplaced.push(row.path); continue; }
    if (role === 'shield' && feature.shape.type === 'ring') {
      shields.push({ row, feature, mid: (feature.shape.rOuter + feature.shape.rInner) / 2 });
      continue;
    }
    terminals.push({ path: row.path, role, tag: row.tag, label: `${row.tag} ${row.label}`, ...placeOnFace(feature.x, feature.y, mirrored, rotation) });
  }
  // A shield ring is picked up at its wall on the outward side, measured on the screen after turning,
  // turned along the wall (upward first) just far enough to stand clear of every other terminal.
  for (const { row, feature, mid } of shields) {
    const centre = placeOnFace(feature.x, feature.y, mirrored, rotation);
    const at = shieldPickup(centre, mid, outward === -1 ? Math.PI : 0, terminals);
    terminals.push({ path: row.path, role: 'shield', tag: row.tag, label: `${row.tag} ${row.label}`, ...at });
  }
  terminals.sort((p, q) => section.rows.findIndex(r => r.path === p.path) - section.rows.findIndex(r => r.path === q.path));
  const ringReadings = (section.groups ?? []).filter(g => g.arrangement === 'ring').map(g =>
    ({ path: g.path, drawn: g.direction, atThisEnd: mirrored ? flip(g.direction) : g.direction }));
  return { status: 'ok', face: { end, viewedFrom: section.viewedFrom, mirrored, rotationDeg: rotation, section, terminals, ringReadings, unplaced } };
}
