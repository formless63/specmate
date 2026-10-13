import { MantineProvider } from '@mantine/core';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { Evaluation, Firmware, FirmwareRead, PopulationReview } from './api';
import { FirmwarePanel } from './FirmwarePanel';

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

function setup(options: { draft?: FirmwareRead; revision?: FirmwareRead; commands?: Response[]; permissions?: string[] } = {}) {
  const bodies: Record<string, any>[] = [];
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith('/firmware')) return reply({ firmware: [{ definition_id: 'fw', name: 'Controller firmware', draft_id: 'draft-1', revisions: options.revision ? [{ revision_id: 'fw-rev', number: 1 }] : [] }] });
    if (url.endsWith('/firmware-targets')) return reply({ targets: [{ revision_id: 'pop-rev', name: 'Controller fit', number: 1, snapshot_sha256: 's'.repeat(64) }] });
    if (url.includes('sources/projects/')) return reply({ revisions: [{ revision_id: 'src-rev', bundle_id: 'b', name: 'Firmware sources', role: 'original', number: 1, manifest_sha256: 'm'.repeat(64), derived_from: null }], next_after: null });
    if (url.endsWith('sources/revisions/src-rev')) return reply({ revision_id: 'src-rev', name: 'Firmware sources', role: 'original', number: 1, manifest_sha256: 'm'.repeat(64), derived_from: null, expansion: null,
      manifest: { ancestry: [], files: [{ path: 'src/main.cpp', sha256: 'a'.repeat(64), bytes: 10, media_type: 'text/plain', rights: 'MIT' }] } });
    if (url.endsWith('/population-revisions/pop-rev/review')) return reply(population);
    if (url.endsWith('/firmware-drafts/draft-1')) return reply(options.draft ?? read('declared'));
    if (url.endsWith('/firmware-revisions/fw-rev')) return reply(options.revision ?? read('declared'));
    if (url.endsWith('/firmware-review')) return reply({ assembly_snapshot_id: 'asm', assignments: [{ path: ['left'], display_ref: 'A1', occurrence_revision_id: 'other-pop', occurrence_kind: 'pcb_population', firmware_revision_id: 'fw-rev', firmware_name: 'Controller firmware', status: 'invalid', message: 'Wrong target: the firmware targets a different population revision.' }] });
    if (url.endsWith('/operations')) { bodies.push(JSON.parse(String(init?.body))); return options.commands?.shift() ?? reply({ result: { draft_id: 'draft-1', revision_id: 'fw-rev' } }); }
    throw new Error(`Unexpected route ${url}`);
  });
  vi.stubGlobal('fetch', fetchMock);
  render(<MantineProvider><FirmwarePanel projectId="project-a" permissions={options.permissions} /></MantineProvider>);
  return { bodies, fetchMock };
}
async function show() { fireEvent.click(screen.getByRole('button', { name: 'Show firmware' })); await screen.findByText('Controller firmware'); }

test('nothing is requested until firmware is opened', () => {
  const { fetchMock } = setup();
  expect(fetchMock).not.toHaveBeenCalled();
});

test('invalid target blocks freezing and is never described as a working build', async () => {
  setup({ draft: read('blocked', [{ code: 'target_population', status: 'invalid', message: 'The target component is omitted in the selected population option.', subject: {} }]) });
  await show();
  fireEvent.click(screen.getByRole('button', { name: 'Open Controller firmware draft' }));
  expect(await screen.findByText(/do not describe a working build/)).toBeTruthy();
  expect(screen.getByText('The target component is omitted in the selected population option.')).toBeTruthy();
  expect(screen.getByText(/Compilation: not performed · Flashing: not performed/)).toBeTruthy();
  expect((screen.getByRole('button', { name: 'Freeze firmware declarations' }) as HTMLButtonElement).disabled).toBe(true);
});

test('declared draft freezes with its state token and reopens the exact revision', async () => {
  const { bodies } = setup({
    draft: read('declared_with_unknowns', [{ code: 'toolchain_version', status: 'unknown', message: 'The toolchain version is unknown.', subject: {} }]),
    revision: read('declared_with_unknowns', [], { draft_id: null, state: null, revision_id: 'fw-rev', revision_number: 1, snapshot_sha256: 'f'.repeat(64) }),
  });
  await show();
  fireEvent.click(screen.getByRole('button', { name: 'Open Controller firmware draft' }));
  await screen.findByText('The toolchain version is unknown.');
  expect(screen.getByText(/version unknown/)).toBeTruthy();
  expect(screen.getByText(/WIFI_PASSWORD=\[secret reference\]/)).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Freeze firmware declarations' }));
  await screen.findByText(`Snapshot SHA-256 ${'f'.repeat(64)}`);
  expect(bodies[0]).toMatchObject({ operation: 'firmware.freeze', expected_state: 'draft-v1', payload: { draft_id: 'draft-1' } });
  expect(screen.queryByRole('button', { name: 'Freeze firmware declarations' })).toBeNull();
});

