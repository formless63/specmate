import { describe, expect, it } from 'vitest';
import { evaluateFit, sectionLayout } from '../../../../packages/section-layout/src';
import { blankSpec, exampleCoax, generate } from './builder';
import type { BuilderSpec } from './builder';
import { clientToMm, contentDiameter, derivedLayup, fitFixes, fitOverlay, nudgeOd, odFromPoint, parseViewBox, stockMeters } from './builder-visual';
import { renderSectionSvg } from '../../../../packages/section-layout/src';

function twoCore(jacketOd: number | null, wall: number | null): BuilderSpec {
  const spec = blankSpec('round', 2);
  return { ...spec, conductor: { ...spec.conductor, diameter_mm: 0.5 }, insulation: { od_mm: 1.3, material: null },
    shield: 'braid', braid_thickness_mm: 0.1, jacket: { od_mm: jacketOd, wall_mm: wall, material: null, color: null } };
}
const analyze = (spec: BuilderSpec) => { const stock = generate(spec); const section = sectionLayout(stock); return { stock, section, fit: evaluateFit(stock) }; };

describe('visual builder meters', () => {
  it('derives content, bore, min OD and fill from the shared placement', () => {
    const { stock, section } = analyze(twoCore(4.2, 0.4));
    const m = stockMeters(twoCore(4.2, 0.4), stock, section);
    expect(m.contentDiameter).toBe(2.8);
    expect(m.jacketBore).toBe(3.4);
    expect(m.minJacketOd).toBe(3.6);
    expect(m.fillPercent).toBe(82.4);
    expect(m.layupDiameter).toBe(2.6);
  });
  it('keeps unknown unknown', () => {
    const spec = blankSpec('round', 2);
    const { stock, section } = analyze(spec);
    const m = stockMeters(spec, stock, section);
    expect([m.contentDiameter, m.jacketBore, m.minJacketOd, m.fillPercent]).toEqual([null, null, null, null]);
    expect(derivedLayup(spec).bore).toBeNull();
  });
  it('reports min OD as content only when the wall is unknown', () => {
    const spec = twoCore(4.2, null);
    const { stock, section } = analyze(spec);
    const m = stockMeters(spec, stock, section);
    expect(m.minJacketOd).toBe(2.8);
    expect(m.wallKnown).toBe(false);
  });
});

describe('fit fixes and overlay', () => {
  it('draws a failing bore and offers deterministic fixes that restore a fit', () => {
    const spec = twoCore(3.2, 0.4);
    const { stock, section, fit } = analyze(spec);
    expect(fit.status).toBe('problems');
    const overlay = fitOverlay(section, fit);
    expect(overlay.bores.map(b => b.path)).toContain('stock.jacket');
    expect(overlay.bands.length).toBeGreaterThan(0);
    expect(overlay.rings.length).toBeGreaterThan(0);
    expect(overlay.callouts).toHaveLength(1);
    expect(overlay.callouts[0]!.text).toMatch(/won't fit Jacket bore 2\.4 mm \(\+\d\.\d{3} mm\)$/);
    // The badge sits on a ring outside the numbered layer tags, on a free angle.
    const c = overlay.callouts[0]!;
    expect(Math.hypot(c.end.x, c.end.y)).toBeGreaterThan(Math.hypot(c.anchor.x, c.anchor.y));
    const fixes = fitFixes(spec, stock, section, fit);
    expect(fixes.map(f => f.id)).toEqual(['jacket-od', 'jacket-wall']);
    for (const fix of fixes) {
      const next = analyze(fix.apply(spec));
      expect(next.fit.status).toBe('ok');
    }
    expect(fixes[0]!.apply(spec).jacket.od_mm).toBe(3.6);
    expect(fixes[1]!.apply(spec).jacket.wall_mm).toBe(0.2);
  });
  it('offers no fix and draws nothing for a fitting or unknown construction', () => {
    const ok = analyze(twoCore(4.2, 0.4));
    expect(fitFixes(twoCore(4.2, 0.4), ok.stock, ok.section, ok.fit)).toEqual([]);
    expect(fitOverlay(ok.section, ok.fit)).toEqual({ bores: [], rings: [], bands: [], callouts: [] });
    const unknown = analyze(blankSpec('round', 2));
    expect(fitOverlay(unknown.section, unknown.fit).bores).toEqual([]);
  });
  it('does not offer a wall fix when the wall is unknown (the jacket then fits the content)', () => {
    const { stock, section, fit } = analyze(exampleCoax());
    expect(fit.status).toBe('ok');
    expect(fitFixes(exampleCoax(), stock, section, fit)).toEqual([]);
    expect(contentDiameter(stock, section)).toBe(2.4);
  });
});

describe('jacket handle math', () => {
  it('maps a pointer to an OD snapped to the step, never below the floor', () => {
    expect(odFromPoint(2.1, 0, 0.1)).toBe(4.2);
    expect(odFromPoint(1.5, 2.0, 0.1)).toBe(5);
    expect(odFromPoint(0.01, 0, 1.55)).toBe(1.55);
    expect(nudgeOd(4.2, 1, 0.1)).toBe(4.25);
    expect(nudgeOd(0.12, -1, 0.1)).toBe(0.1);
  });
  it('maps client pixels through the meet-scaled, centered view box', () => {
    const svg = renderSectionSvg(sectionLayout(generate(exampleCoax())), 'x');
    const vb = parseViewBox(svg)!;
    // A box wider than the drawing: the drawing is centered horizontally.
    const box = { left: 100, top: 50, width: 400, height: 200 };
    const scale = Math.min(400 / vb.w, 200 / vb.h);
    const center = clientToMm(box, vb, 100 + 200, 50 + 100);
    expect(center.x).toBeCloseTo(vb.x + vb.w / 2, 6);
    expect(center.y).toBeCloseTo(vb.y + vb.h / 2, 6);
    const edge = clientToMm(box, vb, 100 + 200 + 1.5 * scale, 50 + 100);
    expect(edge.x - center.x).toBeCloseTo(1.5, 6);
  });
});

describe('section framing', () => {
  it('frames the section tightly with room for the handle label and swaps only the view box', async () => {
    const { frameSection, withViewBox } = await import('./builder-visual');
    const { section } = analyze(twoCore(4.2, 0.4));
    const vb = frameSection(section, 2.1);
    expect(vb.x).toBeLessThan(-2.1);
    expect(vb.w).toBeGreaterThan(vb.h);
    const svg = renderSectionSvg(section, 'x');
    expect(withViewBox(svg, vb)).toContain(`viewBox="${vb.x} ${vb.y} ${vb.w} ${vb.h}"`);
    expect(withViewBox(svg, vb).replace(/viewBox="[^"]*"/, '')).toBe(svg.replace(/viewBox="[^"]*"/, ''));
  });
});
