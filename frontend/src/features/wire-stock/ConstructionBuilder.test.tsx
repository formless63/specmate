import { MantineProvider } from '@mantine/core';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { NewStockRecord } from '../../test/stock-record';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

beforeEach(() => vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} }));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const wrap = (children: React.ReactNode) => <MantineProvider env="test"><QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{children}</QueryClientProvider></MantineProvider>;
const show = () => render(wrap(<NewStockRecord />));

test('a failing jacket is drawn on the section and fixed in one click', () => {
  show();
  fireEvent.change(screen.getByLabelText('Jacket wall'), { target: { value: '1' } });
  expect(document.querySelector('[data-fit-bore="stock.jacket"]')).toBeTruthy();
  expect(screen.getByLabelText('Fit problems').textContent).toContain("won't fit Jacket bore 1 mm");
  expect(screen.getByLabelText('Fit findings').textContent).toContain('checks fail');
  fireEvent.click(screen.getByRole('button', { name: 'Set jacket OD to fit' }));
  expect(document.querySelector('[data-fit-bore]')).toBeNull();
  expect((screen.getByLabelText('Jacket outer diameter') as HTMLInputElement).value).toBe('4.4');
  expect(screen.getByLabelText('Fit findings').textContent).toContain('all 9 checks fit within ±0.001 mm');
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
  render(wrap(<PermissionsProvider permissions={['workspace.read']}><NewStockRecord /></PermissionsProvider>));
  const before = (screen.getByLabelText('Jacket outer diameter') as HTMLInputElement).value;
  fireEvent.change(screen.getByLabelText('Jacket outer diameter slider'), { target: { value: '9' } });
  expect((screen.getByLabelText('Jacket outer diameter') as HTMLInputElement).value).toBe(before);
  expect(screen.getByLabelText('Jacket outer diameter slider').getAttribute('aria-readonly')).toBe('true');
  const handle = screen.getByRole('slider', { name: 'Jacket outer diameter handle' });
  expect(handle.getAttribute('aria-disabled')).toBe('true');
  fireEvent.keyDown(handle, { key: 'ArrowRight' });
  expect((screen.getByLabelText('Jacket outer diameter') as HTMLInputElement).value).toBe(before);
  expect(screen.getByLabelText('Stock section drawing').querySelectorAll('[data-element]').length).toBeGreaterThan(0);
});

test('the record template chooser starts a ribbon construction', () => {
  show();
  fireEvent.click(screen.getByRole('combobox', { name: 'Construction template' }));
  fireEvent.click(screen.getByRole('option', { name: 'Ribbon' }));
  expect(screen.getByRole('group', { name: 'Cores' })).toBeTruthy();
});
