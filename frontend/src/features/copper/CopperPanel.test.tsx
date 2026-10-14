import { MantineProvider } from '@mantine/core';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { CopperInspector, CopperPanel } from './CopperPanel';
import type { Graph, Node } from './api';

beforeEach(() => { vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} }); Element.prototype.scrollIntoView = vi.fn(); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
function cache() { return new QueryClient({ defaultOptions: { queries: { retry: false } } }); }
function wrap(element: React.ReactNode, client = cache()) { return <MantineProvider><QueryClientProvider client={client}>{element}</QueryClientProvider></MantineProvider>; }
async function choose(label: string, option: string) {
  const field = await screen.findByRole('combobox', { name: label });
  fireEvent.focus(field); fireEvent.keyDown(field, { key: 'ArrowDown' });
  fireEvent.click(await within(screen.getByRole('listbox', { name: label, hidden: true })).findByText(option));
  fireEvent.keyDown(field, { key: 'Escape' });
}
function sample(): Graph {
  const origin = { revision_id: 'board-rev', snapshot_sha256: 'digest', occurrence_path: ['board-a'], native_net: 'sense', interpretation: { interpretation_id: 'report-one', source_revision_id: 'source-one', sha256: 'report-digest' } };
  const node = (id: string, label: string, net: string): Node => ({ id, label, occurrence_path: ['board-a'], revision_id: 'board-rev', terminal: { kind: 'pad', pad_id: id, component_id: 'resistor' }, feature_kind: 'pad', provenance: { ...origin, native_net: net } });
  return { root_revision_id: 'root', snapshot_id: 'snapshot-one', snapshot_sha256: 'root-digest', occurrence_path: [], nodes: [node('pad-a', 'R1.1', 'sense'), node('port-a', 'J1.1', 'sense'), node('pad-b', 'R1.2', 'return')], edges: [{ id: 'membership', kind: 'native_net', evidence: 'reported_net_membership', members: ['pad-a', 'port-a'], basis: 'Reported pad membership; routed continuity not proven.', provenance: origin }], components: [{ id: 'component-a', members: ['pad-a', 'port-a'], edge_ids: ['membership'], native_net_ids: ['net-a'], evidence: ['reported_net_membership'] }, { id: 'component-b', members: ['pad-b'], edge_ids: [], native_net_ids: ['net-b'], evidence: ['reported_net_membership'] }], boundaries: [{ id: 'resistor-boundary', kind: 'resistor', members: ['pad-a', 'pad-b'], status: 'not_evaluated', reason: 'Resistor passage keeps the nets separate.', provenance: origin }], selected_component_id: null, continuity: 'not_evaluated', compatibility: 'not_evaluated', physical_qualification: 'not_evaluated', limitations: ['No physical continuity result.'] };
}

test('exact revision selection shows net membership separately from resistor boundaries and retained provenance', async () => {
  const requests: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    requests.push(url);
    const data = url.includes('copper/revisions') ? sample() : url.includes('catalog/definitions') ? { drafts: [], revisions: [{ revision_id: 'root', number: 2 }] } : [{ definition_id: 'design', name: 'Synthetic assembly', kind: 'assembly' }];
    return new Response(JSON.stringify(data), { status: 200 });
  }));
  render(wrap(<CopperPanel projectId="project" />));
  await choose('Copper graph definition', 'Synthetic assembly (assembly)');
  await choose('Frozen graph revision', 'Revision 2');
  expect(await screen.findByText('3 terminals · 2 declared components · 1 boundaries')).toBeTruthy();
  await choose('Inspect copper terminal', 'board-a · R1.1 (pad)');
  expect(screen.getByText('Evidence: Reported net membership')).toBeTruthy();
  const table = screen.getByRole('table');
  expect(within(table).getByText('J1.1')).toBeTruthy(); expect(within(table).queryByText('R1.2')).toBeNull();
  expect(screen.getByText('Resistor passage keeps the nets separate.')).toBeTruthy();
  expect(screen.getAllByText(/Interpretation: report-one/).length).toBeGreaterThan(0);
  expect(screen.getAllByText('source-one', { selector: 'code' }).length).toBeGreaterThan(0);
  await choose('Inspect copper terminal', 'board-a · R1.2 (pad)');
  expect(within(screen.getByRole('table')).queryByText('J1.1')).toBeNull();
  expect(screen.getByText('Native net identity: net-b')).toBeTruthy();
  expect(requests).toContain('/api/v0/copper/revisions/root');
});

