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
