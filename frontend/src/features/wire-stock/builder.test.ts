import { describe, expect, it } from 'vitest';
import { evaluateFit, placeStock, sectionLayout } from '../../../../packages/section-layout/src';
import type { StockSpecification } from '../../../../packages/section-layout/src';
import { awgAreaMm2, awgDiameterMm, awgForArea, blankSpec, colourName, coreLooks, drainPlacement, exampleCoax, generate, illustrate, layup, readBuilder } from './builder';
import type { BuilderSpec } from './builder';
import { stockPresets } from './presets';

const positions = (stock: StockSpecification) => Object.fromEntries(placeStock(stock.structure).nodes
  .filter(n => n.type === 'leaf').map(n => [n.path, n.x === null || n.y === null ? null : [n.x, n.y]]));

/** The owner-reported shape: two 1.3 mm insulated cores, braid, drain and a 4.2 mm jacket with a 0.4 mm wall. */
function shieldedTwoCore(): BuilderSpec {
  const spec = blankSpec('round', 2);
  return { ...spec, source: 'Synthetic example',
    conductor: { ...spec.conductor, diameter_mm: 0.5, material: 'copper' }, insulation: { od_mm: 1.3, material: 'PVC' },
    shield: 'braid', braid_thickness_mm: 0.1, drain: true, drain_diameter_mm: 0.4,
    jacket: { od_mm: 4.2, wall_mm: 0.4, material: 'PVC', color: '#303030' } };
}

