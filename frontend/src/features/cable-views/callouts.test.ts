import { describe, expect, it } from 'vitest';
import { END_FACE_LABEL_GAP, endFaceLayout, layoutCallouts, PICKUP_CLEARANCE, renderEndFaceSvg, renderSectionSvg, sectionLayout, segmentsIntersect } from '../../../../packages/section-layout/src';
import type { CalloutItem, CalloutOptions } from '../../../../packages/section-layout/src';
import { braidedCoax, screenedTwinWithDrain, shieldedPair } from './fixtures';

const parse = (svg: string) => new DOMParser().parseFromString(svg, 'image/svg+xml');
const lcg = (seed: number) => () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32;
const options: CalloutOptions = { cx: 0, cy: 0, radius: 3, fontSize: 0.5 };
const synthetic = (seed: number, count: number, concentric: number): CalloutItem[] => {
  const rand = lcg(seed);
  const items: CalloutItem[] = [];
  for (let i = 0; i < count; i += 1) {
    const r = concentric > i ? 0 : rand() * 2.2, a = rand() * Math.PI * 2;
    const key = `e${String(i).padStart(2, '0')}`, chars = 1 + (i % 2);
    // Concentric rings start their leaders on their own radius, as the renderer does.
    if (concentric > i) { const mid = 0.3 + 0.3 * i; items.push({ key, x: 0, y: 0, chars, anchor: angle => ({ x: mid * Math.cos(angle), y: mid * Math.sin(angle) }) }); }
    else items.push({ key, x: r * Math.cos(a), y: r * Math.sin(a), chars });
  }
  return items;
};
const anyCrossing = (placements: ReturnType<typeof layoutCallouts>) => {
  for (let i = 0; i < placements.length; i += 1) for (let j = i + 1; j < placements.length; j += 1) {
    const a = placements[i]!, b = placements[j]!;
    if (segmentsIntersect(a.anchor, a.end, b.anchor, b.end)) return `${a.key} x ${b.key}`;
  }
  return null;
};

describe('callout layout', () => {
  it('detects crossing and non-crossing segments', () => {
    expect(segmentsIntersect({ x: 0, y: 0 }, { x: 2, y: 2 }, { x: 0, y: 2 }, { x: 2, y: 0 })).toBe(true);
    expect(segmentsIntersect({ x: 0, y: 0 }, { x: 2, y: 0 }, { x: 0, y: 1 }, { x: 2, y: 1 })).toBe(false);
  });

  it.each([[1, 4, 0], [2, 7, 2], [3, 10, 3], [4, 12, 1], [5, 3, 3], [6, 9, 0], [7, 14, 4], [8, 6, 6]])('leaders never cross (seed %i, %i items, %i concentric)', (seed, count, concentric) => {
    const placements = layoutCallouts(synthetic(seed, count, concentric), options);
    expect(placements).toHaveLength(count);
    expect(anyCrossing(placements)).toBeNull();
  });

  it('puts every label on the outer ring, clear of the elements and of each other', () => {
    for (const seed of [11, 12, 13]) {
      const placements = layoutCallouts(synthetic(seed, 9, 2), options);
      for (const p of placements) expect(Math.hypot(p.end.x, p.end.y)).toBeGreaterThan(options.radius);
      const sorted = [...placements].sort((a, b) => a.angle - b.angle);
      for (let i = 0; i < sorted.length; i += 1) {
        const next = sorted[(i + 1) % sorted.length]!;
        const gap = (next.angle - sorted[i]!.angle + Math.PI * 2) % (Math.PI * 2);
        expect(gap * (options.radius + options.fontSize)).toBeGreaterThan(options.fontSize);
      }
    }
  });

  it('follows the angular order of the elements', () => {
    const items: CalloutItem[] = [0, 1, 2, 3, 4].map(i => ({ key: `k${i}`, x: 2 * Math.cos(i * 1.2), y: 2 * Math.sin(i * 1.2) }));
    const placements = layoutCallouts(items, options);
    const angles = items.map(i => placements.find(p => p.key === i.key)!.angle);
    for (let i = 0; i < angles.length; i += 1) expect(Math.abs(Math.atan2(Math.sin(angles[i]! - i * 1.2), Math.cos(angles[i]! - i * 1.2)))).toBeLessThan(0.6);
  });

  it('is deterministic whatever order the items arrive in', () => {
    const items = synthetic(21, 8, 2);
    expect(layoutCallouts(items, options)).toEqual(layoutCallouts(items, options));
    expect(layoutCallouts([...items].reverse(), options)).toEqual(layoutCallouts(items, options));
  });
});

