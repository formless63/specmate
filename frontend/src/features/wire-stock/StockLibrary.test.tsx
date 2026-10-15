import { MantineProvider } from '@mantine/core';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory } from '@tanstack/react-router';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { NavigationProvider, useNavigation } from '../navigation';
import { ProbeProvider } from '../probe';
import { PermissionsProvider } from '../../lib/permissions';
import { StockLibrary } from './StockLibrary';
import { exampleCoax, generate } from './builder';
vi.mock('../../components/library/LibraryList', () => ({ LibraryList: ({ editor }: { editor: { reveal: (newStock: boolean) => void } }) => <button onClick={() => editor.reveal(true)}>New wire stock</button> }));
vi.mock('./StockDisplay', () => ({ StockDisplay: () => <p>Working stock model</p> }));
beforeEach(() => vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} }));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
function mount(path: string) {
  const history = createMemoryHistory({ initialEntries: [path] }); const calls: string[] = []; let held: Promise<void> | null = null; let release = () => {};
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    calls.push(url); if (url.includes('/workspace/library/')) return new Response(JSON.stringify({ record_id: 's1', label: 'Saved stock', kind: 'wire_stock', latest_revision: 1, latest_revision_id: 'r1', used_in: [] }));
    if (url.includes('/stocks?')) return new Response(JSON.stringify([{ definition_id: 's1', draft_id: 'd1', name: 'Saved stock', state: 'draft-v4', content: { stock: generate(exampleCoax()) } }]));
    if (url.endsWith('/operations')) { const command = JSON.parse(String(init?.body)); if (held) await held; return new Response(JSON.stringify({ result: { definition_id: 'snew', draft_id: 'dnew', name: command.payload.name, state: 'draft-v1', content: { stock: command.payload.stock } } })); }
    return new Response(JSON.stringify({ content: { stock: generate(exampleCoax()) }, conventions: [] }));
  }));
  function Routed() { const nav = useNavigation()!; return <ProbeProvider probe={nav.location.probe} onProbe={probe => nav.navigate({ probe })}><StockLibrary active={nav.location.lens === 'wire-stock'} principalKey="user:w1" workspaceId="w1" projects={[]} projectFilterId={nav.location.project} onOpenInProject={vi.fn()} /></ProbeProvider>; }
  render(<MantineProvider env="test"><QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><PermissionsProvider permissions={['workspace.read', 'item.create', 'design.edit', 'design.freeze']}><NavigationProvider history={history}><Routed /></NavigationProvider></PermissionsProvider></QueryClientProvider></MantineProvider>);
  return { history, calls, hold: () => { held = new Promise(resolve => { release = resolve; }); return () => { release(); held = null; }; } };
}
test('New is a dedicated record; leaving and reopening preserves its buffer independently of project list filters', async () => {
  const { history } = mount('/library/wire-stocks'); fireEvent.click(screen.getByRole('button', { name: 'New wire stock' })); const field = await screen.findByLabelText('Stock name'); fireEvent.change(field, { target: { value: 'Unsaved stock' } });
  expect(screen.queryByRole('button', { name: 'New wire stock' })).toBeNull(); expect(history.location.search).toContain('status=new');
  fireEvent.click(screen.getByRole('button', { name: 'Back to Wire stocks' })); fireEvent.click(await screen.findByRole('button', { name: 'New wire stock' })); expect((await screen.findByLabelText('Stock name') as HTMLInputElement).value).toBe('Unsaved stock');
  await act(async () => history.push('/library/wire-stocks?project=p2&status=new')); expect((screen.getByLabelText('Stock name') as HTMLInputElement).value).toBe('Unsaved stock');
});
test('record selection and rail changes retain a dirty draft and never mount the list alongside its record', async () => {
  const { history, calls } = mount('/library/wire-stocks/s1?status=draft'); await screen.findByLabelText('Stock name'); fireEvent.change(screen.getByLabelText('Jacket outer diameter'), { target: { value: '3.8' } });
  expect(screen.queryByRole('button', { name: 'New wire stock' })).toBeNull(); await act(async () => history.push('/library/parts')); await act(async () => history.push('/library/wire-stocks/s1?status=draft')); expect((await screen.findByLabelText('Jacket outer diameter') as HTMLInputElement).value).toBe('3.8'); expect(calls.filter(path => path.includes('/stocks?')).every(path => path.includes('definition_id=s1&latest_only=true'))).toBe(true);
});

test('back to the list retains URL search and layout facets', async () => {
  const { history } = mount('/library/wire-stocks?q=screen&layout=table'); fireEvent.click(screen.getByRole('button', { name: 'New wire stock' })); await screen.findByLabelText('Stock name'); fireEvent.click(screen.getByRole('button', { name: 'Back to Wire stocks' })); expect(history.location.search).toContain('q=screen'); expect(history.location.search).toContain('layout=table'); expect(history.location.search).not.toContain('status=new');
});

test('a hidden create completion never switches the newer active creation buffer', async () => {
  const { history, hold } = mount('/library/wire-stocks'); fireEvent.click(screen.getByRole('button', { name: 'New wire stock' })); fireEvent.change(await screen.findByRole('textbox', { name: 'Stock name' }), { target: { value: 'Submitted stock' } }); const release = hold(); fireEvent.click(screen.getByRole('button', { name: 'Save stock' })); fireEvent.click(screen.getByRole('button', { name: 'Duplicate' })); fireEvent.change(await screen.findByRole('textbox', { name: 'Stock name' }), { target: { value: 'Newer unsaved stock' } }); await act(async () => release()); expect((screen.getByRole('textbox', { name: 'Stock name' }) as HTMLInputElement).value).toBe('Newer unsaved stock'); expect(history.location.search).toContain('status=new'); expect(history.location.pathname).toBe('/library/wire-stocks');
});
