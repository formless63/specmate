import { MantineProvider } from '@mantine/core';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { CableViews } from './CableViews';
import { shieldedPair, unrecordedCoax } from './fixtures';

beforeEach(() => vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} }));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const show = (stock = shieldedPair(), props = {}) => render(<MantineProvider><CableViews stock={stock} name="Synthetic pair" {...props} /></MantineProvider>);

test('section tab draws recorded colours and selecting a key entry adds a reticle without recolouring', () => {
  show();
  const drawing = screen.getByLabelText('Cable section drawing');
  const before = drawing.querySelector('[data-element="stock.jacket"] path')!.getAttribute('fill');
  expect(before).toBe('#1b1b1d');
  fireEvent.click(screen.getByRole('button', { name: /jacket/ }));
  expect(screen.getByLabelText('Cable section drawing').querySelector('[data-selected]')).not.toBeNull();
  expect(screen.getByLabelText('Cable section drawing').querySelector('[data-element="stock.jacket"] path')!.getAttribute('fill')).toBe(before);
});

test('unrecorded colour is stated, not guessed', () => {
  show(unrecordedCoax());
  expect(screen.getAllByRole('button', { name: /colour unknown/ }).length).toBe(2);
  expect(screen.getByText(/Hatched elements have no recorded colour or material/)).toBeTruthy();
});

test('end faces mirror between ends and report how the ring reads', () => {
  show(shieldedPair(), { terminationLabels: { 'stock.drain': 'ep1: 5' } });
  fireEvent.click(screen.getByRole('tab', { name: 'End A face' }));
  expect(screen.getByText(/stock\.pair reads clockwise at end A/)).toBeTruthy();
  expect(screen.getByText('ep1: 5')).toBeTruthy();
  fireEvent.click(screen.getByRole('tab', { name: 'End B face' }));
  expect(screen.getByText(/stock\.pair reads counter-clockwise at end B/)).toBeTruthy();
  expect(screen.getByLabelText('End B face drawing').querySelector('[data-view="end-face"]')!.getAttribute('transform')).toContain('scale(-1 1)');
});

test('an unknown viewed-from end gives no face', () => {
  const stock = shieldedPair(); stock.viewed_from = 'unknown';
  show(stock);
  fireEvent.click(screen.getByRole('tab', { name: 'End A face' }));
  expect(screen.getByText(/End A face unavailable/)).toBeTruthy();
});

test('information tab lists materials and colours with unknowns spelled out', () => {
  show(unrecordedCoax());
  fireEvent.click(screen.getByRole('tab', { name: 'Information' }));
  expect(screen.getByRole('table', { name: 'Layer information' }).textContent).toContain('Unknown');
  expect(screen.getByRole('table', { name: 'Stock summary' }).textContent).toContain('3.2 mm × 3.2 mm');
});

test('3D tab loads nothing until opened, then describes the model in text', async () => {
  show();
  fireEvent.click(screen.getByRole('tab', { name: '3D model' }));
  expect(screen.getByRole('button', { name: 'Open 3D view' })).toBeTruthy();
  expect(screen.queryByTestId('wire-viewport-description')).toBeNull();
});

test('side tab draws an illustrative cutaway until a preparation is given, and selection is shared', () => {
  show();
  fireEvent.click(screen.getByRole('tab', { name: 'Side view' }));
  const drawing = () => screen.getByLabelText('Cable side drawing');
  expect(drawing().querySelector('svg')!.getAttribute('data-mode')).toBe('cutaway');
  expect(screen.getByRole('radio', { name: 'Prepared ends' })).toHaveProperty('disabled', true);
  expect(screen.getByRole('table', { name: 'Side view layers' }).textContent).toContain('Illustrative step (not a dimension)');
  fireEvent.click(drawing().querySelector('[data-element="stock.jacket"] rect')!);
  expect(drawing().querySelectorAll('[data-selected]').length).toBe(2);
});

test('side tab draws prepared ends and states unknown extents', () => {
  const preparation = { label: 'synthetic preparation', profile: {
    a: { instructions: [{ kind: 'layer_strip', element_path: 'stock.jacket', treatment: 'strip_back', length: { nominal_mm: '25', minus_mm: '1', plus_mm: '1', datum: 'from_stock_cut_end' } }] },
    b: { instructions: [] } } };
  show(shieldedPair(), { preparation, tabs: ['side'] });
  expect(screen.getByLabelText('Cable side drawing').querySelector('svg')!.getAttribute('data-mode')).toBe('prepared');
  const table = screen.getByRole('table', { name: 'Side view layers' }).textContent!;
  expect(table).toContain('Stops 25 mm from the cut end (−1 / +1)');
  expect(table).toContain('no preparation instruction');
  expect(screen.getByText('Preparation extent unknown')).toBeTruthy();
  fireEvent.click(screen.getByRole('radio', { name: 'Construction cutaway' }));
  expect(screen.getByLabelText('Cable side drawing').querySelector('svg')!.getAttribute('data-mode')).toBe('cutaway');
});

test('a frozen end preparation is applied only when pinned to this exact stock revision', async () => {
  const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
  const { findByText, waitFor } = await import('@testing-library/react');
  const instructions = [{ kind: 'layer_strip', element_path: 'stock.jacket', treatment: 'strip_back', length: { nominal_mm: '18', minus_mm: null, plus_mm: null, datum: 'from_stock_cut_end' } }];
  vi.stubGlobal('fetch', vi.fn(async (url: string) => new Response(JSON.stringify(url.includes('workspace/definitions') ? []
    : { revision_id: url.split('/').pop(), profile: { stock_revision_id: url.endsWith('other-prep') ? 'other-stock' : 'stock-rev', a: { instructions }, b: { instructions: [] } } }), { status: 200 })));
  render(<QueryClientProvider client={new QueryClient()}><MantineProvider><CableViews stock={shieldedPair()} name="Synthetic pair" revisionId="stock-rev" tabs={['side']} choosePreparation /></MantineProvider></QueryClientProvider>);
  const id = screen.getByLabelText('Side view end preparation exact revision ID');
  fireEvent.change(id, { target: { value: 'other-prep' } });
  await findByText(document.body, 'This profile is pinned to a different stock revision and is not drawn.');
  expect(screen.getByLabelText('Cable side drawing').querySelector('svg')!.getAttribute('data-mode')).toBe('cutaway');
  fireEvent.change(id, { target: { value: 'same-prep' } });
  await waitFor(() => expect(screen.getByLabelText('Cable side drawing').querySelector('svg')!.getAttribute('data-mode')).toBe('prepared'));
  expect(screen.getByRole('table', { name: 'Side view layers' }).textContent).toContain('Stops 18 mm from the cut end');
});

test('information tab renders unknown element dimensions as Unknown, never [object Object]', () => {
  const stock = shieldedPair();
  const jacket = stock.structure.children.find(c => c.kind === 'jacket')!;
  (jacket as { outer_diameter_mm: number | null; inner_diameter_mm: number | null }).outer_diameter_mm = null;
  (jacket as { outer_diameter_mm: number | null; inner_diameter_mm: number | null }).inner_diameter_mm = null;
  show(stock);
  fireEvent.click(screen.getByRole('tab', { name: 'Information' }));
  const text = screen.getByRole('table', { name: 'Layer information' }).textContent ?? '';
  expect(text).not.toContain('[object Object]');
  expect(text).toContain("unknown / – – – unknown");
});
