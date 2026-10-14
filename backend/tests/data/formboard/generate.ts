// Regenerates inputs and expected output of the golden formboard print test from the
// TypeScript renderer (packages/harness-views). Run from the repository root:
//   bun backend/tests/data/formboard/generate.ts
// The Python port (specmate.harnesses.formboard) must reproduce expected.json byte for byte.
import { writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { sectionLayout } from '../../../../packages/section-layout/src';
import { formboardLayout, planFormboardPrint, renderPrintHtml, renderPrintPageSvg } from '../../../../packages/harness-views/src';
import { harness } from '../../../../frontend/src/features/harness-views/fixtures';
import { braidedCoax, shieldedPair, unrecordedCoax } from '../../../../frontend/src/features/cable-views/fixtures';

const here = dirname(new URL(import.meta.url).pathname);
const specs = { 'rev-pair': shieldedPair(), 'rev-coax': braidedCoax(), 'rev-unrec': unrecordedCoax() };
const names: Record<string, string> = { 'rev-pair': 'Synthetic pair r1', 'rev-coax': 'Synthetic coax r2', 'rev-unrec': 'Unrecorded coax r1' };
const stocks = Object.fromEntries(Object.entries(specs).map(([id, spec]) => [id, { name: names[id]!, section: sectionLayout(spec) }]));

const variantHarness = harness();
variantHarness.sections[2]!.stock_revision_id = 'rev-unrec';
const cases = [
  { id: 'default', title: 'Synthetic harness r3', harness: harness(), settings: {}, ts: {} },
  { id: 'variant', title: 'Variant <harness> & "quotes"', harness: variantHarness,
    settings: { paper: 'letter', orientation: 'portrait', margin_mm: 12, overlap_mm: 8, mode: 'ratio', ratio_denominator: 2, measured_ruler_mm: 98.5 },
    ts: { paper: 'letter', orientation: 'portrait', marginMm: 12, overlapMm: 8, mode: 'ratio', ratioDenominator: 2, measuredRulerMm: 98.5 } },
];
const expected: Record<string, unknown> = {};
for (const c of cases) {
  const board = formboardLayout(c.harness, stocks, { rowHeight: 16, fontSize: 3.2 });
  const plan = planFormboardPrint(board, c.title, c.ts);
  expected[c.id] = { ok: plan.ok, scale_label: plan.scaleLabel, rows: plan.rows, cols: plan.cols, full_scale_claim: plan.fullScaleClaim,
    page_one_svg: plan.ok ? renderPrintPageSvg(plan, plan.pages[0]!) : null, html: plan.ok ? renderPrintHtml(plan) : null };
}
writeFileSync(`${here}/inputs.json`, JSON.stringify({ stocks: specs, names, cases: cases.map(({ ts, ...rest }) => rest) }, null, 1));
writeFileSync(`${here}/expected.json`, JSON.stringify(expected, null, 1));
