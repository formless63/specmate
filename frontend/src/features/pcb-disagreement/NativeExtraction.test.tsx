import { MantineProvider } from '@mantine/core';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { NativeExtraction, NativeInspector } from './NativeExtraction';
import { PermissionsProvider } from '../../lib/permissions';
import { ComparisonEditor } from './Editors';
import { PcbDisagreementInspector } from './PcbDisagreementPanel';
import { type Comparison, type NativeAccepted, type Projection } from './api';

beforeEach(() => { vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} }); Element.prototype.scrollIntoView = vi.fn(); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const SOURCE = '10000000-0000-0000-0000-000000000001', NATIVE = '10000000-0000-0000-0000-000000000002';
const source = { source_revision_id: SOURCE, path: 'original.kicad_sch', sha256: '1'.repeat(64), manifest_sha256: '2'.repeat(64), rights: 'synthetic' };
const accepted: NativeAccepted = { interpretation_id: NATIVE, attempt_id: 'attempt', report_sha256: '3'.repeat(64), source, report: { method: 'native_schematic_export', source_role: 'schematic', coverage: 'root_unit_pin_inventory', adapter: 'kicad-net-assertions-v1', tool_version: '10.0.6', xml_sha256: '4'.repeat(64), reported_source_tool: 'Eeschema 10.0.6', terminals: [{ local_id: 'derived-exact', component_ref: 'J1', pin: '1', native_component_id: 'native-component', native_terminal_id: null, net_state: 'assigned', net_name: 'private-net', basis: 'Reported membership' }], unsupported: ['No physical qualification.'] } };
const attempt = { attempt_id: 'attempt', source, source_role: 'schematic', state: 'succeeded', build_id: 'build', interpretation: null };
function wrap(element: React.ReactNode, cache = new QueryClient({ defaultOptions: { queries: { retry: false } } })) { return { cache, ...render(<MantineProvider><QueryClientProvider client={cache}>{element}</QueryClientProvider></MantineProvider>) }; }
async function choose(label: string, option: string) { const field = await screen.findByRole('combobox', { name: label }); fireEvent.focus(field); fireEvent.keyDown(field, { key: 'ArrowDown' }); fireEvent.click(await within(screen.getByRole('listbox', { name: label, hidden: true })).findByText(option)); fireEvent.keyDown(field, { key: 'Escape' }); }

test('native request pins exact source and approved recipe; acceptance sends only attempt and displays retained evidence', async () => {
  const calls: unknown[] = []; let done = false;
  vi.stubGlobal('fetch', vi.fn(async (url: string, options?: RequestInit) => {
    let value: unknown;
    if (options?.method === 'POST') { const request = JSON.parse(String(options.body)); calls.push(request); done ||= request.operation === 'pcb_disagreement.accept_native'; value = { result: done ? accepted : { attempt_id: 'attempt' } }; }
    else if (url.includes('/sources/')) value = { files: [source] };
    else if (url.includes('/native-options')) value = { available_recipe_id: 'exact-approved' };
    else if (url.includes(`/native/${NATIVE}`)) value = accepted;
    else value = { attempts: [{ ...attempt, interpretation: done ? { interpretation_id: NATIVE, report_sha256: accepted.report_sha256 } : null }], limit: 100 };
    return new Response(JSON.stringify(value), { status: 200 });
  }));
  wrap(<NativeExtraction projectId="project" />);
  fireEvent.change(screen.getByLabelText('Preserved source revision ID'), { target: { value: SOURCE } });
  await choose('Preserved source file', source.path);
  await waitFor(() => expect((screen.getByRole('button', { name: 'Request native source extraction' }) as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(screen.getByRole('button', { name: 'Request native source extraction' }));
  await waitFor(() => expect(calls).toHaveLength(1));
  fireEvent.click(screen.getByRole('button', { name: 'Accept extraction attempt' }));
  expect(await screen.findByText('native schematic export · schematic')).toBeTruthy();
  expect(screen.getByText('assigned · private-net')).toBeTruthy();
  expect(calls).toMatchObject([{ operation: 'pcb_disagreement.request_native', payload: { project_id: 'project', source, source_role: 'schematic', recipe_id: 'exact-approved' } }, { operation: 'pcb_disagreement.accept_native', payload: { attempt_id: 'attempt' } }]);
});

test('missing approved extractor remains unavailable without a mock extraction claim', async () => {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => new Response(JSON.stringify(url.includes('/sources/') ? { files: [source] } : url.includes('/native-options') ? { available_recipe_id: null } : { attempts: [] }), { status: 200 })));
  wrap(<NativeExtraction projectId="project" />);
  fireEvent.change(screen.getByLabelText('Preserved source revision ID'), { target: { value: SOURCE } }); await choose('Preserved source file', source.path);
  expect(await screen.findByText('No approved extractor is installed for this exact source selection.')).toBeTruthy();
  expect((screen.getByRole('button', { name: 'Request native source extraction' }) as HTMLButtonElement).disabled).toBe(true);
});

test('same-key denied accepted extraction refresh removes cached private terminals and report hashes', async () => {
  let denied = false;
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(denied ? { error: { message: 'Native origin denied.' } } : accepted), { status: denied ? 404 : 200 })));
  wrap(<NativeInspector interpretationId={NATIVE} />);
  expect(await screen.findByText('assigned · private-net')).toBeTruthy();
  denied = true; fireEvent.click(screen.getByRole('button', { name: 'Refresh accepted extraction' }));
  expect(await screen.findByText('Native origin denied.')).toBeTruthy(); expect(screen.queryByText('assigned · private-net')).toBeNull(); expect(screen.queryByText(/Report SHA-256:/)).toBeNull();
});

