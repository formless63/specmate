import { MantineProvider } from '@mantine/core';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory } from '@tanstack/react-router';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { RecordPage } from '../../components/record/RecordPage';
import { NavigationProvider } from '../navigation';
import { HistoryPage, RecordHistoryDisclosure } from './History';
import { HistoryScopeProvider } from './HistoryScope';

const event = (name = 'Readable stock', evidence = 'revision', basis = 'exact_revision') => ({ event_id: name, evidence, at: '2026-01-01T10:00:00Z', actor: { id: '1', name: 'Readable person' }, operation: evidence === 'receipt' ? 'draft.update' : null, touched: [{ definition_id: 'stock', kind: 'wire_stock', name, basis, revision_id: basis === 'exact_revision' ? 'r3' : null, number: basis === 'exact_revision' ? 3 : null, draft_id: basis === 'current_draft' ? 'd1' : null, state: basis === 'current_draft' ? 'draft-v4' : null }] });
const page = (results = [event()], next: string | null = null, source = 'retained') => ({ workspace_id: 'w1', source, complete_audit: false, hint: 'Keyed update receipts do not retain previous content.', results, next_after: next, scan_limit_reached: false });
const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
beforeEach(() => { vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} }); Element.prototype.scrollIntoView = vi.fn(); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
function mount(path = '/history') {
  const history = createMemoryHistory({ initialEntries: [path] });
  const cache = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const tree = (active = true, principalKey = 'owner') => <MantineProvider env="test"><QueryClientProvider client={cache}><NavigationProvider history={history}><HistoryPage active={active} workspaceId="w1" principalKey={principalKey} /></NavigationProvider></QueryClientProvider></MantineProvider>;
  const view = render(tree()); return { history, rerender: (active = true, principalKey = 'owner') => view.rerender(tree(active, principalKey)) };
}
test('URL filters, Back/Forward and refresh always start a fresh first page', async () => {
  const urls: URL[] = [];
  vi.stubGlobal('fetch', vi.fn(async (path: string) => { const url = new URL(path, 'http://local'); urls.push(url); return response(page([event(url.searchParams.has('after') ? 'Second page' : url.searchParams.get('kind') || 'First page')], url.searchParams.has('after') ? null : 'cursor')); }));
  const { history } = mount('/history?from=2026-01-01&actor=1'); await screen.findByRole('button', { name: 'First page · r3' });
  expect(urls.at(-1)!.searchParams.get('from_date')).toBe('2026-01-01T00:00:00Z'); expect(urls.at(-1)!.searchParams.get('actor_id')).toBe('1');
  fireEvent.click(screen.getByRole('button', { name: 'Next history page' })); await screen.findByRole('button', { name: 'Second page · r3' });
  await act(async () => history.push('/history?kind=wire_stock')); await screen.findByRole('button', { name: 'wire_stock · r3' }); expect(urls.at(-1)!.searchParams.has('after')).toBe(false);
  await act(async () => history.back()); await screen.findByRole('button', { name: 'First page · r3' }); expect(urls.at(-1)!.searchParams.has('after')).toBe(false);
  await act(async () => history.forward()); await screen.findByRole('button', { name: 'wire_stock · r3' });
  fireEvent.click(screen.getByRole('button', { name: 'Next history page' })); await screen.findByRole('button', { name: 'Second page · r3' });
  const count = urls.length; fireEvent.click(screen.getByRole('button', { name: 'Refresh history' })); await screen.findByRole('button', { name: 'wire_stock · r3' }); expect(urls.slice(count)).toHaveLength(1); expect(urls.at(-1)!.searchParams.has('after')).toBe(false);
});
test('expired cursor recovery returns to first page without repeating the rejected cursor', async () => {
  const urls: URL[] = []; vi.stubGlobal('fetch', vi.fn(async (path: string) => { const url = new URL(path, 'http://local'); urls.push(url); return url.searchParams.has('after') ? response({ error: { message: 'Expired private cursor details' } }, 400) : response(page([event()], 'expired')); }));
  mount(); await screen.findByRole('button', { name: 'Readable stock · r3' }); fireEvent.click(screen.getByRole('button', { name: 'Next history page' })); await screen.findByText(/History unavailable/); expect(screen.queryByText(/Expired private/)).toBeNull(); fireEvent.click(screen.getByRole('button', { name: 'Retry history from first page' })); await screen.findByRole('button', { name: 'Readable stock · r3' }); expect(urls.at(-1)!.searchParams.has('after')).toBe(false);
});
test('focus reauthorization withdraws retained rows and person labels, including an open dropdown', async () => {
  let mode = 'allow'; let finish: ((value: Response) => void) | undefined;
  vi.stubGlobal('fetch', vi.fn(async () => mode === 'held' ? new Promise<Response>(resolve => { finish = resolve; }) : response(page())));
  mount('/history?actor=1'); await screen.findByRole('button', { name: 'Readable stock · r3' }); fireEvent.click(screen.getByRole('combobox', { name: 'Person' })); expect(screen.getByRole('option', { name: 'Readable person' })).toBeTruthy();
  mode = 'held'; fireEvent.focus(window); await waitFor(() => expect(finish).toBeDefined()); expect(screen.queryByRole('button', { name: 'Readable stock · r3' })).toBeNull(); expect(screen.queryByDisplayValue('Readable person')).toBeNull(); expect(screen.queryByRole('option', { name: 'Readable person' })).toBeNull();
  await act(async () => finish!(response({ error: { message: 'Secret denied identity' } }, 403))); await screen.findByText(/History unavailable/); expect(screen.queryByText('Secret denied identity')).toBeNull();
  mode = 'allow'; fireEvent.click(screen.getByRole('button', { name: 'Retry history from first page' })); await screen.findByRole('button', { name: 'Readable stock · r3' }); expect((screen.getByRole('combobox', { name: 'Person' }) as HTMLInputElement).value).toBe('Readable person');
});
test('inactive and principal replacement fence held results and dropdown portals', async () => {
  let held: ((value: Response) => void) | undefined; let reads = 0;
  vi.stubGlobal('fetch', vi.fn(async () => ++reads === 1 ? new Promise<Response>(resolve => { held = resolve; }) : response(page([event('New principal stock')]))));
  const view = mount(); await waitFor(() => expect(held).toBeDefined()); view.rerender(false); expect(screen.queryByRole('combobox', { name: 'Kind' })).toBeNull(); view.rerender(true, 'viewer'); await screen.findByRole('button', { name: 'New principal stock · r3' }); await act(async () => held!(response(page([event('Old principal secret')])))); expect(screen.queryByText(/Old principal secret/)).toBeNull();
  fireEvent.click(screen.getByRole('combobox', { name: 'Kind' })); expect(screen.getAllByRole('option').length).toBeGreaterThan(0); view.rerender(false, 'viewer'); expect(screen.queryAllByRole('option')).toHaveLength(0); view.rerender(true, 'viewer'); await screen.findByRole('button', { name: 'New principal stock · r3' }); expect(reads).toBeGreaterThan(2);
});
test('frozen links retain the exact revision while change receipts honestly link the current draft', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => response(page([event(), event('Changed stock', 'receipt', 'current_draft')]))));
  const { history } = mount(); fireEvent.click(await screen.findByRole('button', { name: 'Readable stock · r3' })); expect(history.location.href).toBe('/library/wire-stocks/stock@3'); await act(async () => history.push('/history')); fireEvent.click(await screen.findByRole('button', { name: 'Changed stock · current item' })); expect(history.location.href).toBe('/library/wire-stocks/stock?status=draft');
});
test('shared frame and versions disclosure read record history only when explicitly opened and active', async () => {
  const fetcher = vi.fn(async (_path: string) => response(page())); vi.stubGlobal('fetch', fetcher);
  const cache = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const tree = (active = true) => <MantineProvider env="test"><QueryClientProvider client={cache}><HistoryScopeProvider value={{ workspaceId: 'w1', principalKey: 'viewer' }}><RecordPage active={active} identity={{ id: 'stock', name: 'Stock', kind: 'wire_stock' }} state={{ kind: 'revision', id: 'r3', number: 3 }} views={[{ id: 'model', label: 'Model', content: <p>Drawing</p> }]} view="model" onView={vi.fn()} inspector={[{ id: 'part', label: 'Part', content: () => <p>Properties</p> }]} /><RecordHistoryDisclosure definitionId="stock" active={active} /></HistoryScopeProvider></QueryClientProvider></MantineProvider>;
  const view = render(tree()); expect(fetcher).not.toHaveBeenCalled(); fireEvent.click(screen.getByRole('tab', { name: 'History' })); await screen.findByRole('table', { name: 'Record history' }); expect(String(fetcher.mock.calls[0]![0])).toContain('definition_id=stock'); view.rerender(tree(false)); expect(screen.queryByRole('table')).toBeNull();
});

