import { MantineProvider } from '@mantine/core';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { CableEditor, CableInspector, CablePanel } from './CablePanel';
import { initialCable, type Cable } from './api';
import { PermissionsProvider } from '../../lib/permissions';
import { unknownElectrical, unknownOrientation } from '../interfaces/api';
import { createMemoryHistory } from "@tanstack/react-router";
import { NavigationProvider, useNavigation } from "../navigation";
import { ProbeProvider } from '../probe';

beforeEach(() => vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} }));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
function wrap(children: React.ReactNode, cache = new QueryClient({ defaultOptions: { queries: { retry: false } } })) {
  return <MantineProvider><QueryClientProvider client={cache}>{children}</QueryClientProvider></MantineProvider>;
}
const body = { kind: 'connector_body', family: null, mating_role: 'unknown', drawing_orientation: unknownOrientation(), contacts: ['one', 'two', 'key'].map(contact_id => ({ contact_id, physical_role: contact_id === 'key' ? 'key' : 'contact', label: '', position_mm: null })) };
const pinout = { kind: 'pinout', body_revision_id: 'body-rev', assignments: [{ contact_id: 'one', electrical: unknownElectrical() }], review: 'unreviewed', review_basis: null, orientation: unknownOrientation() };
const stock = { structure: { id: 'stock', kind: 'group', children: [{ id: 'core', kind: 'conductor', label: 'Core' }, { id: 'screen', kind: 'shield', label: 'Screen' }, { id: 'jacket', kind: 'jacket', label: 'Jacket' }] } };
// What the server resolves for a one-connector stack on the synthetic body.
const resolvedStack = () => ({ layers: [{ layer_id: 'connector', kind: 'connector', name: 'Synthetic body r1', variant_label: null, terminals: ['one', 'two'].map(id => ({ terminal_id: id, label: id, kind: 'contact', signal: null, signal_status: 'unknown', reaches: [] })) }],
  joins: [], connector_layer_id: 'connector', body_revision_id: 'body-rev', pinout_revision_id: 'pinout-rev', evaluation: [], continuity: 'not_evaluated' });
const isResolve = (url: string) => url.includes('end-stacks/resolve');
function connectorEnds(cable: Cable) {
  cable.endpoints.forEach(e => { e.stack = { layers: [{ kind: 'connector', layer_id: 'connector', body_revision_id: 'body-rev', pinout_revision_id: 'pinout-rev' }], joins: [] }; });
}
const land = (endpoint_id: string, element_path: string, terminal_id: string, basis: string) => ({ endpoint_id, element_path, layer_id: 'connector', terminal_id, basis });
function inspected(cable: Cable) {
  return { revision_id: 'cable-rev', cable, continuity: 'not_evaluated', compatibility: 'not_evaluated', physical_qualification: 'not_evaluated',
    conductors: ['core', 'screen'].map(id => ({ element_path: `stock.${id}`, kind: id === 'core' ? 'conductor' : 'shield', ends: cable.endpoints.map(e => ({ endpoint_id: e.local_id, assignment: cable.assignments.find(a => a.element_path === `stock.${id}` && a.endpoint_id === e.local_id) ?? null })) })),
    endpoints: cable.endpoints.map(e => ({ ...e, body, pinout, body_revision_id: 'body-rev', pinout_revision_id: 'pinout-rev' })) };
}
// The workbench keeps detail forms in inspector tabs: open the tab that holds a field first.
const benchEl = (mode?: string) => document.querySelector<HTMLElement>(mode ? `.cwb[data-mode="${mode}"]` : '.cwb[data-mode="new"], .cwb[data-mode="draft"]');
function openTab(label: string, mode?: string) {
  const bench = benchEl(mode);
  if (bench) fireEvent.click(within(bench).getByRole('radio', { name: label }));
}
function tabFor(label: string) {
  const end = /^Endpoint (\d+)/.exec(label);
  if (end) openTab(`End ${'AB'[Number(end[1]) - 1]}`);
  else if (/^(Stock|Intent)\b/.test(label)) openTab('Cable');
}
async function paste(label: string, value: string) {
  tabFor(label);
  // A new cable starts with each end unchosen; the connector pickers appear once the end is built here.
  const end = /^Endpoint (\d+) (body|pinout)$/.exec(label);
  if (end && !screen.queryByRole('button', { name: `Advanced: paste exact revision ID for ${label}` })) fireEvent.click(screen.getAllByLabelText('Build this end here')[Number(end[1]) - 1]!);
  fireEvent.click(screen.getByRole('button', { name: `Advanced: paste exact revision ID for ${label}` }));
  fireEvent.change(await screen.findByLabelText(`${label} exact revision ID`), { target: { value } });
}
async function select(label: string, option: string) {
  tabFor(label);
  const field = await screen.findByRole('combobox', { name: label });
  await waitFor(() => expect((field as HTMLInputElement).disabled).toBe(false));
  fireEvent.focus(field); fireEvent.keyDown(field, { key: 'ArrowDown' });
  // The listbox is the one labeled by this field's label element.
  const listbox = () => document.querySelector<HTMLElement>(`[role="listbox"][aria-labelledby="${document.querySelector(`label[for="${field.id}"]`)?.id}"]`);
  fireEvent.click(await within(await waitFor(() => { const box = listbox(); expect(box).toBeTruthy(); return box!; })).findByText(option));
}

