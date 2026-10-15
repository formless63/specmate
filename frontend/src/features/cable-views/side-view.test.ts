import { describe, expect, test } from 'vitest';
import { CALLOUT_SCALE, elementExtent, formatExtent, renderSideViewSvg, sectionLayout, segmentsIntersect, sideAnnotationUnit, sideCallouts, sideViewLayout } from '../../../../packages/section-layout/src';
import type { PrepInstruction, PrepProfile, RoundElement } from '../../../../packages/section-layout/src';
import { braidedCoax, screenedTwinWithDrain, shieldedPair } from './fixtures';

// Expected values below are worked by hand from the synthetic fixtures, not read back from the code.
const strip = (element_path: string, nominal: string | null, extra: Partial<PrepInstruction> = {}, datum = 'from_stock_cut_end', tol: [string | null, string | null] = [null, null]): PrepInstruction =>
  ({ kind: 'layer_strip', element_path, treatment: 'strip_back', length: { nominal_mm: nominal, minus_mm: tol[0], plus_mm: tol[1], datum }, ...extra });
const parse = (svg: string) => new DOMParser().parseFromString(svg, 'image/svg+xml');
const close = (actual: number, expected: number) => expect(actual).toBeCloseTo(expected, 6);

test('cutaway steps each enclosed layer out of the one around it, outermost furthest back', () => {
  // Coax Ø3.2: jacket ⊃ braid ⊃ dielectric ⊃ conductor. Step = 0.7 × 3.2 = 2.24; run = 1.6 × 3.2 = 5.12.
  const view = sideViewLayout(sectionLayout(braidedCoax()), { mode: 'cutaway' });
  const cut = Object.fromEntries(view.bands.map(b => [b.path, b.a.status === 'known' ? b.a.cutbackMm : NaN]));
  close(cut['stock.jacket']!, 6.72); close(cut['stock.braid']!, 4.48); close(cut['stock.dielectric']!, 2.24); close(cut['stock.center']!, 0);
  close(view.windows.a, 6.72 + 5.12);
  // Painter order: nearest surface (x + r) last, so the jacket covers what it encloses.
  expect(view.bands.map(b => b.path)).toEqual(['stock.center', 'stock.dielectric', 'stock.braid', 'stock.jacket']);
  expect(view.bands.every(b => b.a.status === 'known' && b.a.illustrative)).toBe(true);
  const svg = parse(renderSideViewSvg(view, 'Coax'));
  expect(svg.querySelector('svg')!.getAttribute('data-mode')).toBe('cutaway');
  expect(svg.querySelector('[data-element="stock.jacket"][data-end="a"] rect')!.getAttribute('x')).toBe('6.72');
  expect(svg.querySelector('[data-element="stock.jacket"] rect')!.getAttribute('fill')).toBe('#6b4423');
  expect(svg.querySelector('[data-element="stock.braid"]')!.getAttribute('data-texture')).toBe('braid');
  expect(svg.querySelectorAll('[data-dimension]').length).toBe(0);
  expect(svg.querySelector('desc')!.textContent).toContain('Illustrative cutaway');
});

