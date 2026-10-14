import { MantineProvider } from '@mantine/core';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { StrictMode } from 'react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { FirmwareRead } from '../firmware/api';
import type { OccurrenceInspection, SelectionReview } from './api';
import { FirmwareOccurrencesPanel } from './FirmwareOccurrencesPanel';

const declared: FirmwareRead = {
  definition_id: 'fw', name: 'Independent controller', draft_id: null, state: null, revision_id: 'fw-900', revision_number: 2, snapshot_sha256: 'f'.repeat(64),
  content: { firmware: { sources: [{ local_id: 'app', source_revision_id: 'source-exact', source_manifest_sha256: 'a'.repeat(64), files: [{ path: 'main.cpp', sha256: 'b'.repeat(64), rights: 'MIT', role: 'application' }] }],
    configuration: [{ key: 'BLINK_MS', status: 'known', value: '900' }, { key: 'API_KEY', status: 'secret_reference', value: null }],
    toolchain: { family: 'platformio', name: 'Declared compiler', version: null, framework: null, board_id: null },
    target: { population_revision_id: 'same-copper', option_id: 'default', component_id: 'native-mcu', declared_part: null }, pins: [] } },
  evaluation: { sources: [], target: { population_revision_id: 'same-copper', population_name: 'Board', population_number: 1, population_snapshot_sha256: 'p'.repeat(64), option_id: 'default', option_name: 'Default', interpretation_id: 'native-report', interpretation_sha256: 'r'.repeat(64), board_source_revision_id: 'board-source', component: null, declared_part: null, pads: [] },
    findings: [{ code: 'toolchain_version', status: 'unknown', message: 'Toolchain version is unknown.', subject: {} }], counts: { valid: 0, invalid: 0, unknown: 1, not_evaluated: 0 }, readiness: 'declared_with_unknowns', toolchain_support: 'declared_not_verified', compilation: 'not_performed', flashing: 'not_performed', device_operation: 'not_observed' },
};
const inspection: OccurrenceInspection = {
  draft_id: 'assembly-draft', snapshot_id: null, state: 'draft-v3', adoptions: [], history_truncated: false,
  occurrences: ['left', 'right'].map((local) => ({ path: [local, 'board'], display_ref: 'A1', name: 'Repeated board', kind: 'pcb_population', revision_id: 'same-copper', snapshot_sha256: 'p'.repeat(64), firmware_revision_id: 'fw-500' })),
};
const preview: SelectionReview = { draft_id: 'assembly-draft', path: ['right', 'board'], firmware_revision_id: 'fw-900', state: 'draft-v3', review_sha256: 'c'.repeat(64), occurrence_revision_id: 'same-copper', occurrence_snapshot_sha256: 'p'.repeat(64), display_ref: 'A1', eligible: true, message: 'Exact frozen population target.', previous: null, candidate: declared };
function response(value: unknown, status = 200) { return new Response(JSON.stringify(value), { status }); }

