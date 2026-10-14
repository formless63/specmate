import { MantineProvider } from '@mantine/core';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { CableEditor, CableInspector, CablePanel } from './CablePanel';
import { initialCable, type Cable } from './api';
import { PermissionsProvider } from '../../lib/permissions';
import { unknownElectrical, unknownOrientation } from '../interfaces/api';
import { ProbeProvider } from '../probe';

beforeEach(() => vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} }));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
function wrap(children: React.ReactNode, cache = new QueryClient({ defaultOptions: { queries: { retry: false } } })) {
  return <MantineProvider><QueryClientProvider client={cache}>{children}</QueryClientProvider></MantineProvider>;
}
const body = { kind: 'connector_body', family: null, mating_role: 'unknown', drawing_orientation: unknownOrientation(), contacts: ['one', 'two', 'key'].map(contact_id => ({ contact_id, physical_role: contact_id === 'key' ? 'key' : 'contact', label: '', position_mm: null })) };
const pinout = { kind: 'pinout', body_revision_id: 'body-rev', assignments: [{ contact_id: 'one', electrical: unknownElectrical() }], review: 'unreviewed', review_basis: null, orientation: unknownOrientation() };
const stock = { structure: { id: 'stock', kind: 'group', children: [{ id: 'core', kind: 'conductor', label: 'Core' }, { id: 'screen', kind: 'shield', label: 'Screen' }, { id: 'jacket', kind: 'jacket', label: 'Jacket' }] } };
function inspected(cable: Cable) {
  return { revision_id: 'cable-rev', cable, continuity: 'not_evaluated', compatibility: 'not_evaluated', physical_qualification: 'not_evaluated',
    conductors: ['core', 'screen'].map(id => ({ element_path: `stock.${id}`, kind: id === 'core' ? 'conductor' : 'shield', ends: cable.endpoints.map(e => ({ endpoint_id: e.local_id, assignment: cable.assignments.find(a => a.element_path === `stock.${id}` && a.endpoint_id === e.local_id) ?? null })) })),
    endpoints: cable.endpoints.map(e => ({ ...e, body, pinout })) };
}
async function select(label: string, option: string) {
  const field = await screen.findByRole('combobox', { name: label });
  fireEvent.focus(field); fireEvent.keyDown(field, { key: 'ArrowDown' });
  fireEvent.click(await within(screen.getByRole('listbox', { name: label, hidden: true })).findByText(option));
}

