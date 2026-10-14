import { byContent } from "../../test/text";
import { MantineProvider } from '@mantine/core';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { WireStockPanel } from './WireStockPanel';
import { stockPresets } from './presets';
import { PermissionsProvider } from '../../lib/permissions';
import crossCheck from '../../../../tests/fixtures/wire-stock-placement.json';
import type { StockSpecification } from '../../../../packages/section-layout/src';

const record = { name: 'Synthetic saved coax', definition_id: 'definition-1', draft_id: 'draft-1', state: 'draft-v1', content: { stock: stockPresets.coax } };
beforeEach(() => vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} }));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const show = (projectId?: string) => render(<MantineProvider><WireStockPanel projectId={projectId} /></MantineProvider>);

test('produces standalone section and preview without device or connector configuration', () => {
  show();
  expect(screen.getByText(byContent(/Section: 3 mm × 3 mm · 4 material elements/))).toBeTruthy();
  expect(screen.getByLabelText('Stock section drawing').querySelectorAll('[data-element]')).toHaveLength(4);
  expect(screen.getByLabelText('Stock geometry preview').querySelectorAll('[data-preview-element]')).toHaveLength(4);
  // Stock is a library item: saving never needs a project.
  expect((screen.getByRole('button', { name: 'Save stock' }) as HTMLButtonElement).disabled).toBe(false);
  expect(screen.queryByLabelText('Use in this project')).toBeNull();
});

test('saving editor changes persists the exact stock through the shared operation adapter', async () => {
  const fetchMock = vi.fn().mockImplementation(async (_url: string, options?: RequestInit) => {
    if (options?.method === 'POST') {
      const envelope = JSON.parse(options.body as string);
      return new Response(JSON.stringify({ result: { ...record, content: { stock: envelope.payload.stock } } }));
    }
    return new Response('[]');
  });
  vi.stubGlobal('fetch', fetchMock);
  show('project-1');
  fireEvent.change(screen.getByLabelText('stock.jacket outer diameter mm'), { target: { value: '3.2' } });
  expect(screen.getByText(byContent(/Section: 3.2 mm × 3.2 mm/))).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Save stock' }));
  await screen.findByText('Saved Synthetic saved coax (draft-v1).');
  const posts = fetchMock.mock.calls.filter(([, options]) => (options as RequestInit)?.method === 'POST').map(([, options]) => JSON.parse((options as RequestInit).body as string));
  const payload = posts[0];
  expect(payload.operation).toBe('wire_stock.create');
  // "Use in this project" asks the server to reference the new stock in the same operation.
  expect(payload.payload.project_id).toBe('project-1');
  expect(posts).toHaveLength(1);
  expect(payload.payload.stock.structure.children[3].outer_diameter_mm).toBe(3.2);
  expect(payload.payload.stock.facts.impedance.value).toBeNull();
  expect((screen.getByRole('button', { name: 'Freeze saved stock' }) as HTMLButtonElement).disabled).toBe(false);
  fireEvent.change(screen.getByLabelText('stock.center label'), { target: { value: 'Edited center' } });
  expect((screen.getByRole('button', { name: 'Freeze saved stock' }) as HTMLButtonElement).disabled).toBe(true);
});

test('adding unknown material keeps identities in table and marks incomplete geometry', () => {
  show();
  fireEvent.click(screen.getByRole('button', { name: 'Add element to stock' }));
  expect(screen.getByLabelText(/^stock\.conductor-[a-f0-9-]+ label$/)).toBeTruthy();
  expect(screen.getByText(/Incomplete geometry: stock.conductor-[a-f0-9-]+: layer dimensions unknown/, { selector: 'div' })).toBeTruthy();
  expect(screen.getByLabelText('Stock section drawing').querySelectorAll('[data-element]')).toHaveLength(4);
  fireEvent.click(screen.getByRole('button', { name: /^Remove stock\.conductor-[a-f0-9-]+$/ }));
  expect(screen.queryByLabelText(/^stock\.conductor-[a-f0-9-]+ label$/)).toBeNull();
});

test('server conflict is visible and cannot be mistaken for a saved stock', async () => {
  vi.stubGlobal('fetch', vi.fn().mockImplementation(async (_url: string, options?: RequestInit) =>
    options?.method === 'POST' ? new Response(JSON.stringify({ error: { message: 'Draft changed since expected state.' } }), { status: 409 })
      : new Response(_url.includes('/catalog/definitions?') ? JSON.stringify({ results: [], next_after: null }) : '[]')));
  show('project-1');
  fireEvent.click(screen.getByRole('button', { name: 'Save stock' }));
  await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('Draft changed'));
  expect(screen.queryByText(/Saved Synthetic/)).toBeNull();
  expect((screen.getByRole('button', { name: 'Freeze saved stock' }) as HTMLButtonElement).disabled).toBe(true);
});

const showAs = (permissions: string[]) => render(<MantineProvider><PermissionsProvider permissions={permissions}><WireStockPanel projectId="project-1" /></PermissionsProvider></MantineProvider>);
const button = (name: string) => screen.getByRole('button', { name }) as HTMLButtonElement;

test('read-only permissions disable Save stock and Freeze with an accessible reason while local work stays available', () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('[]')));
  showAs(['workspace.read']);
  expect(button('Save stock').disabled).toBe(true);
  expect(button('Save stock').title).toBe('Read-only access: requires Contributor access');
  expect(button('Freeze saved stock').disabled).toBe(true);
  expect(screen.getByRole('note').textContent).toContain('Read-only access: requires Contributor access');
  expect(button('Export specification').disabled).toBe(false);
  expect(button('Export section SVG').disabled).toBe(false);
  expect(button('Add element to stock').disabled).toBe(true);
  expect(button('Add element to stock').title).toBe('Read-only access: requires Contributor access');
});