test('same-key denied attempt list refresh removes prior rows and disables acceptance', async () => {
  let denied = false;
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(denied ? { error: { message: 'Attempts denied.' } } : { attempts: [attempt] }), { status: denied ? 404 : 200 })));
  const { cache } = wrap(<NativeExtraction projectId="project" />);
  expect(await screen.findByRole('button', { name: 'Accept extraction attempt' })).toBeTruthy();
  denied = true; await act(async () => { await cache.refetchQueries({ queryKey: ['pcb-native-attempts', 'project'] }); });
  expect(await screen.findByText('Attempts denied.')).toBeTruthy(); expect(screen.queryByRole('button', { name: 'Accept extraction attempt' })).toBeNull(); expect(screen.queryByText(/Exact source SHA-256:/)).toBeNull();
});

test('denied native input refresh removes exact correspondence choices and reports disabled editing', async () => {
  let denied = false; const onDenied = vi.fn();
  const pin = { kind: 'source_net_interpretation' as const, interpretation_id: NATIVE, report_sha256: accepted.report_sha256, source };
  const value: Comparison = { kind: 'pcb_comparison', left: pin, right: pin, correspondences: [], reviews: [] };
  const input = { method: accepted.report.method, source_role: 'schematic', source, coverage: accepted.report.coverage, coverage_basis: 'Native root inventory', terminals: accepted.report.terminals, extractor: null, unsupported: [] };
  const projection: Projection = { inputs: { left: input, right: input }, parity: 'not_evaluated', physical_qualification: 'not_evaluated' };
  vi.stubGlobal('fetch', vi.fn(async (url: string) => new Response(JSON.stringify(url.includes(`/native/${NATIVE}`) ? denied ? { error: { message: 'Exact extraction denied.' } } : accepted : { attempts: [{ ...attempt, interpretation: pin }] }), { status: denied && url.includes(`/native/${NATIVE}`) ? 404 : 200 })));
  const { cache } = wrap(<ComparisonEditor projectId="project" value={value} onChange={() => {}} definitions={[]} projection={projection} sourcePinsCurrent onDenied={onDenied} />);
  await waitFor(() => expect(cache.getQueryData(['pcb-native-interpretation', NATIVE])).toBeTruthy());
  expect(screen.getByRole('combobox', { name: 'Left exact terminal; blank declares absent' })).toBeTruthy();
  denied = true; await act(async () => { await cache.refetchQueries({ queryKey: ['pcb-native-interpretation', NATIVE] }); });
  expect(await screen.findAllByText('Exact extraction denied.')).toHaveLength(2); expect(screen.queryByRole('combobox', { name: 'Left exact terminal; blank declares absent' })).toBeNull(); expect(onDenied).toHaveBeenLastCalledWith(true);
});

