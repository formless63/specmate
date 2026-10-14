// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Callout layout: labels sit on an outer ring around the drawing, in angular order of the
 * elements they name, joined by straight leaders that never cross. Pure and deterministic:
 * the same inputs always give the same placement, with ties broken by key.
 */
export interface CalloutItem {
  key: string;
  /** Element centre, used to find its angle around the drawing. */
  x: number;
  y: number;
  /** Where the leader starts on the element, given the label's angle. Defaults to the centre. */
  anchor?: (angle: number) => { x: number; y: number };
  /** Label text length in characters, for spacing. */
  chars?: number;
}
export interface CalloutPlacement {
  key: string;
  angle: number;
  anchor: { x: number; y: number };
  /** Leader end, on the label ring. */
  end: { x: number; y: number };
  text: { x: number; y: number; anchor: 'start' | 'middle' | 'end' };
}
export interface CalloutOptions {
  cx: number;
  cy: number;
  /** Radius of a circle that contains every element. Labels sit just outside it. */
  radius: number;
  fontSize: number;
  /** Least distance between neighbouring labels along the ring, drawing units. Defaults to 1.3 font sizes. */
  minLabelGap?: number;
}

const TAU = Math.PI * 2;
const norm = (a: number): number => ((a % TAU) + TAU) % TAU;
const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

type P = { x: number; y: number };
const cross = (o: P, a: P, b: P): number => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
/** True when two segments properly cross or touch. */
export function segmentsIntersect(a: P, b: P, c: P, d: P): boolean {
  const d1 = cross(c, d, a), d2 = cross(c, d, b), d3 = cross(a, b, c), d4 = cross(a, b, d);
  if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) return true;
  const on = (p: P, q: P, r: P): boolean => Math.min(p.x, q.x) <= r.x && r.x <= Math.max(p.x, q.x) && Math.min(p.y, q.y) <= r.y && r.y <= Math.max(p.y, q.y);
  return (d1 === 0 && on(c, d, a)) || (d2 === 0 && on(c, d, b)) || (d3 === 0 && on(a, b, c)) || (d4 === 0 && on(a, b, d));
}

/** Angles for every item: geometric where the element is off the drawing's centre, else in the widest free gap. */
function preferredAngles(items: CalloutItem[], o: CalloutOptions): number[] {
  const eps = o.radius * 1e-6 + 1e-9;
  const angles: (number | null)[] = items.map(i => Math.hypot(i.x - o.cx, i.y - o.cy) <= eps ? null : norm(Math.atan2(i.y - o.cy, i.x - o.cx)));
  const placed = angles.filter((a): a is number => a !== null).sort((a, b) => a - b);
  // Central items are placed in key order, so input order never matters.
  const byKey = items.map((_, i) => i).sort((a, b) => cmp(items[a]!.key, items[b]!.key));
  for (const i of byKey) {
    if (angles[i] !== null) continue;
    // Widest circular gap among angles taken so far; the new label goes in its middle.
    let start = -Math.PI / 4, width = TAU;
    if (placed.length > 0) {
      width = -1;
      for (let k = 0; k < placed.length; k += 1) {
        const next = k + 1 < placed.length ? placed[k + 1]! : placed[0]! + TAU;
        if (next - placed[k]! > width + 1e-12) { width = next - placed[k]!; start = placed[k]!; }
      }
    }
    const a = norm(start + width / 2);
    angles[i] = a;
    placed.push(a); placed.sort((x, y) => x - y);
  }
  return angles as number[];
}

