import { MantineProvider } from '@mantine/core';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { PermissionsProvider } from '../../lib/permissions';
import { NewStockRecord } from '../../test/stock-record';
import { stockPresets } from './presets';
import type { StockSpecification } from '../../../../packages/section-layout/src';
import crossCheck from '../../../../tests/fixtures/wire-stock-placement.json';
vi.mock('./StockDisplay', () => ({ StockDisplay: () => <div aria-label="Stock model" /> }));
beforeEach(() => vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} }));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
function setup(permissions = ['workspace.read', 'item.create', 'design.edit', 'design.freeze'], stock = stockPresets.coax!, conflict = false) {
 const posts: any[] = [];
 vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
  if (init?.method === 'POST') {
   const envelope = JSON.parse(String(init.body)); posts.push(envelope);
   if (conflict) return new Response(JSON.stringify({ error: { message: 'Draft changed since expected state.' } }), { status: 409 });
   const result = envelope.operation === 'wire_stock.freeze' ? { number: 1, draft: { state: 'draft-v2' } } : { name: 'Synthetic saved coax', definition_id: 'definition-1', draft_id: 'draft-1', state: 'draft-v1', content: { stock: envelope.payload.stock } };
   return new Response(JSON.stringify({ result }));
  }
  return new Response(JSON.stringify({ results: [], effective: {} }));
 }));
 render(<MantineProvider env="test"><QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><PermissionsProvider permissions={permissions}><NewStockRecord stock={stock} /></PermissionsProvider></QueryClientProvider></MantineProvider>);
 return posts;
}
const button = (name: string) => screen.getByRole('button', { name }) as HTMLButtonElement;
async function advanced() { fireEvent.click(screen.getByRole('tab', { name: 'More' })); fireEvent.click(screen.getByText('Advanced · exact specification tree')); await screen.findByRole('button', { name: 'Add element to stock' }); }
test('standalone stock record draws the construction without device or project selection', () => {
 setup(); expect(screen.getByLabelText('Stock section drawing').querySelectorAll('[data-element]')).toHaveLength(4);
 expect(button('Save stock').disabled).toBe(false); expect(screen.queryByLabelText('Use in this project')).toBeNull();
});
test('record saves exact stock through the shared operation and subsequent edits fence freezing', async () => {
 const posts = setup(); await advanced(); fireEvent.change(screen.getByLabelText('stock.jacket outer diameter mm'), { target: { value: '3.2' } });
 fireEvent.click(button('Save stock')); await screen.findByText('Saved draft.');
 expect(posts).toHaveLength(1); expect(posts[0].operation).toBe('wire_stock.create'); expect(posts[0].payload.project_id).toBeUndefined();
 expect(posts[0].payload.stock.structure.children[3].outer_diameter_mm).toBe(3.2); expect(posts[0].payload.stock.facts.impedance.value).toBeNull();
 expect(button('Freeze saved stock').disabled).toBe(false); fireEvent.change(screen.getByLabelText('stock.center label'), { target: { value: 'Edited center' } }); expect(button('Freeze saved stock').disabled).toBe(true);
});
test('new material stays unknown and removable without inventing dimensions', async () => {
 const posts = setup(); await advanced(); fireEvent.click(button('Add element to stock')); expect(screen.getByLabelText(/^stock\.conductor-[a-f0-9-]+ label$/)).toBeTruthy();
 fireEvent.click(button('Save stock')); await screen.findByText('Saved draft.'); const added = posts[0].payload.stock.structure.children.at(-1);
 expect(added.outer_diameter_mm).toBeNull(); expect(added.material).toBeNull(); expect(added.source).toBeNull();
 fireEvent.click(button(`Remove stock.${added.id}`)); expect(screen.queryByLabelText(/^stock\.conductor-[a-f0-9-]+ label$/)).toBeNull();
});
test('conflict preserves local edits and does not announce a saved record', async () => {
 setup(undefined, undefined, true); await advanced(); fireEvent.change(screen.getByLabelText('stock.jacket outer diameter mm'), { target: { value: '3.7' } }); fireEvent.click(button('Save stock'));
 await screen.findByText('Draft changed since expected state.'); expect(screen.queryByText('Saved draft.')).toBeNull(); expect((screen.getByLabelText('stock.jacket outer diameter mm') as HTMLInputElement).value).toBe('3.7'); expect(button('Freeze saved stock').disabled).toBe(true);
});
test('viewer cannot author while specification export stays available', () => {
 setup(['workspace.read']); expect(button('Save stock').disabled).toBe(true); expect(button('Save stock').title).toContain('Contributor'); expect(button('Freeze saved stock').disabled).toBe(true);
 fireEvent.click(screen.getByRole('tab', { name: 'Spec sheet' })); expect(button('Download spec sheet').disabled).toBe(false); expect(button('Download section SVG').disabled).toBe(false);
});
test('contributor can save but cannot freeze', async () => {
 setup(['workspace.read', 'item.create']); fireEvent.click(button('Save stock')); await screen.findByText('Saved draft.'); expect(button('Freeze saved stock').disabled).toBe(true); expect(button('Freeze saved stock').title).toContain('Freeze');
});
test('fit failures require explicit acknowledgement even after saving', async () => {
 const posts = setup(undefined, crossCheck.cases[0]!.stock as unknown as StockSpecification);
 expect(screen.getByLabelText('Fit findings').textContent).toContain('5 of 13 checks fail');
 fireEvent.click(button('Save stock')); await screen.findByText('Saved draft.'); expect(button('Freeze saved stock').disabled).toBe(true);
 fireEvent.click(screen.getByLabelText('I have reviewed the 5 fit problems and want to freeze anyway')); expect(button('Freeze saved stock').disabled).toBe(false);
 fireEvent.click(button('Freeze saved stock')); await waitFor(() => expect(posts.some(post => post.operation === 'wire_stock.freeze')).toBe(true));
 expect(posts.find(post => post.operation === 'wire_stock.freeze').payload).toEqual({ draft_id: 'draft-1', acknowledge_geometry_findings: true });
});
