import { byContent } from "../../test/text";
import { grants } from "../../test/grants";
import { PermissionsProvider } from "../../lib/permissions";
import { MantineProvider } from '@mantine/core';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { StrictMode } from 'react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { command } from '../sources/api';
import { FirmwareBuildPanel } from './FirmwareBuildPanel';
import { cancelBuild, readHistory, retryBuild, type BuildHistory } from '../builds/api';
import { compileOptions, compileReview, listResolvedConfigurations, type CompileOptions, type CompileReview } from './api';

vi.mock('./api', async original => ({ ...(await original<typeof import('./api')>()), compileOptions: vi.fn(), compileReview: vi.fn(), listResolvedConfigurations: vi.fn() }));
vi.mock('../builds/api', () => ({ cancelBuild: vi.fn(), readHistory: vi.fn(), retryBuild: vi.fn() }));
vi.mock('../sources/api', async original => ({ ...(await original<typeof import('../sources/api')>()), command: vi.fn() }));
const options: CompileOptions = {
  workspace_id: 'workspace-one', available_recipe_id: 'approved-compiler', unavailable_reason: null, builds: [{ build_id: 'build-one', state: 'succeeded', failure: null, retry_of: 'build-zero', requested_by_viewer: false, state_token: 'tok-0', cancel_available: false, retry_available: false }], truncated: false,
  inputs: { schema_version: '1', adapter: 'firmware-avr-gcc-v1', firmware_revision_id: 'firmware-one', firmware_snapshot_sha256: 'firmware-snapshot', occurrence: null,
    sources: [{ local_id: 'app', source_revision_id: 'source-one', source_manifest_sha256: 'source-manifest', files: [{ path: 'synthetic-main.c', sha256: 'source-hash', rights: 'MIT', role: 'application' }] }],
    configuration: [{ key: 'COUNT', status: 'known', value: '7' }], toolchain: { family: 'other', name: 'avr-gcc', version: '5.4.0', framework: 'baremetal', board_id: 'atmega328p' },
    target: { population_revision_id: 'population-one', option_id: 'default', component_id: 'native-one', declared_part: null }, pins: [] },
};
const evidence: CompileReview = {
  reference: { firmware_revision_id: 'firmware-one', build_id: 'build-one' }, retry_of: 'build-zero',
  lineage: [{ build_id: 'build-zero', state: 'failed', current: false }, { build_id: 'build-one', state: 'succeeded', current: true }], inputs: options.inputs, image: 'exact-compiler-image', recipe_id: 'approved-compiler', report_sha256: 'report-hash',
  report: { compiler_version: '5.4.0', tool_packages: { 'gcc-avr': 'exact-package' }, flashing: 'not_performed', device_operation: 'not_observed', hardware_compatibility: 'not_evaluated', physical_qualification: false },
  outputs: [{ output_id: 'output-one', path: 'handoff.json', sha256: 'handoff-hash', rights: 'MIT', size: 100, media_type: 'application/json' }],
};
beforeEach(() => { vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} }); Element.prototype.scrollIntoView = vi.fn(); vi.mocked(compileOptions).mockResolvedValue(options); vi.mocked(compileReview).mockResolvedValue(evidence); vi.mocked(command).mockResolvedValue({ build_id: 'new-one' });
  vi.mocked(listResolvedConfigurations).mockResolvedValue({ truncated: false, resolved: [] }); });
afterEach(() => { cleanup(); vi.resetAllMocks(); });
const panel = (canExecute = false, firmware = 'firmware-one') => <MantineProvider env="test"><PermissionsProvider permissions={grants({ execute: canExecute })}><FirmwareBuildPanel firmware_revision_id={firmware} /></PermissionsProvider></MantineProvider>;

