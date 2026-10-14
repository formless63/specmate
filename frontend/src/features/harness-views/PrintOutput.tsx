import { useEffect, useMemo, useState } from 'react';
import { Alert, Button, Group, NativeSelect, NumberInput, Stack, Table, Text } from '@mantine/core';
import {
  DEFAULT_LABEL_SETTINGS, DEFAULT_PRINT_SETTINGS, PAPERS, formboardLayout, harnessLabels, planFormboardPrint, planLabelSheet,
  renderLabelHtml, renderLabelPageSvg, renderPrintHtml, renderPrintPageSvg,
} from '../../../../packages/harness-views/src';
import type { HarnessView, PaperId, PrintWarning, ScaleMode, StockMap } from '../../../../packages/harness-views/src';

const CAL_KEY = 'specmate.print.measured-ruler-mm';
const readCal = (): number | null => { try { const v = Number(localStorage.getItem(CAL_KEY)); return Number.isFinite(v) && v > 0 ? v : null; } catch { return null; } };
const writeCal = (v: number | null): void => { try { if (v === null) localStorage.removeItem(CAL_KEY); else localStorage.setItem(CAL_KEY, String(v)); } catch { /* per-viewer convenience only */ } };
const num = (v: number | string): number => (typeof v === 'number' ? v : Number.NaN);
function download(name: string, body: string): void {
  const url = URL.createObjectURL(new Blob([body], { type: 'text/html' }));
  const link = document.createElement('a'); link.href = url; link.download = name; link.click();
  URL.revokeObjectURL(url);
}
const tone = (w: PrintWarning): string => (w.severity === 'error' ? 'red' : w.severity === 'warn' ? 'yellow' : 'blue');

/**
 * Full-scale / scaled formboard print and fixed-size labels with explicit calibration and page rules.
 * Read only: output is derived from the frozen harness record and stock revisions, never stored.
 */
