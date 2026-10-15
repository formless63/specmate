import { MantineProvider } from '@mantine/core';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { PermissionsProvider } from '../../lib/permissions';
import { BoardRecordPage } from './BoardRecordPage';
import { emptyBoard, type Board } from './api';
const grants = ['workspace.read', 'item.create', 'design.edit', 'design.freeze'];
const board = (label = 'Historic contact'): Board => ({ ...emptyBoard(), terminals: [{ terminal_id: 'stable-id', label, kind: 'solder_pad', group: null, side: 'top', native_pad_ids: [], note: null }] });
beforeEach(() => vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} }));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
function server() {
  let denied = false; let value = board('Saved contact'); let state = 'draft-v4'; const calls: string[] = []; const posts: { operation: string; payload: { interface: Board }; expected_state?: string }[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    calls.push(url); const response = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });
    if (denied && !url.endsWith('/operations')) return response({ error: { message: 'Denied' } }, 403);
    if (url.includes('/access/workspace')) return response({ workspace_id: 'workspace' });
    if (url.includes('/workspace/library/')) return response({ record_id: 'board', family: 'definition', kind: 'board', label: 'Synthetic board', latest_revision: 2, latest_revision_id: 'r2', used_in: [], used_in_total: 0, referenceable: true });
    if (url.includes('/catalog/definitions/')) return response({ definition_id: 'board', name: 'Synthetic board', kind: 'board', drafts: [{ draft_id: 'draft', state }], revisions: [{ revision_id: 'r1', number: 1 }, { revision_id: 'r2', number: 2 }] });
    if (url.includes('/catalog/revisions/')) return response({ variants: [], lots: [], representations: [], source_identifiers: [] });
    if (url.includes('/interfaces/revisions/')) return response({ revision_id: url.split('/').at(-1), interface: board(url.endsWith('r1') ? 'Historic contact' : 'Newer contact'), board: {} });
    if (url.includes('/interfaces/drafts/')) return response({ definition_id: 'board', draft_id: 'draft', state, content: { interface: value } });
    if (url.includes('/revision-labels')) return response({ labels: [], source_labels: [] });
    if (url.endsWith('/operations')) { const body = JSON.parse(String(init?.body)); posts.push(body); state = 'draft-v5'; value = body.payload.interface; return response({ result: { definition_id: 'board', draft_id: 'draft', state, content: { interface: value } } }); }
    return response({});
  })); return { calls, posts, deny: (next: boolean) => { denied = next; } };
}
type Props = Parameters<typeof BoardRecordPage>[0];
function setup(patch: Partial<Props> = {}, permissions = grants) {
  const callbacks = { onBack: vi.fn(), onSelect: vi.fn(), onCreated: vi.fn(), onDuplicate: vi.fn(), onOpenInProject: vi.fn() };
  const props: Props = { kind: 'board', active: true, principalKey: 'principal', workspaceId: 'workspace', definitionId: 'board', revisionNumber: 1, draftRequested: false, projects: [], ...callbacks, ...patch };
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const tree = (values: Partial<Props> = {}) => <MantineProvider env="test"><PermissionsProvider permissions={permissions}><QueryClientProvider client={client}><BoardRecordPage {...props} {...values} /></QueryClientProvider></PermissionsProvider></MantineProvider>;
  return { ...render(tree()), tree, callbacks };
}
test('exact historical drawing and inspection stay on r1 across views and authority recovery', async () => {
  const api = server(); setup(); const pad = await screen.findByRole('button', { name: 'Pad Historic contact' }); fireEvent.keyDown(pad, { key: 'Enter' });
  expect((await screen.findByLabelText('Pad label')) as HTMLInputElement).toHaveProperty('value', 'Historic contact'); expect(screen.getByRole('button', { name: 'r1' })).toBeTruthy();
  fireEvent.click(screen.getByRole('tab', { name: 'Sources', selected: false })); expect(await screen.findByText(/No accepted native interpretation is pinned/)).toBeTruthy(); fireEvent.click(screen.getByRole('tab', { name: 'Pads' }));
  api.deny(true); fireEvent(window, new Event('focus')); await screen.findByRole('alert', { name: 'Board state unavailable' }); expect(screen.queryByRole('button', { name: 'Pad Historic contact' })).toBeNull();
  api.deny(false); fireEvent.click(screen.getByRole('button', { name: 'Refresh board' })); expect(await screen.findByRole('button', { name: 'Pad Historic contact' })).toBeTruthy(); expect((screen.getByLabelText('Pad label')) as HTMLInputElement).toHaveProperty('value', 'Historic contact');
  expect(api.calls.some(url => url.endsWith('/interfaces/revisions/r2'))).toBe(false); expect(api.posts).toHaveLength(0);
});
test('New board edits one dedicated drawing buffer and Save carries stable terminal identities', async () => {
  const api = server(); const view = setup({ definitionId: null, revisionNumber: null }); const name = await screen.findByLabelText('Board name'); fireEvent.change(name, { target: { value: 'Synthetic scratch board' } });
  fireEvent.change(screen.getByLabelText('Pad label'), { target: { value: 'Signal' } }); fireEvent.click(screen.getByRole('button', { name: 'Add pad to board' })); const pad = await screen.findByRole('button', { name: 'Pad Signal' }); fireEvent.click(pad);
  fireEvent.change(screen.getByLabelText('Pad label'), { target: { value: 'Renamed signal' } }); fireEvent.click(screen.getByRole('button', { name: 'Save board' })); await waitFor(() => expect(view.callbacks.onCreated).toHaveBeenCalledWith('board', true));
  expect(api.posts).toHaveLength(1); expect(api.posts[0]?.operation).toBe('interface.create'); expect(api.posts[0]?.payload.interface.terminals[0]).toMatchObject({ terminal_id: 'signal', label: 'Renamed signal' });
  expect(screen.queryByLabelText('Definition')).toBeNull(); expect(screen.queryByText('PCB intake')).toBeNull();
});
test('viewer can inspect historic pads but has no creation, continuation, save or freeze actions', async () => {
  const api = server(); setup({}, ['workspace.read']); const drawing = await screen.findByRole('group', { name: 'Synthetic board drawing' }); fireEvent.click(within(drawing).getByRole('button', { name: 'Pad Historic contact' }));
  expect(screen.queryByRole('button', { name: 'Duplicate' })).toBeNull(); expect(screen.queryByRole('button', { name: 'Continue draft' })).toBeNull(); expect(screen.queryByRole('button', { name: 'Save board' })).toBeNull(); expect(screen.queryByRole('button', { name: 'Draw path' })).toBeNull(); expect(screen.getByLabelText('Pad label').matches(':disabled')).toBe(true); expect(api.posts).toHaveLength(0);
});
