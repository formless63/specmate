import { MantineProvider } from '@mantine/core';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { PermissionsProvider } from '../../lib/permissions';
import { ConnectorRecordPage, type ConnectorRecordProps } from './ConnectorRecordPage';
import { initialInterface } from './api';
vi.mock('../parts/RevisionModels', () => ({ RevisionModels: ({ active, revisionId }: { active: boolean; revisionId: string }) => active ? <p>Exact model revision {revisionId}</p> : null }));
const reply = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
beforeEach(() => vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} unobserve() {} }));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
function server() {
  const calls: string[] = []; let deny = false;
  vi.stubGlobal('fetch', vi.fn(async (path: string) => {
    calls.push(path); if (deny) return reply({ error: { message: 'Authority denied' } }, 403);
    if (path.includes('/workspace/library/')) return reply({ record_id: 'body', label: 'Synthetic body', kind: 'connector_body', latest_revision: 1, latest_revision_id: 'r1' });
    if (path.includes('/catalog/definitions/')) return reply({ definition_id: 'body', revisions: [{ revision_id: 'r1', number: 1 }], drafts: [{ draft_id: 'd1' }] });
    if (path.includes('/interfaces/drafts/')) return reply({ definition_id: 'body', draft_id: 'd1', state: 'draft-v4', content: { interface: initialInterface('connector_body') } });
    if (path.includes('/related?')) return reply({ results: [{ definition_id: 'p1', kind: 'pinout', name: 'Synthetic pinout', revision_id: 'pin-r1', number: 1, body_revision_ids: ['r1'], uses_selected_body_revision: true }], next_after: null });
    if (path.includes('/interfaces/revisions/')) return reply({ definition_id: 'body', revision_id: 'r1', interface: { ...initialInterface('connector_body'), family: 'Frozen family' } });
    return reply({ results: [], labels: [], source_labels: [], next_after: null });
  })); return { calls, deny: (next: boolean) => { deny = next; } };
}
function mount(changes: Partial<ConnectorRecordProps> = {}, permissions = ['workspace.read', 'item.create', 'design.edit', 'design.freeze']) {
  const props: ConnectorRecordProps = { definitionId: 'body', revisionNumber: 1, draftRequested: false, active: true, principalKey: 'owner', workspaceId: 'w1', projects: [], onBack: vi.fn(), onSelect: vi.fn(), onCreated: vi.fn(), onNew: vi.fn(), onOpen: vi.fn(), onOpenInProject: vi.fn(), ...changes };
  const cache = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const tree = (next = props) => <MantineProvider env="test"><QueryClientProvider client={cache}><PermissionsProvider permissions={permissions}><ConnectorRecordPage {...next} /></PermissionsProvider></QueryClientProvider></MantineProvider>;
  const view = render(tree()); return { props, rerender: (next: Partial<ConnectorRecordProps>) => view.rerender(tree({ ...props, ...next })) };
}
test('body opens directly with distinct Pinouts/Device ports and no whole-library request', async () => {
  const api = server(); mount(); await screen.findByRole('heading', { name: 'Synthetic body' });
  expect(screen.getByText('Frozen r1')).toBeTruthy(); expect(screen.getByRole('tab', { name: 'Pinouts' })).toBeTruthy(); expect(screen.getByRole('tab', { name: 'Device ports' })).toBeTruthy();
  expect(screen.queryByLabelText('Existing interface definition')).toBeNull(); expect(api.calls.some(path => path.includes('/workspace/definitions') || path.includes('/related?'))).toBe(false);
  fireEvent.click(screen.getByRole('tab', { name: 'Pinouts' })); await screen.findByRole('button', { name: 'Open Synthetic pinout r1' }); expect(api.calls.filter(path => path.includes('/related?'))).toEqual(['/api/v0/interfaces/revisions/r1/related?limit=20&kind=pinout']);
});
test('new pinout and related port/stack actions retain actual exact pins', async () => {
  server(); const { props } = mount(); await screen.findByRole('tab', { name: 'Pinouts' }); fireEvent.click(screen.getByRole('tab', { name: 'Pinouts' }));
  fireEvent.click(await screen.findByRole('button', { name: 'New pinout variant from body r1' })); expect(props.onNew).toHaveBeenCalledWith('pinout', expect.objectContaining({ body_revision_id: 'r1' }), expect.any(String));
  fireEvent.click(await screen.findByRole('button', { name: 'New device port from Synthetic pinout r1' })); expect(props.onNew).toHaveBeenCalledWith('port', expect.objectContaining({ pinout_revision_id: 'pin-r1' }), expect.any(String));
  fireEvent.click(screen.getByRole('button', { name: 'New end stack from Synthetic pinout r1' })); expect(props.onNew).toHaveBeenCalledWith('end_assembly', expect.objectContaining({ stack: { layers: [expect.objectContaining({ body_revision_id: 'r1', pinout_revision_id: 'pin-r1' })], joins: [] } }), expect.any(String));
});
test('viewer can inspect but cannot save or freeze a new definition', async () => {
  server(); mount({ definitionId: null, revisionNumber: null }, ['workspace.read']);
  const save = await screen.findByRole('button', { name: 'Save connector' }); expect((save as HTMLButtonElement).disabled).toBe(true); expect((screen.getByRole('button', { name: 'Freeze saved connector' }) as HTMLButtonElement).disabled).toBe(true);
});
test('principal replacement clears same-ID unsaved buffer; hidden/reactivated denial fences retained form', async () => {
  const api = server(); const { rerender } = mount({ draftRequested: true, revisionNumber: null });
  const field = await screen.findByLabelText('Body family (blank = unknown)'); fireEvent.change(field, { target: { value: 'Owner local secret' } });
  rerender({ draftRequested: true, revisionNumber: null, principalKey: 'viewer' }); await waitFor(() => expect((screen.getByLabelText('Body family (blank = unknown)') as HTMLInputElement).value).toBe(''));
  rerender({ active: false, draftRequested: true, revisionNumber: null, principalKey: 'viewer' }); api.deny(true); rerender({ active: true, draftRequested: true, revisionNumber: null, principalKey: 'viewer' }); await screen.findByText('Connector unavailable'); expect(screen.queryByRole('textbox', { name: 'Body family (blank = unknown)' })).toBeNull();
});

test('body models pin the selected frozen revision for a viewer and release on hide', async () => {
  const api = server(); const page = mount({}, ['workspace.read']);
  fireEvent.click(await screen.findByRole('tab', { name: /^Model$/ }));
  expect(await screen.findByText('Exact model revision r1')).toBeTruthy();
  page.rerender({ active: false });
  await waitFor(() => expect(screen.queryByText('Exact model revision r1')).toBeNull());
  expect(api.calls.some(path => path.includes('/operations'))).toBe(false);
});
