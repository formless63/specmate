import { MantineProvider } from '@mantine/core';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { RevisionWhereUsed } from './RevisionWhereUsed';
import type { UsePage } from '../../features/discovery/api';
const api = vi.hoisted(() => ({ whereUsed: vi.fn() }));
vi.mock('../../features/discovery/api', () => api);
vi.mock('../../lib/IdentityLabel', () => ({ RevisionLabel: ({ id }: { id: string }) => <span>Selected child {id}</span>, ExactPins: ({ pins }: { pins: { label: string; value: string }[] }) => <span>{pins.map(pin => <button key={pin.label}>{pin.label}: {pin.value}</button>)}</span> }));
afterEach(() => { cleanup(); vi.clearAllMocks(); });
const page = (label = 'Synthetic cable parent'): UsePage => ({ revision_id: 'exact-r1', workspace_id: 'workspace', project_id: null, next_after: 'snapshot-cursor', results: [{ record_id: 'snapshot-1', snapshot_id: 'snapshot-1', definition_id: 'parent-1', definition_kind: 'cable', workspace_id: 'workspace', relation: 'exact_revision_pin', label }], project_references: [{ reference_id: 'reference-1', project_id: 'project-1', project_name: 'Synthetic project', archived: false, kind: 'definition', relation: 'project_reference_floating', role: 'Reference', in_project: false }], project_references_truncated: false });
function setup(active = true, onOpenProject?: (id: string) => void) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const tree = (enabled: boolean) => <MantineProvider env="test"><QueryClientProvider client={client}><RevisionWhereUsed revisionId="exact-r1" principalKey="principal" active={enabled} onOpenProject={onOpenProject} toolLabel="Wire stock" /></QueryClientProvider></MantineProvider>;
  return { ...render(tree(active)), tree };
}
test('exact captured snapshots and floating project references stay distinct while paging', async () => {
  api.whereUsed.mockResolvedValueOnce(page()).mockResolvedValueOnce({ ...page('Another captured parent'), next_after: null });
  const open = vi.fn(); setup(true, open); await screen.findByText('Synthetic cable parent');
  fireEvent.click(screen.getByRole('button', { name: 'Open Wire stock in Synthetic project' })); expect(open).toHaveBeenCalledWith('project-1');
  expect(screen.getByRole('button', { name: 'Parent snapshot ID: snapshot-1' })).toBeTruthy();
  expect(screen.getByText(/Floating definition reference/)).toBeTruthy();
  expect(screen.queryByRole('link')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'More parent snapshots' }));
  await screen.findByText('Another captured parent');
  expect(api.whereUsed).toHaveBeenLastCalledWith('exact-r1', 'snapshot-cursor');
  expect(screen.queryByText('Synthetic cable parent')).toBeNull();
});
test('focus and reactivation withdraw retained parents and projects until current authority succeeds', async () => {
  api.whereUsed.mockResolvedValueOnce(page());
  const view = setup(); await screen.findByText('Synthetic cable parent');
  let reject!: (error: Error) => void;
  api.whereUsed.mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail; }));
  fireEvent(window, new Event('focus'));
  await screen.findByText('Reading current exact uses…');
  expect(screen.queryByText('Synthetic cable parent')).toBeNull(); expect(screen.queryByText('Synthetic project')).toBeNull();
  await act(async () => reject(new Error('Denied')));
  await screen.findByText(/Exact uses unavailable/);
  view.rerender(view.tree(false)); expect(screen.queryByText(/Exact uses unavailable/)).toBeNull();
  const calls = api.whereUsed.mock.calls.length; fireEvent(window, new Event('focus')); expect(api.whereUsed).toHaveBeenCalledTimes(calls);
  api.whereUsed.mockRejectedValueOnce(new Error('Still denied'));
  view.rerender(view.tree(true)); await screen.findByText(/Exact uses unavailable/);
  expect(screen.queryByText('Synthetic project')).toBeNull();
  api.whereUsed.mockResolvedValueOnce(page()); fireEvent.click(screen.getByRole('button', { name: 'Refresh exact uses' }));
  await waitFor(() => expect(screen.getByText('Synthetic cable parent')).toBeTruthy());
});
