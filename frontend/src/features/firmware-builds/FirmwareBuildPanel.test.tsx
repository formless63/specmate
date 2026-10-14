import { MantineProvider } from '@mantine/core';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { StrictMode } from 'react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { command } from '../sources/api';
import { FirmwareBuildPanel } from './FirmwareBuildPanel';
import { compileOptions, compileReview, listResolvedConfigurations, type CompileOptions, type CompileReview } from './api';

vi.mock('./api', async original => ({ ...(await original<typeof import('./api')>()), compileOptions: vi.fn(), compileReview: vi.fn(), listResolvedConfigurations: vi.fn() }));
vi.mock('../sources/api', async original => ({ ...(await original<typeof import('../sources/api')>()), command: vi.fn() }));
const options: CompileOptions = {
  workspace_id: 'workspace-one', available_recipe_id: 'approved-compiler', unavailable_reason: null, builds: [{ build_id: 'build-one', state: 'succeeded', failure: null }], truncated: false,
  inputs: { schema_version: '1', adapter: 'firmware-avr-gcc-v1', firmware_revision_id: 'firmware-one', firmware_snapshot_sha256: 'firmware-snapshot', occurrence: null,
    sources: [{ local_id: 'app', source_revision_id: 'source-one', source_manifest_sha256: 'source-manifest', files: [{ path: 'synthetic-main.c', sha256: 'source-hash', rights: 'MIT', role: 'application' }] }],
    configuration: [{ key: 'COUNT', status: 'known', value: '7' }], toolchain: { family: 'other', name: 'avr-gcc', version: '5.4.0', framework: 'baremetal', board_id: 'atmega328p' },
    target: { population_revision_id: 'population-one', option_id: 'default', component_id: 'native-one', declared_part: null }, pins: [] },
};
const evidence: CompileReview = {
  reference: { firmware_revision_id: 'firmware-one', build_id: 'build-one' }, inputs: options.inputs, image: 'exact-compiler-image', recipe_id: 'approved-compiler', report_sha256: 'report-hash',
  report: { compiler_version: '5.4.0', tool_packages: { 'gcc-avr': 'exact-package' }, flashing: 'not_performed', device_operation: 'not_observed', hardware_compatibility: 'not_evaluated', physical_qualification: false },
  outputs: [{ output_id: 'output-one', path: 'handoff.json', sha256: 'handoff-hash', rights: 'MIT', size: 100, media_type: 'application/json' }],
};
beforeEach(() => { vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} }); Element.prototype.scrollIntoView = vi.fn(); vi.mocked(compileOptions).mockResolvedValue(options); vi.mocked(compileReview).mockResolvedValue(evidence); vi.mocked(command).mockResolvedValue({ build_id: 'new-one' });
  vi.mocked(listResolvedConfigurations).mockResolvedValue({ truncated: false, resolved: [] }); });
afterEach(() => { cleanup(); vi.resetAllMocks(); });
const panel = (canExecute = false, firmware = 'firmware-one') => <MantineProvider env="test"><FirmwareBuildPanel firmware_revision_id={firmware} canExecute={canExecute} /></MantineProvider>;

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
