import { MantineProvider } from '@mantine/core';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { PermissionsProvider } from '../../lib/permissions';
import { PartRecordPage, type PartRecordProps } from './PartRecordPage';
import { blankKit, blankPart, type Content } from './api';
const reply = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
beforeEach(() => vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} unobserve() {} }));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
function server(kind = 'part', content: Content = blankPart()) {
  const calls: string[] = [], commands: { operation: string; payload: Record<string, unknown>; expected_state: string }[] = [];
  vi.stubGlobal('fetch', vi.fn(async (path: string, options?: RequestInit) => {
    calls.push(path);
    if (path === '/api/v0/operations') {
      const body = JSON.parse(String(options?.body)); commands.push(body);
      if (body.operation === 'facts.resolve_subject') return reply({ result: { subject: null } });
      return reply({ result: { draft_id: 'draft', definition_id: 'created', kind: 'draft', state: 'draft-v5', content: body.payload.changes ?? body.payload.content, base_revision_id: null } });
    }
    if (path.includes('/record?')) return reply({ definition_id: 'selected', workspace_id: 'workspace', kind, name: 'Synthetic selected record', selected: path.includes('working=true') ? { kind: 'draft', draft_id: 'draft', state: 'draft-v4', content, base_revision_id: 'r1' } : { kind: 'revision', revision_id: 'r1', number: 1, snapshot_id: 's1', sha256: 'a'.repeat(64), content } });
    if (path.includes('/catalog/revisions/r1?')) return reply({ variants: [], lots: [], representations: [], source_identifiers: [] });
    if (path.includes('/kits?')) return reply({ results: [{ definition_id: 'kit', name: 'Synthetic kit', revision_id: 'kit-r2', number: 2, lines: [{ local_id: 'line', revision_id: 'r1', quantity: null, note: null }] }], next_after: null });
    if (path.includes('/where-used')) return reply({ revision_id: 'r1', results: [], project_references: [], next_after: null });
    if (path.includes('revision-labels')) return reply({ labels: new URL(path, 'http://synthetic').searchParams.getAll('revision_ids').map(revision_id => ({ revision_id, readable: true, name: 'Synthetic part', number: 1 })) });
    return reply({ labels: [], source_labels: [], results: [], next_after: null });
  })); return { calls, commands };
}
function mount(changes: Partial<PartRecordProps> = {}, permissions = ['workspace.read', 'item.create', 'design.edit', 'design.freeze']) {
  const props: PartRecordProps = { active: true, principalKey: 'owner', workspaceId: 'workspace', definitionId: 'selected', revisionNumber: 1, draftRequested: false, initial: { kind: 'part', content: blankPart() }, projects: [], onCreated: vi.fn(), onSelect: vi.fn(), onBack: vi.fn(), onDuplicate: vi.fn(), onOpenKit: vi.fn(), onOpenInProject: vi.fn(), ...changes };
  const cache = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const tree = (next = props) => <MantineProvider env="test"><QueryClientProvider client={cache}><PermissionsProvider permissions={permissions}><PartRecordPage {...next} /></PermissionsProvider></QueryClientProvider></MantineProvider>;
  const view = render(tree()); return { props, ...view, rerender: (next: Partial<PartRecordProps>) => view.rerender(tree({ ...props, ...next })) };
}
test('new typed part stages value and package locally; save preserves the complete authored object', async () => {
  const api = server(); mount({ definitionId: null, revisionNumber: null, initial: { kind: 'part', content: { ...blankPart(), opaque: { vendor_note: ['synthetic'] } } } });
  fireEvent.change(await screen.findByLabelText('Part name'), { target: { value: 'Synthetic resistor' } });
  fireEvent.change(screen.getByLabelText('Value'), { target: { value: '4k7' } }); fireEvent.change(screen.getByLabelText('Package'), { target: { value: '0603' } });
  expect(api.commands).toHaveLength(0); fireEvent.click(screen.getByRole('button', { name: 'Save draft' })); await screen.findByText('Saved working draft.');
  expect(api.commands[0]).toMatchObject({ operation: 'definition.create', payload: { kind: 'part', name: 'Synthetic resistor', content: { opaque: { vendor_note: ['synthetic'] }, part: { value: '4k7', package: '0603', fits: [] } } } });
});
test('kit addition requires explicit staging and explicit save; blank quantity remains null', async () => {
  const api = server('kit', blankKit()); mount({ revisionNumber: null, draftRequested: true, addRevision: 'part-r7', initial: { kind: 'kit', content: blankKit() } });
  await screen.findByText('Selected part to add'); expect(api.commands).toHaveLength(0);
  fireEvent.click(screen.getByRole('button', { name: 'Add selected part to this buffer' })); await screen.findByLabelText('Line 1 quantity'); expect(api.commands).toHaveLength(0);
  fireEvent.click(screen.getByRole('button', { name: 'Save draft' })); await screen.findByText('Saved working draft.');
  expect(api.commands[0]).toMatchObject({ operation: 'draft.update', expected_state: 'draft-v4', payload: { changes: { kit: { semantics: 'catalog_grouping', lines: [{ revision_id: 'part-r7', quantity: null, note: null }] } } } });
});
test('frozen record uses exact membership, engineering parents and identity; readonly facts lookup never registers', async () => {
  const api = server(); const view = mount(); await screen.findByRole('heading', { name: 'Synthetic selected record' });
  fireEvent.click(screen.getByRole('tab', { name: 'In kits' })); fireEvent.click(await screen.findByRole('button', { name: 'Synthetic kit · r2' })); expect(view.props.onOpenKit).toHaveBeenCalledWith('kit', 2);
  fireEvent.click(screen.getByRole('tab', { name: 'Where used' })); await screen.findByText('Engineering parents');
  fireEvent.click(screen.getByRole('tab', { name: 'Exact identity' })); await screen.findByText('Snapshot ID');
  fireEvent.click(screen.getByRole('tab', { name: 'Facts' })); await screen.findByText('No fact ledger is registered for this selected state.'); expect(api.commands).toEqual([expect.objectContaining({ operation: 'facts.resolve_subject', payload: { target: { kind: 'revision', revision_id: 'r1' } } })]);
  expect(api.calls.some(path => path.includes('/workspace/definitions'))).toBe(false);
});
test('viewer sees authored metadata but cannot save, freeze, stage kit lines or register catalog associations', async () => {
  const api = server(); mount({ revisionNumber: null, draftRequested: true }, ['workspace.read']);
  await screen.findByLabelText('Value'); expect((screen.getByLabelText('Value') as HTMLInputElement).readOnly).toBe(true); expect((screen.getByRole('button', { name: 'Save draft' }) as HTMLButtonElement).disabled).toBe(true); expect((screen.getByRole('button', { name: 'Freeze saved draft' }) as HTMLButtonElement).disabled).toBe(true); expect(api.commands).toHaveLength(0);
});
test('a changed principal clears local part values before the same record is authorized again', async () => {
  server(); const view = mount({ revisionNumber: null, draftRequested: true }); await screen.findByLabelText('Value'); fireEvent.change(screen.getByLabelText('Value'), { target: { value: 'Retained owner buffer' } });
  view.rerender({ revisionNumber: null, draftRequested: true, principalKey: 'another-member' }); await waitFor(() => expect((screen.getByLabelText('Value') as HTMLInputElement).value).toBe(''));
});


