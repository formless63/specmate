import { MantineProvider } from '@mantine/core';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { WireStockPanel } from './WireStockPanel';
import { stockPresets } from './presets';

const record = { name: 'Synthetic saved coax', definition_id: 'definition-1', draft_id: 'draft-1', state: 'draft-v1', content: { stock: stockPresets.coax } };
beforeEach(() => vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} }));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const show = (projectId?: string) => render(<MantineProvider><WireStockPanel projectId={projectId} /></MantineProvider>);

test('produces standalone section and preview without device or connector configuration', () => {
  show();
  expect(screen.getByText(/Section: 3 mm × 3 mm · 4 material elements/)).toBeTruthy();
  expect(screen.getByLabelText('Stock section drawing').querySelectorAll('[data-element]')).toHaveLength(4);
  expect(screen.getByLabelText('Stock geometry preview').querySelectorAll('[data-preview-element]')).toHaveLength(4);
  expect((screen.getByRole('button', { name: 'Save stock' }) as HTMLButtonElement).disabled).toBe(true);
  expect(screen.getByText(/Select a project to save stock/)).toBeTruthy();
});

test('saving editor changes persists the exact stock through the shared operation adapter', async () => {
  const fetchMock = vi.fn().mockImplementation(async (_url: string, options?: RequestInit) => {
    if (options?.method === 'POST') {
      const envelope = JSON.parse(options.body as string);
      return new Response(JSON.stringify({ result: { ...record, content: { stock: envelope.payload.stock } } }));
    }
    return new Response('[]');
  });
  vi.stubGlobal('fetch', fetchMock);
  show('project-1');
  fireEvent.change(screen.getByLabelText('stock.jacket outer diameter mm'), { target: { value: '3.2' } });
  expect(screen.getByText(/Section: 3.2 mm × 3.2 mm/)).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Save stock' }));
  await screen.findByText('Saved Synthetic saved coax (draft-v1).');
  const call = fetchMock.mock.calls.find(([, options]) => (options as RequestInit)?.method === 'POST')!;
  const payload = JSON.parse((call[1] as RequestInit).body as string);
  expect(payload.operation).toBe('wire_stock.create');
  expect(payload.payload.project_id).toBe('project-1');
  expect(payload.payload.stock.structure.children[3].outer_diameter_mm).toBe(3.2);
  expect(payload.payload.stock.facts.impedance.value).toBeNull();
  expect((screen.getByRole('button', { name: 'Freeze saved stock' }) as HTMLButtonElement).disabled).toBe(false);
  fireEvent.change(screen.getByLabelText('stock.center label'), { target: { value: 'Edited center' } });
  expect((screen.getByRole('button', { name: 'Freeze saved stock' }) as HTMLButtonElement).disabled).toBe(true);
});

test('adding unknown material keeps identities in table and marks incomplete geometry', () => {
  show();
  fireEvent.click(screen.getByRole('button', { name: 'Add element to stock' }));
  expect(screen.getByLabelText(/^stock\.conductor-[a-f0-9-]+ label$/)).toBeTruthy();
  expect(screen.getByText(/Incomplete geometry: stock.conductor-[a-f0-9-]+: layer dimensions unknown/, { selector: 'div' })).toBeTruthy();
  expect(screen.getByLabelText('Stock section drawing').querySelectorAll('[data-element]')).toHaveLength(4);
  fireEvent.click(screen.getByRole('button', { name: /^Remove stock\.conductor-[a-f0-9-]+$/ }));
  expect(screen.queryByLabelText(/^stock\.conductor-[a-f0-9-]+ label$/)).toBeNull();
});

test('server conflict is visible and cannot be mistaken for a saved stock', async () => {
  vi.stubGlobal('fetch', vi.fn().mockImplementation(async (_url: string, options?: RequestInit) =>
    options?.method === 'POST' ? new Response(JSON.stringify({ error: { message: 'Draft changed since expected state.' } }), { status: 409 }) : new Response('[]')));
  show('project-1');
  fireEvent.click(screen.getByRole('button', { name: 'Save stock' }));
  await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('Draft changed'));
  expect(screen.queryByText(/Saved Synthetic/)).toBeNull();
  expect((screen.getByRole('button', { name: 'Freeze saved stock' }) as HTMLButtonElement).disabled).toBe(true);
});