export function PrintOutput({ revisionId, harness, stocks, name }: { revisionId: string; harness: HarnessView; stocks: StockMap; name: string }) {
  const [output, setOutput] = useState<'formboard' | 'labels'>('formboard');
  const [paper, setPaper] = useState<PaperId>(DEFAULT_PRINT_SETTINGS.paper);
  const [orientation, setOrientation] = useState<'portrait' | 'landscape'>('landscape');
  const [margin, setMargin] = useState(10);
  const [overlap, setOverlap] = useState(10);
  const [mode, setMode] = useState<ScaleMode>('actual');
  const [ratio, setRatio] = useState(2);
  const [measured, setMeasured] = useState<number | null>(readCal);
  const [lw, setLw] = useState(DEFAULT_LABEL_SETTINGS.labelWidthMm);
  const [lh, setLh] = useState(DEFAULT_LABEL_SETTINGS.labelHeightMm);
  const [gap, setGap] = useState(DEFAULT_LABEL_SETTINGS.gapMm);
  const [copies, setCopies] = useState(1);
  const [pageIndex, setPageIndex] = useState(0);
  useEffect(() => writeCal(measured !== null && Number.isFinite(measured) ? measured : null), [measured]);

  const board = useMemo(() => formboardLayout(harness, stocks, { rowHeight: 16, fontSize: 3.2 }), [harness, stocks]);
  const plan = useMemo(() => planFormboardPrint(board, name, { paper, orientation, marginMm: margin, overlapMm: overlap, mode, ratioDenominator: ratio, measuredRulerMm: measured }), [board, name, paper, orientation, margin, overlap, mode, ratio, measured]);
  const labels = useMemo(() => harnessLabels(harness, stocks, name), [harness, stocks, name]);
  const sheet = useMemo(() => planLabelSheet(labels, name, { paper, orientation: orientation === 'landscape' ? 'landscape' : 'portrait', marginMm: margin, labelWidthMm: lw, labelHeightMm: lh, gapMm: gap, copies, measuredRulerMm: measured }), [labels, name, paper, orientation, margin, lw, lh, gap, copies, measured]);
  const active = output === 'formboard' ? plan : sheet;
  const count = output === 'formboard' ? plan.pages.length : sheet.pageCount;
  const shown = Math.min(pageIndex, Math.max(0, count - 1));
  const pageSvg = active.ok && count > 0 ? (output === 'formboard' ? renderPrintPageSvg(plan, plan.pages[shown]!) : renderLabelPageSvg(sheet, shown)) : '';

  return <Stack gap="xs" aria-label="Print output">
    <NativeSelect label="Output" data={[{ value: 'formboard', label: 'Formboard (length scale)' }, { value: 'labels', label: 'Labels (declared size)' }]} value={output} onChange={e => { setOutput(e.currentTarget.value as 'formboard' | 'labels'); setPageIndex(0); }} />
    <Group align="flex-end" gap="xs">
      <NativeSelect label="Paper" data={(Object.keys(PAPERS) as PaperId[]).map(id => ({ value: id, label: PAPERS[id].label }))} value={paper} onChange={e => { setPaper(e.currentTarget.value as PaperId); setPageIndex(0); }} />
      <NativeSelect label="Orientation" data={['landscape', 'portrait']} value={orientation} onChange={e => { setOrientation(e.currentTarget.value as 'portrait' | 'landscape'); setPageIndex(0); }} />
      <NumberInput label="Margin (mm)" min={0} value={margin} onChange={v => setMargin(num(v))} w={110} />
      {output === 'formboard' && <>
        <NativeSelect label="Scale" data={[{ value: 'actual', label: 'Actual size 1:1, tiled' }, { value: 'fit', label: 'Fit to one page (reduced)' }, { value: 'ratio', label: 'Reduced ratio 1:n' }]} value={mode} onChange={e => { setMode(e.currentTarget.value as ScaleMode); setPageIndex(0); }} />
        {mode === 'ratio' && <NumberInput label="Ratio 1:n" min={1} max={1000} value={ratio} onChange={v => setRatio(num(v))} w={100} />}
        {mode !== 'fit' && <NumberInput label="Tile overlap (mm)" min={0} value={overlap} onChange={v => setOverlap(num(v))} w={130} />}
      </>}
      {output === 'labels' && <>
        <NumberInput label="Label width (mm)" min={1} value={lw} onChange={v => setLw(num(v))} w={120} />
        <NumberInput label="Label height (mm)" min={1} value={lh} onChange={v => setLh(num(v))} w={120} />
        <NumberInput label="Gap (mm)" min={0} value={gap} onChange={v => setGap(num(v))} w={90} />
        <NumberInput label="Copies" min={1} max={50} allowDecimal={false} value={copies} onChange={v => setCopies(num(v))} w={90} />
      </>}
    </Group>
    <Group align="flex-end" gap="xs">
      <NumberInput label="Measured length of the 100 mm ruler (mm)" description="Print once, measure the ruler, enter it here. Kept in this browser only." decimalScale={2} min={0} value={measured ?? ''} onChange={v => setMeasured(v === '' ? null : num(v))} w={320} />
      {measured !== null && <Button variant="quiet" onClick={() => setMeasured(null)}>Clear calibration</Button>}
    </Group>
    <Table aria-label="Print summary"><Table.Tbody>
      <Table.Tr><Table.Th>Scale</Table.Th><Table.Td>{output === 'formboard' ? (plan.ok ? (plan.fullScaleClaim ? `${plan.scaleLabel} (declared full size)` : `${plan.scaleLabel} (NOT full size)`) : 'No plan') : 'Labels at declared size'}</Table.Td></Table.Tr>
      <Table.Tr><Table.Th>Pages</Table.Th><Table.Td>{active.ok ? (output === 'formboard' ? `${count} (${plan.rows} x ${plan.cols})` : `${count} (${sheet.labels.length} labels, ${sheet.perPage} per page)`) : 'None: fix the errors below'}</Table.Td></Table.Tr>
      <Table.Tr><Table.Th>Calibration</Table.Th><Table.Td>{active.warnings.some(w => w.code === 'calibration-invalid') ? 'Invalid measurement; remeasure' : active.calibration.measuredMm === null ? 'Not calibrated' : `Measured ${active.calibration.measuredMm} mm, correction x${Math.round(active.calibration.factor * 10000) / 10000}`}</Table.Td></Table.Tr>
      {output === 'formboard' && plan.ok && plan.references.length > 0 && <Table.Tr><Table.Th>Reference spans</Table.Th><Table.Td>{plan.references.map(r => `${r.sectionId}: ${r.recordedMm} mm recorded, ${Math.round(r.paperMm * 100) / 100} mm on paper`).join('; ')}</Table.Td></Table.Tr>}
    </Table.Tbody></Table>
    {active.warnings.map(w => <Alert key={w.code + w.text} color={tone(w)} title={w.severity === 'error' ? 'Cannot print' : undefined}>{w.text}</Alert>)}
    {active.ok && count > 0 && <>
      <Group gap="xs" aria-label="Pages">
        {Array.from({ length: count }, (_, i) => <Button key={i} size="compact-sm" variant={i === shown ? 'primary' : 'quiet'} onClick={() => setPageIndex(i)}>{output === 'formboard' ? `Page ${i + 1}${plan.cols > 1 || plan.rows > 1 ? ` (${(plan.pages[i]!.row) + 1},${plan.pages[i]!.col + 1})` : ''}` : `Page ${i + 1}`}</Button>)}
        <Button variant="commit" onClick={() => download(output === 'formboard' ? `formboard-${revisionId}-${plan.scaleLabel.replace(':', '-')}.html` : `labels-${revisionId}.html`, output === 'formboard' ? renderPrintHtml(plan) : renderLabelHtml(sheet))}>Download printable pages (HTML)</Button>
      </Group>
      <div aria-label="Print page preview" style={{ background: '#fff', color: '#000', border: '1px solid var(--sb-border-strong)', overflowX: 'auto' }} dangerouslySetInnerHTML={{ __html: pageSvg.replace(/<svg /, '<svg style="max-width:100%;height:auto" ') }} />
      <Text size="xs">Open the downloaded file and print it at Actual size / 100%; the preview is scaled to the screen and is not a measurement. Printing is derived from the frozen record; nothing is stored.</Text>
    </>}
  </Stack>;
}