/** Spread sorted circular angles so neighbours are at least `gap` apart, moving each as little as the order allows. */
function relax(sorted: number[], gap: number): number[] {
  const n = sorted.length;
  if (n === 1) return sorted;
  let seam = 0, widest = -1;
  for (let k = 0; k < n; k += 1) {
    const next = k + 1 < n ? sorted[k + 1]! : sorted[0]! + TAU;
    if (next - sorted[k]! > widest + 1e-12) { widest = next - sorted[k]!; seam = k; }
  }
  const u: number[] = [];
  for (let k = 1; k <= n; k += 1) { const idx = (seam + k) % n; u.push(sorted[idx]! + (idx <= seam ? TAU : 0)); }
  const f: number[] = [], b: number[] = new Array<number>(n);
  for (let i = 0; i < n; i += 1) f.push(i === 0 ? u[0]! : Math.max(u[i]!, f[i - 1]! + gap));
  for (let i = n - 1; i >= 0; i -= 1) b[i] = i === n - 1 ? u[i]! : Math.min(u[i]!, b[i + 1]! - gap);
  const s = u.map((_, i) => (f[i]! + b[i]!) / 2);
  const ok = s.every((v, i) => i === 0 || v - s[i - 1]! >= gap - 1e-9) && s[0]! + TAU - s[n - 1]! >= gap - 1e-9;
  const out = ok ? s : u.map((_, i) => u[0]! + (i * TAU) / n);
  return out.map(norm).sort((a, b2) => a - b2);
}

export function layoutCallouts(items: CalloutItem[], o: CalloutOptions): CalloutPlacement[] {
  const n = items.length;
  if (n === 0) return [];
  const order = items.map((_, i) => i);
  const pref = preferredAngles(items, o);
  order.sort((a, b) => pref[a]! - pref[b]! || cmp(items[a]!.key, items[b]!.key));
  const ringR = o.radius + o.fontSize * 0.9;
  const chars = Math.max(...items.map(i => i.chars ?? 2));
  const gap = Math.min(TAU / n, Math.max(o.minLabelGap ?? o.fontSize * 1.3, o.fontSize * 0.62 * chars) / ringR);
  const slots = relax(order.map(i => pref[i]!), gap);
  // Slot k is the k-th label position; assign[k] is the item index placed there. Start in angular order.
  // Rotate so slot angles line up with the sorted preference as closely as possible.
  const assign = [...order];
  const anchorOf = (item: CalloutItem, angle: number): P => item.anchor ? item.anchor(angle) : { x: item.x, y: item.y };
  const endOf = (angle: number): P => ({ x: o.cx + ringR * Math.cos(angle), y: o.cy + ringR * Math.sin(angle) });
  const segment = (k: number): [P, P] => [anchorOf(items[assign[k]!]!, slots[k]!), endOf(slots[k]!)];
  const crossing = (): [number, number] | null => {
    const segs = slots.map((_, k) => segment(k));
    for (let i = 0; i < n; i += 1) for (let j = i + 1; j < n; j += 1)
      if (segmentsIntersect(segs[i]![0], segs[i]![1], segs[j]![0], segs[j]![1])) return [i, j];
    return null;
  };
  // Uncrossing: swapping two crossing leaders' labels shortens the total, so this terminates.
  for (let guard = 0; guard < n * n * 4; guard += 1) {
    const hit = crossing();
    if (hit === null) break;
    [assign[hit[0]], assign[hit[1]]] = [assign[hit[1]]!, assign[hit[0]]!];
  }
  const out: CalloutPlacement[] = slots.map((angle, k) => {
    const item = items[assign[k]!]!;
    const dx = Math.cos(angle), dy = Math.sin(angle);
    const pad = o.fontSize * 0.3;
    const anchor: CalloutPlacement['text']['anchor'] = dx > 0.3 ? 'start' : dx < -0.3 ? 'end' : 'middle';
    // Text sits beyond the leader end; vertical centring uses a fixed baseline shift.
    const along = anchor === 'middle' ? 0 : pad;
    const tx = o.cx + ringR * dx + along * dx;
    const ty = o.cy + ringR * dy + (anchor === 'middle' ? dy * o.fontSize * 0.7 : 0) + o.fontSize * 0.35;
    return { key: item.key, angle, anchor: anchorOf(item, angle), end: endOf(angle), text: { x: tx, y: ty, anchor } };
  });
  return out.sort((a, b) => cmp(a.key, b.key));
}
