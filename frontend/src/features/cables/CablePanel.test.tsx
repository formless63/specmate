import { MantineProvider } from '@mantine/core';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { CableInspector, CablePanel } from './CablePanel';
import { initialCable, type Cable } from './api';
import { unknownElectrical, unknownOrientation } from '../interfaces/api';

beforeEach(() => vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} }));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
function wrap(children: React.ReactNode) {
  const cache = new QueryClient({ defaultOptions: { queries: { retry: false } } });
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
  const field = screen.getByRole('combobox', { name: label });
  fireEvent.focus(field); fireEvent.keyDown(field, { key: 'ArrowDown' });
  fireEvent.click(await within(screen.getByRole('listbox', { name: label, hidden: true })).findByText(option));
}

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
  fireEvent.click(screen.getByText('Create cable draft'));
  const heading = await screen.findByText('Edit draft');
  const editor = within(heading.closest('.mantine-Card-root')! as HTMLElement);
  fireEvent.change(editor.getByLabelText('Cable review basis'), { target: { value: 'Independent review' } });
  fireEvent.click(editor.getByText('Save cable draft'));
  await screen.findByText('draft-v2');
  fireEvent.click(screen.getByText('Freeze cable revision'));
  await screen.findByText('Exact revision cable-rev');
  expect(commands[0]).toMatchObject({ operation: 'cable.create', payload: { cable: { stock_revision_id: 'stock-rev', assignments: [{ endpoint_id: 'a', element_path: 'stock.core', contact_id: 'one' }, { endpoint_id: 'b', element_path: 'stock.core', contact_id: 'two' }] } } });
  expect(commands[1]).toMatchObject({ operation: 'cable.update', expected_state: 'draft-v1' });
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
