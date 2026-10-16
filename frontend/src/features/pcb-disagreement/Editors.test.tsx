import { MantineProvider } from '@mantine/core';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { useState } from 'react';
import { AssertionEditor, ComparisonEditor } from './Editors';
import { PcbDisagreementInspector, ProjectionView } from './ProjectionView';
import { blankAssertion, type Assertion, type Comparison, type FilePin, type Frozen, type Projection, type ResolvedInput } from './api';

beforeEach(() => { vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} }); Element.prototype.scrollIntoView = vi.fn(); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const LEFT = '10000000-0000-0000-0000-000000000001', RIGHT = '10000000-0000-0000-0000-000000000002', SOURCE = '10000000-0000-0000-0000-000000000003';
const source: FilePin = { source_revision_id: SOURCE, manifest_sha256: '1'.repeat(64), path: 'original.kicad_sch', sha256: '2'.repeat(64), rights: 'synthetic-test' };
function input(): ResolvedInput { return { method: 'human_assertion', source_role: 'schematic', source, coverage: 'partial', coverage_basis: 'Synthetic independent source basis', terminals: [{ local_id: 'one', component_ref: 'J1', pin: '1', net_state: 'assigned', net_name: 'sense', basis: 'Synthetic terminal table', native_component_id: null, native_terminal_id: null }], extractor: null, unsupported: ['Manual assertions are not native extraction.'] }; }
function projection(): Projection { return { inputs: { left: input(), right: { ...input(), source_role: 'netlist', terminals: [{ ...input().terminals[0]!, net_name: 'return' }] } }, findings: [{ finding_id: 'finding-' + '3'.repeat(64), kind: 'net_name_difference', correspondence_ids: ['matched'], left: input().terminals[0]!, right: { ...input().terminals[0]!, net_name: 'return' }, explanation: 'The independent sources name different nets.', review: null }], comparison_status: 'findings_present', parity: 'not_evaluated', physical_qualification: 'not_evaluated' }; }
function comparison(): Comparison { return { kind: 'pcb_comparison', left: { kind: 'assertion_revision', revision_id: LEFT, snapshot_sha256: '4'.repeat(64) }, right: { kind: 'assertion_revision', revision_id: RIGHT, snapshot_sha256: '5'.repeat(64) }, correspondences: [{ local_id: 'matched', left_terminal_id: 'one', right_terminal_id: 'one', basis: 'Explicit native reference review' }], reviews: [] }; }
function assertionRevision(revisionId: string): Frozen { return { revision_id: revisionId, definition_id: 'assertion-def', sha256: '4'.repeat(64), content: { pcb_assertion: { ...blankAssertion(), source, coverage_basis: 'Independent assertion', terminals: input().terminals } }, projection: { assertion: input(), parity: 'not_evaluated', physical_qualification: 'not_evaluated' } }; }
function client() { return new QueryClient({ defaultOptions: { queries: { retry: false } } }); }
function wrap(element: React.ReactNode, cache = client()) { return <MantineProvider><QueryClientProvider client={cache}>{element}</QueryClientProvider></MantineProvider>; }
async function choose(label: string, option: string) { const field = await screen.findByRole('combobox', { name: label }); fireEvent.focus(field); fireEvent.keyDown(field, { key: 'ArrowDown' }); fireEvent.click(await within(screen.getByRole('listbox', { name: label, hidden: true })).findByText(option)); fireEvent.keyDown(field, { key: 'Escape' }); }
function fill(label: string, value: string) { fireEvent.change(screen.getByLabelText(label), { target: { value } }); }

test('structured human assertion selects exact preserved source and keeps unknown terminal state', async () => {
  let latest = blankAssertion();
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ files: [source], coverage: 'preserved_unparsed' }), { status: 200 })));
  function Editor() { const [value, setValue] = useState<Assertion>(latest); return <AssertionEditor value={value} onChange={v => { latest = v; setValue(v); }} onDenied={() => {}} />; }
  render(wrap(<Editor />));
  fill('Preserved source revision ID', SOURCE); await choose('Preserved source file', source.path);
  fill('Coverage declaration basis', 'Human review of exact original'); fill('Assertion terminal ID', 'terminal-one'); fill('Component reference label', 'J1'); fill('Pin label', '1'); fill('Terminal assertion basis', 'Net not known');
  fireEvent.click(screen.getByRole('button', { name: 'Add asserted terminal' }));
  expect(latest.source).toEqual(source); expect(latest.method).toBe('human_assertion');
  expect(latest.terminals[0]).toMatchObject({ local_id: 'terminal-one', net_state: 'unknown', net_name: null });
});