test('prepared ends follow the instructions; unknown extents are hatched across the end, not guessed', () => {
  const profile: PrepProfile = {
    a: { instructions: [
      strip('stock.jacket', '20', {}, 'from_stock_cut_end', ['0.5', '1']),
      { kind: 'shield_lead', element_path: 'stock.braid', treatment: 'form_lead', length: { nominal_mm: '15', datum: 'along_finished_lead' } },
      strip('stock.dielectric', '5'),
      { kind: 'layer_strip', element_path: 'stock.center', treatment: 'retain' },
    ] },
    b: { instructions: [strip('stock.jacket', '12', {}, 'along_finished_lead')] },
  };
  const view = sideViewLayout(sectionLayout(braidedCoax()), { mode: 'prepared', preparation: profile });
  const at = (path: string, end: 'a' | 'b') => view.bands.find(b => b.path === path)![end];
  expect(at('stock.jacket', 'a')).toMatchObject({ status: 'known', cutbackMm: 20, minusMm: 0.5, plusMm: 1, illustrative: false });
  expect(formatExtent(at('stock.jacket', 'a'))).toBe('Stops 20 mm from the cut end (−0.5 / +1)');
  expect(at('stock.braid', 'a')).toEqual({ status: 'unknown', reason: 'form lead does not fix where the element ends' });
  expect(at('stock.center', 'a')).toMatchObject({ status: 'known', cutbackMm: 0 });
  expect(at('stock.jacket', 'b').status).toBe('unknown');
  expect(at('stock.center', 'b')).toEqual({ status: 'unknown', reason: 'no preparation instruction' });
  // Window A = longest known cut 20 + plus tolerance 1 + run 5.12; nothing known at B leaves only the run.
  close(view.windows.a, 26.12); close(view.windows.b, 5.12);
  const svg = parse(renderSideViewSvg(view, 'Prepared coax'));
  expect([...svg.querySelectorAll('[data-dimension="a"]')].map(d => d.getAttribute('data-length'))).toEqual(['5', '20']);
  expect(svg.querySelectorAll('[data-dimension="b"]').length).toBe(0);
  const braid = svg.querySelector('[data-element="stock.braid"][data-end="a"]')!;
  expect(braid.getAttribute('data-extent')).toBe('unknown');
  expect(braid.querySelector('rect')!.getAttribute('x')).toBe('0');
  expect(braid.querySelector('[data-cut-face]')).toBeNull();
  expect(svg.querySelector('[data-element="stock.jacket"][data-end="a"] [data-cut-face="a"]')).not.toBeNull();
  const notes = [...svg.querySelectorAll('[data-unknown-note]')].map(t => t.textContent);
  expect(notes).toContain('End A extent unknown: 3');
  expect(notes).toContain('End B extent unknown: 1, 2, 3, 4');
});

test('a group instruction reaches its descendants unless a more specific one applies', () => {
  const profile: PrepProfile = { a: { instructions: [
    strip('stock.pair', '30'),
    { kind: 'layer_strip', element_path: 'stock.pair.core-a.insulation', treatment: 'retain' },
  ] }, b: { instructions: [] } };
  expect(elementExtent(profile.a, 'stock.pair.core-b.insulation').extent).toMatchObject({ status: 'known', cutbackMm: 30 });
  expect(elementExtent(profile.a, 'stock.pair.core-a.insulation').extent).toMatchObject({ status: 'known', cutbackMm: 0 });
  expect(elementExtent(profile.a, 'stock.jacket').extent.status).toBe('unknown');
});

test('an unknown layer strip yields to a placing trim; invalid or unplaced lengths stay unknown', () => {
  const end = { instructions: [
    { kind: 'layer_strip', element_path: 'stock.screen', treatment: 'unknown' },
    { kind: 'shield_lead', element_path: 'stock.screen', treatment: 'trim', length: { nominal_mm: '4', datum: 'from_stock_cut_end' } },
    strip('stock.jacket', 'abc'),
    strip('stock.drain', null),
  ] };
  expect(elementExtent(end, 'stock.screen').extent).toMatchObject({ status: 'known', cutbackMm: 4 });
  expect(elementExtent(end, 'stock.jacket').extent).toEqual({ status: 'unknown', reason: 'strip back length is not a valid dimension' });
  expect(elementExtent(end, 'stock.drain').extent).toEqual({ status: 'unknown', reason: 'strip back length unknown' });
});

