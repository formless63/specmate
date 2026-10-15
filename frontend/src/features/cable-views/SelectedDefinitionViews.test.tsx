import { MantineProvider } from '@mantine/core';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { ProbeProvider } from '../probe';
import type { ProbeTarget } from '../navigation/url';
import { record } from '../../test/workspaceServer';
import { SelectedDefinitionViews, revisionPageOffset } from './SelectedDefinitionViews';
import { shieldedPair, unrecordedCoax } from './fixtures';
import { initialCable } from '../cables/api';
import { unknownElectrical, unknownOrientation } from '../interfaces/api';

beforeEach(() => vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} }));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const body = { kind: 'connector_body', family: null, mating_role: 'unknown', drawing_orientation: unknownOrientation(), contacts: [] };
const pinout = { kind: 'pinout', body_revision_id: 'body-rev', assignments: [], review: 'unreviewed', review_basis: null, orientation: unknownOrientation() };
void unknownElectrical;
const cable = { ...initialCable(), stock_revision_id: 'stock-1' };
const inspected = (revision: string) => ({ revision_id: revision, snapshot_id: 's', cable, continuity: 'not_evaluated', compatibility: 'not_evaluated', physical_qualification: 'not_evaluated',
  conductors: [], endpoints: cable.endpoints.map(e => ({ ...e, body, pinout })) });

type Config = { revisions?: { revision_id: string; number: number }[]; drafts?: { draft_id: string; state: string }[]; draftStock?: string; stocks?: Record<string, unknown>; harness?: unknown };
function serve(config: Config) {
  const calls: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    calls.push(url);
    const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });
    if (url.includes('catalog/definitions/')) return json({ definition_id: 'd1', name: 'Lead', kind: 'cable', revisions: config.revisions ?? [], drafts: (config.drafts ?? []).map(d => ({ ...d, dependencies: [] })) });
    if (url.includes('cables/revisions/')) return json(inspected(url.split('/').pop()!));
    if (url.includes('cables/drafts/')) return json({ definition_id: 'd1', draft_id: 'draft-1', state: 'draft-v3', content: { cable: { ...cable, stock_revision_id: config.draftStock ?? '' } } });
    if (url.includes('harnesses/drafts/')) return json({ definition_id: 'd1', draft_id: 'draft-1', state: 'draft-v1', content: { harness: config.harness } });
    const snapshot = /revisions\/([^/]+)\/snapshot/.exec(url);
    if (snapshot) return json({ content: { stock: config.stocks?.[snapshot[1]!] } });
    if (url.includes('revision-labels')) return json({ labels: [], source_labels: [] });
    return json({ error: { message: 'unexpected' } }, 404);
  }));
  return calls;
}
function show(item: ReturnType<typeof record>, probe: ProbeTarget | null = null) {
  const onProbe = vi.fn();
  const cache = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<MantineProvider><QueryClientProvider client={cache}><ProbeProvider probe={probe} onProbe={onProbe}><SelectedDefinitionViews record={item} /></ProbeProvider></QueryClientProvider></MantineProvider>);
  return { onProbe };
}
const REVISIONS = [{ revision_id: 'cable-r1', number: 1 }, { revision_id: 'cable-r2', number: 2 }];

test('selecting a frozen cable opens its cross-section for the latest revision', async () => {
  const calls = serve({ revisions: REVISIONS, stocks: { 'stock-1': shieldedPair() } });
  show(record('d1', 'Lead', { latest_revision: 2, latest_revision_id: 'cable-r2' }));
  expect(await screen.findByLabelText('Cable section drawing')).toBeTruthy();
  expect(screen.getByRole('tab', { name: '3D model' })).toBeTruthy();
  expect(calls.some(url => url.includes('cables/revisions/cable-r2'))).toBe(true);
  expect(calls.some(url => url.includes('cables/revisions/cable-r1'))).toBe(false);
});