beforeEach(() => { vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} }); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function setup(options: { canEdit?: boolean; eligible?: boolean; lostResponse?: boolean; strict?: boolean } = {}) {
  const bodies: Record<string, any>[] = [];
  let denied = false;
  let adoptionCalls = 0;
  const mock = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith('/definitions')) return response([{ definition_id: 'asm', name: 'Synthetic pair', kind: 'assembly' }]);
    if (url.endsWith('/firmware')) return response({ firmware: [{ definition_id: 'fw', name: 'Independent controller', draft_id: 'fw-draft', revisions: [{ revision_id: 'fw-900', number: 2 }] }] });
    if (url.includes('/catalog/definitions/asm')) return response({ definition_id: 'asm', name: 'Synthetic pair', kind: 'assembly', drafts: [{ draft_id: 'assembly-draft', state: 'draft-v3', dependencies: [] }], revisions: [{ revision_id: 'frozen-asm', number: 1 }] });
    if (url.endsWith('/revisions/frozen-asm')) return response({ snapshot_id: 'frozen-snapshot' });
    if (url.includes('/firmware-builds/firmware/')) {
      const query = new URL(url, 'http://localhost').searchParams;
      return response({ inputs: { ...declared.content.firmware, adapter: 'firmware-avr-gcc-v1', firmware_revision_id: 'fw-500', firmware_snapshot_sha256: 'f'.repeat(64),
        occurrence: { assembly_snapshot_id: query.get('assembly_snapshot_id'), assembly_snapshot_sha256: 'a'.repeat(64), path: query.get('path')!.split('/'), population_revision_id: 'same-copper', population_snapshot_sha256: 'p'.repeat(64) } },
        available_recipe_id: null, unavailable_reason: 'Declared toolchain is unsupported by the installed profile.', builds: [], truncated: false });
    }
    if (url.endsWith('/operations')) {
      const body = JSON.parse(String(init?.body)); bodies.push(body);
      if (denied) return response({ error: { message: 'Source authority unavailable' } }, 404);
      if (body.operation === 'firmware_occurrence.inspect') return response({ result: body.payload.snapshot_id ? { ...inspection, draft_id: null, state: null, snapshot_id: 'frozen-snapshot' } : inspection });
      if (body.operation === 'firmware_occurrence.review') return response({ result: { ...preview, eligible: options.eligible ?? true, message: options.eligible === false ? 'Wrong exact population target.' : preview.message } });
      if (body.operation === 'firmware_occurrence.adopt') {
        adoptionCalls++;
        if (options.lostResponse && adoptionCalls === 1) throw new Error('Response unavailable');
        return response({ result: { adoption_id: 'adoption-1', state: 'draft-v4' } });
      }
    }
    throw new Error(`Unexpected request ${url}`);
  });
  vi.stubGlobal('fetch', mock);
  const panel = <MantineProvider><FirmwareOccurrencesPanel projectId="project-a" permissions={options.canEdit === false ? ['project.read'] : ['design.edit']} /></MantineProvider>;
  const rendered = render(options.strict ? <StrictMode>{panel}</StrictMode> : panel);
  return { bodies, mock, deny: () => { denied = true; }, restore: () => { denied = false; }, rendered };
}
async function open(frozen = false) {
  fireEvent.click(screen.getByRole('button', { name: 'Show occurrence firmware' }));
  await screen.findByRole('option', { name: 'Synthetic pair' });
  fireEvent.change(screen.getByLabelText('Owning assembly'), { target: { value: 'asm' } });
  await screen.findByLabelText('Assembly draft or frozen revision');
  fireEvent.change(screen.getByLabelText('Assembly draft or frozen revision'), { target: { value: frozen ? 'revision:frozen-asm' : 'draft:assembly-draft' } });
  await screen.findByRole('cell', { name: 'left/board · A1' });
}
async function review() {
  fireEvent.change(screen.getByLabelText('Exact board occurrence'), { target: { value: JSON.stringify(['right', 'board']) } });
  fireEvent.change(screen.getByLabelText('Frozen firmware for this occurrence'), { target: { value: 'fw-900' } });
  fireEvent.click(screen.getByRole('button', { name: 'Review occurrence firmware selection' }));
  await screen.findByText('BLINK_MS=900');
}

test('frozen compile inspection pins one repeated board and hides execution without its grant', async () => {
  const { mock } = setup({ canEdit: false }); await open(true);
  fireEvent.change(screen.getByLabelText('Frozen board occurrence for compilation'), { target: { value: JSON.stringify(['right', 'board']) } });
  await screen.findByRole('heading', { name: 'Firmware compile and handoff' });
  expect(await screen.findByText(/occurrence right \/ board/)).toBeTruthy();
  expect(mock.mock.calls.some(([url]) => url === '/api/v0/firmware-builds/firmware/fw-500?assembly_snapshot_id=frozen-snapshot&path=right%2Fboard')).toBe(true);
  expect(screen.queryByRole('button', { name: 'Request firmware compile' })).toBeNull();
  fireEvent.change(screen.getByLabelText('Frozen board occurrence for compilation'), { target: { value: JSON.stringify(['left', 'board']) } });
  expect(await screen.findByText(/occurrence left \/ board/)).toBeTruthy();
  expect(screen.queryByText(/occurrence right \/ board/)).toBeNull();
});

test('occurrence module stays lazy until opened', () => {
  const { mock } = setup();
  expect(mock).not.toHaveBeenCalled();
});

