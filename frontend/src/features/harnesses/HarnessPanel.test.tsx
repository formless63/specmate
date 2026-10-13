import { MantineProvider } from '@mantine/core';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { useState } from 'react';
import { HarnessInspector, HarnessPanel } from './HarnessPanel';
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

// This complete authoring workflow opens several searchable selectors and performs
// three commands. Keep its assertions intact with a bounded CI scheduling allowance.
test('create shared material and explicit uncut breakout, save with token, freeze and inspect', async () => {
  let harness = initialHarness(); let state = 'draft-v1';
  const calls: { operation: string; expected_state?: string; payload: { harness?: Harness } }[] = [];
  const draft = () => ({ definition_id: 'harness', draft_id: 'draft', state, content: { harness } });
  vi.stubGlobal('fetch', vi.fn(async (url: string, options?: RequestInit) => {
    let data: unknown;
    if (options?.method === 'POST') {
      const operation = JSON.parse(String(options.body)); calls.push(operation);
      if (operation.payload.harness) harness = operation.payload.harness;
      if (operation.operation === 'harness.update') state = 'draft-v2';
      data = { result: operation.operation === 'harness.freeze' ? { revision_id: 'harness-rev' } : draft() };
    } else if (url.includes('/snapshot')) data = { content: { stock } };
    else if (url.includes('harnesses/drafts')) data = draft();
    else if (url.includes('harnesses/revisions')) data = frozen(harness);
    else if (url.includes('catalog/definitions')) data = { drafts: [{ draft_id: 'draft', state }], revisions: [{ revision_id: 'harness-rev', number: 1 }] };
    else data = [{ definition_id: 'harness', kind: 'harness', name: 'Synthetic branch' }];
    return new Response(JSON.stringify(data), { status: 200 });
  }));
  render(wrap(<HarnessPanel projectId="project" />));
  fill('Definition name', 'Synthetic branch'); fill('New physical section ID', 'shared'); fireEvent.click(screen.getByText('Add physical section'));
  fill('Section shared stock exact revision ID', 'stock-rev');
  fill('Section shared planned cut (mm); blank = unknown', '0.1000'); fill('Section shared cut basis', 'Planned synthetic cut');
  for (const name of ['trunk', 'leg']) { fill('New segment ID', name); if (name === 'trunk') await choose('New segment physical section', 'shared'); fireEvent.click(screen.getByText('Add segment span')); }
  fill('Breakout stable ID', 'split'); await choose('Breakout trunk end', 'trunk / b'); await choose('Breakout leg ends', 'leg / a'); fireEvent.click(screen.getByText('Add breakout'));
  fill('split fate ID', 'uncut-core'); await choose('split exact terminal', 'trunk / b / stock.core'); await choose('split uncut leg terminal', 'leg / a / stock.core'); fill('split fate basis', 'Explicit uncut correspondence'); fireEvent.click(screen.getByText('Add fate to split'));
  fireEvent.click(screen.getByText('Create harness draft'));
  const heading = await screen.findByText('Edit draft'); const editor = within(heading.closest('.mantine-Card-root')! as HTMLElement);
  fireEvent.change(editor.getByLabelText('Harness review basis'), { target: { value: 'Independent review' } }); fireEvent.click(editor.getByText('Save harness draft'));
  await screen.findByText('draft-v2'); fireEvent.click(screen.getByText('Freeze harness revision'));
  expect(await screen.findByText('Planned stock pieces: 1; segment spans: 2')).toBeTruthy();
  expect(calls[0]).toMatchObject({ operation: 'harness.create', payload: { harness: { sections: [{ local_id: 'shared', stock_revision_id: 'stock-rev', planned_cut_length_mm: '0.1000' }], segments: [{ local_id: 'trunk', section_id: 'shared' }, { local_id: 'leg', section_id: 'shared' }], breakouts: [{ local_id: 'split', fates: [{ kind: 'through', trunk: terminal('trunk', 'b', 'core'), leg: terminal('leg', 'a', 'core'), basis: 'Explicit uncut correspondence' }] }] } } });
  expect(calls[1]).toMatchObject({ operation: 'harness.update', expected_state: 'draft-v1' }); expect(calls[2]).toMatchObject({ operation: 'harness.freeze', expected_state: 'draft-v2' });
}, 10_000);

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

