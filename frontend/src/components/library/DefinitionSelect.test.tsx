import { MantineProvider } from '@mantine/core';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { DefinitionSelect } from './DefinitionSelect';
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
beforeEach(() => vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} }));
test('source choices are lazy kind-specific metadata pages, search and next cursor stay bounded', async () => {
  const calls: string[] = []; const onChange = vi.fn();
  vi.stubGlobal('fetch', vi.fn(async (url: string) => { calls.push(url); return new Response(JSON.stringify({ results: [{ record_id: url.includes('after=') ? 'p2' : 'p1', label: url.includes('after=') ? 'Second pinout' : 'First pinout' }], next_after: url.includes('after=') ? null : 'cursor2' })); }));
  render(<MantineProvider env="test"><QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><DefinitionSelect label="Pinout source" kind="pinout" value={null} onChange={onChange} /></QueryClientProvider></MantineProvider>);
  expect(calls).toEqual([]); fireEvent.click(screen.getByRole('combobox', { name: 'Pinout source' })); await screen.findByRole('option', { name: 'First pinout' });
  expect(calls).toEqual(['/api/v0/workspace/library-table?limit=50&kinds=pinout']);
  screen.getByRole('combobox', { name: 'Pinout source' }).focus();
  fireEvent.input(screen.getByRole('combobox', { name: 'Pinout source' }), { target: { value: 'coax' } }); await waitFor(() => expect(calls.some(url => url.includes('query=coax'))).toBe(true)); expect(calls.at(-1)).not.toContain('after=');
  fireEvent.click(screen.getByRole('button', { name: 'More choices' })); await screen.findByRole('option', { name: 'Second pinout' }); expect(calls.at(-1)).toContain('after=cursor2');
  fireEvent.click(screen.getByRole('option', { name: 'Second pinout' })); expect(onChange).toHaveBeenCalledWith('p2');
  expect(calls.every(url => url.includes('limit=50&kinds=pinout'))).toBe(true);
});