test('nested repeated board selection shows exact config/source pins and requires deliberate adoption', async () => {
  const { bodies } = setup();
  await open(); await review();
  expect(screen.getByText('API_KEY=[secret reference]')).toBeTruthy();
  expect(screen.getAllByText('source-exact', { selector: 'code' }).length).toBeGreaterThan(0);
  expect(screen.getByText(/Native component native-mcu/)).toBeTruthy();
  expect(screen.getByText(/Compilation: not performed/)).toBeTruthy();
  expect((screen.getByRole('button', { name: 'Adopt reviewed firmware selection' }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.change(screen.getByLabelText('Firmware adoption review basis'), { target: { value: 'Reviewed right controller timing' } });
  fireEvent.click(screen.getByRole('button', { name: 'Adopt reviewed firmware selection' }));
  await waitFor(() => expect(bodies.some((body) => body.operation === 'firmware_occurrence.adopt')).toBe(true));
  const request = bodies.find((body) => body.operation === 'firmware_occurrence.adopt')!;
  expect(request).toMatchObject({ expected_state: 'draft-v3', payload: { draft_id: 'assembly-draft', path: ['right', 'board'], firmware_revision_id: 'fw-900', review_sha256: 'c'.repeat(64), basis: 'Reviewed right controller timing' } });
  expect(request.idempotency_key).toBeTruthy();
  expect(bodies.filter((body) => body.operation !== 'firmware_occurrence.adopt').every((body) => body.idempotency_key === undefined)).toBe(true);
});

test('read-only accounts may review but cannot adopt and wrong targets stay blocked', async () => {
  setup({ canEdit: false, eligible: false });
  await open(); await review();
  expect(screen.getByText('Wrong exact population target.')).toBeTruthy();
  fireEvent.change(screen.getByLabelText('Firmware adoption review basis'), { target: { value: 'Attempted review' } });
  expect((screen.getByRole('button', { name: 'Adopt reviewed firmware selection' }) as HTMLButtonElement).disabled).toBe(true);
});

test('changing the selected occurrence clears its review before another adoption', async () => {
  setup(); await open(); await review();
  fireEvent.change(screen.getByLabelText('Exact board occurrence'), { target: { value: JSON.stringify(['left', 'board']) } });
  expect(screen.queryByText('BLINK_MS=900')).toBeNull();
  expect(screen.queryByRole('button', { name: 'Adopt reviewed firmware selection' })).toBeNull();
});

test('focus denial discards retained rows, configuration and source evidence', async () => {
  const { deny } = setup(); await open(); await review();
  deny(); fireEvent(window, new Event('focus'));
  await screen.findByText('Source authority unavailable');
  expect(screen.queryByText('BLINK_MS=900')).toBeNull();
  expect(screen.queryByRole('cell', { name: 'left/board · A1' })).toBeNull();
  expect(screen.queryAllByText('source-exact', { selector: 'code' })).toHaveLength(0);
});

test('lost response retry keeps the reviewed request key and payload', async () => {
  const { bodies } = setup({ lostResponse: true }); await open(); await review();
  fireEvent.change(screen.getByLabelText('Firmware adoption review basis'), { target: { value: 'Reviewed config' } });
  fireEvent.click(screen.getByRole('button', { name: 'Adopt reviewed firmware selection' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Retry reviewed firmware adoption' }));
  await waitFor(() => expect(bodies.filter((body) => body.operation === 'firmware_occurrence.adopt')).toHaveLength(2));
  const calls = bodies.filter((body) => body.operation === 'firmware_occurrence.adopt');
  expect(calls[0]!.idempotency_key).toBe(calls[1]!.idempotency_key);
  expect(calls[0]!.payload).toEqual(calls[1]!.payload);
  expect(calls[0]!.expected_state).toBe(calls[1]!.expected_state);
});

test('frozen assembly inspection resolves exact snapshot with no mutation controls', async () => {
  const { bodies } = setup(); await open(true);
  expect(bodies.find((body) => body.operation === 'firmware_occurrence.inspect')).toMatchObject({ payload: { snapshot_id: 'frozen-snapshot' } });
  expect(screen.queryByLabelText('Exact board occurrence')).toBeNull();
});

test('project changes unmount retained selections and evidence', async () => {
  const { rendered } = setup(); await open(); await review();
  rendered.rerender(<MantineProvider><FirmwareOccurrencesPanel projectId="project-b" permissions={['design.edit']} /></MantineProvider>);
  expect(screen.queryByText('BLINK_MS=900')).toBeNull();
  expect(screen.getByRole('button', { name: 'Show occurrence firmware' })).toBeTruthy();
});


test('response-loss retry survives denied refresh and later authority restoration', async () => {
  const { bodies, deny, restore } = setup({ lostResponse: true }); await open(); await review();
  fireEvent.change(screen.getByLabelText('Firmware adoption review basis'), { target: { value: 'Retained deliberate review' } });
  fireEvent.click(screen.getByRole('button', { name: 'Adopt reviewed firmware selection' }));
  await screen.findByText('Response unavailable');
  deny(); fireEvent(window, new Event('focus'));
  await screen.findByText('Source authority unavailable');
  expect(screen.queryByText('BLINK_MS=900')).toBeNull();
  expect(screen.queryByRole('cell', { name: 'left/board · A1' })).toBeNull();
  restore(); fireEvent.click(screen.getByRole('button', { name: 'Refresh occurrence firmware' }));
  await screen.findByRole('cell', { name: 'left/board · A1' });
  fireEvent.click(screen.getByRole('button', { name: 'Retry reviewed firmware adoption' }));
  await waitFor(() => expect(bodies.filter(body => body.operation === 'firmware_occurrence.adopt')).toHaveLength(2));
  const calls = bodies.filter(body => body.operation === 'firmware_occurrence.adopt');
  expect(calls[1]!.payload).toEqual(calls[0]!.payload);
  expect(calls[1]!.expected_state).toEqual(calls[0]!.expected_state);
  expect(calls[1]!.idempotency_key).toEqual(calls[0]!.idempotency_key);
  await waitFor(() => expect((screen.getByRole('button', { name: 'Refresh occurrence firmware' }) as HTMLButtonElement).disabled).toBe(false));
  expect(screen.queryByRole('button', { name: 'Retry reviewed firmware adoption' })).toBeNull();
});

function delayed() {
  let resolve!: (value: Response) => void;
  const promise = new Promise<Response>(done => { resolve = done; });
  return { promise, resolve };
}

test.each([200, 404])('a delayed previous selection review (%s) does not restore data or block the new path', async status => {
  const { mock } = setup(); await open();
  const pending = delayed();
  const allowed = mock.getMockImplementation()!;
  mock.mockImplementation((url, init) => {
    const body = url.endsWith('/operations') ? JSON.parse(String(init?.body)) : null;
    return body?.operation === 'firmware_occurrence.review' ? pending.promise : allowed(url, init);
  });
  fireEvent.change(screen.getByLabelText('Exact board occurrence'), { target: { value: JSON.stringify(['right', 'board']) } });
  fireEvent.change(screen.getByLabelText('Frozen firmware for this occurrence'), { target: { value: 'fw-900' } });
  fireEvent.click(screen.getByRole('button', { name: 'Review occurrence firmware selection' }));
  fireEvent.change(screen.getByLabelText('Exact board occurrence'), { target: { value: JSON.stringify(['left', 'board']) } });
  await act(async () => { pending.resolve(status === 200 ? response({ result: preview }) : response({ error: { message: 'Old selection denied' } }, 404)); await pending.promise; });
  expect(screen.queryByText('BLINK_MS=900')).toBeNull();
  expect(screen.queryByText('Old selection denied')).toBeNull();
  expect((screen.getByLabelText('Exact board occurrence') as HTMLSelectElement).value).toBe(JSON.stringify(['left', 'board']));
  expect((screen.getByRole('button', { name: 'Refresh occurrence firmware' }) as HTMLButtonElement).disabled).toBe(false);
});

test('StrictMode cleanup fences the first delayed inspection and keeps the current workspace usable', async () => {
  const { mock } = setup({ strict: true });
  const pending = delayed();
  const allowed = mock.getMockImplementation()!;
  let inspections = 0;
  mock.mockImplementation((url, init) => {
    const body = url.endsWith('/operations') ? JSON.parse(String(init?.body)) : null;
    if (body?.operation === 'firmware_occurrence.inspect' && ++inspections === 1) return pending.promise;
    return allowed(url, init);
  });
  await open();
  await act(async () => { pending.resolve(response({ error: { message: 'Detached inspection denied' } }, 404)); await pending.promise; });
  expect(screen.queryByText('Detached inspection denied')).toBeNull();
  expect(screen.getByRole('cell', { name: 'left/board · A1' })).toBeTruthy();
  expect((screen.getByRole('button', { name: 'Refresh occurrence firmware' }) as HTMLButtonElement).disabled).toBe(false);
});