test('recorded colors and tracer stripes are drawn; an unknown diameter is listed, never drawn', () => {
  const stock = shieldedPair();
  const jacket = stock.structure.children.find(c => c.id === 'jacket') as RoundElement;
  jacket.outer_diameter_mm = null;
  const view = sideViewLayout(sectionLayout(stock), { mode: 'cutaway' });
  expect(view.notDrawn).toEqual([{ path: 'stock.jacket', tag: '7', reason: 'layer dimensions unknown' }]);
  const svg = parse(renderSideViewSvg(view, 'Pair'));
  expect(svg.querySelector('[data-element="stock.jacket"]')).toBeNull();
  expect(svg.querySelector('[data-element="stock.pair.core-b.insulation"] [data-stripe]')!.getAttribute('fill')).toBe('#1f5fbf');
  expect(svg.querySelector('[data-element="stock.pair.core-a.insulation"] rect')!.getAttribute('fill')).toBe('#c62828');
  expect([...svg.querySelectorAll('[data-unknown-note]')].map(t => t.textContent)).toContain('Not drawn, section geometry unknown: 7');
});

test('selection adds a reticle and never changes a fill', () => {
  const view = sideViewLayout(sectionLayout(braidedCoax()), { mode: 'cutaway' });
  const plain = parse(renderSideViewSvg(view, 'Coax'));
  const picked = parse(renderSideViewSvg(view, 'Coax', { selected: 'stock.braid' }));
  expect(plain.querySelector('[data-selected]')).toBeNull();
  expect(picked.querySelectorAll('[data-selected]').length).toBe(2);
  const fill = (doc: Document) => doc.querySelector('[data-element="stock.braid"] rect')!.getAttribute('fill');
  expect(fill(picked)).toBe(fill(plain));
});

