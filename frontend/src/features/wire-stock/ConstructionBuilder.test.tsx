import { MantineProvider } from '@mantine/core';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { WireStockPanel } from './WireStockPanel';

beforeEach(() => vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} }));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const show = () => render(<MantineProvider><WireStockPanel /></MantineProvider>);

test('a failing jacket is drawn on the section and fixed in one click', () => {
  show();
  fireEvent.change(screen.getByLabelText('Jacket wall'), { target: { value: '1' } });
  expect(document.querySelector('[data-fit-bore="stock.jacket"]')).toBeTruthy();
  expect(screen.getByLabelText('Fit problems').textContent).toContain("won't fit Jacket bore 1 mm");
  expect(screen.getByText('Problems')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Set jacket OD to fit' }));
  expect(document.querySelector('[data-fit-bore]')).toBeNull();
  expect((screen.getByLabelText('Jacket outer diameter') as HTMLInputElement).value).toBe('4.4');
  expect(screen.getByText('Fits')).toBeTruthy();
});

test('sliders, steppers and the jacket handle edit the same draft', () => {
  show();
  fireEvent.change(screen.getByLabelText('Jacket outer diameter slider'), { target: { value: '3.5' } });
  expect((screen.getByLabelText('Jacket outer diameter') as HTMLInputElement).value).toBe('3.5');
  fireEvent.keyDown(screen.getByRole('slider', { name: 'Jacket outer diameter handle' }), { key: 'ArrowRight' });
  expect((screen.getByLabelText('Jacket outer diameter') as HTMLInputElement).value).toBe('3.55');
});

test('a viewer sees the drawing and meters but cannot move sliders or the handle', async () => {
  const { PermissionsProvider } = await import('../../lib/permissions');
  render(<MantineProvider><PermissionsProvider permissions={['workspace.read']}><WireStockPanel /></PermissionsProvider></MantineProvider>);
  const before = (screen.getByLabelText('Jacket outer diameter') as HTMLInputElement).value;
  fireEvent.change(screen.getByLabelText('Jacket outer diameter slider'), { target: { value: '9' } });
  expect((screen.getByLabelText('Jacket outer diameter') as HTMLInputElement).value).toBe(before);
  expect(screen.getByLabelText('Jacket outer diameter slider').getAttribute('aria-readonly')).toBe('true');
  expect(screen.queryByRole('slider', { name: 'Jacket outer diameter handle' })).toBeNull();
  expect(screen.getByLabelText('Stock section drawing').querySelectorAll('[data-element]').length).toBeGreaterThan(0);
});

test('the template strip starts a construction from a drawn template', () => {
  show();
  expect(screen.getAllByRole('button', { name: /^New / })).toHaveLength(6);
  fireEvent.click(screen.getByRole('button', { name: 'New Ribbon' }));
  expect(screen.getByRole('group', { name: 'Cores' })).toBeTruthy();
});
