import { MantineProvider } from '@mantine/core';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { useState } from 'react';
import { HarnessInspector } from './HarnessInspector';
import { HarnessEditor } from './HarnessEditor';
import { initialHarness, type Harness, type Inspection, type SegmentTerminal } from './api';

beforeEach(() => { vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} }); Element.prototype.scrollIntoView = vi.fn(); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const stock = { structure: { id: 'stock', kind: 'group', children: [{ id: 'core', label: 'Core', kind: 'conductor' }, { id: 'screen', label: 'Screen', kind: 'shield' }, { id: 'drain', label: 'Drain', kind: 'drain' }] } };
const terminal = (segment: string, end: 'a' | 'b', path: string): SegmentTerminal => ({ kind: 'segment', segment_id: segment, end, element_path: `stock.${path}` });
function wrap(children: React.ReactNode, cache = new QueryClient({ defaultOptions: { queries: { retry: false } } })) {
  return <MantineProvider><QueryClientProvider client={cache}>{children}</QueryClientProvider></MantineProvider>;
}
async function choose(label: string, option: string) {
  const input = await screen.findByRole('combobox', { name: label });
  fireEvent.focus(input); fireEvent.keyDown(input, { key: 'ArrowDown' });
  fireEvent.click(await within(screen.getByRole('listbox', { name: label, hidden: true })).findByText(option));
  fireEvent.keyDown(input, { key: 'Escape' });
}
function fill(label: string, value: string) { fireEvent.change(screen.getByLabelText(label), { target: { value } }); }
function frozen(harness: Harness): Inspection {
  return { revision_id: 'harness-rev', harness, terminals: ['trunk', 'leg'].flatMap(s => ['core', 'screen'].map(path => ({ terminal: terminal(s, 'a', path), feature_kind: path === 'core' ? 'conductor' : 'shield' }))), declared_relationships: harness.joints.map(j => ({ id: j.local_id, kind: j.kind, members: j.members, basis: j.basis })), breakout_fates: [{ breakout_id: 'split', terminal: terminal('trunk', 'b', 'drain'), fate: 'unknown' }], quantities: { harness_count: 1, segment_count: harness.segments.length, physical_piece_count: harness.sections.length, stock: harness.sections.map(s => ({ stock_revision_id: s.stock_revision_id, section_ids: [s.local_id], piece_count: 1, planned_cut_total_mm: s.planned_cut_length_mm?.toString() ?? null })) }, continuity: 'not_evaluated', compatibility: 'not_evaluated', physical_qualification: 'not_evaluated' };
}
const branched = (): Harness => ({ ...initialHarness(), sections: [{ local_id: 'shared', stock_revision_id: 'stock-rev', planned_cut_length_mm: null, cut_basis: null }], segments: ['trunk', 'leg'].map(local_id => ({ local_id, section_id: 'shared', label: null, element_paths: null })), joints: [{ local_id: 'screen-bond', kind: 'shield_bond', members: [terminal('trunk', 'a', 'screen'), terminal('leg', 'a', 'screen')], basis: 'Explicit synthetic shield basis' }], breakouts: [{ local_id: 'split', trunk: { segment_id: 'trunk', end: 'b' }, legs: [{ segment_id: 'leg', end: 'b' }], fates: [] }] });

test('joint editor records explicit exact members and never infers bonds from shared section', async () => {
  let latest: Harness = { ...branched(), joints: [], breakouts: [] };
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ content: { stock } }), { status: 200 })));
  function Editor() { const [value, setValue] = useState<Harness>(latest); return <HarnessEditor value={value} onChange={v => { latest = v; setValue(v); }} definitions={[]} />; }
  render(wrap(<Editor />));
  expect(latest.joints).toHaveLength(0);
  fill('Joint stable ID', 'declared-bond'); await choose('Joint declaration kind', 'shield_bond');
  await choose('Joint exact members', 'trunk / a / stock.screen'); await choose('Joint exact members', 'leg / a / stock.drain');
  fill('Joint declaration basis', 'Independent screen instruction'); fireEvent.click(screen.getByText('Add declared joint'));
  expect(latest.joints).toEqual([{ local_id: 'declared-bond', kind: 'shield_bond', members: [terminal('trunk', 'a', 'screen'), terminal('leg', 'a', 'drain')], basis: 'Independent screen instruction' }]);
});


test('frozen declaration inspector limits selection to explicit relationships and clears denied cached rows', async () => {
  const cache = new QueryClient({ defaultOptions: { queries: { retry: false } } }); let denied = false;
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(denied ? { error: { message: 'Harness access denied.' } } : frozen(branched())), { status: denied ? 404 : 200 })));
  render(wrap(<HarnessInspector revisionId="harness-rev" />, cache));
  await choose('Inspect terminal declarations', 'trunk / a / stock.screen (shield)');
  expect(await screen.findByText('shield_bond: screen-bond')).toBeTruthy();
  await choose('Inspect terminal declarations', 'trunk / a / stock.core (conductor)');
  expect(screen.getByText('No relationship declared for this terminal; continuity remains unknown.')).toBeTruthy();
  denied = true; await act(async () => { await cache.refetchQueries({ queryKey: ['harness-inspect', 'harness-rev', 1] }); });
  expect(await screen.findByText('Harness access denied.')).toBeTruthy(); expect(screen.queryByRole('table')).toBeNull(); expect(screen.queryByRole('combobox', { name: 'Inspect terminal declarations' })).toBeNull();
});
