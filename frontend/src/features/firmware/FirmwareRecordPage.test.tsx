import { MantineProvider } from '@mantine/core';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { PermissionsProvider } from '../../lib/permissions';
import type { Evaluation, Firmware, FirmwareRead, PopulationReview } from './api';
import { FirmwareRecordPage, type FirmwareRecordProps } from './FirmwareRecordPage';
const firmware: Firmware = {
  sources: [{ local_id: 'app', source_revision_id: 'src-rev', source_manifest_sha256: 'm'.repeat(64), files: [{ path: 'src/main.cpp', sha256: 'a'.repeat(64), rights: 'MIT', role: 'application' }] }],
  configuration: [{ key: 'WIFI_PASSWORD', status: 'secret_reference', value: null }],
  toolchain: { family: 'platformio', name: 'PlatformIO Core', version: null, framework: null, board_id: 'synthetic_board' },
  target: { population_revision_id: 'pop-rev', option_id: 'default', component_id: 'mcu', declared_part: 'SYNTH-MCU' },
  pins: [{ signal: 'LED', pad_id: 'pad-2', function: 'gpio_out', peripheral: null, expected_net: 'LED_DRIVE', peer_pad_id: null, basis: null }],
};
function evaluation(readiness: Evaluation['readiness'], findings: Evaluation['findings']): Evaluation {
  return {
    sources: [{ ...firmware.sources[0]!, bundle_name: 'Firmware sources', revision_number: 1, manifest_sha256: 'm'.repeat(64) }],
    target: { population_revision_id: 'pop-rev', population_name: 'Controller fit', population_number: 1, population_snapshot_sha256: 's'.repeat(64), option_id: 'default', option_name: 'Default',
      interpretation_id: 'interp', interpretation_sha256: 'i'.repeat(64), board_source_revision_id: 'board-rev', component: { id: 'mcu', reference: 'U1', value: 'SYNTH-MCU', footprint: 'QFN', native_dnp: false }, declared_part: 'SYNTH-MCU', pads: [] },
    findings, counts: { valid: 0, invalid: 0, unknown: 0, not_evaluated: 0 }, readiness,
    toolchain_support: 'declared_not_verified', compilation: 'not_performed', flashing: 'not_performed', device_operation: 'not_observed',
  };
}
function read(readiness: Evaluation['readiness'], findings: Evaluation['findings'] = [], extra: Partial<FirmwareRead> = {}): FirmwareRead {
  return { definition_id: 'fw', name: 'Controller firmware', draft_id: 'draft-1', state: 'draft-v1', revision_id: null, revision_number: null, snapshot_sha256: null,
    content: { firmware }, evaluation: evaluation(readiness, findings), ...extra };
}
const population: PopulationReview = {
  population: { options: [{ local_id: 'default', name: 'Default fit', decisions: [{ component_id: 'mcu', status: 'populate' }, { component_id: 'led', status: 'omit' }] }] },
  report: {
    components: [{ id: 'mcu', reference: 'U1', value: 'SYNTH-MCU' }, { id: 'led', reference: 'D1', value: 'LED' }],
    pads: [{ id: 'pad-2', component_id: 'mcu', terminal: 'U1.2', net: 'LED_DRIVE', type: 'smd' }, { id: 'pad-led', component_id: 'led', terminal: 'D1.1', net: 'LED_DRIVE', type: 'smd' }],
  },
};
function reply(value: unknown, status = 200) { return new Response(JSON.stringify(value), { status }); }
beforeEach(() => { vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} }); Element.prototype.scrollIntoView = vi.fn(); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });


