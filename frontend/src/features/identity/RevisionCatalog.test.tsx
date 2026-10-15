import { MantineProvider } from '@mantine/core';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { RevisionCatalog } from './IdentityPanel';
const catalog = { variants: [{ variant_id: 'variant', manufacturer: 'Synthetic manufacturer', part_number: 'EXACT-1', association_basis: 'Synthetic basis' }], lots: [{ lot_id: 'lot', label: 'Synthetic retained lot', variant_id: null }], representations: [], source_identifiers: [] };
beforeEach(() => vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} }));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
test('scoped catalog withdraws retained variant and lot metadata on403 and never lends it to another principal', async () => {
  let denied = false; vi.stubGlobal('fetch', vi.fn(async (url: string) => url.includes('/catalog/revisions/') ? new Response(JSON.stringify(denied ? { error: { message: 'Catalog unavailable' } } : catalog), { status: denied ? 403 : 200 }) : new Response(JSON.stringify({ revisions: [], labels: [], source_labels: [] }))));
  const cache = new QueryClient({ defaultOptions: { queries: { retry: false } } }); const tree = (scopeKey: string) => <MantineProvider env="test"><QueryClientProvider client={cache}><RevisionCatalog revisionId="exact-r1" workspaceId="workspace" scopeKey={scopeKey} /></QueryClientProvider></MantineProvider>;
  const view = render(tree('principal-a:workspace')); await screen.findByRole('cell', { name: 'Synthetic manufacturer / EXACT-1' }); await screen.findByText(/Synthetic retained lot/); denied = true;
  await act(async () => { await cache.invalidateQueries({ queryKey: ['catalog', 'principal-a:workspace'] }); }); await screen.findByText('Catalog unavailable'); expect(screen.queryByRole('cell', { name: 'Synthetic manufacturer / EXACT-1' })).toBeNull(); expect(screen.queryByText(/Synthetic retained lot/)).toBeNull();
  view.rerender(tree('principal-b:workspace')); expect(screen.queryByRole('cell', { name: 'Synthetic manufacturer / EXACT-1' })).toBeNull(); await waitFor(() => expect(cache.getQueryState(['catalog', 'principal-b:workspace', 'exact-r1', 0])?.status).toBe('error'));
});