test('comparison correspondence uses exact terminal IDs and does not guess duplicate labels', async () => {
  let latest = { ...comparison(), correspondences: [] };
  const resolved = projection(); resolved.inputs!.left.terminals.push({ ...input().terminals[0]!, local_id: 'duplicate' });
  vi.stubGlobal('fetch', vi.fn(async (url: string) => new Response(JSON.stringify(assertionRevision(url.includes(LEFT) ? LEFT : RIGHT)), { status: 200 })));
  function Editor() { const [value, setValue] = useState<Comparison>(latest); return <ComparisonEditor workspaceId="project" value={value} onChange={v => { latest = v as typeof latest; setValue(v); }} definitions={[]} projection={resolved} sourcePinsCurrent onDenied={() => {}} />; }
  render(wrap(<Editor />));
  expect(latest.correspondences).toEqual([]);
  fill('Correspondence stable ID', 'explicit'); await choose('Left exact terminal; blank declares absent', 'J1 / 1 · duplicate'); await choose('Right exact terminal; blank declares absent', 'J1 / 1 · one'); fill('Correspondence basis', 'Exact physical pin review'); fireEvent.click(screen.getByRole('button', { name: 'Add explicit correspondence' }));
  expect(latest.correspondences).toEqual([{ local_id: 'explicit', left_terminal_id: 'duplicate', right_terminal_id: 'one', basis: 'Exact physical pin review' }]);
});

test('denied frozen refetch removes retained conflict and exact source evidence', async () => {
  const cache = client(); let denied = false;
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(denied ? { error: { message: 'Source access denied.' } } : { projection: projection() }), { status: denied ? 404 : 200 })));
  render(wrap(<PcbDisagreementInspector revisionId="frozen" />, cache));
  expect(await screen.findByText('The independent sources name different nets.')).toBeTruthy();
  denied = true; await act(async () => { await cache.refetchQueries({ queryKey: ['pcb-review-frozen', 'frozen'] }); });
  expect(await screen.findByText('Source access denied.')).toBeTruthy(); expect(screen.queryByText('The independent sources name different nets.')).toBeNull(); expect(screen.queryByText('Synthetic independent source basis')).toBeNull();
});

test('finding review changes do not alter either source assertion', async () => {
  const report = projection(), original = JSON.stringify(report.inputs); let result = comparison();
  function Review() { const [value, setValue] = useState(result); return <ProjectionView projection={report} reviewValue={value} onReviewChange={v => { result = v; setValue(v); }} />; }
  render(wrap(<Review />)); fill('Review basis finding-' + '3'.repeat(64), 'Independent acknowledgment'); fireEvent.click(screen.getByRole('button', { name: 'Record decision for net name difference' }));
  expect(result.reviews[0]?.status).toBe('acknowledged'); expect(JSON.stringify(report.inputs)).toBe(original);
});


test('denied preserved-source refresh hides private assertion rows and declaration basis', async () => {
  const cache = client(); let denied = false; const onDenied = vi.fn();
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(denied ? { error: { message: 'Preserved source denied.' } } : { files: [source], coverage: 'preserved_unparsed' }), { status: denied ? 404 : 200 })));
  const value: Assertion = { ...blankAssertion(), source, coverage_basis: 'Private coverage statement', terminals: input().terminals };
  render(wrap(<AssertionEditor value={value} onChange={() => {}} onDenied={onDenied} />, cache));
  expect(await screen.findByText('J1 / 1 · one · assigned · sense · Synthetic terminal table')).toBeTruthy();
  await waitFor(() => expect(cache.getQueryData(['pcb-review-source', SOURCE])).toBeTruthy());
  denied = true; await act(async () => { await cache.refetchQueries({ queryKey: ['pcb-review-source', SOURCE] }); });
  expect(await screen.findByText('Preserved source denied.')).toBeTruthy();
  expect(screen.queryByLabelText('Coverage declaration basis')).toBeNull();
  expect(screen.queryByText('J1 / 1 · one · assigned · sense · Synthetic terminal table')).toBeNull();
  expect(onDenied).toHaveBeenLastCalledWith(true);
});