function server() {
  let denied = false, referencesDenied = false, wrongKind = false, conflict = false, blocked = false, state = 'draft-v1', hold: 'read' | 'save' | 'source' | null = null, complete: ((value: Response) => void) | undefined;
  const reads: string[] = [], writes: { operation: string; payload: any; expected_state?: string }[] = [];
  const draft = () => read(blocked ? 'blocked' : 'declared', blocked ? [{ code: 'target_population', status: 'invalid', message: 'The target is omitted.', subject: {} }] : [], { state });
  const frozen = (number: number) => read('declared', [], { draft_id: null, state: null, revision_id: `fw-r${number}`, revision_number: number, snapshot_sha256: 'f'.repeat(64) });
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    reads.push(url);
    if (url.includes('/catalog/revision-labels?')) { const params = new URL(url, 'http://test').searchParams; return reply({ labels: params.getAll('revision_ids').map(revision_id => ({ revision_id, readable: !referencesDenied })), source_labels: params.getAll('source_revision_ids').map(revision_id => ({ revision_id, readable: !referencesDenied })) }); }
    if (url.includes('/record?')) {
      if (hold === 'read') return new Promise<Response>(resolve => { complete = resolve; });
      if (denied) return reply({ error: { message: 'Firmware record denied' } }, 403);
      const params = new URL(url, 'http://test').searchParams, working = params.has('working') || params.has('draft_id'), number = Number(params.get('revision_number') ?? 75);
      return reply({ definition_id: 'fw', workspace_id: 'w1', kind: wrongKind ? 'part' : 'firmware', name: 'Controller firmware', selected: working ? { kind: 'draft', draft_id: 'draft-1', state, content: { firmware } } : { kind: 'revision', revision_id: `fw-r${number}`, number, snapshot_id: 'snap', sha256: 'f'.repeat(64), content: { firmware } } });
    }
    if (url.endsWith('/firmware-drafts/draft-1')) return denied ? reply({ error: { message: 'Firmware record denied' } }, 403) : reply(draft());
    if (url.includes('/firmware-revisions/fw-r')) return reply(frozen(Number(url.split('fw-r')[1])));
    if (url.endsWith('/firmware-targets')) return reply({ targets: [{ revision_id: 'pop-rev', name: 'Controller fit', number: 1 }] });
    if (url.includes('sources/workspaces/')) return reply({ revisions: [{ revision_id: 'src-rev', name: 'Firmware sources', number: 1 }], next_after: null });
    if (url.endsWith('/population-revisions/pop-rev/review')) return reply(population);
    if (url.endsWith('/sources/revisions/src-rev') && hold === 'source') return new Promise<Response>(resolve => { complete = resolve; });
    if (url.endsWith('/sources/revisions/src-rev')) return reply({ revision_id: 'src-rev', manifest_sha256: 'm'.repeat(64), manifest: { files: [{ path: 'src/main.cpp', sha256: 'a'.repeat(64), rights: 'MIT' }] } });
    if (url.endsWith('/access/workspace')) return reply({ workspace_id: 'w1' });
    if (url.endsWith('/operations')) {
      const body = JSON.parse(String(init?.body)); writes.push(body);
      if (hold === 'save') return new Promise<Response>(resolve => { complete = resolve; });
      if (conflict) return reply({ error: { message: 'Original token conflicts' } }, 409);
      state = 'draft-v2'; return reply({ result: body.operation === 'firmware.freeze' ? { revision_id: 'fw-r76' } : { draft_id: 'draft-1' } });
    }
    throw new Error(`Unexpected workspace/list/build read ${url}`);
  }); vi.stubGlobal('fetch', fetchMock);
  return { reads, writes, draft, frozen, deny: (value: boolean) => { denied = value; }, denyRefs: (value: boolean) => { referencesDenied = value; }, wrongKind: () => { wrongKind = true; }, conflict: () => { conflict = true; }, block: () => { blocked = true; }, advance: () => { state = 'draft-v9'; }, hold: (kind: 'read' | 'save' | 'source') => { hold = kind; }, held: () => complete, release: (value: Response) => { hold = null; complete?.(value); } };
}
function mount(options: Partial<FirmwareRecordProps> = {}, permissions = ['workspace.read', 'item.create', 'design.edit', 'design.freeze']) {
  const callbacks = { onBack: vi.fn(), onSelect: vi.fn(), onCreated: vi.fn() }, client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  let props: FirmwareRecordProps = { active: true, principalKey: 'owner', workspaceId: 'w1', definitionId: 'fw', revisionNumber: null, working: true, ...callbacks, ...options };
  const tree = () => <MantineProvider env="test"><QueryClientProvider client={client}><PermissionsProvider permissions={permissions}><FirmwareRecordPage {...props} /></PermissionsProvider></QueryClientProvider></MantineProvider>;
  const view = render(tree()); return { ...callbacks, rerender: (patch: Partial<FirmwareRecordProps>) => { props = { ...props, ...patch }; view.rerender(tree()); } };
}
async function editName(value = 'Hand authored framework') { const input = await screen.findByRole('textbox', { name: 'Toolchain name' }); fireEvent.change(input, { target: { value } }); return input; }
async function focus() { act(() => window.dispatchEvent(new Event('focus'))); }