test('same-key graph denial removes retained terminal options, component rows and boundary provenance', async () => {
  const client = cache(); let denied = false;
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(denied ? { error: { message: 'Graph source access denied.' } } : sample()), { status: denied ? 404 : 200 })));
  render(wrap(<CopperInspector revisionId="root" />, client));
  await choose('Inspect copper terminal', 'board-a · R1.1 (pad)');
  expect(screen.getByRole('table')).toBeTruthy();
  denied = true; fireEvent.click(screen.getByRole('button', { name: 'Refresh graph access' }));
  expect(await screen.findByText('Graph source access denied.')).toBeTruthy();
  expect(screen.queryByRole('table')).toBeNull(); expect(screen.queryByRole('combobox', { name: 'Inspect copper terminal' })).toBeNull();
  expect(screen.queryByText('Resistor passage keeps the nets separate.')).toBeNull();
  expect(screen.queryByText('Native net identity: net-a')).toBeNull();
});

test.each(['definitions', 'identity'])('denied %s refresh hides retained graph and frozen revision options', async target => {
  const client = cache(); let denied = false;
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const kind = url.includes('copper/revisions') ? 'graph' : url.includes('catalog/definitions') ? 'identity' : 'definitions';
    if (denied && kind === target) return new Response(JSON.stringify({ error: { message: `Denied ${target}.` } }), { status: 404 });
    const data = kind === 'graph' ? sample() : kind === 'identity' ? { drafts: [], revisions: [{ revision_id: 'root', number: 1 }] } : [{ definition_id: 'design', name: 'Synthetic assembly', kind: 'assembly' }];
    return new Response(JSON.stringify(data), { status: 200 });
  }));
  render(wrap(<CopperPanel projectId="project" />, client));
  await choose('Copper graph definition', 'Synthetic assembly (assembly)'); await choose('Frozen graph revision', 'Revision 1');
  expect(await screen.findByText('Resistor passage keeps the nets separate.')).toBeTruthy();
  denied = true; await act(async () => { await client.refetchQueries({ queryKey: target === 'identity' ? ['copper-identity', 'design', 0] : ['copper-definitions', 'project'] }); });
  expect(await screen.findByText(`Denied ${target}.`)).toBeTruthy();
  expect(screen.queryByRole('combobox', { name: 'Frozen graph revision' })).toBeNull();
  expect(screen.queryByText('Resistor passage keeps the nets separate.')).toBeNull();
  expect((screen.getByRole('button', { name: 'Inspect exact graph' }) as HTMLButtonElement).disabled).toBe(true);
});

test('terminal and evidence pagination remain independent for large declared components', async () => {
  const value = sample();
  value.edges = Array.from({ length: 101 }, (_, index) => ({ ...value.edges[0]!, id: `edge-${index}`, basis: `Evidence item ${index}` }));
  value.components[0]!.edge_ids = value.edges.map(e => e.id);
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(value), { status: 200 })));
  render(wrap(<CopperInspector revisionId="root" />));
  await choose('Inspect copper terminal', 'board-a · R1.1 (pad)');
  expect((screen.getByRole('button', { name: 'Next terminals' }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: 'Next connections' }));
  expect(screen.getByText('Evidence item 100')).toBeTruthy(); expect(screen.queryByText('Evidence item 0')).toBeNull();
});
