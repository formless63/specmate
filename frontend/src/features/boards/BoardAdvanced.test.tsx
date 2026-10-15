import { MantineProvider } from '@mantine/core';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { PermissionsProvider } from '../../lib/permissions';
import type { Inspection } from '../passive-passages/api';
import { BoardPassiveReview } from './BoardAdvanced';
const source = '00000000-0000-4000-8000-000000000001';
const review: Inspection = { revision_id: 'model-r1', sha256: 'a'.repeat(64), snapshot_id: 'snapshot', model: { root_revision_id: 'root-r1', assumptions: 'ideal_lumped_components', model_basis: 'Declared ideal model', passages: [] }, graph: { root_revision_id: 'root-r1', snapshot_id: 'root-snapshot', snapshot_sha256: 'b'.repeat(64), occurrence_path: [], nodes: [], edges: [], boundaries: [], components: [], selected_component_id: null, continuity: 'not_evaluated', compatibility: 'not_evaluated', physical_qualification: 'not_evaluated', limitations: [] }, state: 'review-v1', decision: 'needs_evidence', reviews: [] };
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
async function setup(fetcher: (url: string, init?: RequestInit) => Promise<Response>) { vi.stubGlobal('fetch', vi.fn(fetcher)); const changed = vi.fn(); const client = new QueryClient({ defaultOptions: { queries: { retry: false } } }); render(<MantineProvider env="test"><PermissionsProvider permissions={['workspace.read', 'design.edit']}><QueryClientProvider client={client}><BoardPassiveReview review={review} active principalKey="principal" workspaceId="workspace" onChanged={changed} /></QueryClientProvider></PermissionsProvider></MantineProvider>); fireEvent.click(screen.getByText('Review ideal model independently')); await screen.findByLabelText('Passive model review basis'); return changed; }
const reply = (data: unknown) => new Response(JSON.stringify(data));
test('a committed review refreshes its own CAS even if unrelated query controls changed while the response was held', async () => {
  let release = () => {}; const held = new Promise<void>(resolve => { release = resolve; }); const posts: { expected_state: string }[] = [];
  const changed = await setup(async (url, init) => { if (url.endsWith('/operations')) { posts.push(JSON.parse(String(init?.body))); await held; return reply({ result: {} }); } return reply({ labels: [], source_labels: [] }); });
  fireEvent.change(screen.getByLabelText('Passive model review basis'), { target: { value: 'Independent ideal-model review' } }); fireEvent.click(screen.getByRole('button', { name: 'Append model review' })); await waitFor(() => expect(posts).toHaveLength(1)); fireEvent.change(screen.getByLabelText('Passive query meaning'), { target: { value: 'signal' } }); await act(async () => release()); await waitFor(() => expect(changed).toHaveBeenCalledTimes(1)); expect(posts[0]?.expected_state).toBe('review-v1');
});
test('new registered review evidence is freshly withdrawn on denial without losing the authored basis', async () => {
  let denied = false; let posts = 0; await setup(async url => { if (url.endsWith('/operations')) { posts += 1; return reply({ result: {} }); } return reply({ labels: [], source_labels: [{ revision_id: source, readable: !denied }] }); });
  fireEvent.change(screen.getByLabelText('Passive model review basis'), { target: { value: 'Private reviewed basis retained' } }); fireEvent.change(screen.getByLabelText('Model review evidence status'), { target: { value: 'registered_file' } }); fireEvent.change(screen.getByLabelText('Model review source bundle revision ID'), { target: { value: source } }); await screen.findByLabelText('Model review exact source path'); await waitFor(() => expect(screen.queryByText('Rechecking review evidence…')).toBeNull());
  denied = true; fireEvent(window, new Event('focus')); await screen.findByText(/Review evidence unavailable. Local declarations/); expect(screen.queryByRole('textbox', { name: 'Passive model review basis' })).toBeNull(); expect(screen.queryByRole('button', { name: 'Append model review' })).toBeNull(); expect(posts).toBe(0);
  denied = false; fireEvent.click(screen.getByRole('button', { name: 'Refresh review evidence access' })); expect(await screen.findByRole('textbox', { name: 'Passive model review basis' })).toHaveProperty('value', 'Private reviewed basis retained');
});