// Complete authoring with searchable selectors and three commands needs a bounded CI allowance.
test('compose two ends, save with token, freeze and inspect unchanged conductor identity', async () => {
  const commands: { operation: string; expected_state: string; payload: { cable?: Cable } }[] = [];
  let cable = initialCable(); let state = 'draft-v1';
  const draft = () => ({ definition_id: 'cable', draft_id: 'draft', state, content: { cable } });
  vi.stubGlobal('fetch', vi.fn(async (url: string, options?: RequestInit) => {
    let data: unknown;
    if (isResolve(url)) data = resolvedStack();
    else if (options?.method === 'POST') {
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
  fireEvent.change(screen.getByLabelText('Cable name'), { target: { value: 'Synthetic cable' } });
  await paste('Stock', 'stock-rev');
  for (const index of [1, 2]) {
    await paste(`Endpoint ${index} body`, 'body-rev');
    await paste(`Endpoint ${index} pinout`, 'pinout-rev');
    fireEvent.change(await screen.findByLabelText(`Endpoint ${index} stock.core termination basis`), { target: { value: 'Synthetic table' } });
    await select(`Endpoint ${index} stock.core target`, index === 1 ? 'one' : 'two');
  }
  fireEvent.click(screen.getByLabelText('Record independent cable lengths'));
  fireEvent.change(screen.getByLabelText('Route declared mm'), { target: { value: '1000.000001' } });
  fireEvent.change(screen.getByLabelText('Route declaration basis'), { target: { value: 'Synthetic route' } });
  fireEvent.click(screen.getByText('Create cable draft'));
  const heading = await screen.findByText('Edit draft');
  const editor = within(heading.closest('.cwb')! as HTMLElement);
  fireEvent.change(editor.getByLabelText('Review basis'), { target: { value: 'Independent review' } });
  expect((editor.getByLabelText('Route declared mm') as HTMLInputElement).value).toBe('1000.000001');
  fireEvent.change(editor.getByLabelText('Route declared mm'), { target: { value: '1100.000001' } });
  fireEvent.click(editor.getByText('Save cable draft'));
  await screen.findByText('draft-v2');
  fireEvent.click(screen.getByText('Freeze cable revision'));
  await screen.findAllByText('cable-rev', { selector: 'code' });
  expect(commands[0]).toMatchObject({ operation: 'cable.create', payload: { project_id: 'project', cable: { stock_revision_id: 'stock-rev', assignments: [{ endpoint_id: 'a', element_path: 'stock.core', layer_id: 'connector', terminal_id: 'one' }, { endpoint_id: 'b', element_path: 'stock.core', layer_id: 'connector', terminal_id: 'two' }] } } });
  expect(commands[1]).toMatchObject({ operation: 'cable.update', expected_state: 'draft-v1', payload: { cable: { lengths: { route: { amount_mm: '1100.000001' } } } } });
  expect(commands[2]).toMatchObject({ operation: 'cable.freeze', expected_state: 'draft-v2' });
  expect(await screen.findByText('stock.core · conductor')).toBeTruthy();
  // The draft and the new frozen revision share one workbench with a toggle, not two stacked benches.
  expect(screen.getByRole('radio', { name: 'Draft (editing)' })).toBeTruthy();
  expect(screen.getAllByRole('heading', { name: 'Edit draft' })).toHaveLength(1);
  expect(screen.queryByRole('heading', { name: 'Frozen cable' })).toBeNull();
  fireEvent.click(screen.getByRole('radio', { name: 'Frozen r1' }));
  expect((await screen.findAllByRole('heading', { name: 'Frozen cable' })).length).toBeGreaterThan(0);
  expect(screen.queryByRole('heading', { name: 'Edit draft' })).toBeNull();
  expect(screen.getAllByText('unknown / unassigned')).toHaveLength(2);
  expect(screen.getAllByText('unknown to unknown').length).toBeGreaterThan(0);
});

test('inaccessible frozen cable reveals no assignments or pins', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: { message: 'Project not found.' } }), { status: 404 })));
  render(wrap(<CableInspector revisionId="restricted" />));
  expect(await screen.findByText('Project not found.')).toBeTruthy();
  expect(screen.queryByRole('table')).toBeNull();
});