test('exact older firmware uses its own state without a workspace list or draft-first fallback', async () => {
  const api = server(); mount({ revisionNumber: 7, working: false });
  await screen.findByRole('button', { name: 'Continue draft' });
  expect(api.reads.some(url => url.includes('/record?revision_number=7'))).toBe(true);
  expect(api.reads.some(url => url.endsWith('/firmware-revisions/fw-r7'))).toBe(true);
  expect(screen.getByText('Frozen r7')).toBeTruthy();
  expect(api.reads.some(url => url.endsWith('/firmware') || url.includes('/workspace/definitions'))).toBe(false);
});
test('returned wrong kind never becomes a readable firmware declaration', async () => {
  const api = server(); api.wrongKind(); mount();
  await screen.findByText('This record is not firmware in the current workspace.');
  expect(screen.queryByRole('textbox', { name: 'Toolchain name' })).toBeNull();
});
test('a blocked exact target disables freezing and never claims a working device', async () => {
  const api = server(); api.block(); mount(); await editName('PlatformIO Core');
  expect(screen.getByText('The target is omitted.')).toBeTruthy();
  expect((screen.getByRole('button', { name: 'Freeze firmware declarations' }) as HTMLButtonElement).disabled).toBe(true);
  expect(screen.getByText(/toolchain support and compilation require separate evidence/)).toBeTruthy();
});
test('save retains typed firmware.update and the original independent CAS token', async () => {
  const api = server(); mount(); await editName(); fireEvent.click(screen.getByRole('button', { name: 'Save firmware draft' }));
  await waitFor(() => expect(api.writes).toHaveLength(1));
  expect(api.writes[0]).toMatchObject({ operation: 'firmware.update', expected_state: 'draft-v1', payload: { draft_id: 'draft-1', firmware: { toolchain: { name: 'Hand authored framework' } } } });
});
test('conflicting update retains the prepared declaration for explicit recovery', async () => {
  const api = server(); api.conflict(); mount(); await editName('Unsaved conflict buffer'); fireEvent.click(screen.getByRole('button', { name: 'Save firmware draft' }));
  await screen.findByText('Original token conflicts'); expect(screen.getByRole('textbox', { name: 'Toolchain name' })).toHaveProperty('value', 'Unsaved conflict buffer');
});
test('readable refresh preserves dirty fields and their original CAS after a newer draft arrives', async () => {
  const api = server(); mount(); await editName('Retained through refresh'); api.advance(); await focus();
  await screen.findByText(/A newer saved draft exists/);
  expect(screen.getByRole('textbox', { name: 'Toolchain name' })).toHaveProperty('value', 'Retained through refresh');
  fireEvent.click(screen.getByRole('button', { name: 'Save firmware draft' })); await waitFor(() => expect(api.writes).toHaveLength(1)); expect(api.writes[0]!.expected_state).toBe('draft-v1');
});
test('focus denial hides source-derived content and restoration retains working values and CAS', async () => {
  const api = server(); mount(); await editName('Prepared private buffer'); api.deny(true); await focus(); await screen.findByText('Firmware record denied');
  expect(screen.queryByRole('textbox', { name: 'Toolchain name' })).toBeNull(); api.deny(false); fireEvent.click(screen.getByRole('button', { name: 'Refresh firmware access' }));
  expect(await screen.findByRole('textbox', { name: 'Toolchain name' })).toHaveProperty('value', 'Prepared private buffer');
  fireEvent.click(screen.getByRole('button', { name: 'Save firmware draft' })); await waitFor(() => expect(api.writes).toHaveLength(1)); expect(api.writes[0]!.expected_state).toBe('draft-v1');
});
test('frozen inspection and rail resume retain the separate unfinished working declaration', async () => {
  server(); const view = mount(); await editName('Working buffer separate from r7'); view.rerender({ working: false, revisionNumber: 7 }); await screen.findByText('Frozen r7');
  view.rerender({ active: false }); await focus(); view.rerender({ active: true, working: true, revisionNumber: null });
  expect(await screen.findByRole('textbox', { name: 'Toolchain name' })).toHaveProperty('value', 'Working buffer separate from r7');
});
test('ordinary field keystrokes keep focus without source authorization reads', async () => {
  const api = server(); mount(); const input = await editName('First'); await waitFor(() => expect(api.reads.filter(url => url.includes('revision-labels')).length).toBeGreaterThan(0));
  const count = api.reads.length; input.focus(); fireEvent.change(input, { target: { value: 'Second' } }); fireEvent.change(input, { target: { value: 'Second letter' } });
  expect(document.activeElement).toBe(input); expect(api.reads).toHaveLength(count);
});
test('retained source denial fences the whole declaration and undo remains a local recovery', async () => {
  const api = server(); mount(); await editName('Retained after source denial'); api.denyRefs(true); await focus(); await screen.findByText(/retained local source is unavailable/);
  expect(screen.queryByRole('textbox', { name: 'Toolchain name' })).toBeNull(); api.denyRefs(false); fireEvent.click(screen.getByRole('button', { name: 'Refresh firmware access' }));
  expect(await screen.findByRole('textbox', { name: 'Toolchain name' })).toHaveProperty('value', 'Retained after source denial');
});
test('freeze uses firmware.freeze with original token and opens only its returned exact revision', async () => {
  const api = server(); const view = mount(); await screen.findByRole('textbox', { name: 'Toolchain name' });
  fireEvent.click(screen.getByRole('button', { name: 'Freeze firmware declarations' })); await waitFor(() => expect(view.onSelect).toHaveBeenCalledWith(76, false));
  expect(api.writes[0]).toMatchObject({ operation: 'firmware.freeze', expected_state: 'draft-v1', payload: { draft_id: 'draft-1' } });
});
test('viewer cannot save or freeze an otherwise readable working declaration', async () => {
  const api = server(); mount({}, ['workspace.read']); await screen.findByRole('textbox', { name: 'Toolchain name' });
  expect((screen.getByRole('button', { name: 'Save firmware draft' }) as HTMLButtonElement).disabled).toBe(true);
  expect((screen.getByRole('button', { name: 'Freeze firmware declarations' }) as HTMLButtonElement).disabled).toBe(true); expect(api.writes).toHaveLength(0);
});
test('held reads cannot disclose old principal state', async () => {
  const api = server(); api.hold('read'); const view = mount(); await waitFor(() => expect(api.held()).toBeDefined());
  view.rerender({ principalKey: 'replacement', active: false }); await act(async () => api.release(reply({ definition_id: 'fw', workspace_id: 'w1', kind: 'firmware', selected: { kind: 'draft', draft_id: 'draft-1', state: 'draft-v1', content: { firmware } } })));
  expect(screen.queryByRole('textbox', { name: 'Toolchain name' })).toBeNull();
});
test('held save after deactivation cannot navigate or replace the retained editor', async () => {
  const api = server(); const view = mount(); await editName('Before held save'); api.hold('save'); fireEvent.click(screen.getByRole('button', { name: 'Save firmware draft' })); await waitFor(() => expect(api.held()).toBeDefined());
  view.rerender({ active: false }); await act(async () => api.release(reply({ result: { draft_id: 'draft-1' } })));
  expect(view.onCreated).not.toHaveBeenCalled(); expect(view.onSelect).not.toHaveBeenCalled();
  view.rerender({ active: true }); expect(await screen.findByRole('textbox', { name: 'Toolchain name' })).toHaveProperty('value', 'Before held save');
});