describe('construction builder', () => {
  it('lays two cores side by side, centred and inside the screen and jacket', () => {
    const stock = generate(shieldedTwoCore());
    const at = positions(stock);
    expect(at['stock.cores.core-1.insulation']![0]).toBeCloseTo(-0.65, 9);
    expect(at['stock.cores.core-2.insulation']![0]).toBeCloseTo(0.65, 9);
    expect(at['stock.cores.core-1.insulation']![1]).toBeCloseTo(0, 9);
    // The drain sits in the upper interstice touching the screen bore (lay-up radius 1.3 mm).
    expect(at['stock.drain']).toEqual([0, -1.1]);
    const braid = stock.structure.children.find(c => c.id === 'braid');
    expect(braid).toMatchObject({ inner_diameter_mm: 2.6, outer_diameter_mm: 2.8, construction: 'braid' });
    const jacket = stock.structure.children.find(c => c.id === 'jacket');
    expect(jacket).toMatchObject({ outer_diameter_mm: 4.2, inner_diameter_mm: 3.4 });
    const fit = evaluateFit(stock);
    expect(fit.status).toBe('ok');
    expect(fit.findings).toEqual([]);
    // No manual offset is stored on arranged members.
    expect(placeStock(stock.structure).offsetMembers).toEqual([]);
  });

  it('re-lays the cores when the insulation diameter changes', () => {
    const spec = shieldedTwoCore();
    const wider = generate({ ...spec, insulation: { ...spec.insulation, od_mm: 1.5 } });
    const cores = wider.structure.children.find(c => c.id === 'cores');
    expect(cores).toMatchObject({ arrangement: 'linear', pitch_mm: 1.5 });
    expect(wider.structure.children.find(c => c.id === 'braid')).toMatchObject({ inner_diameter_mm: 3 });
    expect(evaluateFit(wider).status).toBe('ok');
  });

  it('rings three or more cores with an inscribed centre filler', () => {
    const spec = { ...shieldedTwoCore(), cores: blankSpec('round', 3).cores, filler: true };
    const stock = generate(spec);
    const l = layup(1.3, 3);
    expect(l.ringRadius).toBeCloseTo(1.3 / (2 * Math.sin(Math.PI / 3)), 12);
    expect(stock.structure.children.find(c => c.id === 'cores')).toMatchObject({ arrangement: 'ring' });
    const filler = stock.structure.children.find(c => c.id === 'filler');
    expect(filler).toMatchObject({ kind: 'filler' });
    expect((filler as { outer_diameter_mm: number }).outer_diameter_mm).toBeCloseTo(2 * l.ringRadius! - 1.3, 4);
    expect(evaluateFit(stock).status).toBe('ok');
  });

  it('builds fitting pairs, ribbon, figure-eight and coax constructions', () => {
    const base = shieldedTwoCore();
    for (const spec of [
      { ...base, template: 'pairs' as const, cores: blankSpec('pairs', 1).cores },
      // Three pairs do not fit the two-core jacket bore; fit the jacket to the lay-up instead.
      { ...base, template: 'pairs' as const, cores: blankSpec('pairs', 3).cores, jacket: { ...base.jacket, od_mm: null } },
      { ...blankSpec('ribbon', 6), conductor: base.conductor, insulation: base.insulation, web_thickness_mm: 0.3 },
      { ...blankSpec('figure-eight'), conductor: base.conductor, insulation: base.insulation, spacing_mm: 1.6, web_thickness_mm: 0.4 },
      exampleCoax(),
    ]) {
      const stock = generate(spec);
      expect(sectionLayout(stock).unknown, spec.template).toEqual([]);
      expect(evaluateFit(stock).status, spec.template).toBe('ok');
      // Reopens in the builder (an entered value may read back in an equivalent form).
      expect(readBuilder(stock)?.template, spec.template).toBe(spec.template);
    }
  });

  it('matches the original synthetic coax fixture dimensions', () => {
    const section = sectionLayout(generate(exampleCoax()));
    expect([section.widthMm, section.heightMm, section.rows.length]).toEqual([3, 3, 4]);
  });

  it('keeps unknown inputs unknown: positions, pitch and bores are null and the fit is not ok', () => {
    const spec = { ...shieldedTwoCore(), insulation: { od_mm: null, material: null } };
    const stock = generate(spec);
    expect(stock.structure.children.find(c => c.id === 'cores')).toMatchObject({ pitch_mm: null });
    const drain = stock.structure.children.find(c => c.id === 'drain')!;
    expect([drain.x_mm, drain.y_mm]).toEqual([null, null]);
    expect(positions(stock)['stock.drain']).toBeNull();
    expect(stock.structure.children.find(c => c.id === 'braid')).toMatchObject({ inner_diameter_mm: null, outer_diameter_mm: null });
    const fit = evaluateFit(stock);
    expect(fit.status).toBe('incomplete');
    expect(drainPlacement(layup(null, 2), 0.4)).toEqual({ x: null, y: null, boreRadius: null });
    // The illustration substitutes placeholders and says so; the stored spec is untouched.
    const drawn = illustrate(spec);
    expect(drawn.substituted).toContain('insulation diameter');
    expect(spec.insulation.od_mm).toBeNull();
    expect(sectionLayout(generate(drawn.spec)).unknown).toEqual([]);
  });

  it('reports an entered jacket that is too small for the lay-up', () => {
    const fit = evaluateFit(generate({ ...shieldedTwoCore(), template: 'pairs', cores: blankSpec('pairs', 3).cores }));
    expect(fit.status).toBe('problems');
    expect(fit.findings.every(f => f.code === 'containment' && f.paths[1] === 'stock.jacket')).toBe(true);
  });

  it('reads back only trees it can regenerate exactly', () => {
    const spec = shieldedTwoCore();
    const stock = generate(spec);
    expect(readBuilder(stock)).toEqual(spec);
    const edited = structuredClone(stock);
    edited.structure.children[0]!.x_mm = 0.2;
    expect(readBuilder(edited)).toBeNull();
    expect(readBuilder(stockPresets.pair!)).toBeNull();
  });

  it('sizes conductors by AWG and area', () => {
    expect(awgDiameterMm(24)).toBeCloseTo(0.5106, 4);
    expect(awgAreaMm2(24)).toBeCloseTo(0.2047, 4);
    expect(awgDiameterMm(36)).toBeCloseTo(0.127, 12);
    expect(awgForArea(0.2047)).toBe(24);
    expect(awgForArea(0.3)).toBeNull();
  });

  it('labels generated nodes by core and keeps entered colours, round-tripping exactly', () => {
    const spec = { ...shieldedTwoCore(), cores: coreLooks('round', 2, 'sequence') };
    const stock = generate(spec);
    const cores = stock.structure.children.find(c => c.id === 'cores');
    const core1 = (cores as { children: { id: string; children: { label: string; color: string | null }[] }[] }).children[0]!;
    expect(core1.children.map(c => c.label)).toEqual(['Core 1', 'Core 1 insulation']);
    expect(core1.children[1]!.color).toBe('#d62728');
    expect(colourName('#d62728')).toBe('red');
    expect(stock.structure.children.find(c => c.id === 'braid')!.label).toBe('Screen');
    expect(readBuilder(stock)).toEqual(spec);
  });

  it('leaves core colours unknown until a colour code is chosen', () => {
    expect(coreLooks('round', 3).map(l => l.color)).toEqual([null, null, null]);
    expect(coreLooks('pairs', 1, 'sequence').map(l => l.color)).toEqual(['#1f5fbf', '#f2f2f2']);
  });
});