test.each(['request', 'accept'])('a denied %s clears retained native rows, inspector and source options', async action => {
  let denied = false;
  const retained = { ...attempt, interpretation: { interpretation_id: NATIVE, report_sha256: accepted.report_sha256 } };
  vi.stubGlobal('fetch', vi.fn(async (url: string, options?: RequestInit) => {
    if (denied && (options?.method === 'POST' || url.includes('/sources/') || url.includes(`/native/${NATIVE}`))) return new Response(JSON.stringify({ error: { message: 'Native evidence denied.' } }), { status: 404 });
    const value = url.includes('/sources/') ? { files: [source] } : url.includes('/native-options') ? { available_recipe_id: 'exact-approved' } : url.includes(`/native/${NATIVE}`) ? accepted : { attempts: [retained, { ...attempt, attempt_id: 'pending' }], limit: 100 };
    return new Response(JSON.stringify(value), { status: 200 });
  }));
  wrap(<NativeExtraction projectId="project" />);
  fireEvent.change(screen.getByLabelText('Preserved source revision ID'), { target: { value: SOURCE } });
  await choose('Preserved source file', source.path);
  fireEvent.click(await screen.findByRole('button', { name: `Inspect accepted extraction ${NATIVE}` }));
  expect(await screen.findByText('assigned · private-net')).toBeTruthy();
  denied = true;
  fireEvent.click(screen.getByRole('button', { name: action === 'request' ? 'Request native source extraction' : 'Accept extraction pending' }));
  expect(await screen.findByText('Native evidence denied.')).toBeTruthy();
  await waitFor(() => expect(screen.queryByText('assigned · private-net')).toBeNull());
  expect(screen.queryByText(/Report SHA-256:/)).toBeNull();
  expect(screen.queryByText(/Exact source SHA-256:/)).toBeNull();
  expect((screen.getByRole('combobox', { name: 'Preserved source file' }) as HTMLInputElement).value).toBe('');
  expect((screen.getByLabelText('Preserved source revision ID') as HTMLInputElement).value).toBe('');
  expect((screen.getByRole('button', { name: 'Request native source extraction' }) as HTMLButtonElement).disabled).toBe(true);
});

test('status refresh revalidates a selected interpretation even when the filtered attempt list succeeds', async () => {
  let denied = false; let reads = 0;
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url.includes(`/native/${NATIVE}`)) {
      reads += 1;
      return new Response(JSON.stringify(denied ? { error: { message: 'Selected native source denied.' } } : accepted), { status: denied ? 404 : 200 });
    }
    return new Response(JSON.stringify({ attempts: denied ? [] : [{ ...attempt, interpretation: { interpretation_id: NATIVE, report_sha256: accepted.report_sha256 } }], limit: 100 }), { status: 200 });
  }));
  wrap(<NativeExtraction projectId="project" />);
  fireEvent.click(await screen.findByRole('button', { name: `Inspect accepted extraction ${NATIVE}` }));
  expect(await screen.findByText('assigned · private-net')).toBeTruthy();
  denied = true;
  fireEvent.click(screen.getByRole('button', { name: 'Refresh extraction status' }));
  expect(await screen.findByText('Selected native source denied.')).toBeTruthy();
  expect(reads).toBeGreaterThan(1);
  expect(screen.queryByText('assigned · private-net')).toBeNull();
  expect(screen.queryByText(/Report SHA-256:/)).toBeNull();
  // The denied selection was discarded; a fresh list can recover without requesting an empty source.
  fireEvent.click(screen.getByRole('button', { name: 'Refresh extraction status' }));
  await waitFor(() => expect(screen.queryByText(/Cached native evidence was cleared/)).toBeNull());
});

test('native mutation denial revalidates the affected comparison input without rewriting unsaved values', async () => {
  let denied = false;
  const changed = vi.fn(), onDenied = vi.fn();
  const pin = { kind: 'source_net_interpretation' as const, interpretation_id: NATIVE, report_sha256: accepted.report_sha256, source };
  const value: Comparison = { kind: 'pcb_comparison', left: pin, right: pin, correspondences: [], reviews: [] };
  const input = { method: accepted.report.method, source_role: 'schematic', source, coverage: accepted.report.coverage, coverage_basis: 'Native root inventory', terminals: accepted.report.terminals, extractor: null, unsupported: [] };
  const projection: Projection = { inputs: { left: input, right: input }, parity: 'not_evaluated', physical_qualification: 'not_evaluated' };
  vi.stubGlobal('fetch', vi.fn(async (url: string, options?: RequestInit) => {
    if (denied && (options?.method === 'POST' || url.includes(`/native/${NATIVE}`))) return new Response(JSON.stringify({ error: { message: 'Comparison native source denied.' } }), { status: 404 });
    return new Response(JSON.stringify(url.includes(`/native/${NATIVE}`) ? accepted : { attempts: [attempt, { ...attempt, attempt_id: 'accepted', interpretation: pin }], limit: 100 }), { status: 200 });
  }));
  const { cache } = wrap(<><NativeExtraction projectId="project" /><ComparisonEditor projectId="project" value={value} onChange={changed} definitions={[]} projection={projection} sourcePinsCurrent onDenied={onDenied} /></>);
  expect(await screen.findAllByText(/exact XML/)).toHaveLength(2);
  expect(screen.getByRole('combobox', { name: 'Left exact terminal; blank declares absent' })).toBeTruthy();
  fireEvent.change(screen.getByLabelText('Correspondence basis'), { target: { value: 'Unsaved review basis' } });
  denied = true;
  fireEvent.click(await screen.findByRole('button', { name: 'Accept extraction attempt' }));
  await waitFor(() => expect(onDenied).toHaveBeenLastCalledWith(true));
  expect(screen.queryByRole('combobox', { name: 'Left exact terminal; blank declares absent' })).toBeNull();
  expect(screen.queryByText(/exact XML/)).toBeNull();
  expect(changed).not.toHaveBeenCalled();
  denied = false;
  await act(async () => { await cache.refetchQueries({ queryKey: ['pcb-native-interpretation', NATIVE] }); });
  await waitFor(() => expect(onDenied).toHaveBeenLastCalledWith(false));
  expect((screen.getByLabelText('Correspondence basis') as HTMLInputElement).value).toBe('Unsaved review basis');
  expect(changed).not.toHaveBeenCalled();
});