// Complete authoring with searchable selectors and three commands needs a bounded CI allowance.
test('compose two ends, save with token, freeze and inspect unchanged conductor identity', async () => {
  const commands: { operation: string; expected_state: string; payload: { cable?: Cable } }[] = [];
  let cable = initialCable(); let state = 'draft-v1';
  const draft = () => ({ definition_id: 'cable', draft_id: 'draft', state, content: { cable } });
  vi.stubGlobal('fetch', vi.fn(async (url: string, options?: RequestInit) => {
    let data: unknown;
    if (options?.method === 'POST') {
      const cmd = JSON.parse(String(options.body)); commands.push(cmd);
      if (cmd.payload.cable) cable = cmd.payload.cable;
      if (cmd.operation === 'cable.update') state = 'draft-v2';
      data = { result: cmd.operation === 'cable.freeze' ? { revision_id: 'cable-rev' } : draft() };
    } else if (url.includes('cables/drafts')) data = draft();
    else if (url.includes('cables/revisions')) data = inspected(cable);
    else if (url.includes('interfaces/revisions/body-rev')) data = { interface: body };
    else if (url.includes('interfaces/revisions/pinout-rev')) data = { interface: pinout };
    else if (url.includes('/snapshot')) data = { content: { stock } };
    else if (url.includes('catalog/definitions')) data = { drafts: [{ draft_id: 'draft', state }], revisions: [{ revision_id: 'cable-rev', number: 1 }] };
    else data = [{ definition_id: 'cable', name: 'Synthetic cable', kind: 'cable' }];
    return new Response(JSON.stringify(data), { status: 200 });
  }));
  render(wrap(<CablePanel projectId="project" />));
  fireEvent.change(screen.getByLabelText('Definition name'), { target: { value: 'Synthetic cable' } });
  fireEvent.change(screen.getByLabelText('Cable stock exact revision ID'), { target: { value: 'stock-rev' } });
  for (const index of [1, 2]) {
    fireEvent.change(screen.getByLabelText(`Endpoint ${index} body exact revision ID`), { target: { value: 'body-rev' } });
    fireEvent.change(screen.getByLabelText(`Endpoint ${index} pinout exact revision ID`), { target: { value: 'pinout-rev' } });
    await select(`Endpoint ${index} conductive element`, 'stock.core · Core (conductor)');
    await select(`Endpoint ${index} physical contact`, `${index === 1 ? 'one' : 'two'} (contact)`);
    fireEvent.change(screen.getByLabelText(`Endpoint ${index} termination basis`), { target: { value: 'Synthetic table' } });
    fireEvent.click(screen.getByText(`Assign endpoint ${index} terminal`));
  }
  fireEvent.click(screen.getByLabelText('Record independent cable lengths'));
  fireEvent.change(screen.getByLabelText('Route declared mm'), { target: { value: '1000.000001' } });
  fireEvent.change(screen.getByLabelText('Route declaration basis'), { target: { value: 'Synthetic route' } });
  fireEvent.click(screen.getByText('Create cable draft'));
  const heading = await screen.findByText('Edit draft');
  const editor = within(heading.closest('.mantine-Card-root')! as HTMLElement);
  fireEvent.change(editor.getByLabelText('Cable review basis'), { target: { value: 'Independent review' } });
  expect((editor.getByLabelText('Route declared mm') as HTMLInputElement).value).toBe('1000.000001');
  fireEvent.change(editor.getByLabelText('Route declared mm'), { target: { value: '1100.000001' } });
  fireEvent.click(editor.getByText('Save cable draft'));
  await screen.findByText('draft-v2');
  fireEvent.click(screen.getByText('Freeze cable revision'));
  await screen.findAllByText('cable-rev', { selector: 'code' });
  expect(commands[0]).toMatchObject({ operation: 'cable.create', payload: { cable: { stock_revision_id: 'stock-rev', assignments: [{ endpoint_id: 'a', element_path: 'stock.core', contact_id: 'one' }, { endpoint_id: 'b', element_path: 'stock.core', contact_id: 'two' }] } } });
  expect(commands[1]).toMatchObject({ operation: 'cable.update', expected_state: 'draft-v1', payload: { cable: { lengths: { route: { amount_mm: '1100.000001' } } } } });
  expect(commands[2]).toMatchObject({ operation: 'cable.freeze', expected_state: 'draft-v2' });
  expect(await screen.findByText('stock.core · conductor')).toBeTruthy();
  expect(screen.getAllByText('unknown / unassigned')).toHaveLength(2);
  expect(screen.getAllByText('unknown to unknown').length).toBeGreaterThan(0);
});

test('inaccessible frozen cable reveals no assignments or pins', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: { message: 'Project not found.' } }), { status: 404 })));
  render(wrap(<CableInspector revisionId="restricted" />));
  expect(await screen.findByText('Project not found.')).toBeTruthy();
  expect(screen.queryByRole('table')).toBeNull();
});

test('mismatched exact body pin blocks adding a terminal and keys are excluded', async () => {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => new Response(JSON.stringify(url.includes('interfaces/revisions/body') ? { interface: body } : url.includes('interfaces/revisions/pinout') ? { interface: { ...pinout, body_revision_id: 'different-body' } } : url.includes('/snapshot') ? { content: { stock } } : []), { status: 200 })));
  render(wrap(<CablePanel projectId="project" />));
  fireEvent.change(screen.getByLabelText('Cable stock exact revision ID'), { target: { value: 'stock-rev' } });
  fireEvent.change(screen.getByLabelText('Endpoint 1 body exact revision ID'), { target: { value: 'body-rev' } });
  fireEvent.change(screen.getByLabelText('Endpoint 1 pinout exact revision ID'), { target: { value: 'pinout-rev' } });
  expect(await screen.findByText('The pinout must reference this exact body revision.')).toBeTruthy();
  const contact = screen.getByRole('combobox', { name: 'Endpoint 1 physical contact' });
  fireEvent.focus(contact); fireEvent.keyDown(contact, { key: 'ArrowDown' });
  expect(screen.queryByRole('option', { name: 'key (key)' })).toBeNull();
  expect((screen.getByRole('button', { name: 'Assign endpoint 1 terminal' }) as HTMLButtonElement).disabled).toBe(true);
});

