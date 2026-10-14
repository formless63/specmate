import { describe, expect, it } from 'vitest';
import { endFaceLayout, layoutCallouts, renderEndFaceSvg, renderSectionSvg, sectionLayout, segmentsIntersect } from '../../../../packages/section-layout/src';
import type { CalloutItem, CalloutOptions } from '../../../../packages/section-layout/src';
import { braidedCoax, shieldedPair } from './fixtures';

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