test('contributor can save but not freeze; freeze holder can do both', async () => {
  const saved = { name: 'Synthetic saved coax', definition_id: 'definition-1', draft_id: 'draft-1', state: 'draft-v1', content: { stock: stockPresets.coax } };
  vi.stubGlobal('fetch', vi.fn().mockImplementation(async (_url: string, options?: RequestInit) =>
    options?.method === 'POST' ? new Response(JSON.stringify({ result: saved })) : new Response('[]')));
  showAs(['workspace.read', 'item.create']);
  expect(button('Save stock').disabled).toBe(false);
  expect(screen.queryByRole('note')).toBeNull();
  fireEvent.click(button('Save stock'));
  await screen.findByText('Saved Synthetic saved coax (draft-v1).');
  expect(button('Freeze saved stock').disabled).toBe(true);
  expect(button('Freeze saved stock').title).toBe('Read-only access: requires Freeze');
  cleanup();
  showAs(['workspace.read', 'item.create', 'design.edit', 'design.freeze']);
  fireEvent.click(button('Save stock'));
  await screen.findByText('Saved Synthetic saved coax (draft-v1).');
  expect(button('Freeze saved stock').disabled).toBe(false);
});

const doubled = crossCheck.cases[0]!.stock as unknown as StockSpecification;

test('a template opens the builder; unknown dimensions draw illustratively and entering them re-lays the cores', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('[]')));
  show();
  fireEvent.click(screen.getByLabelText('New construction', { selector: 'input' }));
  fireEvent.click(await screen.findByRole('option', { name: 'Multi-core round cable', hidden: true }));
  expect(screen.getByLabelText('Construction builder')).toBeTruthy();
  expect(screen.getByText(byContent(/^Illustrative · placeholder proportions for unknown insulation diameter, conductor diameter/))).toBeTruthy();
  expect(screen.getByLabelText('Illustrative section drawing').querySelectorAll('[data-element]').length).toBeGreaterThan(0);
  expect(screen.getByLabelText('Fit findings').textContent).toContain('not evaluated');
  fireEvent.change(screen.getByLabelText('Insulation outer diameter'), { target: { value: '1.3' } });
  fireEvent.change(screen.getByLabelText('Conductor diameter'), { target: { value: '0.5' } });
  const cells = screen.getByLabelText('Computed lay-up');
  expect(cells.textContent).toContain('Core spacing1.3 mm');
  expect(cells.textContent).toContain('Lay-up diameter2.6 mm');
  fireEvent.change(screen.getByLabelText('Insulation outer diameter'), { target: { value: '1.5' } });
  expect(cells.textContent).toContain('Core spacing1.5 mm');
  expect(cells.textContent).toContain('Lay-up diameter3 mm');
});

test('fit problems are listed, saving warns, and freezing needs explicit acknowledgement', async () => {
  const saved = { ...record, name: 'Synthetic double-placed', content: { stock: doubled }, geometry: { failed: 5 } };
  const fetchMock = vi.fn().mockImplementation(async (_url: string, options?: RequestInit) => {
    if (options?.method === 'POST') {
      const envelope = JSON.parse(options.body as string);
      return new Response(JSON.stringify({ result: envelope.operation === 'wire_stock.freeze' ? { number: 1, draft: { state: 'draft-v2' } } : saved }));
    }
    return new Response(JSON.stringify([saved]));
  });
  vi.stubGlobal('fetch', fetchMock);
  render(<MantineProvider><PermissionsProvider permissions={['workspace.read', 'item.create', 'design.edit', 'design.freeze']}><WireStockPanel /></PermissionsProvider></MantineProvider>);
  fireEvent.click(screen.getByLabelText('Saved stock', { selector: 'input' }));
  fireEvent.click(await screen.findByRole('option', { name: 'Synthetic double-placed', hidden: true }));
  const findings = screen.getByLabelText('Fit findings');
  expect(findings.textContent).toContain('5 of 13 checks fail');
  expect(findings.textContent).toContain('stock.pair.c1 extends 0.700 mm beyond the bore of stock.screen.');
  expect(findings.textContent).toContain('arranged members are placed by pitch, so offsets move them twice');
  // Element-by-element constructions keep the advanced editor; offsets sit behind Advanced placement.
  expect(screen.getByText(/Element-by-element construction/)).toBeTruthy();
  expect(screen.getAllByText(/^Advanced placement · /).length).toBeGreaterThan(0);
  fireEvent.click(button('Save stock'));
  await screen.findByText('Saved Synthetic double-placed (draft-v1). Fit: 5 problems; review them before freezing.');
  expect(button('Freeze saved stock').disabled).toBe(true);
  fireEvent.click(screen.getByLabelText('I have reviewed the 5 fit problems and want to freeze anyway'));
  expect(button('Freeze saved stock').disabled).toBe(false);
  fireEvent.click(button('Freeze saved stock'));
  await screen.findByText(/Frozen revision 1/);
  const freeze = fetchMock.mock.calls.map(([, o]) => (o as RequestInit)?.body).filter(Boolean).map(b => JSON.parse(b as string)).find(b => b.operation === 'wire_stock.freeze');
  expect(freeze.payload).toEqual({ draft_id: 'draft-1', acknowledge_geometry_findings: true });
});