test('a stack the server rejects (pinout of another body) blocks choosing any terminal', async () => {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => isResolve(url)
    ? new Response(JSON.stringify({ error: { code: 'validation_failed', message: "A connector layer's pinout must pin its exact body revision." } }), { status: 422 })
    : new Response(JSON.stringify(url.includes('interfaces/revisions/body') ? { interface: body } : url.includes('/snapshot') ? { content: { stock } } : []), { status: 200 })));
  render(wrap(<CablePanel projectId="project" />));
  await paste('Stock', 'stock-rev');
  await paste('Endpoint 1 body', 'body-rev');
  await paste('Endpoint 1 pinout', 'pinout-rev');
  expect(await screen.findByText("A connector layer's pinout must pin its exact body revision.")).toBeTruthy();
  const contact = await screen.findByRole('combobox', { name: 'Endpoint 1 stock.core target' });
  // An unresolvable stack offers no terminal to land on.
  expect((contact as HTMLInputElement).disabled).toBe(true);
});

async function openRetainedDraft(permissions?: string[]) {
  const cable = initialCable();
  cable.stock_revision_id = 'stock-rev';
  connectorEnds(cable);
  cable.lengths = { route: { amount_mm: '1234', basis: 'human_declaration', explanation: 'Private route basis' }, finished: { declaration: { amount_mm: null, basis: 'unknown', explanation: null }, model: null }, stock_cut: { declaration: { amount_mm: null, basis: 'unknown', explanation: null }, model: null }, conductor_cuts: [] };
  cable.assignments = [land('a', 'stock.core', 'one', 'Private assignment basis')];
  const cache = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  let deniedPath = '';
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (deniedPath && url.includes(deniedPath)) return new Response(JSON.stringify({ error: { message: 'Current access denied.' } }), { status: 404 });
    const data = isResolve(url) ? resolvedStack() : url.includes('cables/drafts') ? { definition_id: 'cable', draft_id: 'draft', state: 'draft-v1', content: { cable } }
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
  await screen.findByDisplayValue('Private assignment basis');
  const heading = screen.getByText('Edit draft');
  const editor = within(heading.closest('.cwb')! as HTMLElement);
  openTab('End A', 'draft');
  await waitFor(() => expect(cache.getQueriesData({ queryKey: ['cable-end-resolve'] }).some(([, data]) => !!data)).toBe(true));
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
  expect(screen.queryByDisplayValue('Private assignment basis')).toBeNull();
  expect(screen.queryByDisplayValue('Private route basis')).toBeNull();
  expect(screen.queryByRole('button', { name: 'Save cable draft' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Freeze cable revision' })).toBeNull();
  if (_name !== 'draft') expect(screen.queryByRole('combobox', { name: 'Inspect frozen cable' })).toBeNull();
  if (_name === 'definitions') {
    const definition = screen.getByRole('combobox', { name: 'Existing cable definition' }) as HTMLInputElement;
    expect(definition.disabled).toBe(true);
    expect(definition.value).toBe('');
    // Creating is reached through "New cable"; while a definition is open no create control is offered.
    const create = screen.queryByRole('button', { name: 'Create cable draft' }) as HTMLButtonElement | null;
    expect(!create || create.disabled).toBe(true);
  }
});

test.each([
  ['stock', '/snapshot', ['cable-stock', 'stock-rev']],
  ['body', 'interfaces/revisions/body-rev', ['cable-body', 'body-rev']],
  ['end stack', 'end-stacks/resolve', ['cable-end-resolve']],
])('%s denial after successful read removes assignments and cached source choices', async (_name, path, key) => {
  const { cache, editor, deny } = await openRetainedDraft();
  fireEvent.change(editor.getByLabelText('Endpoint 1 stock.screen termination basis'), { target: { value: 'New declaration' } });
  const contact = editor.getByRole('combobox', { name: 'Endpoint 1 stock.screen target' });
  fireEvent.focus(contact); fireEvent.keyDown(contact, { key: 'ArrowDown' });
  expect(screen.queryByRole('option', { name: 'key' })).toBeNull();
  fireEvent.click(await within(screen.getAllByRole('listbox', { name: 'Endpoint 1 stock.screen target', hidden: true }).at(-1)!).findByText('two'));
  expect((contact as HTMLInputElement).value).toBe('two');
  expect(editor.getByDisplayValue('New declaration')).toBeTruthy();
  deny(path);
  await act(async () => { await cache.refetchQueries({ queryKey: key }); });
  expect((await screen.findAllByText('Current access denied.')).length).toBeGreaterThan(0);
  expect(screen.queryByDisplayValue('Private assignment basis')).toBeNull();
  expect(screen.queryByDisplayValue('Private route basis')).toBeNull();
  // The termination rows and their retained choices are withdrawn with the denied source.
  expect(screen.queryByRole('combobox', { name: 'Endpoint 1 stock.screen target' })).toBeNull();
  expect(screen.queryByDisplayValue('New declaration')).toBeNull();
  for (const name of ['Save cable draft', 'Freeze cable revision']) expect((screen.getByRole('button', { name }) as HTMLButtonElement).disabled).toBe(true);
  expect(screen.queryByRole('combobox', { name: 'Endpoint 1 stock.screen target' })).toBeNull();
});

test('a denied reference identity refresh clears its retained revision choices', async () => {
  const cache = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  let denied = false;
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(denied ? { error: { message: 'Reference access denied.' } } : { revisions: [{ revision_id: 'private-stock-rev', number: 1 }] }), { status: denied ? 404 : 200 })));
  render(wrap(<CableEditor value={initialCable()} onChange={vi.fn()} definitions={[{ definition_id: 'stock-definition', name: 'Synthetic stock', kind: 'wire_stock' }]} />, cache));
  await select('Stock definition', 'Synthetic stock');
  await select('Stock revision', 'Revision 1 · latest');
  denied = true;
  await act(async () => { await cache.refetchQueries({ queryKey: ['cable-reference', 'stock-definition', 0] }); });
  expect(await screen.findByText('Reference access denied.')).toBeTruthy();
  expect((screen.getByRole('combobox', { name: 'Stock revision' }) as HTMLInputElement).disabled).toBe(true);
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
    if (isResolve(url)) return new Response(JSON.stringify(resolvedStack()), { status: 200 });
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
  fireEvent.change(screen.getByLabelText('Cable name'), { target: { value: 'Synthetic cable' } });
  await paste('Stock', 'stock-rev');
  for (const index of [1, 2]) {
    await paste(`Endpoint ${index} body`, 'body-rev');
    await paste(`Endpoint ${index} pinout`, 'pinout-rev');
  }
  fireEvent.click(screen.getByLabelText('Record independent cable lengths'));
  fireEvent.change(screen.getByLabelText('Route declared mm'), { target: { value: '1234' } });
  fireEvent.change(screen.getByLabelText('Route declaration basis'), { target: { value: 'Private route basis' } });
  if (operation === 'cable.create') {
    // The new cable's unsaved text is withheld while access is rechecked, then restored.
    fireEvent.change(screen.getByLabelText('Route declared mm'), { target: { value: '888.000001' } });
    denyMutation = true;
    fireEvent.click(screen.getByRole('button', { name: button }));
    const refresh = await screen.findByRole('button', { name: 'Refresh cable access' });
    await waitFor(() => expect((refresh as HTMLButtonElement).disabled).toBe(false));
    expect(screen.queryByDisplayValue('Private route basis')).toBeNull();
    expect(screen.queryByDisplayValue('888.000001')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Create cable draft' })).toBeNull();
    cache.removeQueries({ queryKey: ['cable-stock', 'stock-rev'] });
    fireEvent(window, new Event('focus'));
    await waitFor(() => expect((screen.getByRole('button', { name: 'Refresh cable access' }) as HTMLButtonElement).disabled).toBe(false));
    expect(screen.queryByDisplayValue('888.000001')).toBeNull();
    sourceDenied = false; denyMutation = false;
    fireEvent(window, new Event('focus'));
    await screen.findByRole('button', { name: 'Create cable draft' });
    expect((screen.getByLabelText('Route declared mm') as HTMLInputElement).value).toBe('888.000001');
    expect(commands.filter(c => c.operation === 'cable.create')).toHaveLength(1);
    return;
  }
  fireEvent.click(screen.getByText('Create cable draft'));
  await screen.findByText('Edit draft');
  fireEvent.click(screen.getByText('Freeze cable revision'));
  await screen.findAllByText('cable-rev', { selector: 'code' });
  await screen.findByText('saved-v2');
  const draftEditor = () => within(screen.getByText('Edit draft').closest('.cwb')! as HTMLElement);
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
  expect(screen.getByRole('button', { name: 'Save cable draft' }).getAttribute('title')).toBe(saveOff ? 'Read-only access: requires Edit' : null);
  expect(screen.queryAllByText(/Read-only access: requires Edit/).length > 0).toBe(saveOff);
  fireEvent.click(screen.getByRole('button', { name: 'New cable' }));
  expect((await screen.findByRole('button', { name: 'Create cable draft' })).hasAttribute('data-readonly-reason')).toBe(saveOff);
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
    if (options?.method === 'POST' && String(url).endsWith('/operations')) return new Response(JSON.stringify({ error: { code: 'validation_failed', message: 'Invalid payload.', details: { errors: [{ loc: ['cable', 'endpoints', 0, 'end_assembly_revision_id'], type: 'missing', msg: 'Field required' }] } } }), { status: 422 });
    return new Response(JSON.stringify(isResolve(String(url)) ? resolvedStack() : String(url).includes('/snapshot') ? { content: { stock } } : String(url).endsWith('/definitions') ? [] : {}), { status: 200 });
  }));
  render(wrap(<PermissionsProvider permissions={['item.create']}><CablePanel projectId="project" /></PermissionsProvider>));
  fireEvent.change(await screen.findByLabelText('Cable name'), { target: { value: 'Lead' } });
  await paste('Stock', 'stock-rev');
  fireEvent.click(screen.getAllByLabelText('Reusable end assembly')[0]!); await paste('Endpoint 1 end assembly', 'assembly-a');
  fireEvent.click(screen.getAllByLabelText('Reusable end assembly')[1]!); await paste('Endpoint 2 end assembly', 'assembly-b');
  fireEvent.click(screen.getByRole('button', { name: 'Create cable draft' }));
  expect(await screen.findByText(/Invalid payload\. endpoints #1 end assembly revision: Field required/)).toBeTruthy();
  await waitFor(() => expect(screen.getByLabelText('Endpoint 1 end assembly exact revision ID').getAttribute('aria-invalid')).toBe('true'));
});

