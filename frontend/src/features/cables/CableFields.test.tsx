import { MantineProvider } from '@mantine/core';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { useState } from 'react';
import { CableEditor, useCableSources } from './CableFields';
import { CableInspector } from './CableInspector';
import { initialCable, type Cable } from './api';
import { unknownOrientation } from '../interfaces/api';

beforeEach(() => vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} }));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
function wrap(children: React.ReactNode, cache = new QueryClient({ defaultOptions: { queries: { retry: false } } })) {
  return <MantineProvider><QueryClientProvider client={cache}>{children}</QueryClientProvider></MantineProvider>;
}
const body = { kind: 'connector_body', family: null, mating_role: 'unknown', drawing_orientation: unknownOrientation(), contacts: ['one', 'two', 'key'].map(contact_id => ({ contact_id, physical_role: contact_id === 'key' ? 'key' : 'contact', label: '', position_mm: null })) };
const stock = { structure: { id: 'stock', kind: 'group', children: [{ id: 'core', kind: 'conductor', label: 'Core' }, { id: 'screen', kind: 'shield', label: 'Screen' }, { id: 'jacket', kind: 'jacket', label: 'Jacket' }] } };
const isResolve = (url: string) => url.includes('end-stacks/resolve');
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

// What the server resolves for a one-connector stack on the synthetic body.
const resolvedStack = () => ({ layers: [{ layer_id: 'connector', kind: 'connector', name: 'Synthetic body r1', variant_label: null, terminals: ['one', 'two'].map(id => ({ terminal_id: id, label: id, kind: 'contact', signal: null, signal_status: 'unknown', reaches: [] })) }],
  joins: [], connector_layer_id: 'connector', body_revision_id: 'body-rev', pinout_revision_id: 'pinout-rev', evaluation: [], continuity: 'not_evaluated' });
function EditableCable() {
  const [value, setValue] = useState(initialCable());
  return <CableEditor value={value} onChange={setValue} definitions={[]} />;
}

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
  render(wrap(<EditableCable />));
  await paste('Stock', 'stock-rev');
  await paste('Endpoint 1 body', 'body-rev');
  await paste('Endpoint 1 pinout', 'pinout-rev');
  expect(await screen.findByText("A connector layer's pinout must pin its exact body revision.")).toBeTruthy();
  const contact = await screen.findByRole('combobox', { name: 'Endpoint 1 stock.core target' });
  // An unresolvable stack offers no terminal to land on.
  expect((contact as HTMLInputElement).disabled).toBe(true);
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

test('the editor leads with a cable summary: both ends, the stock and termination counts', async () => {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => new Response(JSON.stringify(isResolve(url) ? resolvedStack() : url.includes('/snapshot') ? { content: { stock } } : url.includes('interfaces/revisions/body') ? { interface: body } : { labels: [], source_labels: [] }), { status: 200 })));
  const cable = initialCable();
  cable.stock_revision_id = 'stock-rev';
  cable.endpoints.forEach(e => { e.stack = { layers: [{ kind: 'connector', layer_id: 'connector', body_revision_id: 'body-rev', pinout_revision_id: 'pinout-rev' }], joins: [] }; });
  cable.endpoints[0]!.label = 'Plug';
  cable.endpoints[0]!.stock_end = 'a';
  cable.assignments = [{ endpoint_id: 'a', element_path: 'stock.core', layer_id: 'connector', terminal_id: 'one', basis: 'Synthetic' }];
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


test.each([
  ['stock', '/snapshot', ['cable-stock', 'stock-rev']],
  ['body', 'interfaces/revisions/body-rev', ['cable-body', 'body-rev']],
  ['stack', 'end-stacks/resolve', ['cable-end-resolve']],
])('%s denial withdraws cached termination choices and restores the unchanged working cable', async (_name, deniedPath, key) => {
  let denied = false; const value = initialCable(); value.stock_revision_id = 'stock-rev';
  value.endpoints.forEach(endpoint => { endpoint.stack = { layers: [{ kind: 'connector', layer_id: 'connector', body_revision_id: 'body-rev', pinout_revision_id: 'pinout-rev' }], joins: [] }; });
  value.assignments = [{ endpoint_id: 'a', element_path: 'stock.core', layer_id: 'connector', terminal_id: 'one', basis: 'Retained authored landing' }];
  const cache = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  vi.stubGlobal('fetch', vi.fn(async (url: string) => new Response(JSON.stringify(denied && url.includes(deniedPath) ? { error: { message: 'Source unavailable' } } : isResolve(url) ? resolvedStack() : url.includes('/snapshot') ? { content: { stock } } : { interface: body }), { status: denied && url.includes(deniedPath) ? 403 : 200 })));
  const snapshots: Cable[] = [];
  function Sources() { const sources = useCableSources(value, null); snapshots.push(value); return <div>{sources.denied ? 'Withheld' : sources.choices.map(choice => choice.label).join(',')}</div>; }
  render(wrap(<Sources />, cache));
  await screen.findByText(/stock.core · Core/);
  denied = true; await act(async () => { await cache.refetchQueries({ queryKey: [...key] }); });
  await screen.findByText('Withheld'); expect(screen.queryByText(/stock.core · Core/)).toBeNull();
  denied = false; await act(async () => { await cache.refetchQueries({ queryKey: [...key] }); });
  await screen.findByText(/stock.core · Core/);
  expect(snapshots.every(snapshot => snapshot === value)).toBe(true);
  expect(value.assignments[0]?.basis).toBe('Retained authored landing');
});