describe('rendered callouts', () => {
  const leader = (g: Element) => { const [x1, y1, x2, y2] = g.querySelector('path')!.getAttribute('d')!.match(/-?\d+(\.\d+)?/g)!.map(Number); return { a: { x: x1!, y: y1! }, b: { x: x2!, y: y2! } }; };
  const crossings = (groups: Element[]) => {
    const ls = groups.map(leader);
    let count = 0;
    for (let i = 0; i < ls.length; i += 1) for (let j = i + 1; j < ls.length; j += 1) if (segmentsIntersect(ls[i]!.a, ls[i]!.b, ls[j]!.a, ls[j]!.b)) count += 1;
    return count;
  };
  it.each([['pair', shieldedPair], ['coax', braidedCoax]])('section callouts for a %s do not cross', (_name, make) => {
    const svg = parse(renderSectionSvg(sectionLayout(make()), 'Synthetic'));
    const groups = [...svg.querySelectorAll('[data-callout]')];
    expect(groups.length).toBeGreaterThan(3);
    expect(crossings(groups)).toBe(0);
  });
  it.each([['a', 0], ['b', 0], ['a', 40], ['b', 135]] as const)('end %s face at %i degrees has uncrossed leaders with outside labels', (end, rotation) => {
    const section = sectionLayout(shieldedPair());
    const result = endFaceLayout(section, end, { rotationDeg: rotation });
    if (result.status !== 'ok') throw new Error('face unavailable');
    const svg = parse(renderEndFaceSvg(result.face, 'End'));
    const groups = [...svg.querySelectorAll('[data-terminal]')];
    expect(groups).toHaveLength(4);
    expect(crossings(groups)).toBe(0);
    expect(renderEndFaceSvg(result.face, 'End')).toBe(renderEndFaceSvg(result.face, 'End'));
  });
});

describe('end face terminal labels', () => {
  const labels = (svg: Document) => [...svg.querySelectorAll('[data-terminal]')].map(g => {
    const t = g.querySelector('text')!;
    const [x1, y1, x2, y2] = g.querySelector('path')!.getAttribute('d')!.match(/-?\d+(\.\d+)?/g)!.map(Number);
    return { tag: g.getAttribute('data-terminal')!, x: Number(t.getAttribute('x')), y: Number(t.getAttribute('y')), size: Number(t.getAttribute('font-size')), a: { x: x1!, y: y1! }, b: { x: x2!, y: y2! } };
  });
  const faces = [['pair', shieldedPair], ['twin with drain', screenedTwinWithDrain]] as const;
  const turns = [['a', 0], ['b', 0], ['a', 90], ['b', 200], ['a', 315]] as const;

  it.each(faces.flatMap(([name, make]) => turns.map(([end, rotation]) => [name, make, end, rotation] as const)))('%s end %s at %i degrees: labels keep a minimum spacing and leaders stay apart', (_name, make, end, rotation) => {
    const result = endFaceLayout(sectionLayout(make()), end, { rotationDeg: rotation });
    if (result.status !== 'ok') throw new Error('face unavailable');
    const ls = labels(parse(renderEndFaceSvg(result.face, 'End')));
    expect(ls).toHaveLength(4);
    for (let i = 0; i < ls.length; i += 1) for (let j = i + 1; j < ls.length; j += 1) {
      const p = ls[i]!, q = ls[j]!;
      // Label anchors sit on a ring; their straight-line distance is a chord, a little under the arc gap.
      expect(Math.hypot(p.x - q.x, p.y - q.y), `${p.tag} / ${q.tag}`).toBeGreaterThan(p.size * END_FACE_LABEL_GAP * 0.9);
      expect(segmentsIntersect(p.a, p.b, q.a, q.b)).toBe(false);
    }
  });

  it('picks the screen up on its own ring, clear of the conductor beside it', () => {
    const section = sectionLayout(screenedTwinWithDrain());
    for (const end of ['a', 'b'] as const) {
      const result = endFaceLayout(section, end);
      if (result.status !== 'ok') throw new Error('face unavailable');
      const screen = result.face.terminals.find(t => t.role === 'shield')!;
      const mid = (2.9 + 2.7) / 4;
      // On the ring wall, not on a conductor.
      expect(Math.hypot(screen.x, screen.y)).toBeCloseTo(mid, 9);
      for (const other of result.face.terminals.filter(t => t !== screen)) {
        expect(Math.hypot(other.x - screen.x, other.y - screen.y)).toBeGreaterThanOrEqual(PICKUP_CLEARANCE * mid);
        if (Math.hypot(other.x, other.y) > 0.3) {
          const bearing = (p: { x: number; y: number }) => Math.atan2(p.y, p.x);
          const d = Math.abs(Math.atan2(Math.sin(bearing(other) - bearing(screen)), Math.cos(bearing(other) - bearing(screen))));
          expect(d).toBeGreaterThan(Math.PI / 8);
        }
      }
      // Still on the side the end's connections leave toward, turned upward first.
      expect(Math.sign(screen.x)).toBe(end === 'a' ? -1 : 1);
      expect(screen.y).toBeLessThan(0);
    }
  });
});