test('the editor leads with a cable summary: both ends, the stock and termination counts', async () => {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => new Response(JSON.stringify(isResolve(url) ? resolvedStack() : url.includes('/snapshot') ? { content: { stock } } : url.includes('interfaces/revisions/body') ? { interface: body } : { labels: [], source_labels: [] }), { status: 200 })));
  const cable = initialCable();
  cable.stock_revision_id = 'stock-rev';
  connectorEnds(cable);
  cable.endpoints[0]!.label = 'Plug';
  cable.endpoints[0]!.stock_end = 'a';
  cable.assignments = [land('a', 'stock.core', 'one', 'Synthetic')];
  render(wrap(<CableEditor value={cable} onChange={vi.fn()} definitions={[]} />));
  const summary = screen.getByLabelText('Cable summary');
  expect(within(summary).getByText('Plug')).toBeTruthy();
  expect(within(summary).getByText('End B')).toBeTruthy();
  expect(within(summary).getByText(/Length/)).toBeTruthy();
  await waitFor(() => expect(within(summary).getByTestId('terminated-a').textContent).toBe('1 of 2 terminated'));
  // Each end reads as its layer stack once resolved, with the stock end it uses.
  expect(within(summary).getByText('Stock end A')).toBeTruthy();
  expect(await within(summary).findByRole('list', { name: 'Plug layers' })).toBeTruthy();
  expect(screen.queryByLabelText('Stock exact revision ID')).toBeNull();
});

