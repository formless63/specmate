import { MantineProvider } from '@mantine/core';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { PermissionsProvider } from '../../lib/permissions';
import { SecondaryRecordPage, type SecondaryRecordProps } from '../records/SecondaryRecordPage';
import { vocabularyConfig } from './VocabularyLibrary';
import { blankProfile } from '../workshop-profiles/WorkshopProfileFields';
import coax from '../../../../tests/fixtures/wire-stock-coax.json';
const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const owner = ['workspace.read', 'item.create', 'design.edit', 'design.freeze'];
beforeEach(() => { vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} }); Element.prototype.scrollIntoView = vi.fn(); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
function mount(tool: string, changes: Partial<SecondaryRecordProps> = {}, permissions = owner) {
 const props: SecondaryRecordProps = { ...vocabularyConfig(tool), active: true, principalKey: 'owner', workspaceId: 'workspace', definitionId: null, revisionNumber: null, draftRequested: false, onCreated: vi.fn(), onSelect: vi.fn(), onBack: vi.fn(), ...changes };
 render(<MantineProvider env="test"><QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><PermissionsProvider permissions={permissions}><SecondaryRecordPage {...props} /></PermissionsProvider></QueryClientProvider></MantineProvider>);
 return props;
}
test('new signal record saves manual declarations and freezes through the existing interface operation', async () => {
 const commands: any[] = [];
 vi.stubGlobal('fetch', vi.fn(async (_path: string, init?: RequestInit) => { if (init?.method === 'POST') { const body = JSON.parse(String(init.body)); commands.push(body); return reply({ result: body.operation === 'interface.freeze' ? { number: 1, draft: { draft_id: 'draft', state: 'draft-v2', content: commands[0].payload.content } } : { definition_id: 'created', draft_id: 'draft', state: 'draft-v1', content: body.payload.content } }); } return reply({ results: [], labels: [] }); }));
 mount('signals'); await screen.findByRole('textbox', { name: 'Signal set name' });
 fireEvent.change(screen.getByLabelText('Signal set name'), { target: { value: 'Synthetic signal vocabulary' } });
 fireEvent.change(screen.getByLabelText('New signal name'), { target: { value: 'Clock' } }); fireEvent.click(screen.getByRole('button', { name: 'Add signal' }));
 fireEvent.click(screen.getByRole('button', { name: 'Save draft' })); await screen.findByText('Saved working draft.');
 expect(commands[0]).toMatchObject({ operation: 'definition.create', payload: { workspace_id: 'workspace', kind: 'signal_set', content: { interface: { signals: [{ name: 'Clock', type: 'unknown', level: { status: 'unknown' } }] } } } });
 fireEvent.click(screen.getByRole('button', { name: 'Freeze saved draft' })); await waitFor(() => expect(commands[1]).toMatchObject({ operation: 'interface.freeze', expected_state: 'draft-v1', payload: { draft_id: 'draft' } }));
});
test.each(['signals', 'conventions', 'workshop-profiles'])('viewer cannot save or freeze %s records', async tool => {
 vi.stubGlobal('fetch', vi.fn(async () => reply({ results: [], labels: [] })));
 mount(tool, {}, ['workspace.read']); await waitFor(() => expect(screen.getByRole('button', { name: 'Save draft' })).toHaveProperty('disabled', true));
 expect(screen.getByRole('button', { name: 'Freeze saved draft' })).toHaveProperty('disabled', true);
});
test('workshop source denial conceals retained local suggestions and recovery saves with original token', async () => {
 let denied = false; const commands: any[] = [];
 const profile = blankProfile('stock-r1'); profile.foil_visibility = { value: 'hide', basis: 'documented', note: null, source: { kind: 'source_file', bundle_revision_id: 'source-r1', path: 'exact.txt', locator: '', sha256: 'a'.repeat(64), rights: 'Synthetic' } };
 vi.stubGlobal('fetch', vi.fn(async (path: string, init?: RequestInit) => {
  if (init?.method === 'POST') { const body = JSON.parse(String(init.body)); commands.push(body); return reply({ result: { draft_id: 'draft', state: 'draft-v8', content: body.payload.changes } }); }
  if (path.includes('/sources/revisions/')) return denied ? reply({ error: { message: 'Source access withdrawn' } }, 403) : reply({ files: [] });
  if (path.includes('/snapshot')) return reply({ content: { stock: coax.stock } });
  if (path.includes('/record?')) return reply({ definition_id: 'profile', workspace_id: 'workspace', name: 'Synthetic profile', kind: 'workshop_profile', selected: { kind: 'draft', draft_id: 'draft', state: 'draft-v7', content: { profile } } });
  return reply({ results: [], labels: [] });
 }));
 mount('workshop-profiles', { definitionId: 'profile', draftRequested: true });
 fireEvent.change(await screen.findByLabelText('Illustration lay length mm'), { target: { value: '24' } });
 denied = true; fireEvent(window, new Event('focus')); await screen.findByText('Source access withdrawn');
 expect(screen.queryByRole('textbox', { name: 'Illustration lay length mm' })).toBeNull();
 denied = false; fireEvent.click(screen.getByRole('button', { name: 'Refresh access' })); await waitFor(() => expect(screen.getByRole('textbox', { name: 'Illustration lay length mm' })).toHaveProperty('value', '24'));
 fireEvent.click(screen.getByRole('button', { name: 'Save draft' })); await screen.findByText('Saved working draft.');
 expect(commands[0]).toMatchObject({ operation: 'draft.update', expected_state: 'draft-v7', payload: { changes: { profile: { stock_revision_id: 'stock-r1', illustration_lay_length_mm: { value: 24 } } } } });
});
test('workshop creation requires an exact stock before Save', async () => {
 vi.stubGlobal('fetch', vi.fn(async () => reply({ results: [], labels: [] }))); mount('workshop-profiles');
 fireEvent.change(await screen.findByLabelText('Workshop profile name'), { target: { value: 'Synthetic new practice' } });
 expect(screen.getByRole('button', { name: 'Save draft' })).toHaveProperty('disabled', true);
});
