import { MantineProvider } from '@mantine/core';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { shieldedPair, braidedCoax } from '../cable-views/fixtures';
import { harness } from './fixtures';
import { HarnessViews } from './HarnessViews';

beforeEach(() => vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} }));
afterEach(() => { cleanup(); localStorage.clear(); vi.unstubAllGlobals(); });
const wrap = (ui: React.ReactElement) => <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><MantineProvider>{ui}</MantineProvider></QueryClientProvider>;
const stub = (denyCoax = false) => vi.stubGlobal('fetch', vi.fn(async (url: string) => {
  if (url.includes('rev-coax') && denyCoax) return new Response(JSON.stringify({ error: { message: 'Stock access denied.' } }), { status: 403 });
  const stock = url.includes('rev-pair') ? shieldedPair() : braidedCoax();
  return new Response(JSON.stringify({ content: { stock } }));
}));

test('draws the formboard from exact stocks and shows a selected section', async () => {
  stub();
  render(wrap(<HarnessViews revisionId="rev-1" harness={harness()} title="Synthetic harness" />));
  const board = await screen.findByLabelText('Formboard drawing');
  await waitFor(() => expect(board.querySelector('[data-section="S2"] rect')!.getAttribute('fill')).toBe('#6b4423'));
  fireEvent.click(board.querySelector('[data-section="S2"] rect')!);
  expect(screen.getByRole('table', { name: 'Selected section' }).textContent).toContain('250.5 mm');
  expect(screen.getByLabelText('Formboard drawing').querySelector('[data-selected]')).not.toBeNull();
});

test('a denied stock leaves its jacket unknown rather than guessed', async () => {
  stub(true);
  render(wrap(<HarnessViews revisionId="rev-1" harness={harness()} />));
  expect((await screen.findByText(/Stock access denied/)).textContent).toContain('unknown');
  expect(screen.getByLabelText('Formboard drawing').querySelector('[data-section="S2"]')!.getAttribute('data-fill-source')).toBe('unknown');
});

test('the build sheet is a sandboxed self-contained document', async () => {
  stub();
  render(wrap(<HarnessViews revisionId="rev-1" harness={harness()} quantity={2} />));
  fireEvent.click(await screen.findByRole('tab', { name: 'Build sheet' }));
  const frame = screen.getByTitle('Build sheet') as HTMLIFrameElement;
  expect(frame.getAttribute('sandbox')).toBe('');
  expect(frame.getAttribute('srcdoc')).toContain('data-stage="kit"');
  expect(frame.getAttribute('srcdoc')).toContain('quantity 2');
});

test('a harness with no sections draws nothing', () => {
  stub();
  const empty = { ...harness(), sections: [], segments: [], breakouts: [], joints: [] };
  render(wrap(<HarnessViews revisionId="rev-1" harness={empty} />));
  expect(screen.getByText(/nothing to draw/)).toBeTruthy();
});

async function openPrint() {
  stub();
  render(wrap(<HarnessViews revisionId="rev-1" harness={harness()} title="Synthetic harness" />));
  await screen.findByLabelText('Formboard drawing');
  fireEvent.click(screen.getByRole('tab', { name: 'Full-scale print and labels' }));
  return screen.findByLabelText('Print output');
}

test('print tab declares full size only for an actual-size plan and shows the uncalibrated state', async () => {
  const panel = await openPrint();
  const summary = within(panel).getByRole('table', { name: 'Print summary' }).textContent!;
  expect(summary).toContain('1:1 (declared full size)');
  expect(summary).toContain('Not calibrated');
  expect(summary).toContain('S1: 500 mm recorded, 500 mm on paper');
  expect(panel.textContent).toContain('Tiled across');
  expect(panel.querySelector('[aria-label="Print page preview"] svg[data-scale="1:1"]')).not.toBeNull();
});

test('fit to page never shows a 1:1 claim', async () => {
  const panel = await openPrint();
  fireEvent.change(within(panel).getByLabelText('Scale'), { target: { value: 'fit' } });
  const summary = within(panel).getByRole('table', { name: 'Print summary' }).textContent!;
  expect(summary).toContain('NOT full size');
  expect(summary).not.toContain('declared full size');
  expect(panel.textContent).toContain('do not build to this print');
});

test('a measured ruler is applied and an implausible one blocks printing', async () => {
  const panel = await openPrint();
  const input = within(panel).getByLabelText(/Measured length of the 100 mm ruler/);
  fireEvent.change(input, { target: { value: '99' } });
  await waitFor(() => expect(within(panel).getByRole('table', { name: 'Print summary' }).textContent).toContain('Measured 99 mm'));
  fireEvent.change(input, { target: { value: '50' } });
  await waitFor(() => expect(panel.textContent).toContain('not plausible'));
  expect(within(panel).queryByRole('button', { name: /Download printable pages/ })).toBeNull();
});

test('labels output reports pages and unfit labels at the declared size', async () => {
  const panel = await openPrint();
  fireEvent.change(within(panel).getByLabelText('Output'), { target: { value: 'labels' } });
  expect(within(panel).getByRole('table', { name: 'Print summary' }).textContent).toContain('5 labels');
  fireEvent.change(within(panel).getByLabelText('Label width (mm)'), { target: { value: '8' } });
  await waitFor(() => expect(panel.textContent).toContain('not drawn because the text does not fit'));
});