test('a new cable starts with both ends unchosen and names the missing piece instead of sending a raw UUID error', async () => {
  const fetchMock = vi.fn(async (url: string) => new Response(JSON.stringify(String(url).endsWith('/definitions') ? [] : {}), { status: 200 }));
  vi.stubGlobal('fetch', fetchMock);
  render(wrap(<PermissionsProvider permissions={['item.create']}><CablePanel projectId="project" /></PermissionsProvider>));
  fireEvent.change(await screen.findByLabelText('Cable name'), { target: { value: 'Lead' } });
  expect(screen.getAllByText('Choose an end assembly or build this end.')).toHaveLength(2);
  await paste('Stock', 'stock-rev');
  fireEvent.click(screen.getByRole('button', { name: 'Create cable draft' }));
  expect(await screen.findByText('End A: choose an end assembly or build this end.')).toBeTruthy();
  expect(screen.getByText('End B: choose an end assembly or build this end.')).toBeTruthy();
  expect(fetchMock.mock.calls.some(call => (call as unknown[])[1] && ((call as unknown[])[1] as RequestInit).method === 'POST')).toBe(false);
  fireEvent.click(screen.getAllByLabelText('Build this end here')[1]!);
  fireEvent.click(screen.getByRole('button', { name: 'Create cable draft' }));
  expect(await screen.findByText('End B: choose a connector body.')).toBeTruthy();
  expect(screen.getByText('End B: choose a connector pinout variant.')).toBeTruthy();
});


