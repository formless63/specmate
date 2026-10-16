import { MantineProvider } from '@mantine/core';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { RevisionModels } from './RevisionModels';

const released = vi.hoisted(() => vi.fn());
vi.mock('./PartModel', async () => {
  const { useEffect } = await import('react');
  return { PartModel: ({ rows }: { rows: { label: string }[] }) => {
    useEffect(() => () => released(), []);
    return <div data-testid="bounded-model">{rows.map(row => row.label).join(',')}</div>;
  } };
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); released.mockClear(); });
type Props = Parameters<typeof RevisionModels>[0];
function setup(patch: Partial<Props> = {}) {
  const props = { active: true, revisionId: 'historic-r1', principalKey: 'owner', workspaceId: 'workspace', onAccessLost: vi.fn(), ...patch };
  const cache = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const tree = (next: Partial<Props> = {}) => <MantineProvider env="test"><QueryClientProvider client={cache}><RevisionModels {...props} {...next} /></QueryClientProvider></MantineProvider>;
  return { ...render(tree()), tree, props };
}
test('hidden model view reads nothing and exact historic model is released on hiding', async () => {
  const fetch = vi.fn(async (_url: string) => new Response(JSON.stringify({ representations: [{ label: 'Historic model' }] })));
  vi.stubGlobal('fetch', fetch); const page = setup({ active: false });
  expect(fetch).not.toHaveBeenCalled(); page.rerender(page.tree({ active: true }));
  expect((await screen.findByTestId('bounded-model')).textContent).toContain('Historic model');
  expect(fetch.mock.calls[0]?.[0]).toBe('/api/v0/catalog/revisions/historic-r1?offset=0&limit=50');
  page.rerender(page.tree({ active: false })); expect(screen.queryByTestId('bounded-model')).toBeNull(); expect(released).toHaveBeenCalled();
});
test('exact revision replacement hides previous model while new access is pending', async () => {
  let complete: (value: Response) => void = () => {};
  vi.stubGlobal('fetch', vi.fn((url: string) => url.includes('historic-r1') ? Promise.resolve(new Response(JSON.stringify({ representations: [{ label: 'Historic model' }] }))) : new Promise<Response>(resolve => { complete = resolve; })));
  const page = setup(); await screen.findByTestId('bounded-model'); page.rerender(page.tree({ revisionId: 'r2' }));
  expect(screen.queryByTestId('bounded-model')).toBeNull(); expect(screen.getByRole('status').textContent).toContain('Confirming exact model access');
  complete(new Response(JSON.stringify({ representations: [{ label: 'New model' }] })));
  expect((await screen.findByTestId('bounded-model')).textContent).toContain('New model'); expect(released).toHaveBeenCalled();
});
test('catalog denial exposes no retained preview and asks containing record to refresh authority', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: { message: 'Exact source denied' } }), { status: 403 })));
  const page = setup(); expect((await screen.findByRole('alert')).textContent).toContain('Exact source denied');
  await waitFor(() => expect(page.props.onAccessLost).toHaveBeenCalled()); expect(screen.queryByTestId('bounded-model')).toBeNull();
});
test('denial refresh notification is bounded and a later explicit reactivation can recover', async () => {
  let denied = true;
  vi.stubGlobal('fetch', vi.fn(async () => denied ? new Response(JSON.stringify({ error: { message: 'Exact source denied' } }), { status: 403 }) : new Response(JSON.stringify({ representations: [{ label: 'Recovered model' }] }))));
  const page = setup(); await screen.findByRole('alert'); await waitFor(() => expect(page.props.onAccessLost).toHaveBeenCalledTimes(1));
  page.rerender(page.tree({ active: false })); page.rerender(page.tree({ active: true })); await screen.findByRole('alert');
  expect(page.props.onAccessLost).toHaveBeenCalledTimes(1);
  denied = false; page.rerender(page.tree({ active: false })); page.rerender(page.tree({ active: true }));
  expect((await screen.findByTestId('bounded-model')).textContent).toContain('Recovered model');
});
