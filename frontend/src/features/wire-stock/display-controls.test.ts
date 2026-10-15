import { expect, test } from 'vitest';
import { sectionLayout } from '../../../../packages/section-layout/src';
import { unpreparedProfile } from '../../../../packages/wire-geometry/src/model';
import { cutValue, layerPaths, withLayerCut } from './display-controls';
import { stockPresets } from './presets';
import { blankSpec, generate } from './builder';
import { stockSpecSheet } from './spec-sheet';

test('display layers select material paths without hiding or bonding drains', () => {
  const spec = blankSpec('round'); spec.shield = 'foil'; spec.drain = true; const section = sectionLayout(generate(spec));
  expect(layerPaths(section, 'screen').length).toBeGreaterThan(0); expect(section.rows.some(row => row.kind === 'drain')).toBe(true);
  expect(layerPaths(section, 'screen').every(path => section.rows.find(row => row.path === path)?.kind === 'shield')).toBe(true);
  expect(layerPaths(section, 'jacket').every(path => path.split('.').length === 2)).toBe(true);
  expect(layerPaths(section, 'insulation').every(path => ['insulation', 'dielectric'].includes(section.rows.find(row => row.path === path)!.kind))).toBe(true);
  expect(layerPaths(section, 'screen').some(path => section.rows.find(row => row.path === path)?.kind === 'drain')).toBe(false);
});
test('explicit unknown cut and unequal cuts remain unknown; local edits preserve opposite end and frozen input', () => {
  const original = { ...unpreparedProfile(), cuts: { a: { a: null, b: 5 }, b: { a: 7, b: 6 } } };
  expect(cutValue(original, ['a'], 'a')).toBeNull(); expect(cutValue(original, ['a', 'b'], 'b')).toBeNull(); expect(cutValue(original, ['unprepared'], 'a')).toBe(0);
  const next = withLayerCut(original, ['a'], 'a', 3); expect(next.cuts.a).toEqual({ a: 3, b: 5 }); expect(original.cuts.a.a).toBeNull(); expect(next.cuts.b).toEqual(original.cuts.b); expect(next.id).toBe('local-preview');
});
test('standalone sheet escapes authored text, retains unknown facts and labels exact state', () => {
  const stock = structuredClone(stockPresets.coax!); stock.structure.label = '<script>unsafe</script>'; stock.facts.impedance = { value: null, unit: 'ohm', status: 'unknown', source: null };
  const sheet = stockSpecSheet('A & B <img src=x>', stock, 'Frozen r75 · exact-pin');
  expect(sheet).toContain('Frozen r75 · exact-pin'); expect(sheet).toContain('A &amp; B &lt;img src=x&gt;'); expect(sheet).not.toContain('<script>unsafe'); expect(sheet).toContain('<td>Unknown ohm</td><td>unknown</td>');
});