async function openRetainedDraft(permissions?: string[]) {
  const cable = initialCable();
  cable.stock_revision_id = 'stock-rev';
  cable.endpoints.forEach(e => { e.body_revision_id = 'body-rev'; e.pinout_revision_id = 'pinout-rev'; });
  cable.lengths = { route: { amount_mm: '1234', basis: 'human_declaration', explanation: 'Private route basis' }, finished: { declaration: { amount_mm: null, basis: 'unknown', explanation: null }, model: null }, stock_cut: { declaration: { amount_mm: null, basis: 'unknown', explanation: null }, model: null }, conductor_cuts: [] };
  cable.assignments = [{ endpoint_id: 'a', element_path: 'stock.core', contact_id: 'one', basis: 'Private assignment basis' }];
  const cache = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  let deniedPath = '';
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (deniedPath && url.includes(deniedPath)) return new Response(JSON.stringify({ error: { message: 'Current access denied.' } }), { status: 404 });
    const data = url.includes('cables/drafts') ? { definition_id: 'cable', draft_id: 'draft', state: 'draft-v1', content: { cable } }
      : url.includes('catalog/definitions') ? { drafts: [{ draft_id: 'draft', state: 'draft-v1' }], revisions: [{ revision_id: 'private-rev', number: 1 }] }
      : url.includes('interfaces/revisions/body-rev') ? { interface: body }
      : url.includes('interfaces/revisions/pinout-rev') ? { interface: pinout }
      : url.includes('/snapshot') ? { content: { stock } }
      : [{ definition_id: 'cable', kind: 'cable', name: 'Private cable' }];
    return new Response(JSON.stringify(data), { status: 200 });
  }));
  render(wrap(<PermissionsProvider permissions={permissions}><CablePanel projectId="project" /></PermissionsProvider>, cache));
  await select('Existing cable definition', 'Private cable (cable)');
  await select('Edit cable draft', 'draft · draft-v1');
  await screen.findByText('stock.core → one · Private assignment basis');
  const heading = screen.getByText('Edit draft');
  const editor = within(heading.closest('.mantine-Card-root')! as HTMLElement);
  await waitFor(() => expect(cache.getQueryData(['cable-pinout', 'pinout-rev'])).toBeTruthy());
  return { cache, editor, deny: (path: string) => { deniedPath = path; } };
}

