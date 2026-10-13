import { describe, expect, it } from 'vitest';
import original from '../../../../tests/fixtures/stock-section.json';
import { renderPreviewSvg, renderSectionSvg, sectionLayout, stockGeometry } from '../../../../packages/section-layout/src';
import type { StockSpecification } from '../../../../packages/section-layout/src';
import { stockPresets } from './presets';
import coax from '../../../../tests/fixtures/wire-stock-coax.json';
import pair from '../../../../tests/fixtures/wire-stock-pair.json';
import ribbon from '../../../../tests/fixtures/wire-stock-ribbon.json';
import figure8 from '../../../../tests/fixtures/wire-stock-figure-eight.json';

const cases = [coax, pair, ribbon, figure8];
describe('shared stock section, drawing and geometry', () => {
  it.each(cases)('retains independent construction dimensions and feature counts', fixture => {
    const section = sectionLayout(fixture.stock as StockSpecification);
    expect(section.unknown).toEqual([]);
    expect(section.widthMm).toBeCloseTo(fixture.expected.width_mm, 8);
    expect(section.heightMm).toBeCloseTo(fixture.expected.height_mm, 8);
    expect(section.features).toHaveLength(fixture.expected.leaf_count);
    expect(section.rows).toHaveLength(fixture.expected.leaf_count);
    const geometry = stockGeometry(section, 100);
    expect(geometry.widthMm).toBe(section.widthMm);
    expect(geometry.pieces).toHaveLength(fixture.expected.leaf_count);
    expect(geometry.pieces.every(p => p.endMm - p.startMm === 100)).toBe(true);
    const svg = new DOMParser().parseFromString(renderSectionSvg(section, '<Synthetic & stock>'), 'image/svg+xml');
    expect(svg.querySelectorAll('[data-element]')).toHaveLength(fixture.expected.leaf_count);
    expect(svg.querySelectorAll('[data-callout]')).toHaveLength(fixture.expected.leaf_count);
    expect(svg.querySelector('title')?.textContent).toBe('<Synthetic & stock>');
    const preview = new DOMParser().parseFromString(renderPreviewSvg(geometry, 'Synthetic'), 'image/svg+xml');
    expect(preview.querySelectorAll('[data-preview-element]')).toHaveLength(fixture.expected.leaf_count);
    expect(section.electricalBonds).toHaveLength(original.expected.electrical_bonds_from_display);
  });
  it('preserves the original independent four-layer 3 mm coax oracle', () => {
    const section = sectionLayout(stockPresets.coax!);
    expect(section.widthMm).toBe(original.expected.outer_diameter_mm);
    expect(section.features).toHaveLength(original.expected.layer_count);
    for (const expected of original.layers) {
      const feature = section.features.find(f => f.path === `stock.${expected.id}`)!;
      expect(feature.kind).toBe(expected.kind);
      expect(feature.shape).toEqual({ type: 'ring', rInner: expected.r_inner, rOuter: expected.r_outer });
    }
  });
  it('does not invent a bore or dimension for unknown geometry and preserves table identities', () => {
    const stock = structuredClone(stockPresets.coax!);
    const node = stock.structure.children[2]!;
    if (node.kind !== 'web' && node.kind !== 'group') node.inner_diameter_mm = null;
    const section = sectionLayout(stock);
    expect(section.widthMm).toBeNull();
    expect(section.features).toHaveLength(3);
    expect(section.rows).toHaveLength(4);
    expect(section.rows[2]?.path).toBe('stock.screen');
    expect(section.rows[2]?.innerDiameterMm).toBeNull();
    expect(stockGeometry(section, 100).unknown).toContain('stock.screen: layer dimensions unknown');
  });
  it('reports unknown nested positions rather than drawing a false arrangement', () => {
    const stock = structuredClone(stockPresets.pair!);
    const pair = stock.structure.children[0]!;
    if (pair.kind === 'group') pair.pitch_mm = null;
    const section = sectionLayout(stock);
    expect(section.widthMm).toBeNull();
    expect(section.rows).toHaveLength(8);
    expect(section.features.filter(f => f.path.startsWith('stock.pair.'))).toHaveLength(0);
  });
  it('retains deterministic handed ring order and creates no bonds', () => {
    const stock = structuredClone(stockPresets.pair!);
    const pair = stock.structure.children[0]!;
    if (pair.kind === 'group') { pair.arrangement = 'ring'; pair.pitch_mm = 1.5; }
    const a = sectionLayout(stock);
    expect(sectionLayout(stock)).toEqual(a);
    expect(a.features.find(f => f.path === 'stock.pair.red.center')?.y).toBeCloseTo(-0.75, 8);
    expect(a.electricalBonds).toEqual([]);
  });
  it('does not render impossible unsaved layer boundaries as engineering geometry', () => {
    const stock = structuredClone(stockPresets.coax!);
    const layer = stock.structure.children[2]!;
    if (layer.kind !== 'group' && layer.kind !== 'web') layer.inner_diameter_mm = 3;
    const section = sectionLayout(stock);
    expect(section.widthMm).toBeNull();
    expect(section.features).toHaveLength(3);
    expect(section.unknown).toContain('stock.screen: invalid layer boundaries');
  });
  it('does not inject unsanitized SVG color attributes', () => {
    const section = sectionLayout(stockPresets.coax!);
    section.features[0]!.color = 'red" onload="alert(1)';
    expect(renderSectionSvg(section, 'Synthetic')).not.toContain('onload');
  });
});
