import { MantineProvider } from '@mantine/core';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { shieldedPair, braidedCoax } from '../cable-views/fixtures';
import { harness } from './fixtures';
import { HarnessViews } from './HarnessViews';

beforeEach(() => vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} }));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
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

test('names lead on the formboard and build sheet while exact IDs stay available as evidence', async () => {
  const names: Record<string, [string, number]> = { 'rev-1': ['Power harness', 4], 'rev-pair': ['Shielded pair', 2], 'rev-coax': ['Braided coax', 1] };
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url.includes('catalog/revision-labels')) {
      const ids = new URL(url, 'http://x').searchParams.getAll('revision_ids');
      return new Response(JSON.stringify({ labels: ids.map(id => names[id] ? { revision_id: id, readable: true, definition_id: `def-${id}`, name: names[id]![0], kind: 'x', number: names[id]![1] } : { revision_id: id, readable: false }), source_labels: [] }));
    }
    return new Response(JSON.stringify({ content: { stock: url.includes('rev-pair') ? shieldedPair() : braidedCoax() } }));
  }));
  render(wrap(<HarnessViews revisionId="rev-1" harness={harness()} />));
  const board = await screen.findByLabelText('Formboard drawing');
  await waitFor(() => expect(board.innerHTML).toContain('Shielded pair r2'));
  expect(board.innerHTML).toContain('Braided coax r1');
  expect(board.innerHTML).not.toContain('Stock rev-');
  fireEvent.click(await screen.findByRole('tab', { name: 'Build sheet' }));
  await waitFor(() => expect((screen.getByTitle('Build sheet') as HTMLIFrameElement).getAttribute('srcdoc')).toContain('Revision Power harness r4'));
  const sheet = (screen.getByTitle('Build sheet') as HTMLIFrameElement).getAttribute('srcdoc')!;
  expect(sheet).toContain('data-stage="pins"');
  expect(sheet).toContain('<td>rev-1</td>');
});