describe('end A tag callouts', () => {
  const unknownScreen: PrepProfile = { a: { instructions: [
    strip('stock.jacket', '15', {}, 'from_stock_cut_end', ['0.2', '0.3']),
    { kind: 'shield_lead', element_path: 'stock.screen', treatment: 'form_lead', length: { nominal_mm: '8', datum: 'along_finished_lead' } },
    { kind: 'drain_treatment', element_path: 'stock.drain', treatment: 'trim', length: { nominal_mm: '0', datum: 'from_stock_cut_end' } },
  ] }, b: { instructions: [] } };
  const stepped: PrepProfile = { a: { instructions: [
    strip('stock.jacket', '20'), strip('stock.screen', '14'), strip('stock.drain', '14'),
    strip('stock.pair.core-a.insulation', '5'), strip('stock.pair.core-b.insulation', '5'),
  ] }, b: { instructions: [] } };
  const cases = [
    ['twin, screen lead unknown', () => sideViewLayout(sectionLayout(screenedTwinWithDrain()), { mode: 'prepared', preparation: unknownScreen })],
    ['twin, stepped strip', () => sideViewLayout(sectionLayout(screenedTwinWithDrain()), { mode: 'prepared', preparation: stepped })],
    ['twin cutaway', () => sideViewLayout(sectionLayout(screenedTwinWithDrain()), { mode: 'cutaway' })],
    ['pair cutaway', () => sideViewLayout(sectionLayout(shieldedPair()), { mode: 'cutaway' })],
    ['coax cutaway', () => sideViewLayout(sectionLayout(braidedCoax()), { mode: 'cutaway' })],
  ] as const;
  const leaders = (svg: Document) => [...svg.querySelectorAll('[data-callout]')].map(g => {
    const [x1, y1, x2, y2] = g.querySelector('path')!.getAttribute('d')!.match(/-?\d+(\.\d+)?/g)!.map(Number);
    const text = g.querySelector('text')!;
    return { path: g.getAttribute('data-callout')!, a: { x: x1!, y: y1! }, b: { x: x2!, y: y2! }, x: Number(text.getAttribute('x')), size: Number(text.getAttribute('font-size')), tag: text.textContent! };
  });

  test.each(cases)('%s: leaders never cross and labels are ordered, spaced and readable', (_name, make) => {
    const view = make();
    const fs = sideAnnotationUnit(view);
    const ls = leaders(parse(renderSideViewSvg(view, 'Side')));
    expect(ls.length).toBe(view.bands.filter(b => b.tag).length);
    for (let i = 0; i < ls.length; i += 1) for (let j = i + 1; j < ls.length; j += 1)
      expect(segmentsIntersect(ls[i]!.a, ls[i]!.b, ls[j]!.a, ls[j]!.b), `${ls[i]!.tag} x ${ls[j]!.tag}`).toBe(false);
    const xs = ls.map(l => l.x).sort((p, q) => p - q);
    for (let i = 1; i < xs.length; i += 1) expect(xs[i]! - xs[i - 1]!).toBeGreaterThanOrEqual(fs * 1.5);
    // Readable: the tags are set at the drawing's annotation size, not shrunk below it.
    for (const l of ls) expect(l.size).toBeGreaterThanOrEqual(fs * CALLOUT_SCALE - 1e-3);
    expect(CALLOUT_SCALE).toBeGreaterThanOrEqual(1);
  });

  test.each(cases)('%s: each leader starts on its own element at end A', (_name, make) => {
    const view = make();
    for (const c of sideCallouts(view, sideAnnotationUnit(view))) {
      const band = view.bands.find(b => b.path === c.path)!;
      const x0 = band.a.status === 'known' ? band.a.cutbackMm : 0;
      expect(c.anchor.x).toBeGreaterThanOrEqual(x0);
      expect(c.anchor.x).toBeLessThanOrEqual(view.windows.a);
      expect(c.anchor.y).toBeGreaterThanOrEqual(band.y - band.half);
      expect(c.anchor.y).toBeLessThanOrEqual(band.y + band.half);
    }
  });

  test('visible layers are pointed at where they show; covered ones are marked, never placed on top', () => {
    // Stepped strip: insulation shows from 5 mm, screen and drain from 14 mm, jacket from 20 mm.
    const view = sideViewLayout(sectionLayout(screenedTwinWithDrain()), { mode: 'prepared', preparation: stepped });
    const placed = new Map(sideCallouts(view, sideAnnotationUnit(view)).map(c => [c.path, c]));
    expect(placed.get('stock.jacket')!.anchor.x).toBeGreaterThan(20);
    expect(placed.get('stock.screen')!.anchor.x).toBeGreaterThan(14);
    expect(placed.get('stock.screen')!.anchor.x).toBeLessThan(20);
    expect(placed.get('stock.pair.core-b.insulation')!.anchor.x).toBeGreaterThan(5);
    expect(placed.get('stock.pair.core-b.insulation')!.anchor.x).toBeLessThan(14);
    expect(placed.get('stock.pair.core-b.wire')!.anchor.x).toBeLessThan(5);
    expect(placed.get('stock.pair.core-b.wire')!.occluded).toBe(false);
    // Core A lies exactly behind core B in this view: it is called out as covered, at its center line.
    expect(placed.get('stock.pair.core-a.wire')).toMatchObject({ occluded: true, anchor: { y: 0 } });
    const svg = parse(renderSideViewSvg(view, 'Side'));
    expect(svg.querySelector('[data-callout="stock.pair.core-a.wire"]')!.getAttribute('data-occluded')).toBe('true');
    expect(svg.querySelector('[data-callout="stock.pair.core-b.wire"]')!.hasAttribute('data-occluded')).toBe(false);
  });

  test('elements that show in the same place are labeled in tag order, and layout is deterministic', () => {
    const view = sideViewLayout(sectionLayout(screenedTwinWithDrain()), { mode: 'prepared', preparation: unknownScreen });
    const fs = sideAnnotationUnit(view);
    const order = [...sideCallouts(view, fs)].sort((p, q) => p.label.x - q.label.x).map(c => c.tag);
    // Everything under the screen and the screen itself can only be pointed at ahead of the jacket.
    expect(order.slice(0, 5)).toEqual(['1', '2', '3', '4', '5']);
    expect(order.at(-1)).toBe('7');
    expect(sideCallouts(view, fs)).toEqual(sideCallouts(view, fs));
  });
});