test('reopening exact cable A after a manual B selection restores A without clearing B on a rail switch', async () => {
  Element.prototype.scrollIntoView = vi.fn();
  const definitions = ['a', 'b'].map(id => ({ definition_id: id, name: `Synthetic cable ${id.toUpperCase()}`, kind: 'cable' }));
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    let data: unknown;
    if (url.includes('catalog/definitions/')) {
      const id = /definitions\/([^?]+)/.exec(url)![1]!;
      data = { ...definitions.find(row => row.definition_id === id), drafts: [{ draft_id: `draft-${id}`, state: `state-${id}` }], revisions: [{ revision_id: `${id}-r1`, number: 1 }, { revision_id: `${id}-r2`, number: 2 }] };
    } else if (url.includes('cables/drafts/')) data = { definition_id: 'b', draft_id: 'draft-b', state: 'state-b', content: { cable: initialCable() } };
    else if (url.includes('cables/revisions/')) data = inspected({ ...initialCable(), stock_revision_id: '' });
    else if (url.includes('revision-labels')) data = { labels: [], source_labels: [] };
    else data = definitions;
    return new Response(JSON.stringify(data), { status: 200 });
  }));
  const history = createMemoryHistory({ initialEntries: ['/designs/a@1'] });
  function RetainedCable() {
    const navigation = useNavigation()!;
    return <ProbeProvider probe={navigation.location.probe} onProbe={() => {}}>
      <button onClick={() => navigation.navigate({ area: 'history', lens: 'history', probe: null })}>Open History rail</button>
      <button onClick={() => navigation.navigate({ area: 'designs', lens: 'cables', probe: { object: 'a', rev: 1, path: [] } })}>Reopen exact cable A</button>
      <div hidden={navigation.location.lens === 'history'}><CablePanel /></div>
    </ProbeProvider>;
  }
  render(wrap(<NavigationProvider history={history}><RetainedCable /></NavigationProvider>));
  const definition = () => screen.getByRole('combobox', { name: 'Existing cable definition' }) as HTMLInputElement;
  await waitFor(() => expect(definition().value).toBe('Synthetic cable A (cable)'));
  await waitFor(() => expect((screen.getByRole('combobox', { name: 'Inspect frozen cable' }) as HTMLInputElement).value).toBe('Synthetic cable A · r1'));
  await select('Existing cable definition', 'Synthetic cable B (cable)');
  await select('Edit cable draft', 'draft-b · state-b');
  await screen.findByText('Edit draft'); openTab('Cable', 'draft');
  fireEvent.change(screen.getByLabelText('Review basis'), { target: { value: 'Retained unsaved B basis' } });
  fireEvent.click(screen.getByText('Open History rail'));
  await waitFor(() => expect(history.location.pathname).toBe('/history'));
  expect((screen.getByDisplayValue('Retained unsaved B basis') as HTMLInputElement).value).toBe('Retained unsaved B basis');
  fireEvent.click(screen.getByText('Reopen exact cable A'));
  await waitFor(() => expect(definition().value).toBe('Synthetic cable A (cable)'));
  await waitFor(() => expect((screen.getByRole('combobox', { name: 'Inspect frozen cable' }) as HTMLInputElement).value).toBe('Synthetic cable A · r1'));
  expect((screen.getByRole('combobox', { name: 'Edit cable draft' }) as HTMLInputElement).value).toBe('');
});