test('an exact historic record reads its own selected state without a broader current identity lookup', async () => {
 const api = server('hardware', {legacy_note:'Original hardware declaration'}); mount({revisionNumber:75});
 await screen.findByRole('heading',{name:'Synthetic selected record'}); fireEvent.click(screen.getByRole('tab',{name:'Exact identity'}));
 expect(api.calls.some(path=>path.includes('/record?') && path.includes('revision_number=75'))).toBe(true);
 expect(api.calls.some(path=>path.includes('/catalog/definitions/selected?'))).toBe(false);
 expect(screen.getByText('hardware')).toBeTruthy();
});
test('contributor can create at Library scope while freeze remains unavailable', async () => {
 const api=server(); mount({definitionId:null, revisionNumber:null}, ['workspace.read','item.create']);
 fireEvent.change(await screen.findByLabelText('Part name'),{target:{value:'Synthetic Library part'}}); fireEvent.click(screen.getByRole('button',{name:'Save draft'})); await screen.findByText('Saved working draft.');
 expect(api.commands[0]!.payload).toMatchObject({workspace_id:'workspace',kind:'part',name:'Synthetic Library part'}); expect(api.commands[0]!.payload).not.toHaveProperty('project_id');
 expect((screen.getByRole('button',{name:'Freeze saved draft'}) as HTMLButtonElement).disabled).toBe(true);
});
