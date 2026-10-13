import { describe, expect, it } from 'vitest';
import { sectionLayout } from '../../../../packages/section-layout/src';
import { wireModel } from '../../../../packages/wire-geometry/src/model';
import { adaptFrozenProfile } from './profile-adapter';
import { stockPresets } from './presets';
import { endPractice, profileRevision, suggestion } from './profile-test-fixtures';

describe('frozen workshop profile projection', () => {
  it('pins exact stock, preserves immutable inputs and does not substitute zero for an unknown cut', () => {
    const stock = structuredClone(stockPresets.coax!), revision = profileRevision();
    revision.content.profile.element_rules['stock.screen'] = { a: endPractice(null), b: endPractice(6) };
    const before = structuredClone({ stock, revision });
    const applied = adaptFrozenProfile(revision, 'stock-r1', stock);
    expect(applied.display.cuts['stock.screen']).toEqual({ a: null, b: 6 });
    const model = wireModel(sectionLayout(stock), 50, applied.display);
    expect(model.pieces.some(p => p.elementPath === 'stock.screen')).toBe(false);
    expect(model.electricalBonds).toEqual([]);
    expect({ stock, revision }).toEqual(before);
    expect(() => adaptFrozenProfile(revision, 'stock-r2', stock)).toThrow('do not match');
  });
  it('omits leads with unknown direction without inventing geometry, preserving other nullable lead values', () => {
    const revision = profileRevision();
    const rule = { a: endPractice(10), b: endPractice(8) };
    rule.a.lead = { length_mm: suggestion(5), diameter_mm: suggestion(0.4), reach_mm: suggestion<number>(null), angle_deg: suggestion(0) };
    rule.b.lead = { length_mm: suggestion(5), diameter_mm: suggestion<number>(null), reach_mm: suggestion(2), angle_deg: suggestion(180) };
    revision.content.profile.element_rules['stock.screen'] = rule;
    const applied = adaptFrozenProfile(revision, 'stock-r1', stockPresets.coax!);
    expect(applied.display.cuts['stock.screen']!.leads?.a).toBeUndefined();
    expect(applied.display.cuts['stock.screen']!.leads?.b).toMatchObject({ diameterMm: null, angleDeg: 180 });
    expect(applied.notices.join()).toContain('reach or angle is unknown');
    expect(wireModel(sectionLayout(stockPresets.coax!), 50, applied.display).pieces.some(p => p.kind === 'pigtail')).toBe(false);
  });
  it('hides only declared foil and explicitly hidden group descendants, leaving stock dimensions and facts unchanged', () => {
    const stock = structuredClone(stockPresets.pair!), revision = profileRevision();
    const screen = stock.structure.children.find(c => c.id === 'screen')!;
    if (screen.kind !== 'group' && screen.kind !== 'web') screen.construction = 'foil';
    revision.content.profile.hidden_element_paths = ['stock.pair'];
    revision.content.profile.foil_visibility = suggestion('hide');
    const before = structuredClone(stock);
    const adapted = adaptFrozenProfile(revision, 'stock-r1', stock);
    expect(adapted.display.hiddenPaths).toEqual(['stock.pair.red.center', 'stock.pair.red.insulation', 'stock.pair.blue.center', 'stock.pair.blue.insulation', 'stock.screen']);
    expect(stock).toEqual(before);
    expect(sectionLayout(stock).rows).toHaveLength(8);
  });
  it('applies group cuts while retaining unsupported lay/prepend notices', () => {
    const revision = profileRevision();
    revision.content.profile.illustration_lay_length_mm = suggestion(25);
    revision.content.profile.element_rules['stock'] = { a: endPractice(20), b: endPractice(20) };
    revision.content.profile.element_rules['stock.jacket']!.a.prepend_cut_mm = suggestion(7);
    revision.content.profile.omit_occluded = suggestion<boolean>(null);
    const adapted = adaptFrozenProfile(revision, 'stock-r1', stockPresets.coax!);
    expect(adapted.display.cuts.stock).toBeUndefined();
    expect(adapted.display.cuts['stock.jacket']!.a).toBe(20);
    expect(adapted.display.cuts['stock.center']).toEqual({ a: 20, b: 20 });
    expect(adapted.notices.join()).toContain('25 mm is unsupported');
    expect(adapted.notices.join()).toContain('prepend cut 7 mm is unsupported');
    expect(adapted.notices.join()).toContain('group cutbacks apply to every descendant');
    expect(adapted.notices.join()).toContain('Occlusion preference is unknown');
  });
  it('combines nested group cuts without restoring child material or changing identities', () => {
    const stock = structuredClone(stockPresets.pair!), revision = profileRevision();
    revision.content.profile.element_rules = {
      stock: { a: endPractice(2), b: endPractice(0) },
      'stock.pair': { a: endPractice(10), b: endPractice(6) },
      'stock.pair.red.center': { a: endPractice(3), b: endPractice(8) },
    };
    const before = structuredClone({ stock, revision });
    const applied = adaptFrozenProfile(revision, 'stock-r1', stock);
    expect(applied.display.cuts['stock.pair.red.center']).toEqual({ a: 10, b: 8 });
    expect(applied.display.cuts['stock.pair.blue.center']).toEqual({ a: 10, b: 6 });
    expect(applied.display.cuts['stock.jacket']).toEqual({ a: 2, b: 0 });
    const model = wireModel(sectionLayout(stock), 50, { ...applied.display, omitOccluded: false });
    expect(model.pieces.filter(piece => piece.elementPath.startsWith('stock.pair.')).every(piece => piece.shape !== 'tube' || piece.points[0]![0] >= 10)).toBe(true);
    expect(model.electricalBonds).toEqual([]);
    expect({ stock, revision }).toEqual(before);
  });
  it('retains unknown group cuts and omits only the unresolved subtree', () => {
    const stock = structuredClone(stockPresets.pair!), revision = profileRevision();
    revision.content.profile.element_rules = {
      'stock.pair': { a: endPractice(null), b: endPractice(6) },
      'stock.pair.red.center': { a: endPractice(3), b: endPractice(8) },
    };
    const applied = adaptFrozenProfile(revision, 'stock-r1', stock);
    expect(applied.display.cuts['stock.pair.red.center']).toEqual({ a: null, b: 8 });
    const model = wireModel(sectionLayout(stock), 50, { ...applied.display, omitOccluded: false });
    expect(model.pieces.some(piece => piece.elementPath.startsWith('stock.pair.'))).toBe(false);
    expect(model.pieces.some(piece => piece.elementPath === 'stock.jacket')).toBe(true);
    expect(model.unknown.join()).toContain('unresolved or invalid end cuts');
  });
});