async function choose(label: string, text: string) {
  const input = await screen.findByRole('combobox', { name: label }); fireEvent.focus(input); fireEvent.keyDown(input, { key: 'ArrowDown' });
  fireEvent.click(await screen.findByRole('option', { name: text, hidden: true }));
}
test('new declaration preserves explicit source roles, unknown pins and typed create operation', async () => {
  const api = server(); const view = mount({ definitionId: null, working: true });
  fireEvent.change(await screen.findByLabelText('Firmware name'), { target: { value: 'Synthetic new declaration' } });
  await choose('Add preserved source revision', 'Firmware sources revision 1');
  await screen.findByText(/manifest mmmmm/);
  await choose('Role for src/main.cpp', 'application');
  await editName('Declared framework');
  fireEvent.click(screen.getByRole('button', { name: 'Add setting' }));
  fireEvent.change(screen.getByLabelText('Configuration key 1'), { target: { value: 'API_TOKEN' } });
  await choose('Configuration status 1', 'Secret reference (value not stored)');
  await choose('Frozen population revision', 'Controller fit revision 1');
  await choose('Population option', 'Default fit');
  await choose('Target component', 'U1 SYNTH-MCU · populate');
  fireEvent.click(screen.getByRole('button', { name: 'Add signal' }));
  fireEvent.change(screen.getByLabelText('Signal 1'), { target: { value: 'Unknown pad signal' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save firmware draft' }));
  await waitFor(() => expect(view.onCreated).toHaveBeenCalledWith('fw', true));
  expect(api.writes[0]).toMatchObject({ operation: 'firmware.create', payload: { workspace_id: 'w1', name: 'Synthetic new declaration', firmware: { sources: [{ source_revision_id: 'src-rev', files: [{ role: 'application' }] }], configuration: [{ key: 'API_TOKEN', status: 'secret_reference', value: null }], pins: [{ signal: 'Unknown pad signal', pad_id: null, expected_net: null, peer_pad_id: null }] } } });
});
test('freezing refreshes the working token before a later update', async () => {
  const api = server(); const view = mount(); await screen.findByRole('textbox', { name: 'Toolchain name' });
  fireEvent.click(screen.getByRole('button', { name: 'Freeze firmware declarations' })); await waitFor(() => expect(view.onSelect).toHaveBeenCalledWith(76, false));
  view.rerender({ working: false, revisionNumber: 76 }); await screen.findByText('Frozen r76');
  view.rerender({ working: true, revisionNumber: null }); await editName('New edits after freeze');
  fireEvent.click(screen.getByRole('button', { name: 'Save firmware draft' })); await waitFor(() => expect(api.writes).toHaveLength(2));
  expect(api.writes[1]).toMatchObject({ operation: 'firmware.update', expected_state: 'draft-v2' });
});


test('a held source choice cannot populate a hidden and reopened new declaration', async () => {
  const api = server(); const view = mount({ definitionId: null, working: true }); await screen.findByLabelText('Firmware name'); api.hold('source');
  await choose('Add preserved source revision', 'Firmware sources revision 1'); await waitFor(() => expect(api.held()).toBeDefined());
  view.rerender({ active: false }); view.rerender({ active: true });
  await act(async () => api.release(reply({ revision_id: 'src-rev', manifest_sha256: 'm'.repeat(64), manifest: { files: [{ path: 'src/main.cpp', sha256: 'a'.repeat(64), rights: 'MIT' }] } })));
  await screen.findByRole('textbox', { name: 'Toolchain name' }); expect(screen.queryByText('src/main.cpp · MIT')).toBeNull(); expect(api.writes).toHaveLength(0);
});
