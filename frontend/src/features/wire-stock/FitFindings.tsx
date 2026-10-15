import { Checkbox, Stack, Text, UnstyledButton } from '@mantine/core';
import { SbStatus } from '../../components/sb';
import type { SbLed } from '../../components/sb';
import { fitMm } from '../../../../packages/section-layout/src';
import type { FitFinding, FitReport } from '../../../../packages/section-layout/src';

const LED: Record<FitFinding['status'], SbLed> = { fail: 'failed', not_evaluated: 'not-evaluated', note: 'info' };
const SUMMARY: Record<FitReport['status'], SbLed> = { problems: 'failed', incomplete: 'not-evaluated', ok: 'active', nothing_to_check: 'idle' };

export function fitSummary(report: FitReport): string {
  const tol = `±${fitMm(report.tolerance_mm)} mm`;
  const unevaluated = report.not_evaluated > 0 ? ` · ${report.not_evaluated} not evaluated` : '';
  if (report.status === 'problems') return `${report.failed} of ${report.checks} checks fail (${tol})${unevaluated}`;
  if (report.status === 'incomplete') return `No conflicts found${unevaluated} (of ${report.checks} checks; unknown dimensions or positions)`;
  if (report.status === 'ok') return `all ${report.checks} checks fit within ${tol}`;
  return 'no nested or adjacent elements to check';
}

/** Short Fit-cell word. "Fits" only when every check was evaluated. */
export function fitWord(report: FitReport): string {
  const unevaluated = report.not_evaluated > 0 ? ` · ${report.not_evaluated} not evaluated` : '';
  if (report.status === 'problems') return `Problems${unevaluated}`;
  if (report.status === 'incomplete') return `No conflicts found${unevaluated}`;
  return report.status === 'ok' ? 'Fits' : 'Nothing to check';
}

/**
 * Containment and sibling-overlap findings for the current construction. Failing
 * findings are warnings: saving is allowed and freezing needs an explicit acknowledgement.
 * Declared geometry only; not clearance or physical qualification.
 */
export function FitFindings({ report, onSelect, acknowledged, onAcknowledge, canFreeze }: {
  report: FitReport; onSelect?: (path: string) => void;
  acknowledged: boolean; onAcknowledge: (value: boolean) => void; canFreeze: boolean;
}) {
  const unknown = report.findings.filter(f => f.status === 'not_evaluated');
  const row = (f: FitFinding) => <UnstyledButton key={`${f.code}:${f.paths.join('|')}`} onClick={() => onSelect?.(f.paths[0])}
    title="Select in the section drawing" style={{ display: 'flex', gap: 8, alignItems: 'baseline', textAlign: 'left' }}>
    <span className="sb-led" data-state={LED[f.status]} aria-hidden="true" />
    <Text size="sm" span>{f.message}</Text>
  </UnstyledButton>;
  return <Stack gap={4} aria-label="Fit findings">
    <SbStatus led={SUMMARY[report.status]} dimension="fit" value={fitSummary(report)} />
    {report.findings.filter(f => f.status !== 'not_evaluated').map(row)}
    {unknown.length > 0 && <details className="sb-builder-advanced" open={unknown.length <= 3}>
      <summary>{unknown.length} check{unknown.length === 1 ? '' : 's'} not evaluated</summary>
      {unknown.map(row)}
    </details>}
    {report.failed > 0 && canFreeze && <Checkbox size="xs" checked={acknowledged} onChange={e => onAcknowledge(e.currentTarget.checked)}
      label={`I have reviewed the ${report.failed} fit problem${report.failed === 1 ? '' : 's'} and want to freeze anyway`} />}
    <Text size="xs" c="dimmed">Compares declared outer circles with enclosing bores and neighboring elements. Unknown values are not evaluated. Not clearance or physical qualification.</Text>
  </Stack>;
}
