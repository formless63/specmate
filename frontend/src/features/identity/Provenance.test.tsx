import { MantineProvider } from '@mantine/core';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { Provenance } from './Provenance';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const origin = { namespace: 'synthetic-catalog', record_key: 'fixture-part', upstream_revision: '0', source_status: 'legacy', synthetic_example: true, converter: 'fixture/1', source_bundle_revision_id: 'source', source_path: 'parts/one.json', sha256: 'a'.repeat(64), rights: 'Synthetic original' };
const reply = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
function tree(active = true) { return <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><MantineProvider env="test"><Provenance definitionId="part" revisionId="r1" scopeKey="actor:workspace" active={active} /></MantineProvider></QueryClientProvider>; }

test('exact historic origins and current replacement are distinct, refresh denial clears both', async () => {
  let denied = false;
  vi.stubGlobal('fetch', vi.fn(async (path: string) => denied ? reply({ error: { message: 'Not found' } }, 404) : path.includes('/operations') ? reply({ result: { definition_id: 'part', status: 'superseded', replacement_revision_id: 'new-r2', basis: 'Reviewed correction' } }) : reply({ source_origins: [origin] })));
  render(tree());
  expect(await screen.findByText(/synthetic-catalog · fixture-part/)).toBeTruthy();
  expect(screen.getByText(/Upstream revision: 0/)).toBeTruthy();
  expect(screen.getByText(/Superseded by exact revision new-r2/)).toBeTruthy();
  denied = true;
  fireEvent.click(screen.getByRole('button', { name: 'Refresh provenance' }));
  await screen.findByText('Exact source provenance unavailable.');
  expect(screen.queryByText(/synthetic-catalog · fixture-part/)).toBeNull();
  expect(screen.queryByText(/Superseded by exact revision new-r2/)).toBeNull();
});

test('inactive provenance makes no requests and bounded pages retain exact revision', async () => {
  const fetcher = vi.fn(async (path: string) => path.includes('/operations') ? reply({ result: { definition_id: 'part', status: 'active' } }) : reply({ source_origins: path.includes('offset=0') ? Array.from({ length: 50 }, (_, index) => ({ ...origin, record_key: `p${index}` })) : [{ ...origin, record_key: 'page-two' }] }));
  vi.stubGlobal('fetch', fetcher);
  const view = render(tree(false));
  expect(fetcher).not.toHaveBeenCalled();
  view.rerender(tree());
  await screen.findByText('synthetic-catalog · p49');
  fireEvent.click(screen.getByRole('button', { name: 'More origins' }));
  await screen.findByText('synthetic-catalog · page-two');
  await waitFor(() => expect(fetcher.mock.calls.some(([path]) => path.includes('/revisions/r1?offset=50&limit=50'))).toBe(true));
});