test('read-only handoff retains exact source/configuration and separate qualification claims', async () => {
  render(panel()); fireEvent.click(await screen.findByRole('button', { name: 'Inspect firmware handoff build-one' }));
  await screen.findByText('Registered compiler handoff');
  expect(screen.getByRole('link', { name: 'handoff.json' }).getAttribute('href')).toContain('/builds/build-one/outputs/output-one');
  expect(screen.getByText(/hardware compatibility remains unevaluated/)).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Request firmware compile' })).toBeNull();
});
test('source consent and basis are separate from installed recipe approval', async () => {
  render(panel(true)); const button = await screen.findByRole('button', { name: 'Request firmware compile' });
  expect((button as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole('checkbox'));
  expect((button as HTMLButtonElement).disabled).toBe(true);
  fireEvent.change(screen.getByLabelText('Source execution review basis'), { target: { value: 'Reviewed synthetic source' } });
  fireEvent.click(button);
  await waitFor(() => expect(command).toHaveBeenCalledWith('firmware_build.request', expect.objectContaining({ firmware_revision_id: 'firmware-one', source_execution_authorized: true, basis: 'Reviewed synthetic source', recipe_id: 'approved-compiler' }), expect.objectContaining({ idempotencyKey: expect.any(String) })));
});
test('focus denial clears source evidence and handoff links', async () => {
  render(panel()); fireEvent.click(await screen.findByRole('button', { name: 'Inspect firmware handoff build-one' })); await screen.findByRole('link', { name: 'handoff.json' });
  vi.mocked(compileOptions).mockRejectedValue(new Error('Current source authority denied.'));
  fireEvent(window, new Event('focus'));
  expect(screen.queryByRole('link', { name: 'handoff.json' })).toBeNull();
  expect(screen.queryByText(/synthetic-main.c/)).toBeNull();
  await screen.findByText('Current source authority denied.');
});

test('late compile success cannot reopen evidence after a newer denied refresh', async () => {
  let finish!: (value: unknown) => void;
  vi.mocked(command).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  render(panel(true)); await screen.findByRole('button', { name: 'Request firmware compile' });
  fireEvent.click(screen.getByRole('checkbox'));
  fireEvent.change(screen.getByLabelText('Source execution review basis'), { target: { value: 'Exact reviewed source' } });
  fireEvent.click(screen.getByRole('button', { name: 'Request firmware compile' }));
  await waitFor(() => expect(command).toHaveBeenCalledOnce());
  vi.mocked(compileOptions).mockRejectedValueOnce(new Error('Latest source access denied'));
  fireEvent(window, new Event('focus'));
  await screen.findByText('Latest source access denied');
  const count = vi.mocked(compileOptions).mock.calls.length;
  await act(async () => finish({ build_id: 'committed-build' }));
  expect(compileOptions).toHaveBeenCalledTimes(count);
  expect(screen.getByText('Latest source access denied')).toBeTruthy();
  expect(screen.queryByText(/synthetic-main.c/)).toBeNull();
});

test('response-loss retry keeps its exact key through denial and deliberate restoration', async () => {
  vi.mocked(command).mockRejectedValueOnce(new Error('Compile response unavailable'));
  render(panel(true)); await screen.findByRole('button', { name: 'Request firmware compile' });
  fireEvent.click(screen.getByRole('checkbox'));
  fireEvent.change(screen.getByLabelText('Source execution review basis'), { target: { value: 'Exact reviewed source' } });
  fireEvent.click(screen.getByRole('button', { name: 'Request firmware compile' }));
  await screen.findByText('Compile response unavailable');
  vi.mocked(compileOptions).mockRejectedValueOnce(new Error('Source temporarily denied'));
  fireEvent.click(screen.getByRole('button', { name: 'Refresh compiler evidence' }));
  await screen.findByText('Source temporarily denied');
  fireEvent.click(screen.getByRole('button', { name: 'Refresh compiler evidence' }));
  await screen.findByRole('button', { name: 'Request firmware compile' });
  fireEvent.click(screen.getByRole('checkbox'));
  fireEvent.click(screen.getByRole('button', { name: 'Request firmware compile' }));
  await waitFor(() => expect(command).toHaveBeenCalledTimes(2));
  expect(vi.mocked(command).mock.calls[1]).toEqual(vi.mocked(command).mock.calls[0]);
});

test('late compile failure cannot clear a newer successful authority refresh', async () => {
  let fail!: (reason: Error) => void;
  vi.mocked(command).mockImplementationOnce(() => new Promise((_resolve, reject) => { fail = reject; }));
  render(panel(true)); await screen.findByRole('button', { name: 'Request firmware compile' });
  fireEvent.click(screen.getByRole('checkbox'));
  fireEvent.change(screen.getByLabelText('Source execution review basis'), { target: { value: 'Exact reviewed source' } });
  fireEvent.click(screen.getByRole('button', { name: 'Request firmware compile' }));
  fireEvent(window, new Event('focus'));
  await screen.findByRole('button', { name: 'Request firmware compile' });
  await act(async () => fail(new Error('Stale compile failure')));
  expect(screen.queryByText('Stale compile failure')).toBeNull();
  expect(screen.getByText(/synthetic-main.c/)).toBeTruthy();
});

test('strict-mode project replacement and unmount ignore old compile completion', async () => {
  let finish!: (value: unknown) => void;
  vi.mocked(command).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const view = render(<StrictMode>{panel(true)}</StrictMode>);
  await screen.findByRole('button', { name: 'Request firmware compile' });
  fireEvent.click(screen.getByRole('checkbox'));
  fireEvent.change(screen.getByLabelText('Source execution review basis'), { target: { value: 'Exact reviewed source' } });
  fireEvent.click(screen.getByRole('button', { name: 'Request firmware compile' }));
  view.rerender(<StrictMode>{panel(false, 'firmware-two')}</StrictMode>);
  await screen.findByRole('button', { name: 'Inspect firmware handoff build-one' });
  const count = vi.mocked(compileOptions).mock.calls.length;
  view.unmount();
  await act(async () => finish({ build_id: 'old-build' }));
  expect(compileOptions).toHaveBeenCalledTimes(count);
});

test('firmware builds show their retry chain in the list and the handoff', async () => {
  render(panel()); await screen.findByText(/retry of build-zero/);
  fireEvent.click(await screen.findByRole('button', { name: 'Inspect firmware handoff build-one' }));
  await screen.findByText('Retry of #1 (build-zero)');
  expect(screen.getByText('Attempt #2 · build-one (this) · succeeded')).toBeTruthy();
});

const failed = (viewer: boolean, cancel = false) => ({ ...options, builds: [{ build_id: 'build-bad', state: 'failed', failure: 'x', retry_of: null, requested_by_viewer: viewer, state_token: 'tok-1', cancel_available: cancel, retry_available: !cancel }] });
const hist = (over: object) => ({ state: 'failed', state_token: 'tok-1', cancel_available: false, retry_available: true, ...over }) as BuildHistory;
test('retry needs the grant and calls the generic build.retry with the exact state token', async () => {
  vi.mocked(compileOptions).mockResolvedValue(failed(true));
  vi.mocked(readHistory).mockResolvedValue(hist({}));
  vi.mocked(retryBuild).mockResolvedValue({ build_id: 'build-new' });
  const { unmount } = render(panel(false)); await screen.findByText("build-bad");
  expect(screen.queryByRole('button', { name: /Retry build-bad/ })).toBeNull(); unmount();
  render(panel(true)); fireEvent.click(await screen.findByRole('button', { name: 'Retry build-bad as a new attempt' }));
  await waitFor(() => expect(retryBuild).toHaveBeenCalledWith('build-bad', 'tok-1', expect.any(String)));
});
test('the requester can cancel without the grant; others cannot', async () => {
  vi.mocked(readHistory).mockResolvedValue(hist({ state: 'running', cancel_available: true, retry_available: false }));
  vi.mocked(cancelBuild).mockResolvedValue({});
  vi.mocked(compileOptions).mockResolvedValue(failed(false, true));
  const { unmount } = render(panel(false)); await screen.findByText("build-bad");
  expect(screen.queryByRole('button', { name: /cancellation of build-bad/ })).toBeNull(); unmount();
  vi.mocked(compileOptions).mockResolvedValue(failed(true, true));
  render(panel(false)); fireEvent.click(await screen.findByRole('button', { name: 'Request cancellation of build-bad' }));
  await waitFor(() => expect(cancelBuild).toHaveBeenCalledWith('build-bad', 'tok-1', expect.any(String)));
});

test('only actions valid for the current state are offered', async () => {
  vi.mocked(compileOptions).mockResolvedValue({ ...failed(true), builds: [{ build_id: 'build-bad', state: 'cancellation_requested', failure: null, retry_of: null, requested_by_viewer: true, state_token: 'tok-2', cancel_available: false, retry_available: false }] });
  vi.mocked(readHistory).mockResolvedValue(hist({ state: 'cancellation_requested', cancel_available: false, retry_available: false }));
  render(panel(true)); await screen.findByText(byContent(/cancellation requested/));
  expect(readHistory).not.toHaveBeenCalled();
  expect(screen.queryByRole('button', { name: /cancellation of build-bad/ })).toBeNull();
  expect(screen.queryByRole('button', { name: /Retry build-bad/ })).toBeNull();
});

test('a complete resolved configuration can be pinned and incomplete ones cannot', async () => {
  const row = (id: string, status: 'complete' | 'incomplete') => ({ resolved_configuration_id: id, status, snapshot_id: `snap-${id}`, resolution_sha256: 'h', draft_version: 1, basis: `Reviewed ${id}`, created_at: 't' });
  vi.mocked(listResolvedConfigurations).mockResolvedValue({ truncated: false, resolved: [row('config-complete', 'complete'), row('config-partial', 'incomplete')] });
  render(panel(true));
  const picker = (await screen.findAllByLabelText('Resolved configuration (optional)'))[0]!;
  fireEvent.click(picker);
  expect(listResolvedConfigurations).toHaveBeenCalledWith('workspace-one');
  expect(screen.getByRole('option', { name: /config-p.*incomplete, cannot be built/ }).getAttribute('data-combobox-disabled')).toBe('true');
  fireEvent.click(screen.getByRole('option', { name: /config-c.*complete/ }));
  fireEvent.click(screen.getByRole('checkbox'));
  fireEvent.change(screen.getByLabelText('Source execution review basis'), { target: { value: 'Reviewed synthetic source' } });
  fireEvent.click(screen.getByRole('button', { name: 'Request firmware compile' }));
  await waitFor(() => expect(command).toHaveBeenCalledWith('firmware_build.request', expect.objectContaining({ resolved_configuration_id: 'config-complete' }), expect.anything()));
});
