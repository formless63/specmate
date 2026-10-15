import { describe, expect, it } from 'vitest';
import { buildSheetModel, formboardLayout, parseDecimal, renderBuildSheetHtml, renderFormboardSvg, sumDecimals } from '../../../../packages/harness-views/src';
import { harness, stocks } from './fixtures';

const parse = (svg: string) => new DOMParser().parseFromString(svg, 'image/svg+xml');

describe('exact decimal sums', () => {
  it('adds without floating-point error and multiplies by quantity', () => {
    expect(sumDecimals(['500', '250.5'], 1)).toBe('750.5');
    expect(sumDecimals(['500', '250.5'], 3)).toBe('2251.5');
    expect(sumDecimals(['0.1', '0.2'])).toBe('0.3');
  });
  it('propagates unknown and rejects malformed text', () => {
    expect(sumDecimals(['500', null])).toBeNull();
    expect(parseDecimal('1e3')).toBeNull();
    expect(parseDecimal('-5')).toBeNull();
  });
});

describe('formboard layout', () => {
  const board = formboardLayout(harness(), stocks());
  const bar = (id: string) => board.bars.find(b => b.sectionId === id)!;
  it('draws each section at its planned length on one scale', () => {
    expect(bar('S1').x1 - bar('S1').x0).toBe(500);
    expect(bar('S2').x1 - bar('S2').x0).toBeCloseTo(250.5, 10);
  });
  it('continues the first leg from the trunk end on the same row and drops the others', () => {
    expect(bar('S2').x0).toBe(500);
    expect(bar('S2').y).toBe(bar('S1').y);
    expect(bar('S3').x0).toBe(500);
    expect(bar('S3').y).toBeGreaterThan(bar('S1').y);
    expect(board.links).toEqual([{ breakoutId: 'B1', x1: 500, y1: 0, x2: 500, y2: bar('S3').y }]);
    expect(board.junctions.find(j => j.breakoutId === 'B1')).toMatchObject({ x: 500, legCount: 2 });
  });
  it('gives an unknown length a placeholder, marked unknown', () => {
    expect(bar('S3').lengthKnown).toBe(false);
    expect(bar('S3').lengthText).toBe('length unknown');
    expect(bar('S3').x1 - bar('S3').x0).toBeCloseTo(60, 10);
  });
  it('draws a leg that shares its trunk section as a stub with no length', () => {
    expect(board.stubs).toHaveLength(1);
    expect(board.stubs[0]).toMatchObject({ breakoutId: 'B2', sectionId: 'S1', labels: ['Tap <b>'] });
  });
  it('labels physical ends at the right ends of the right bars', () => {
    expect(bar('S1').ends.find(e => e.end === 'a')!.labels).toEqual(['Left → endpoint Header']);
    expect(bar('S2').ends.find(e => e.end === 'b')!.labels).toEqual(['Right → endpoint EP2']);
  });
  it('does not loop forever on a cycle and says how it was started', () => {
    const h = harness();
    h.breakouts.push({ local_id: 'B3', trunk: { segment_id: 'legA', end: 'b' }, legs: [{ segment_id: 'trunk', end: 'a' }], fates: [] });
    const looped = formboardLayout(h, stocks());
    expect(looped.bars).toHaveLength(3);
  });
});