test('denied source refresh hides cached joint and breakout records and disables save and freeze', async () => {
  const cache = new QueryClient({ defaultOptions: { queries: { retry: false } } }); let denied = false;
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (denied && url.includes('/snapshot')) return new Response(JSON.stringify({ error: { message: 'Source access denied.' } }), { status: 404 });
    const data = url.includes('/snapshot') ? { content: { stock } } : url.includes('harnesses/drafts') ? { definition_id: 'harness', draft_id: 'draft', state: 'v1', content: { harness: branched() } } : url.includes('catalog/definitions') ? { drafts: [{ draft_id: 'draft', state: 'v1' }], revisions: [] } : [{ definition_id: 'harness', kind: 'harness', name: 'Synthetic branch' }];
    return new Response(JSON.stringify(data), { status: 200 });
  }));
  render(wrap(<HarnessPanel projectId="project" />, cache));
  await choose('Existing harness definition', 'Synthetic branch (harness)'); await choose('Edit harness draft', 'draft · v1');
  expect(await screen.findByText('Basis: Explicit synthetic shield basis')).toBeTruthy();
  await waitFor(() => expect(cache.getQueryData(['harness-source', 'revisions/stock-rev/snapshot'])).toBeTruthy());
  denied = true; await act(async () => { await cache.refetchQueries({ queryKey: ['harness-source', 'revisions/stock-rev/snapshot'] }); });
  expect(await screen.findByText('Source access denied.')).toBeTruthy(); expect(screen.queryByText('Basis: Explicit synthetic shield basis')).toBeNull(); expect(screen.queryByText('Breakout split: trunk/b → leg/b')).toBeNull();
  for (const name of ['Save harness draft', 'Freeze harness revision']) expect((screen.getByRole('button', { name }) as HTMLButtonElement).disabled).toBe(true);
});


test.each(['definitions', 'identity', 'draft'])('denied %s refresh removes cached private draft and choices', async (target) => {
  const cache = new QueryClient({ defaultOptions: { queries: { retry: false } } }); let denied = false;
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const kind = url.includes('/snapshot') ? 'source' : url.includes('harnesses/drafts') ? 'draft' : url.includes('catalog/definitions') ? 'identity' : 'definitions';
    if (denied && kind === target) return new Response(JSON.stringify({ error: { message: `Denied ${target}.` } }), { status: 404 });
    const data = kind === 'source' ? { content: { stock } } : kind === 'draft' ? { definition_id: 'harness', draft_id: 'draft', state: 'v1', content: { harness: branched() } } : kind === 'identity' ? { drafts: [{ draft_id: 'draft', state: 'v1' }], revisions: [] } : [{ definition_id: 'harness', kind: 'harness', name: 'Synthetic branch' }];
    return new Response(JSON.stringify(data), { status: 200 });
  }));
  render(wrap(<HarnessPanel projectId="project" />, cache));
  await choose('Existing harness definition', 'Synthetic branch (harness)'); await choose('Edit harness draft', 'draft · v1');
  expect(await screen.findByText('Basis: Explicit synthetic shield basis')).toBeTruthy();
  const key = target === 'definitions' ? ['harness-definitions', 'project'] : target === 'identity' ? ['harness-identity', 'harness', 0] : ['harness-draft', 'draft'];
  denied = true; await act(async () => { await cache.refetchQueries({ queryKey: key }); });
  expect(await screen.findByText(`Denied ${target}.`)).toBeTruthy();
  expect(screen.queryByText('Basis: Explicit synthetic shield basis')).toBeNull();
  expect(screen.queryByRole('button', { name: 'Save harness draft' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Freeze harness revision' })).toBeNull();
  if (target !== 'draft') expect(screen.queryByRole('combobox', { name: 'Edit harness draft' })).toBeNull();
  if (target === 'definitions') expect((screen.getByRole('button', { name: 'Create harness draft' }) as HTMLButtonElement).disabled).toBe(true);
});
