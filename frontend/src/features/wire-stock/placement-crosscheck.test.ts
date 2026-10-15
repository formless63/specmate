import { describe, expect, it } from 'vitest';
import crossCheck from '../../../../tests/fixtures/wire-stock-placement.json';
import { evaluateFit, FIT_TOLERANCE_MM, sectionLayout } from '../../../../packages/section-layout/src';
import type { StockSpecification } from '../../../../packages/section-layout/src';
import coax from '../../../../tests/fixtures/wire-stock-coax.json';
import pair from '../../../../tests/fixtures/wire-stock-pair.json';
import ribbon from '../../../../tests/fixtures/wire-stock-ribbon.json';
import figure8 from '../../../../tests/fixtures/wire-stock-figure-eight.json';

const referenced: Record<string, { stock: unknown }> = {
  'wire-stock-coax.json': coax, 'wire-stock-pair.json': pair, 'wire-stock-ribbon.json': ribbon, 'wire-stock-figure-eight.json': figure8,
};
type Case = (typeof crossCheck.cases)[number] & { fixture?: string; stock?: unknown };
const stockOf = (entry: Case) => (entry.fixture ? referenced[entry.fixture]!.stock : entry.stock) as StockSpecification;

describe('section placement and fit findings match the backend cross-check fixture', () => {
  it('shares the tolerance', () => expect(crossCheck.tolerance_mm).toBe(FIT_TOLERANCE_MM));
  it.each(crossCheck.cases as Case[])('$name', entry => {
    const stock = stockOf(entry);
    const section = sectionLayout(stock);
    const expected = entry.expected.positions as unknown as Record<string, [number, number] | null>;
    // Every drawn leaf sits exactly where the backend places it; unknown positions are not drawn.
    expect(section.rows.map(r => r.path)).toEqual(Object.keys(expected));
    for (const [path, xy] of Object.entries(expected)) {
      const feature = section.features.find(f => f.path === path);
      if (xy === null) {
        expect(feature).toBeUndefined();
        expect(section.unknown).toContain(`${path}: position unknown`);
      } else if (feature) {
        expect(feature.x).toBeCloseTo(xy[0], 9);
        expect(feature.y).toBeCloseTo(xy[1], 9);
      }
    }
    const report = evaluateFit(stock);
    expect([report.status, report.checks]).toEqual([entry.expected.status, entry.expected.checks]);
    expect(report.findings.map(f => [f.code, f.status, f.paths, f.message]))
      .toEqual(entry.expected.findings.map(f => [f.code, f.status, f.paths, f.message]));
    report.findings.forEach((f, i) => {
      const want = entry.expected.findings[i]!.excess_mm;
      if (want === null) expect(f.excess_mm).toBeNull();
      else expect(f.excess_mm).toBeCloseTo(want, 6);
    });
  });
});