describe('formboard drawing', () => {
  const board = formboardLayout(harness(), stocks());
  const text = renderFormboardSvg(board, 'Board');
  const svg = parse(text);
  it('is well formed, deterministic and self-contained', () => {
    expect(svg.querySelector('parsererror')).toBeNull();
    expect(renderFormboardSvg(board, 'Board')).toBe(text);
    expect(text).not.toMatch(/<image|href=|https?:\/\/(?!www\.w3\.org)/);
    const ids = [...svg.querySelectorAll('[id]')].map(e => e.getAttribute('id'));
    for (const m of text.matchAll(/url\(#([^)]+)\)/g)) expect(ids).toContain(m[1]);
  });
  it('colors bars from the exact stock jacket and marks unknown lengths', () => {
    const s1 = svg.querySelector('[data-section="S1"]')!;
    expect(s1.querySelector('rect')!.getAttribute('fill')).toBe('#1b1b1d');
    expect(svg.querySelector('[data-section="S2"] rect')!.getAttribute('fill')).toBe('#6b4423');
    expect(svg.querySelector('[data-section="S3"]')!.getAttribute('data-length-known')).toBe('false');
    expect(svg.querySelector('[data-scale]')).not.toBeNull();
  });
  it('escapes names and shows selection as a reticle only', () => {
    expect(text).not.toContain('<b>');
    expect(text).toContain('Tap &lt;b&gt;');
    const picked = parse(renderFormboardSvg(board, 'Board', { selected: 'S2' }));
    expect(picked.querySelector('[data-selected]')).not.toBeNull();
    expect(picked.querySelector('[data-section="S2"] rect')!.getAttribute('fill')).toBe('#6b4423');
  });
  it('shows a section whose stock could not be read with an unknown, hatched jacket', () => {
    const missing = parse(renderFormboardSvg(formboardLayout(harness(), {}), 'Board'));
    expect(missing.querySelector('[data-section="S1"]')!.getAttribute('data-fill-source')).toBe('unknown');
  });
});

describe('build sheet', () => {
  const model = buildSheetModel({ title: 'Synthetic harness', revisionId: 'rev-1', harness: harness(), stocks: stocks(), quantity: 3 });
  it('prints names first and keeps every exact revision ID in an Exact pins page', () => {
    const labeled = buildSheetModel({ title: 'Synthetic harness', revisionId: 'rev-1', harness: harness(), stocks: stocks(), quantity: 1,
      labels: { 'rev-1': 'Power harness r4', 'body-1': 'Header body r1', 'pin-1': 'Header pinout r2' } });
    const html = renderBuildSheetHtml(labeled);
    expect(html).toContain('Revision Power harness r4');
    expect(html).toContain('Header body r1 · Header pinout r2');
    expect(html).not.toContain('Revision rev-1');
    expect(html).toContain('data-stage="pins"');
    expect(html).toContain('<td>Power harness r4</td><td>rev-1</td>');
    expect(html).toContain('<td>body-1</td>');
    // Unlabeled sheets keep printing the IDs they were given and add no pins page.
    expect(renderBuildSheetHtml(model)).not.toContain('data-stage="pins"');
  });
  it('keeps exact planned lengths and reports an unknown total honestly', () => {
    expect(model.cuts.map(c => c.totalMm)).toEqual(['1500', '751.5', null]);
    expect(model.totalCutMm).toBeNull();
    expect(model.pieceCount).toBe(9);
    expect(model.notes.join(' ')).toContain('no planned cut length');
  });
  it('orders landings by terminal identifier, numerically, from 1', () => {
    const header = model.ends.find(e => e.endpointId === 'EP1')!;
    expect(header.landings.map(l => [l.number, l.terminalId, l.elementLabel])).toEqual([[1, '2', 'wire'], [2, '10', 'wire']]);
    // Without a resolved stack the signal is unknown, never blank.
    expect(header.landings[0]!.signal).toBe('Signal unknown (end stack not resolved)');
    expect(header.landings[0]!.elementLook!.family).toBe('copper');
    expect(model.ends.find(e => e.endpointId === 'EP2')!.landings).toEqual([]);
  });
  it('names each landing\'s target, pin signal and parts from the resolved end stack', () => {
    const ends = { EP1: { name: 'Header end assembly r1', terminals: {
      'connector/10': { label: '10', layerKind: 'connector', signals: [{ label: '10', name: 'Composite sync', type: 'sync', status: 'declared' }], parts: [] },
      'connector/2': { label: '2', layerKind: 'connector', signals: [{ label: '2', name: null, type: null, status: 'declared' }], parts: ['470 R resistor'] },
    } } };
    const named = buildSheetModel({ title: 'Synthetic harness', revisionId: 'rev-1', harness: harness(), stocks: stocks(), quantity: 1, ends });
    const header = named.ends.find(e => e.endpointId === 'EP1')!;
    expect(header.stackName).toBe('Header end assembly r1');
    expect(header.landings.map(l => [l.target, l.signal, l.parts])).toEqual([
      ['connector 2', '2: signal unknown', '470 R resistor'],
      ['connector 10', '10: Composite sync (sync)', 'None declared'],
    ]);
    const html = renderBuildSheetHtml(named);
    expect(html).toContain('<th>Pin and signal</th>');
    expect(html).toContain('10: Composite sync (sync)');
  });
  it('lists non-termination joints and breakouts, and states stages with no data', () => {
    expect(model.otherJoints[0]).toMatchObject({ kind: 'shield_bond', members: 'trunk / A / stock.screen ↔ legA / A / stock.braid' });
    expect(model.breakouts.map(b => [b.breakoutId, b.fates])).toEqual([['B1', 1], ['B2', 0]]);
    expect(model.assembly.recorded).toBe(false);
    expect(model.test.recorded).toBe(false);
  });
  it('renders one page per stage as a deterministic, self-contained, escaped document', () => {
    const hostile = buildSheetModel({ title: '<script>alert(1)</script>', revisionId: 'r"1', harness: harness(), stocks: stocks(), quantity: 1 });
    const html = renderBuildSheetHtml(hostile, { formboardSvg: renderFormboardSvg(formboardLayout(harness(), stocks()), 'Board') });
    expect(html).not.toContain('<script');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html.match(/class="cs-page"/g)).toHaveLength(3 + hostile.ends.length);
    expect(html).not.toMatch(/<link|<img|src=|https?:\/\/(?!www\.w3\.org)/);
    expect(renderBuildSheetHtml(hostile)).toBe(renderBuildSheetHtml(hostile));
    expect(renderBuildSheetHtml(hostile)).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
  });
  it('rejects a bad quantity instead of printing it', () => {
    expect(buildSheetModel({ title: 't', revisionId: 'r', harness: harness(), stocks: stocks(), quantity: 0 }).quantity).toBe(1);
  });
});