test.each([
  ['draft', 'cables/drafts', ['cable-draft', 'draft']],
  ['identity', 'catalog/definitions', ['cable-identity', 'cable', 0]],
  ['definitions', 'workspace/definitions', ['cable-definitions', 'project']],
])('%s denial on the same query key hides retained draft and mutation controls', async (_name, path, key) => {
  const { cache, deny } = await openRetainedDraft();
  expect(screen.getByRole('button', { name: 'Freeze cable revision' })).toBeTruthy();
  deny(path as string);
  await act(async () => { await cache.refetchQueries({ queryKey: key as (string | number)[] }); });
  expect(await screen.findByText('Current access denied.')).toBeTruthy();
  expect(screen.queryByText('stock.core → one · Private assignment basis')).toBeNull();
  expect(screen.queryByDisplayValue('Private route basis')).toBeNull();
  expect(screen.queryByRole('button', { name: 'Save cable draft' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Freeze cable revision' })).toBeNull();
  if (_name !== 'draft') expect(screen.queryByRole('combobox', { name: 'Inspect frozen cable' })).toBeNull();
  if (_name === 'definitions') {
    const definition = screen.getByRole('combobox', { name: 'Existing cable definition' }) as HTMLInputElement;
    expect(definition.disabled).toBe(true);
    expect(definition.value).toBe('');
    expect((screen.getByRole('button', { name: 'Create cable draft' }) as HTMLButtonElement).disabled).toBe(true);
  }
});

test.each([
  ['stock', '/snapshot', ['cable-stock', 'stock-rev']],
  ['body', 'interfaces/revisions/body-rev', ['cable-body', 'body-rev']],
  ['pinout', 'interfaces/revisions/pinout-rev', ['cable-pinout', 'pinout-rev']],
])('%s denial after successful read removes assignments and cached source choices', async (_name, path, key) => {
  const { cache, editor, deny } = await openRetainedDraft();
  const conductive = editor.getByRole('combobox', { name: 'Endpoint 1 conductive element' });
  fireEvent.focus(conductive); fireEvent.keyDown(conductive, { key: 'ArrowDown' });
  fireEvent.click(await within(screen.getAllByRole('listbox', { name: 'Endpoint 1 conductive element', hidden: true }).at(-1)!).findByText('stock.screen · Screen (shield)'));
  const contact = editor.getByRole('combobox', { name: 'Endpoint 1 physical contact' });
  fireEvent.focus(contact); fireEvent.keyDown(contact, { key: 'ArrowDown' });
  fireEvent.click(await within(screen.getAllByRole('listbox', { name: 'Endpoint 1 physical contact', hidden: true }).at(-1)!).findByText('two (contact)'));
  fireEvent.change(editor.getByLabelText('Endpoint 1 termination basis'), { target: { value: 'New declaration' } });
  expect((editor.getByRole('button', { name: 'Assign endpoint 1 terminal' }) as HTMLButtonElement).disabled).toBe(false);
  deny(path);
  await act(async () => { await cache.refetchQueries({ queryKey: key }); });
  expect((await screen.findAllByText('Current access denied.')).length).toBeGreaterThan(0);
  expect(screen.queryByText('stock.core → one · Private assignment basis')).toBeNull();
  expect(screen.queryByDisplayValue('Private route basis')).toBeNull();
  for (const input of [conductive, contact] as HTMLInputElement[]) {
    expect(input.disabled).toBe(true);
    expect(input.value).toBe('');
  }
  expect(screen.queryByRole('option', { name: 'stock.screen · Screen (shield)' })).toBeNull();
  for (const name of ['Save cable draft', 'Freeze cable revision']) expect((screen.getByRole('button', { name }) as HTMLButtonElement).disabled).toBe(true);
  expect((editor.getByRole('button', { name: 'Assign endpoint 1 terminal' }) as HTMLButtonElement).disabled).toBe(true);
});

test('a denied reference identity refresh clears its retained revision choices', async () => {
  const cache = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  let denied = false;
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(denied ? { error: { message: 'Reference access denied.' } } : { revisions: [{ revision_id: 'private-stock-rev', number: 1 }] }), { status: denied ? 404 : 200 })));
  render(wrap(<CableEditor value={initialCable()} onChange={vi.fn()} definitions={[{ definition_id: 'stock-definition', name: 'Synthetic stock', kind: 'wire_stock' }]} />, cache));
  await select('Cable stock definition', 'Synthetic stock');
  await select('Cable stock revision', 'Revision 1');
  denied = true;
  await act(async () => { await cache.refetchQueries({ queryKey: ['cable-reference', 'stock-definition', 0] }); });
  expect(await screen.findByText('Reference access denied.')).toBeTruthy();
  expect((screen.getByRole('combobox', { name: 'Cable stock revision' }) as HTMLInputElement).disabled).toBe(true);
  expect(screen.queryByText('Revision 1')).toBeNull();
});

