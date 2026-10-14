import { expect, test } from 'vitest';
import { elementExtent, formatExtent, renderSideViewSvg, sectionLayout, sideViewLayout } from '../../../../packages/section-layout/src';
import type { PrepInstruction, PrepProfile, RoundElement } from '../../../../packages/section-layout/src';
import { braidedCoax, shieldedPair } from './fixtures';

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

test('recorded colours and tracer stripes are drawn; an unknown diameter is listed, never drawn', () => {
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
