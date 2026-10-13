import { describe, expect, it } from 'vitest';
import { sectionLayout } from '../../../../packages/section-layout/src';
import type { Section } from '../../../../packages/section-layout/src';
import { unpreparedProfile, wireModel } from '../../../../packages/wire-geometry/src/model';
import type { DisplayProfile, TubePiece } from '../../../../packages/wire-geometry/src/model';
import { LAY_MAX_PIECE_SEGMENTS, LAY_MAX_TOTAL_SEGMENTS } from '../../../../packages/wire-geometry/src/lay';
import type { IllustrationLay } from '../../../../packages/wire-geometry/src/lay';
import { sweepPiece } from '../../../../packages/wire-geometry/src/scene';
import { stockPresets } from './presets';

const lay: IllustrationLay = { lengthMm: 24, direction: 'positive', construction: 'pair' };
const profile = (patch: Partial<DisplayProfile> = {}): DisplayProfile => ({ ...unpreparedProfile(), omitOccluded: false, illustrationLay: lay, ...patch });
const section = () => sectionLayout(structuredClone(stockPresets.pair!));
const tubes = (model: ReturnType<typeof wireModel>) => model.pieces as TubePiece[];

describe('explicit bounded illustration lay', () => {
  it('uses the declared phase and sign, preserves axial cuts and never changes construction', () => {
    const input = section(), before = structuredClone(input);
    const positive = wireModel(input, 24, profile({ cuts: { 'stock.pair.red.insulation': { a: 6, b: 3 } } }));
    const negative = wireModel(input, 24, profile({ illustrationLay: { ...lay, direction: 'negative' } }));
    const feature = input.features.find(f => f.path === 'stock.pair.red.center')!;
    const p = tubes(positive).find(p => p.elementPath === feature.path)!;
    const n = tubes(negative).find(p => p.elementPath === feature.path)!;
    expect(p.points).toHaveLength(25);
    expect(p.points[0]).toEqual([0, feature.x, feature.y]);
    expect(p.points[6]![1]).toBeCloseTo(-feature.y);
    expect(p.points[6]![2]).toBeCloseTo(feature.x);
    expect(n.points[6]![1]).toBeCloseTo(feature.y);
    expect(n.points[6]![2]).toBeCloseTo(-feature.x);
    const cut = tubes(positive).find(p => p.elementPath === 'stock.pair.red.insulation')!;
    expect(cut.points[0]![0]).toBe(6); expect(cut.points.at(-1)![0]).toBe(21);
    expect(cut.points[0]![2]).toBeCloseTo(feature.x);
    expect(cut.caps).toEqual({ start: 'ring', end: 'ring' });
    expect(positive.illustration).toMatchObject({ layApplied: true });
    expect(positive.illustration.message).toContain('phase zero at end A');
    expect(input).toEqual(before); expect(positive.electricalBonds).toEqual([]);
  });

  it('preserves occlusion intervals, artificial open boundaries and explicit hiding', () => {
    const input = section();
    const options = profile({ omitOccluded: true, hiddenPaths: ['stock.screen'], cuts: { 'stock.jacket': { a: 8, b: 5 } } });
    const straight = wireModel(input, 24, { ...options, illustrationLay: undefined });
    const curved = wireModel(input, 24, options);
    expect(curved.illustration.layApplied).toBe(true);
    const identity = (p: TubePiece) => [p.id, p.points[0]![0], p.points.at(-1)![0], p.caps];
    expect(tubes(curved).map(identity)).toEqual(tubes(straight).map(identity));
    expect(curved.omitted).toEqual(straight.omitted);
    expect(curved.pieces.some(p => p.elementPath === 'stock.screen')).toBe(false);
    expect(input.rows.some(r => r.path === 'stock.screen')).toBe(true);
  });

  it('attaches separate leads to both rotated screen cap planes, with conservative mesh bounds', () => {
    const input = section();
    input.features = [-2, 2].map((x, i) => ({ path: `screen${i}`, kind: 'shield', x, y: 0,
      color: null, material: null, shape: { type: 'ring', rOuter: 0.6, rInner: 0.4 } }));
    input.rows = input.features.map(f => ({ ...input.rows[0]!, path: f.path, kind: 'shield' }));
    const cuts = Object.fromEntries(input.features.map(f => [f.path, { a: 6, b: 3, leads: {
      a: { lengthMm: 4, diameterMm: 0.1, reachMm: 1, angleDeg: 35 },
      b: { lengthMm: 2, diameterMm: 0.1, reachMm: 1, angleDeg: 120 },
    } }]));
    const model = wireModel(input, 24, profile({ cuts }));
    const leads = tubes(model).filter(p => p.kind === 'pigtail');
    expect(leads.map(p => p.id)).toEqual(['screen0:lead:a', 'screen0:lead:b', 'screen1:lead:a', 'screen1:lead:b']);
    for (const lead of leads) {
      const body = tubes(model).find(p => p.elementPath === lead.elementPath && p.kind === 'shield')!;
      const atStart = lead.end === 'a';
      const center = atStart ? body.points[0]! : body.points.at(-1)!;
      const next = atStart ? body.points[1]! : body.points.at(-2)!;
      const tangent = center.map((v, i) => v - next[i]!);
      const offset = lead.points[0]!.map((v, i) => v - center[i]!);
      expect(Math.hypot(...offset)).toBeCloseTo(0.5);
      expect(offset.reduce((sum, v, i) => sum + v * tangent[i]!, 0)).toBeCloseTo(0, 10);
      expect(lead.points.at(-1)![0] - lead.points[0]![0]).toBeCloseTo(atStart ? -4 : 2);
    }
    // Full generated surfaces (including tilted caps) must lie inside display bounds.
    for (const piece of tubes(model)) {
      const geometry = sweepPiece(piece), positions = geometry.getAttribute('position');
      for (let i = 0; i < positions.count; i++) for (let axis = 0; axis < 3; axis++) {
        const value = positions.getComponent(i, axis);
        expect(Number.isFinite(value)).toBe(true);
        expect(value).toBeGreaterThanOrEqual(model.bounds!.min[axis]! - 1e-6);
        expect(value).toBeLessThanOrEqual(model.bounds!.max[axis]! + 1e-6);
      }
      geometry.dispose();
    }
    expect(model.electricalBonds).toEqual([]);
  });

  it('rotates a drain lead anchor even when its body is fully occluded', () => {
    const input = section();
    const model = wireModel(input, 24, profile({ omitOccluded: true, cuts: {
      'stock.drain': { a: 6, b: 3, leads: { a: { lengthMm: 4, diameterMm: 0.1, reachMm: 1, angleDeg: 0 } } },
    } }));
    expect(model.pieces.some(p => p.elementPath === 'stock.drain' && p.kind !== 'pigtail')).toBe(false);
    const lead = tubes(model).find(p => p.kind === 'pigtail')!;
    expect(lead.points[0]![0]).toBe(6);
    expect(lead.points[0]![1]).toBeCloseTo(-1.5);
    expect(lead.points[0]![2]).toBeCloseTo(0);
    expect(lead.points.every(p => p.every(Number.isFinite))).toBe(true);
  });

  it.each([
    { lengthMm: null }, { direction: null }, { lengthMm: 0 }, { lengthMm: -1 },
    { lengthMm: NaN }, { lengthMm: Infinity }, { lengthMm: 1e-20 },
    { construction: 'ribbon' as const }, { construction: 'figure-eight' as const },
    { construction: 'coax' as const }, { unsupportedReason: 'nested web' },
  ])('retains exactly straight geometry when lay is unresolved, invalid or unsupported: %o', patch => {
    const input = section();
    const straight = wireModel(input, 24, profile({ illustrationLay: undefined }));
    const result = wireModel(input, 24, profile({ illustrationLay: { ...lay, ...patch } }));
    expect(result.illustration.layApplied).toBe(false);
    expect(result.illustration.message).toContain('Straight illustration:');
    expect(result.pieces).toEqual(straight.pieces); expect(result.bounds).toEqual(straight.bounds);
  });

  it('retains straight geometry for unresolved construction and webs even with a round construction label', () => {
    const input = section(); input.unknown.push('Synthetic missing dimensions');
    expect(wireModel(input, 24, profile()).illustration.message).toContain('construction geometry is unresolved');
    const web = sectionLayout(stockPresets['figure-eight']!);
    const model = wireModel(web, 24, profile());
    expect(model.illustration.layApplied).toBe(false);
    expect(model.pieces.find(p => p.shape === 'web')).toBeDefined();
  });

  it('preflights per-piece and total segment budgets without partial application or undersampling', () => {
    const input = section();
    const overPiece = wireModel(input, 24, profile({ illustrationLay: { ...lay, lengthMm: 1 } }));
    expect(overPiece.illustration.message).toContain(`${LAY_MAX_PIECE_SEGMENTS} segments per piece`);
    expect(tubes(overPiece).every(p => p.points.length === 2)).toBe(true);
    const count = Math.floor(LAY_MAX_TOTAL_SEGMENTS / LAY_MAX_PIECE_SEGMENTS) + 1;
    const many: Section = { ...input, features: Array.from({ length: count }, (_, i) => ({
      ...input.features[0]!, path: `synthetic${i}`, x: i + 1, y: 0,
    })) };
    many.rows = many.features.map(f => ({ ...input.rows[0]!, path: f.path }));
    const bounded = profile({ illustrationLay: { ...lay, construction: 'bundle', lengthMm: 24 * 24 / LAY_MAX_PIECE_SEGMENTS } });
    const overTotal = wireModel(many, 24, bounded);
    expect(overTotal.illustration.message).toContain('total budget');
    expect(tubes(overTotal).every(p => p.points.length === 2)).toBe(true);
    many.features.pop(); many.rows.pop();
    const fits = wireModel(many, 24, bounded);
    expect(fits.illustration.layApplied).toBe(true);
    expect(tubes(fits).reduce((sum, p) => sum + p.points.length - 1, 0)).toBe(LAY_MAX_TOTAL_SEGMENTS);
  });
});
