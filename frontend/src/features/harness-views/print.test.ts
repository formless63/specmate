import { describe, expect, it } from 'vitest';
import { DEFAULT_PRINT_SETTINGS, MAX_PAGES, PAPERS, RULER_MM, calibrationFactor, fitLabelText, formboardLayout, harnessLabels, planFormboardPrint, planLabelSheet, renderFormboardSvg, renderLabelHtml, renderLabelPageSvg, renderPrintHtml, renderPrintPageSvg } from '../../../../packages/harness-views/src';
import { harness, stocks } from './fixtures';

const board = () => formboardLayout(harness(), stocks(), { rowHeight: 16, fontSize: 3.2 });
const plan = (s: Parameters<typeof planFormboardPrint>[2] = {}, b = board()) => planFormboardPrint(b, 'Synthetic harness', s);
const doc = (svg: string) => new DOMParser().parseFromString(svg, 'image/svg+xml');
const contentScale = (svg: string): number => Number(/data-content="true" transform="translate\([^)]*\) scale\(([\d.e+-]+)\)/.exec(svg)![1]);
const barWidth = (svg: string, section: string): number => Number(doc(svg).querySelector(`[data-section="${section}"] rect`)!.getAttribute('width'));
/** Paper millimetres of a recorded span on a page: the bar's content width times the content scale. */
const paperMm = (svg: string, section: string): number => barWidth(svg, section) * contentScale(svg);

describe('formboard layout options', () => {
  it('keeps the screen defaults and honours fixed physical sizes', () => {
    const screen = formboardLayout(harness(), stocks());
    expect(screen.rowHeight).toBeCloseTo(45, 10);
    const fixed = board();
    expect(fixed.rowHeight).toBe(16);
    expect(fixed.fontSize).toBe(3.2);
    expect(fixed.bars.find(b => b.sectionId === 'S1')!.x1).toBe(500);
  });
  it('the screen svg is unchanged in structure and still has its scale bar', () => {
    const svg = renderFormboardSvg(formboardLayout(harness(), stocks()), 'T');
    expect(doc(svg).querySelector('[data-scale]')).not.toBeNull();
  });
});

describe('full-scale plan', () => {
  it('prints a known reference span at its declared scale and says so', () => {
    const p = plan({ mode: 'actual', paper: 'a4', orientation: 'landscape' });
    expect(p.ok).toBe(true);
    expect(p.fullScaleClaim).toBe(true);
    expect(p.scaleLabel).toBe('1:1');
    expect(p.references.find(r => r.sectionId === 'S1')).toMatchObject({ recordedMm: 500, paperMm: 500 });
    for (const page of p.pages) {
      expect(paperMm(renderPrintPageSvg(p, page), 'S1')).toBeCloseTo(500, 6);
      expect(paperMm(renderPrintPageSvg(p, page), 'S2')).toBeCloseTo(250.5, 6);
    }
    const first = renderPrintPageSvg(p, p.pages[0]!);
    expect(first).toContain('width="297mm" height="210mm"');
    expect(first).toContain('Declared scale 1:1');
    expect(first).toContain('500 mm recorded, 500 mm on paper');
  });
  it('tiles a long board with the stated overlap, covering every part exactly', () => {
    const p = plan({ mode: 'actual', paper: 'a4', orientation: 'landscape', marginMm: 10, overlapMm: 12 });
    expect(p.windowWidthMm).toBe(277);
    expect(p.cols).toBeGreaterThan(2);
    expect(p.pages).toHaveLength(p.rows * p.cols);
    const step = p.windowWidthMm - 12;
    expect(p.pages[1]!.txMm).toBe(step);
    const last = p.pages[p.cols - 1]!;
    expect(last.txMm + p.windowWidthMm).toBeGreaterThanOrEqual(p.contentWidthMm);
    expect(last.txMm).toBeLessThan(p.contentWidthMm);
    expect((p.cols - 1) * step + p.windowWidthMm - p.contentWidthMm).toBeLessThan(step);
    expect(p.warnings.map(w => w.code)).toContain('tiled');
    const svg = renderPrintPageSvg(p, p.pages[0]!);
    expect(svg).toContain('overlaps page 1,2');
    expect(renderPrintPageSvg(p, last)).toContain(`overlaps page 1,${p.cols - 1}`);
    expect(svg).toContain('data-registration');
  });
  it('a board that fits one page is not tiled', () => {
    const p = plan({ mode: 'actual', paper: 'a3', orientation: 'landscape', marginMm: 5 }, formboardLayout({ ...harness(), sections: [{ ...harness().sections[0]!, planned_cut_length_mm: '200' }], segments: [{ local_id: 'trunk', section_id: 'S1', label: null, element_paths: null }], breakouts: [], joints: [] }, stocks(), { rowHeight: 16, fontSize: 3.2 }));
    expect(p.pages).toHaveLength(1);
    expect(p.warnings.map(w => w.code)).not.toContain('tiled');
  });
  it('fit-to-page never claims 1:1 and states the true reduction', () => {
    const p = plan({ mode: 'fit' });
    expect(p.pages).toHaveLength(1);
    expect(p.scale).toBeLessThan(1);
    expect(p.fullScaleClaim).toBe(false);
    expect(p.scaleLabel).not.toBe('1:1');
    expect(p.warnings.find(w => w.code === 'reduced-fit')!.text).toContain('NOT full size');
    const svg = renderPrintPageSvg(p, p.pages[0]!);
    expect(svg).toContain('NOT full size');
    expect(svg).not.toContain('Declared scale 1:1');
    expect(paperMm(svg, 'S1')).toBeCloseTo(500 * p.scale, 6);
    expect(paperMm(svg, 'S1')).toBeLessThanOrEqual(p.windowWidthMm + 1e-6);
  });
  it('an explicit ratio scales lengths and is never full size', () => {
    const p = plan({ mode: 'ratio', ratioDenominator: 2 });
    expect(p.scaleLabel).toBe('1:2');
    expect(p.fullScaleClaim).toBe(false);
    expect(paperMm(renderPrintPageSvg(p, p.pages[0]!), 'S1')).toBeCloseTo(250, 6);
    expect(plan({ mode: 'ratio', ratioDenominator: 0.5 }).ok).toBe(false);
    expect(plan({ mode: 'ratio', ratioDenominator: 2000 }).warnings.map(w => w.code)).toContain('ratio-invalid');
  });
  it('a ratio of 1:1 is reported as actual size', () => {
    expect(plan({ mode: 'ratio', ratioDenominator: 1 }).fullScaleClaim).toBe(true);
  });
});

describe('calibration', () => {
  it('is reported as absent until a measurement is entered', () => {
    const p = plan();
    expect(p.calibration).toEqual({ measuredMm: null, factor: 1 });
    expect(p.warnings.map(w => w.code)).toContain('uncalibrated');
    expect(renderPrintPageSvg(p, p.pages[0]!)).toContain('Uncalibrated');
  });
  it('pre-compensates a measured ruler so the reference span lands at its declared length once printed', () => {
    const p = plan({ measuredRulerMm: 99 });
    const f = 100 / 99;
    expect(p.calibration.factor).toBeCloseTo(f, 12);
    const svg = renderPrintPageSvg(p, p.pages[0]!);
    expect(paperMm(svg, 'S1')).toBeCloseTo(500 * f, 6);
    // the printer then shrinks by 99/100: 500 * f * 0.99 = 500
    expect(paperMm(svg, 'S1') * 0.99).toBeCloseTo(500, 6);
    expect(svg).toContain('Calibrated: measured 99 mm');
    const ruler = doc(svg).querySelector('[data-footer] path')!.getAttribute('d')!;
    expect(ruler).toContain(`h${Math.round(RULER_MM * f * 1000) / 1000}`);
    expect(p.warnings.map(w => w.code)).not.toContain('uncalibrated');
  });
  it('rejects an implausible measurement instead of ignoring it', () => {
    expect(plan({ measuredRulerMm: 50 }).ok).toBe(false);
    expect(plan({ measuredRulerMm: Number.NaN }).ok).toBe(false);
    expect(calibrationFactor(130).error).toContain('not plausible');
    expect(calibrationFactor(98).warning).toContain('printer scaled');
    expect(calibrationFactor(100).warning).toBeNull();
  });
});

describe('page rules and honesty', () => {
  it('warns about an unprintable margin, unknown lengths and non-measured axes', () => {
    const codes = plan({ marginMm: 2 }).warnings.map(w => w.code);
    expect(codes).toContain('margin-unprintable');
    expect(codes).toContain('unknown-length');
    expect(codes).toContain('not-to-scale-across');
    expect(codes).toContain('stub-length-not-recorded');
  });
  it('makes no scale claim when no section has a recorded length', () => {
    const h = harness(); h.sections.forEach(s => { s.planned_cut_length_mm = null; });
    const p = plan({}, formboardLayout(h, stocks(), { rowHeight: 16, fontSize: 3.2 }));
    expect(p.fullScaleClaim).toBe(false);
    expect(p.scaleLabel).toContain('no scale');
    expect(p.warnings.map(w => w.code)).toContain('no-known-length');
    expect(renderPrintPageSvg(p, p.pages[0]!)).not.toContain('Declared scale');
  });
  it('errors on a page budget, overlap and margin that cannot work, and has no pages then', () => {
    const huge = formboardLayout({ ...harness(), sections: [{ ...harness().sections[0]!, planned_cut_length_mm: '60000' }], segments: [{ local_id: 'trunk', section_id: 'S1', label: null, element_paths: null }], breakouts: [], joints: [] }, stocks(), { rowHeight: 16, fontSize: 3.2 });
    const p = plan({ mode: 'actual' }, huge);
    expect(p.ok).toBe(false);
    expect(p.warnings.find(w => w.code === 'too-many-pages')!.text).toContain(String(MAX_PAGES));
    expect(p.pages).toEqual([]);
    expect(() => renderPrintHtml(p)).toThrow();
    expect(plan({ overlapMm: 500 }).warnings.map(w => w.code)).toContain('overlap-invalid');
    expect(plan({ marginMm: 120 }).ok).toBe(false);
    expect(plan({ marginMm: -1 }).ok).toBe(false);
  });
  it('supports the other papers and orientation', () => {
    const p = plan({ paper: 'letter', orientation: 'portrait' });
    expect(p.pageWidthMm).toBe(PAPERS.letter.widthMm);
    expect(p.pageHeightMm).toBe(PAPERS.letter.heightMm);
  });
  it('is deterministic and the document is self-contained with exact page size', () => {
    const a = renderPrintHtml(plan()), b = renderPrintHtml(plan());
    expect(a).toBe(b);
    expect(a).toContain('@page{size:297mm 210mm;margin:0}');
    expect(a).not.toMatch(/(src|href)=|url\(http|<script/);
    expect((a.match(/class="page"/g) ?? []).length).toBe(plan().pages.length);
    expect(a).toContain('data-full-scale="true"');
  });
  it('escapes the title', () => {
    const html = renderPrintHtml(planFormboardPrint(board(), 'A <script>x</script> & "q"'));
    expect(html).not.toContain('<script>x');
    expect(html).toContain('&lt;script&gt;');
  });
  it('page footer wording fits the page width', () => {
    const p = plan({ paper: 'a4', orientation: 'portrait', measuredRulerMm: 99.5 });
    const svg = renderPrintPageSvg(p, p.pages[0]!);
    const lines = [...doc(svg).querySelectorAll('[data-footer] ~ g text')].map(t => t.textContent!);
    expect(Math.max(...lines.map(l => l.length)) * 2.3 * 0.62).toBeLessThanOrEqual(190 + 1);
  });
});

describe('labels', () => {
  const labels = () => harnessLabels(harness(), stocks(), 'Synthetic harness');
  it('derives one label per section and per recorded physical end from recorded facts only', () => {
    const l = labels();
    expect(l.map(x => x.id)).toEqual(['section:S1', 'end:S1:PE1', 'section:S2', 'end:S2:PE2', 'section:S3']);
    expect(l[0]!.lines).toContain('Cut 500 mm');
    expect(l.find(x => x.id === 'section:S3')!.lines).toContain('Cut length not recorded');
    expect(l[1]!.lines).toEqual(['Synthetic harness', 'S1 end A', 'Left', 'Endpoint Header']);
    expect(l[3]!.lines).toContain('Endpoint EP2');
  });
  it('fits text by shrinking, wrapping and never truncating', () => {
    expect(fitLabelText(['Short'], 50, 20, 3.2, 1.8)!.fontMm).toBe(3.2);
    const small = fitLabelText(['one two three four five six seven eight nine ten eleven twelve'], 30, 10, 3.2, 1.8);
    expect(small === null || small.lines.join(' ') === 'one two three four five six seven eight nine ten eleven twelve').toBe(true);
    expect(fitLabelText(['x'.repeat(200)], 30, 10, 3.2, 1.8)).toBeNull();
    expect(fitLabelText(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'], 30, 8, 3.2, 1.8)).toBeNull();
  });
  it('lays labels on a grid at the declared physical size, with copies and pages', () => {
    const p = planLabelSheet(labels(), 'Synthetic harness', { labelWidthMm: 50, labelHeightMm: 20, gapMm: 2, marginMm: 10, copies: 3 });
    expect(p.ok).toBe(true);
    expect(p.cols).toBe(3); // (190+2)/(52)
    expect(p.rows).toBe(Math.floor((297 - 20 - 22 + 2) / 22));
    expect(p.labels).toHaveLength(15);
    expect(p.pageCount).toBe(Math.ceil(15 / p.perPage));
    const svg = renderLabelPageSvg(p, 0);
    const d = doc(svg);
    const rect = d.querySelector('[data-label] rect')!;
    expect(rect.getAttribute('width')).toBe('50');
    expect(rect.getAttribute('height')).toBe('20');
    expect(svg).toContain('width="210mm" height="297mm"');
    expect(svg).toContain('Labels at declared size');
    expect(p.labels[1]!.x - p.labels[0]!.x).toBe(52);
  });
  it('scales label sizes by the calibration factor', () => {
    const p = planLabelSheet(labels(), 't', { measuredRulerMm: 99 });
    const w = Number(doc(renderLabelPageSvg(p, 0)).querySelector('[data-label] rect')!.getAttribute('width'));
    expect(w).toBeCloseTo(50 * 100 / 99, 2);
  });
  it('reports labels whose text does not fit instead of cutting them off', () => {
    const p = planLabelSheet([{ id: 'x', kind: 'section', lines: ['y'.repeat(120)] }, { id: 'ok', kind: 'section', lines: ['fine'] }], 't', { labelWidthMm: 30, labelHeightMm: 10 });
    expect(p.unfit).toEqual(['x']);
    expect(p.labels.map(l => l.id)).toEqual(['ok']);
    expect(p.warnings.find(w => w.code === 'text-does-not-fit')!.text).toContain('x');
  });
  it('rejects impossible sizes, copies and calibration', () => {
    expect(planLabelSheet(labels(), 't', { labelWidthMm: 500 }).ok).toBe(false);
    expect(planLabelSheet(labels(), 't', { labelWidthMm: 0 }).ok).toBe(false);
    expect(planLabelSheet(labels(), 't', { copies: 0 }).ok).toBe(false);
    expect(planLabelSheet(labels(), 't', { copies: 1.5 }).ok).toBe(false);
    expect(planLabelSheet(labels(), 't', { measuredRulerMm: 10 }).ok).toBe(false);
    expect(planLabelSheet(labels(), 't', { gapMm: -1 }).ok).toBe(false);
    expect(() => renderLabelHtml(planLabelSheet(labels(), 't', { copies: 0 }))).toThrow();
  });
  it('is deterministic, self-contained and escaped', () => {
    const l = [{ id: 'a&b', kind: 'section' as const, lines: ['<b>hi</b>'] }];
    const a = renderLabelHtml(planLabelSheet(l, 'T <i>', {}));
    expect(a).toBe(renderLabelHtml(planLabelSheet(l, 'T <i>', {})));
    expect(a).not.toContain('<b>hi');
    expect(a).not.toMatch(/(src|href)=|<script/);
    expect(DEFAULT_PRINT_SETTINGS.mode).toBe('actual');
  });
});
