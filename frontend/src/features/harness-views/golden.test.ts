// Drift guard: the backend's Python formboard port must match this renderer byte for byte.
// The golden lives with the backend tests; regenerate with `bun backend/tests/data/formboard/generate.ts`.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test } from 'vitest';
import { sectionLayout } from '../../../../packages/section-layout/src';
import type { StockSpecification } from '../../../../packages/section-layout/src';
import { formboardLayout, planFormboardPrint, renderPrintHtml, renderPrintPageSvg } from '../../../../packages/harness-views/src';
import type { HarnessView } from '../../../../packages/harness-views/src';

// vitest runs from the frontend directory.
const read = (name: string) => JSON.parse(readFileSync(resolve(process.cwd(), '../backend/tests/data/formboard', name), 'utf8'));
const inputs = read('inputs.json') as { stocks: Record<string, StockSpecification>; names: Record<string, string>; cases: { id: string; title: string; harness: HarnessView; settings: Record<string, unknown> }[] };
const expected = read('expected.json') as Record<string, { html: string; page_one_svg: string }>;
const camel: Record<string, string> = { margin_mm: 'marginMm', overlap_mm: 'overlapMm', ratio_denominator: 'ratioDenominator', measured_ruler_mm: 'measuredRulerMm' };

test.each(inputs.cases.map(c => c.id))('formboard print %s matches the backend golden byte for byte', id => {
  const c = inputs.cases.find(x => x.id === id)!;
  const stocks = Object.fromEntries(Object.entries(inputs.stocks).map(([rid, spec]) => [rid, { name: inputs.names[rid]!, section: sectionLayout(spec) }]));
  const settings = Object.fromEntries(Object.entries(c.settings).map(([k, v]) => [camel[k] ?? k, v]));
  const plan = planFormboardPrint(formboardLayout(c.harness, stocks, { rowHeight: 16, fontSize: 3.2 }), c.title, settings);
  expect(renderPrintPageSvg(plan, plan.pages[0]!)).toBe(expected[id]!.page_one_svg);
  expect(renderPrintHtml(plan)).toBe(expected[id]!.html);
});