test('authoring pins exact sources, target component and pads without inferring them', async () => {
  const { bodies } = setup();
  await show();
  fireEvent.click(screen.getByRole('button', { name: 'New firmware declaration' }));
  fireEvent.change(screen.getByLabelText('Firmware name'), { target: { value: 'New controller firmware' } });
  fireEvent.click(screen.getByRole('option', { name: 'Firmware sources revision 1', hidden: true }));
  await screen.findByText('src/main.cpp · MIT');
  fireEvent.click(screen.getByRole('option', { name: 'application', hidden: true }));
  fireEvent.change(screen.getByLabelText('Toolchain name'), { target: { value: 'PlatformIO Core' } });
  fireEvent.click(screen.getByRole('button', { name: 'Add setting' }));
  fireEvent.change(screen.getByLabelText('Configuration key 1'), { target: { value: 'API_TOKEN' } });
  fireEvent.click(screen.getByRole('option', { name: 'Secret reference (value not stored)', hidden: true }));
  fireEvent.click(screen.getByRole('option', { name: 'Controller fit revision 1', hidden: true }));
  fireEvent.click(await screen.findByRole('option', { name: 'Default fit', hidden: true }));
  expect(screen.getByRole('option', { name: 'D1 LED · omit', hidden: true })).toBeTruthy();
  fireEvent.click(screen.getByRole('option', { name: 'U1 SYNTH-MCU · populate', hidden: true }));
  fireEvent.click(screen.getByRole('button', { name: 'Add signal' }));
  fireEvent.change(screen.getByLabelText('Signal 1'), { target: { value: 'LED' } });
  fireEvent.click(screen.getByRole('button', { name: 'Add signal' }));
  fireEvent.change(screen.getByLabelText('Signal 2'), { target: { value: 'SPARE' } });
  fireEvent.click(screen.getAllByRole('option', { name: 'U1.2', hidden: true })[0]!);
  fireEvent.change(screen.getByLabelText('Expected net for signal 1'), { target: { value: 'LED_DRIVE' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save firmware draft' }));
  await waitFor(() => expect(bodies).toHaveLength(1));
  const payload = bodies[0]!.payload;
  expect(bodies[0]!.operation).toBe('firmware.create');
  expect(payload.firmware.sources[0]).toEqual({ local_id: 'src1', source_revision_id: 'src-rev', source_manifest_sha256: 'm'.repeat(64), files: [{ path: 'src/main.cpp', sha256: 'a'.repeat(64), rights: 'MIT', role: 'application' }] });
  expect(payload.firmware.configuration).toEqual([{ key: 'API_TOKEN', status: 'secret_reference', value: null }]);
  expect(payload.firmware.target).toEqual({ population_revision_id: 'pop-rev', option_id: 'default', component_id: 'mcu', declared_part: null });
  expect(payload.firmware.pins).toEqual([
    { signal: 'LED', pad_id: 'pad-2', function: 'gpio_in', peripheral: null, expected_net: 'LED_DRIVE', peer_pad_id: null, basis: null },
    { signal: 'SPARE', pad_id: null, function: 'gpio_in', peripheral: null, expected_net: null, peer_pad_id: null, basis: null },
  ]);
  expect(payload.firmware.toolchain.version).toBeNull();
});

test('stale draft update keeps the unsaved form for deliberate recovery', async () => {
  const { bodies } = setup({ commands: [reply({ error: { message: 'Draft changed since expected state.' } }, 409)] });
  await show();
  fireEvent.click(screen.getByRole('button', { name: 'Open Controller firmware draft' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Edit firmware draft' }));
  fireEvent.change(screen.getByLabelText('Toolchain version'), { target: { value: '6.1.18' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save firmware draft' }));
  expect(await screen.findByText('Draft changed since expected state.')).toBeTruthy();
  expect(bodies[0]).toMatchObject({ operation: 'firmware.update', expected_state: 'draft-v1' });
  expect((screen.getByLabelText('Toolchain version') as HTMLInputElement).value).toBe('6.1.18');
});

test('assignment review shows a wrong target and viewers get no authoring controls', async () => {
  setup({ permissions: ['project.read'] });
  await show();
  expect(screen.queryByRole('button', { name: 'New firmware declaration' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Open Controller firmware draft' }));
  await screen.findByText(/Toolchain: platformio/);
  expect(screen.queryByRole('button', { name: 'Edit firmware draft' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Freeze firmware declarations' })).toBeNull();
  fireEvent.change(screen.getByLabelText('Frozen assembly snapshot ID'), { target: { value: 'asm' } });
  fireEvent.click(screen.getByRole('button', { name: 'Review firmware assignments' }));
  expect(await screen.findByText('Wrong target: the firmware targets a different population revision.')).toBeTruthy();
});

test('access loss clears retained firmware data', async () => {
  const { fetchMock } = setup();
  await show();
  fireEvent.click(screen.getByRole('button', { name: 'Open Controller firmware draft' }));
  await screen.findByText(/Toolchain: platformio/);
  fetchMock.mockImplementation(async () => reply({ error: { message: 'Not found.' } }, 404));
  fireEvent.click(screen.getByRole('button', { name: 'Refresh firmware' }));
  await screen.findByText('Not found.');
  expect(screen.queryByText(/Toolchain: platformio/)).toBeNull();
  expect(screen.queryByText('Controller firmware')).toBeNull();
});

test('refresh rechecks the open firmware even when project lists still succeed', async () => {
  const { fetchMock } = setup();
  await show();
  fireEvent.click(screen.getByRole('button', { name: 'Open Controller firmware draft' }));
  await screen.findByText(/Toolchain: platformio/);
  const allowed = fetchMock.getMockImplementation()!;
  fetchMock.mockImplementation(async (url, init) => url.endsWith('/firmware-drafts/draft-1')
    ? reply({ error: { message: 'Source origin unavailable.' } }, 404) : allowed(url, init));
  fireEvent.click(screen.getByRole('button', { name: 'Refresh firmware' }));
  await screen.findByText('Source origin unavailable.');
  expect(screen.queryByText(/Toolchain: platformio/)).toBeNull();
  expect(screen.queryByRole('button', { name: 'Freeze firmware declarations' })).toBeNull();
});

test('a denied save rechecks retained authority and hides revoked source choices', async () => {
  const { fetchMock } = setup({ commands: [reply({ error: { message: 'Source unavailable.' } }, 404)] });
  await show();
  fireEvent.click(screen.getByRole('button', { name: 'Open Controller firmware draft' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Edit firmware draft' }));
  await screen.findByRole('option', { name: 'U1 SYNTH-MCU · populate', hidden: true });
  fireEvent.change(screen.getByLabelText('Toolchain version'), { target: { value: '6.1.18' } });
  const allowed = fetchMock.getMockImplementation()!;
  fetchMock.mockImplementation(async (url, init) => url.endsWith('/firmware-drafts/draft-1')
    ? reply({ error: { message: 'Retained source revoked.' } }, 404) : allowed(url, init));
  fireEvent.click(screen.getByRole('button', { name: 'Save firmware draft' }));
  await screen.findByText('Retained source revoked.');
  expect(screen.queryByLabelText('Toolchain version')).toBeNull();
  expect(screen.queryByText('src/main.cpp · MIT')).toBeNull();
});

test('authorized refresh preserves unsaved edits and their original state token', async () => {
  const { fetchMock, bodies } = setup();
  await show();
  fireEvent.click(screen.getByRole('button', { name: 'Open Controller firmware draft' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Edit firmware draft' }));
  fireEvent.change(screen.getByLabelText('Toolchain version'), { target: { value: '6.1.18' } });
  const allowed = fetchMock.getMockImplementation()!;
  fetchMock.mockImplementation(async (url, init) => url.endsWith('/firmware-drafts/draft-1')
    ? reply(read('declared', [], { state: 'draft-v2' })) : allowed(url, init));
  fireEvent.click(screen.getByRole('button', { name: 'Refresh firmware' }));
  await waitFor(() => expect(fetchMock.mock.calls.filter(([url]) => url.endsWith('/firmware-drafts/draft-1'))).toHaveLength(2));
  expect((screen.getByLabelText('Toolchain version') as HTMLInputElement).value).toBe('6.1.18');
  fireEvent.click(screen.getByRole('button', { name: 'Save firmware draft' }));
  await waitFor(() => expect(bodies).toHaveLength(1));
  expect(bodies[0]!.expected_state).toBe('draft-v1');
});