test('the probe revision selects that exact frozen revision and the picker updates the probe', async () => {
  const calls = serve({ revisions: REVISIONS, stocks: { 'stock-1': shieldedPair() } });
  const { onProbe } = show(record('d1', 'Lead', { latest_revision: 2, latest_revision_id: 'cable-r2' }), { object: 'd1', rev: 1, path: [] });
  expect(await screen.findByLabelText('Cable section drawing')).toBeTruthy();
  expect(calls.some(url => url.includes('cables/revisions/cable-r1'))).toBe(true);
  expect(calls.some(url => url.includes('cables/revisions/cable-r2'))).toBe(false);
  const picker = screen.getByRole('combobox', { name: 'Inspect frozen cable' }) as HTMLInputElement;
  expect(picker.value).toBe('r1');
  fireEvent.focus(picker); fireEvent.keyDown(picker, { key: 'ArrowDown' });
  fireEvent.click(await within(screen.getByRole('listbox', { name: 'Inspect frozen cable', hidden: true })).findByText('r2'));
  expect(onProbe).toHaveBeenCalledWith({ object: 'd1', rev: 2, path: [] });
});

test('a revision the item does not have is stated, never substituted', async () => {
  serve({ revisions: REVISIONS, stocks: { 'stock-1': shieldedPair() } });
  show(record('d1', 'Lead', { latest_revision: 2, latest_revision_id: 'cable-r2' }), { object: 'd1', rev: 9, path: [] });
  expect(await screen.findByText(/r9 is not available for Lead/)).toBeTruthy();
  expect(screen.queryByLabelText('Cable section drawing')).toBeNull();
});

test('a never-frozen cable shows its draft as saved now, with the stock drawn from it', async () => {
  serve({ drafts: [{ draft_id: 'draft-1', state: 'draft-v3' }], draftStock: 'stock-1', stocks: { 'stock-1': shieldedPair() } });
  show(record('d1', 'Lead'));
  expect(await screen.findByLabelText('Cable section drawing')).toBeTruthy();
  expect(screen.getByText(/Unfrozen draft, shown as saved now \(draft-v3\)/)).toBeTruthy();
  fireEvent.click(screen.getByRole('tab', { name: 'Information' }));
  expect(screen.getByText('Unfrozen draft')).toBeTruthy();
});

test('a draft with no stock chosen draws nothing and says unknown', async () => {
  serve({ drafts: [{ draft_id: 'draft-1', state: 'draft-v3' }] });
  show(record('d1', 'Lead'));
  expect(await screen.findByText(/No stock is chosen in this draft/)).toBeTruthy();
  expect(screen.queryByLabelText('Cable section drawing')).toBeNull();
  expect(document.querySelector('[data-unknown="true"]')).not.toBeNull();
});

test('unrecorded dimensions and colors render as unknown in the cable views', async () => {
  serve({ revisions: REVISIONS, stocks: { 'stock-1': unrecordedCoax() } });
  show(record('d1', 'Lead', { latest_revision: 2, latest_revision_id: 'cable-r2' }));
  await screen.findByLabelText('Cable section drawing');
  expect(screen.getAllByRole('button', { name: /color unknown/ }).length).toBeGreaterThan(0);
  fireEvent.click(screen.getByRole('tab', { name: 'Information' }));
  const layers = screen.getByRole('table', { name: 'Layer information' });
  expect(layers.textContent).toContain('Unknown');
  expect(within(layers).queryByText('0 mm')).toBeNull();
});

test('a draft harness shows only its formboard, with no build sheet that would imply a revision', async () => {
  const harness = { sections: [], segments: [], endpoints: [], joints: [], breakouts: [], review: 'unreviewed', review_basis: null };
  serve({ drafts: [{ draft_id: 'draft-1', state: 'draft-v1' }], harness });
  show(record('h1', 'Loom', { kind: 'harness' }));
  expect(await screen.findByText(/Unfrozen draft, shown as saved now \(draft-v1\)/)).toBeTruthy();
  expect(await screen.findByText(/No physical sections are declared/)).toBeTruthy();
  await waitFor(() => expect(screen.queryByRole('tab', { name: 'Build sheet' })).toBeNull());
});

test('revision pages are found by number', () => {
  expect([1, 50, 51, 100, 101].map(revisionPageOffset)).toEqual([0, 0, 50, 50, 100]);
});