test('native mutation denial revalidates a frozen comparison that retains the same source', async () => {
  let denied = false;
  const input = { method: accepted.report.method, source_role: 'schematic', source, coverage: accepted.report.coverage, coverage_basis: 'Native inventory', terminals: accepted.report.terminals, extractor: { adapter: accepted.report.adapter, tool_version: accepted.report.tool_version, report_sha256: accepted.report_sha256, interpretation_id: NATIVE }, unsupported: [] };
  const frozen = { revision_id: 'frozen', projection: { inputs: { left: input, right: input }, parity: 'not_evaluated', physical_qualification: 'not_evaluated' } };
  vi.stubGlobal('fetch', vi.fn(async (url: string, options?: RequestInit) => {
    if (denied && (options?.method === 'POST' || url.includes('/revisions/frozen'))) return new Response(JSON.stringify({ error: { message: 'Frozen native source denied.' } }), { status: 404 });
    return new Response(JSON.stringify(url.includes('/revisions/frozen') ? frozen : { attempts: [attempt], limit: 100 }), { status: 200 });
  }));
  wrap(<><NativeExtraction projectId="project" /><PcbDisagreementInspector revisionId="frozen" /></>);
  expect(await screen.findAllByText(/Source revision:/)).toHaveLength(2);
  denied = true;
  fireEvent.click(await screen.findByRole('button', { name: 'Accept extraction attempt' }));
  await waitFor(() => expect(screen.queryByText(/Source revision:/)).toBeNull());
  expect(screen.queryByText(/Report SHA-256:/)).toBeNull();
  expect(await screen.findAllByText('Frozen native source denied.')).toHaveLength(2);
});

test.each([
  ['read-only', ['project.read'], true, true],
  ['editor without execution', ['project.read', 'design.edit', 'source.register'], true, false],
  ['executor without source registration', ['project.read', 'build.execute'], false, true],
  ['executor with source registration', ['project.read', 'source.register', 'build.execute'], false, false],
] as const)('%s permissions gate native extraction request and acceptance', async (_name, permissions, requestOff, acceptOff) => {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    let value: unknown;
    if (url.includes('/sources/')) value = { files: [source] };
    else if (url.includes('/native-options')) value = { available_recipe_id: 'exact-approved' };
    else value = { attempts: [attempt], limit: 100 };
    return new Response(JSON.stringify(value), { status: 200 });
  }));
  wrap(<PermissionsProvider permissions={[...permissions]}><NativeExtraction projectId="project" /></PermissionsProvider>);
  fireEvent.change(screen.getByLabelText('Preserved source revision ID'), { target: { value: SOURCE } });
  await choose('Preserved source file', source.path);
  const accept = await screen.findByRole('button', { name: 'Accept extraction attempt' }) as HTMLButtonElement;
  const request = screen.getByRole('button', { name: 'Request native source extraction' }) as HTMLButtonElement;
  expect(request.hasAttribute('data-readonly-reason')).toBe(requestOff);
  expect(accept.hasAttribute('data-readonly-reason')).toBe(acceptOff);
  expect(request.title).toBe(requestOff ? 'Read-only access: requires Native execution' : '');
  expect(accept.title).toBe(acceptOff ? 'Read-only access: requires Source registration' : '');
  if (requestOff) expect(request.disabled).toBe(true);
  else await waitFor(() => expect(request.disabled).toBe(false));
  if (acceptOff) expect(accept.disabled).toBe(true);
  else expect(accept.disabled).toBe(false);
});