test('source and kind choices persist in the URL and current drafts are labeled separately', async () => {
  vi.stubGlobal('fetch', vi.fn(async (path: string) => { const source = new URL(path, 'http://local').searchParams.get('source')!; return response(page([event('Current stock', source === 'current_drafts' ? 'draft' : 'revision', source === 'current_drafts' ? 'current_draft' : 'exact_revision')], null, source)); }));
  const { history } = mount(); await screen.findByRole('table', { name: 'Workspace history' }); fireEvent.click(screen.getByRole('combobox', { name: 'Evidence source' })); fireEvent.click(screen.getByRole('option', { name: 'Current drafts' })); await screen.findByRole('button', { name: 'Current stock · current item' }); expect(history.location.search).toContain('history_source=current_drafts'); expect(screen.getByText(/Current drafts can change or disappear/)).toBeTruthy();
  fireEvent.click(screen.getByRole('combobox', { name: 'Kind' })); fireEvent.click(screen.getByRole('option', { name: 'pinout' })); await waitFor(() => expect(history.location.search).toContain('kind=pinout')); expect(screen.queryByRole('option', { name: 'pinout variant' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Clear history filters' })); await waitFor(() => expect(history.location.href).toBe('/history')); await screen.findByRole('button', { name: 'Current stock · r3' });
});
