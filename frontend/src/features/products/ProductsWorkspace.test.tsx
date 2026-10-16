import { MantineProvider } from '@mantine/core';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { PermissionsProvider } from '../../lib/permissions';
import { FamilyRecord, VariantTable } from './ProductsWorkspace';
import { blankFamily } from './api';
vi.mock('../cables/RevisionPicker', () => ({ RevisionPicker: ({ value, onChange }: { value: string; onChange: (v: string) => void }) => <input aria-label="Variant design choice" value={value} onChange={e => onChange(e.currentTarget.value)} /> }));
const reply = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
beforeEach(() => vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} unobserve() {} }));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
function server() {
  let content = { product_family: blankFamily(), opaque: ['retained'] }, denied = false;
  const calls: string[] = [], commands: { operation: string; payload: Record<string, unknown>; expected_state: string; idempotency_key: string }[] = [];
  vi.stubGlobal('fetch', vi.fn(async (path: string, options?: RequestInit) => {
    calls.push(path);
    if (path === '/api/v0/operations') {
      const body = JSON.parse(String(options?.body));
      if (body.operation === 'products.versions') return reply({ result: { revisions: [{ definition_id: 'family', revision_id: 'r1', name: 'Synthetic family', kind: 'product_family', number: 1, sha256: 'a'.repeat(64) }], drafts: [{ draft_id: 'draft', version: 4, label: 'Working draft v4 · synthetic time' }], next_offset: null } });
      commands.push(body);
      if (body.operation === 'draft.freeze') return reply({ result: { number: 3, draft: { draft_id: 'draft', state: 'draft-v6', content, base_revision_id: 'r3' } } });
      content = body.payload.changes ?? body.payload.content;
      return reply({ result: { draft_id: 'draft', definition_id: 'family', state: 'draft-v5', content, base_revision_id: null } });
    }
    if (path.includes('/record?')) return denied ? reply({ error: { message: 'Current family access unavailable' } }, 403) : reply({ definition_id: 'family', workspace_id: 'workspace', name: 'Synthetic family', kind: 'product_family', selected: path.includes('working=true') ? { kind: 'draft', draft_id: 'draft', state: 'draft-v4', content, base_revision_id: null } : { kind: 'revision', revision_id: 'r1', number: 1, snapshot_id: 's1', sha256: 'a'.repeat(64), content } });
    if (path.includes('revision-labels')) return reply({ labels: new URL(path, 'http://synthetic').searchParams.getAll('revision_ids').map(revision_id => ({ revision_id, readable: !denied, definition_id: 'design', kind: 'cable', name: 'Synthetic cable', number: 2 })) });
    return reply({ results: [], next_after: null });
  })); return { calls, commands, deny: (value: boolean) => { denied = value; } };
}
function mount(changes: Partial<Parameters<typeof FamilyRecord>[0]> = {}, permissions = ['workspace.read', 'item.create', 'design.edit', 'design.freeze']) {
  const props = { active: true, principalKey: 'owner', workspaceId: 'workspace', definitionId: 'family', revisionNumber: null as number | null, draftRequested: true, onCreated: vi.fn(), onSelect: vi.fn(), onBack: vi.fn(), ...changes };
  const cache = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const tree = (next = props) => <MantineProvider env="test"><QueryClientProvider client={cache}><PermissionsProvider permissions={permissions}><FamilyRecord {...next} /></PermissionsProvider></QueryClientProvider></MantineProvider>;
  const view = render(tree()); return { props, ...view, rerender: (next: Partial<typeof props>) => view.rerender(tree({ ...props, ...next })) };
}
test('structured variants stage exact pins with unknown length, then save with CAS and explicitly freeze', async () => {
  const api = server(); const view = mount();
  await screen.findByLabelText('Family number');
  fireEvent.change(screen.getByLabelText('Variant design choice'), { target: { value: 'design-r2' } });
  fireEvent.click(screen.getByRole('button', { name: 'Add exact design variant' }));
  await screen.findByLabelText('Variant variant-1 declared length (mm)');
  expect(api.commands).toHaveLength(0);
  expect((screen.getByRole('button', { name: 'Freeze saved draft' }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: 'Save draft' })); await screen.findByText('Saved working draft.');
  expect(api.commands[0]).toMatchObject({ operation: 'draft.update', expected_state: 'draft-v4', payload: { changes: { opaque: ['retained'], product_family: { variants: [{ design_revision_id: 'design-r2', declared_length_mm: null, options: {} }] } } } });
  fireEvent.click(screen.getByRole('button', { name: 'Freeze saved draft' })); await waitFor(() => expect(view.props.onSelect).toHaveBeenCalledWith(3, false));
  expect(api.commands[1]).toMatchObject({ operation: 'draft.freeze', expected_state: 'draft-v5' });
});
test('authority withdrawal and inactive views retain local buffer and original CAS until recovery', async () => {
  const api = server(); const view = mount(); await screen.findByLabelText('Family number');
  fireEvent.change(screen.getByLabelText('Family number'), { target: { value: 'LOCAL-7' } });
  api.deny(true); fireEvent.click(screen.getByRole('button', { name: 'Refresh access' }));
  await screen.findByText('Family contents withdrawn until current access is confirmed. Local edits are retained.');
  expect(screen.queryByLabelText('Family number')).toBeNull();
  expect((screen.getByRole('button', { name: 'Save draft' }) as HTMLButtonElement).disabled).toBe(true);
  api.deny(false); fireEvent.click(screen.getByRole('button', { name: 'Refresh access' }));
  await waitFor(() => expect((screen.getByLabelText('Family number') as HTMLInputElement).value).toBe('LOCAL-7'));
  view.rerender({ active: false }); expect(screen.queryByLabelText('Family number')).toBeNull();
  view.rerender({ active: true }); await screen.findByLabelText('Family number');
  fireEvent.click(screen.getByRole('button', { name: 'Save draft' })); await screen.findByText('Saved working draft.');
  expect(api.commands[0]!.expected_state).toBe('draft-v4');
});
test('viewer inspects frozen exact family and cannot write; newer draft reads are unnecessary', async () => {
  const api = server(); mount({ revisionNumber: 1, draftRequested: false }, ['workspace.read']);
  await screen.findByLabelText('Family number');
  expect((screen.getByLabelText('Family number') as HTMLInputElement).readOnly).toBe(true);
  expect(screen.queryByRole('button', { name: 'Save draft' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Add exact design variant' })).toBeNull();
  expect(api.calls.filter(path => path.includes('/record?'))).toEqual(['/api/v0/catalog/definitions/family/record?revision_number=1']);
  expect(api.commands).toHaveLength(0);
});
test('principal change clears retained local family edits', async () => {
  server(); const view = mount(); await screen.findByLabelText('Family number');
  fireEvent.change(screen.getByLabelText('Family number'), { target: { value: 'OWNER-LOCAL' } });
  view.rerender({ principalKey: 'viewer' }); await waitFor(() => expect((screen.getByLabelText('Family number') as HTMLInputElement).value).toBe(''));
});
test('lineup has exact family and design links and shows unknown length without inference', () => {
  const exact = { definition_id: 'family', revision_id: 'family-r3', name: 'Synthetic family', kind: 'product_family', number: 3, sha256: 'a'.repeat(64) };
  render(<MantineProvider env="test"><QueryClientProvider client={new QueryClient()}><VariantTable rows={[{ family: exact, family_number: null, selected_options: [{ axis_id: 'a1', axis_label: 'Color', value_id: 'v1', value_label: 'Blue' }], variant: { local_id: 'two', label: 'Second', design_revision_id: 'design-r2', number: null, declared_length_mm: null, options: {}, note: null }, design: { ...exact, definition_id: 'design', revision_id: 'design-r2', name: 'Synthetic cable', kind: 'cable', number: 2 } }]} /></QueryClientProvider></MantineProvider>);
  expect(screen.getByRole('link', { name: 'Synthetic family · r3' }).getAttribute('href')).toBe('/products/families/family@3');
  expect(screen.getByRole('link', { name: 'Synthetic cable · r2' }).getAttribute('href')).toBe('/designs/design@2');
  expect(screen.getByText('Unknown')).toBeTruthy();
  expect(screen.getByText('Color: Blue')).toBeTruthy();
});

test('Family Versions lists readable frozen and working choices without typed IDs', async () => {
  const api = server(); const view = mount({ revisionNumber: 1, draftRequested: false });
  await screen.findByLabelText('Family number'); fireEvent.click(screen.getByRole('button', { name: 'Versions' }));
  await screen.findByRole('button', { name: 'Synthetic family · frozen r1' });
  expect(screen.queryByLabelText('Working draft ID')).toBeNull();
  expect(screen.queryByLabelText('Exact family revision number')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Working draft v4 · synthetic time' }));
  await waitFor(() => expect(view.props.onSelect).toHaveBeenCalledWith(null, true));
  expect(api.commands).toHaveLength(0);
});