test.each([
  ['cable.create', 'Create cable draft', 403],
  ['cable.update', 'Save cable draft', 404],
  ['cable.freeze', 'Freeze cable revision', 403],
])('%s denial hides retained content and focus restores unsaved text with its original CAS token', async (operation, button, status) => {
  let serverCable = initialCable();
  let state = 'saved-v1';
  let denyMutation = false;
  let sourceDenied = false;
  let restored = false;
  const commands: { operation: string; expected_state?: string; payload: { cable?: Cable } }[] = [];
  const savedDraft = () => ({ definition_id: 'cable', draft_id: 'draft', state, content: { cable: serverCable } });
  vi.stubGlobal('fetch', vi.fn(async (url: string, options?: RequestInit) => {
    if (options?.method === 'POST') {
      const cmd = JSON.parse(String(options.body)); commands.push(cmd);
      if (denyMutation && cmd.operation === operation) {
        sourceDenied = true;
        return new Response(JSON.stringify({ error: { message: 'Mutation source access denied.' } }), { status });
      }
      if (restored && cmd.operation === 'cable.update') {
        return new Response(JSON.stringify({ error: { message: 'Original editing token conflicts with newer draft.' } }), { status: 409 });
      }
      if (cmd.payload.cable) serverCable = cmd.payload.cable;
      if (cmd.operation === 'cable.freeze') state = 'saved-v2';
      return new Response(JSON.stringify({ result: cmd.operation === 'cable.freeze' ? { revision_id: 'cable-rev', draft: savedDraft() } : savedDraft() }), { status: 200 });
    }
    if (sourceDenied && url.includes('/snapshot')) return new Response(JSON.stringify({ error: { message: 'Stock source access denied.' } }), { status: 404 });
    const data = url.includes('cables/drafts') ? savedDraft()
      : url.includes('cables/revisions') ? inspected(serverCable)
      : url.includes('interfaces/revisions/body-rev') ? { interface: body }
      : url.includes('interfaces/revisions/pinout-rev') ? { interface: pinout }
      : url.includes('/snapshot') ? { content: { stock } }
      : url.includes('catalog/definitions') ? { drafts: [{ draft_id: 'draft', state }], revisions: [{ revision_id: 'cable-rev', number: 1 }] }
      : [{ definition_id: 'cable', name: 'Synthetic cable', kind: 'cable' }];
    return new Response(JSON.stringify(data), { status: 200 });
  }));
  const cache = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(wrap(<CablePanel projectId="project" />, cache));
  fireEvent.change(screen.getByLabelText('Definition name'), { target: { value: 'Synthetic cable' } });
  fireEvent.change(screen.getByLabelText('Cable stock exact revision ID'), { target: { value: 'stock-rev' } });
  for (const index of [1, 2]) {
    fireEvent.change(screen.getByLabelText(`Endpoint ${index} body exact revision ID`), { target: { value: 'body-rev' } });
    fireEvent.change(screen.getByLabelText(`Endpoint ${index} pinout exact revision ID`), { target: { value: 'pinout-rev' } });
  }
  fireEvent.click(screen.getByLabelText('Record independent cable lengths'));
  fireEvent.change(screen.getByLabelText('Route declared mm'), { target: { value: '1234' } });
  fireEvent.change(screen.getByLabelText('Route declaration basis'), { target: { value: 'Private route basis' } });
  fireEvent.click(screen.getByText('Create cable draft'));
  await screen.findByText('Edit draft');
  fireEvent.click(screen.getByText('Freeze cable revision'));
  await screen.findAllByText('cable-rev', { selector: 'code' });
  await screen.findByText('saved-v2');
  const createEditor = () => within(screen.getByText('New reusable definition').closest('.mantine-Card-root')! as HTMLElement);
  const draftEditor = () => within(screen.getByText('Edit draft').closest('.mantine-Card-root')! as HTMLElement);
  fireEvent.change(createEditor().getByLabelText('Route declared mm'), { target: { value: '888.000001' } });
  fireEvent.change(draftEditor().getByLabelText('Route declared mm'), { target: { value: '777.000001' } });
  denyMutation = true;
  fireEvent.click(screen.getByRole('button', { name: button }));
  const refresh = await screen.findByRole('button', { name: 'Refresh cable access' });
  await waitFor(() => expect((refresh as HTMLButtonElement).disabled).toBe(false));
  expect(screen.queryByDisplayValue('Private route basis')).toBeNull();
  expect(screen.queryByDisplayValue('777.000001')).toBeNull();
  expect(screen.queryByDisplayValue('stock-rev')).toBeNull();
  expect(screen.queryAllByText('cable-rev', { selector: 'code' })).toHaveLength(0);
  expect(screen.queryByRole('button', { name: 'Save cable draft' })).toBeNull();
  // A long-lived denial may garbage-collect hidden source queries. Their original
  // read functions must still be rechecked before revealing the retained editor.
  cache.removeQueries({ queryKey: ['cable-stock', 'stock-rev'] });
  fireEvent(window, new Event('focus'));
  await waitFor(() => expect((screen.getByRole('button', { name: 'Refresh cable access' }) as HTMLButtonElement).disabled).toBe(false));
  expect(screen.queryByDisplayValue('777.000001')).toBeNull();
  sourceDenied = false; denyMutation = false; restored = true; state = 'server-newer';
  fireEvent(window, new Event('focus'));
  await screen.findByText('Edit draft');
  expect((createEditor().getByLabelText('Route declared mm') as HTMLInputElement).value).toBe('888.000001');
  expect((draftEditor().getByLabelText('Route declared mm') as HTMLInputElement).value).toBe('777.000001');
  expect(draftEditor().getByText('saved-v2')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Save cable draft' }));
  await screen.findByText('Original editing token conflicts with newer draft.');
  expect(commands.at(-1)).toMatchObject({ operation: 'cable.update', expected_state: 'saved-v2', payload: { cable: { lengths: { route: { amount_mm: '777.000001' } } } } });
  expect((draftEditor().getByLabelText('Route declared mm') as HTMLInputElement).value).toBe('777.000001');
});

test.each([
  ['read-only', ['workspace.read'], true, true],
  ['editor without freeze', ['workspace.read', 'item.create', 'design.edit'], false, true],
  ['editor with freeze', ['workspace.read', 'item.create', 'design.edit', 'design.freeze'], false, false],
] as const)('%s permissions gate cable create, save and freeze controls', async (_name, permissions, saveOff, freezeOff) => {
  await openRetainedDraft([...permissions]);
  const disabled = (name: string) => (screen.getByRole('button', { name }) as HTMLButtonElement).disabled;
  expect(disabled('Save cable draft')).toBe(saveOff);
  expect(disabled('Freeze cable revision')).toBe(freezeOff);
  expect(screen.getByRole('button', { name: 'Create cable draft' }).hasAttribute('data-readonly-reason')).toBe(saveOff);
  expect(screen.getByRole('button', { name: 'Save cable draft' }).getAttribute('title')).toBe(saveOff ? 'Read-only access: requires Edit' : null);
  expect(screen.queryAllByText(/Read-only access: requires Edit/).length > 0).toBe(saveOff);
});

test('a probe on a cable revision selects that definition and shows its views once, in the library row', async () => {
  const cable = { ...initialCable(), stock_revision_id: 'stock-rev' };
  const urls: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    urls.push(url);
    let data: unknown;
    if (url.includes('cables/revisions')) data = inspected(cable);
    else if (url.includes('/snapshot')) data = { content: { stock } };
    else if (url.includes('catalog/definitions/cable')) data = { definition_id: 'cable', name: 'Synthetic cable', kind: 'cable', drafts: [], revisions: [{ revision_id: 'cable-r1', number: 1 }, { revision_id: 'cable-r2', number: 2 }] };
    else if (url.includes('revision-labels')) data = { labels: [], source_labels: [] };
    else data = [{ definition_id: 'cable', name: 'Synthetic cable', kind: 'cable' }];
    return new Response(JSON.stringify(data), { status: 200 });
  }));
  render(wrap(<ProbeProvider probe={{ object: 'cable', rev: 1, path: [] }} onProbe={() => {}}><CablePanel projectId="project" /></ProbeProvider>));
  // The Library row owns the views for the probed definition; the panel points to it instead of repeating them.
  expect(await screen.findByTestId('views-shown-above')).toBeTruthy();
  expect(screen.queryByText('Frozen cable inspection')).toBeNull();
  expect(screen.queryByLabelText('Cable section drawing')).toBeNull();
  expect(urls.some(url => url.includes('cables/revisions/'))).toBe(false);
});

test('validation details from a rejected create appear on the offending fields', async () => {
  vi.stubGlobal('fetch', vi.fn(async (url: string, options?: RequestInit) => {
    if (options?.method === 'POST') return new Response(JSON.stringify({ error: { code: 'validation_failed', message: 'Invalid payload.', details: { errors: [{ loc: ['cable', 'stock_revision_id'], type: 'missing', msg: 'Field required' }] } } }), { status: 422 });
    return new Response(JSON.stringify(String(url).endsWith('/definitions') ? [] : {}), { status: 200 });
  }));
  render(wrap(<PermissionsProvider permissions={['item.create']}><CablePanel projectId="project" /></PermissionsProvider>));
  fireEvent.change(await screen.findByLabelText('Definition name'), { target: { value: 'Lead' } });
  fireEvent.click(screen.getByRole('button', { name: 'Create cable draft' }));
  expect(await screen.findByText(/Invalid payload\. stock revision: Field required/)).toBeTruthy();
  expect((await screen.findAllByText('Field required')).length).toBeGreaterThan(0);
});
