import { MantineProvider } from '@mantine/core';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { PermissionsProvider } from '../../lib/permissions';
import { BuildsPanel } from './BuildsPanel';
import { abandonBuild, cancelBuild, findReusable, listBuilds, readHistory, reproduceBuild, retryBuild, reuseResult, type BuildHistory, type PinnedTool } from './api';

vi.mock('./api', async original => ({ ...(await original<typeof import('./api')>()), listBuilds: vi.fn(), readHistory: vi.fn(), cancelBuild: vi.fn(), retryBuild: vi.fn(), abandonBuild: vi.fn(), reproduceBuild: vi.fn(), findReusable: vi.fn(), reuseResult: vi.fn() }));

const summary = (id: string, state: string, retryOf: string | null = null) => ({
  build_id: id, stage_id: `stage-${id}`, state, state_token: 'stage-v3', terminal: false, cancellation_requested: false,
  recipe_id: 'synthetic-check-r1', requested_at: '2026-01-01T00:00:00Z', retry_of: retryOf, requested_by_viewer: false,
});
const history = (over: Partial<BuildHistory> = {}): BuildHistory => ({
  build_id: 'build-a', state: 'running', state_token: 'stage-v3', receipt: null, recipe_id: 'synthetic-check-r1',
  source_revision_id: 'rev-1', requested_at: '2026-01-01T00:00:00Z', retry_of: null, retried_by: null, requested_by_viewer: false,
  lineage: [{ build_id: 'build-a', state: 'running', current: true }],
  events: [{ kind: 'requested', at: 't1', detail: {} }], outputs: [],
  staged_inputs: [{ path: 'a.txt', sha256: 'aa', bytes: 3, media_type: 'text/plain', rights: 'MIT' }], output_rights: { rights: 'MIT', basis: 'uniform' },
  cancel_available: true, retry_available: false, abandon_available: false, awaiting_runner_confirmation: false, configuration: null, ...over,
});
const panel = (permissions?: string[]) => <MantineProvider env="test" theme={{ respectReducedMotion: true }}>
  <PermissionsProvider permissions={permissions}><BuildsPanel workspaceId="p1" /></PermissionsProvider></MantineProvider>;
const open = async () => { render(panel(['workspace.read', 'build.execute'])); fireEvent.click(await screen.findByRole('button', { name: 'Inspect build build-a' })); await screen.findByLabelText('Build history'); };

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  vi.mocked(listBuilds).mockResolvedValue({ builds: [summary('build-a', 'running')], truncated: false });
  vi.mocked(readHistory).mockResolvedValue(history());
  vi.mocked(cancelBuild).mockResolvedValue({});
  vi.mocked(retryBuild).mockResolvedValue({ build_id: 'build-b' });
  vi.mocked(abandonBuild).mockResolvedValue({});
  vi.mocked(reproduceBuild).mockResolvedValue({ build_id: 'build-r', reproduction_of: 'build-a' });
  vi.mocked(findReusable).mockResolvedValue({ reusable: null });
});

const pinned: PinnedTool = {
  recipe_id: 'synthetic-check-r1', image: `example.invalid/tool@sha256:${'1'.repeat(64)}`, image_digest: `sha256:${'1'.repeat(64)}`,
  argv: ['/tool', '/inputs/a.txt'], network: 'none', resolved_image_id: null,
  limits: { cpus: 1, memory_bytes: 64 * 1024 ** 2, timeout_seconds: 60, pids: 16, max_output_bytes: 1024 },
};
const accepted = (over: Partial<BuildHistory> = {}) => history({
  state: 'succeeded', cancel_available: false, reproduce_available: true, pinned,
  receipt: { outcome: 'succeeded', exit_code: 0, message: 'Tool execution completed', outputs: [{ path: 'result.txt', sha256: 'abc' }] },
  outputs: [{ path: 'result.txt', sha256: 'abc', size: 4, rights: 'MIT', accepted: true, reproducibility: 'provenance' }],
  reproducibility: { level: 'provenance', outputs: { 'result.txt': { level: 'provenance', attempts_compared: 0, comparators: [] } } },
  comparisons: [], ...over,
});

test('a single tool success shows provenance only, never byte-identical, with its exact tool pin', async () => {
  vi.mocked(readHistory).mockResolvedValue(accepted());
  await open();
  expect(screen.getAllByText('provenance only').length).toBe(2);
  expect(screen.queryByText('byte-identical')).toBeNull();
  expect(screen.getByText(/No repeated execution has been compared/)).toBeTruthy();
  expect(screen.getByText(/Tool pin/)).toBeTruthy();
  expect(screen.getByText(/resolved image not reported/)).toBeTruthy();
  expect(screen.getByText(/60s · network none/)).toBeTruthy();
});

test('byte-identical is shown only from a recorded comparison with another attempt', async () => {
  vi.mocked(readHistory).mockResolvedValue(accepted({
    outputs: [{ path: 'result.txt', sha256: 'abc', size: 4, rights: 'MIT', accepted: true, reproducibility: 'byte_reproducible' }],
    reproducibility: { level: 'byte_reproducible', outputs: { 'result.txt': { level: 'byte_reproducible', attempts_compared: 1, comparators: [] } } },
    comparisons: [{ path: 'result.txt', other_build_id: 'build-r', byte_identical: true, comparator: null, result: 'not_needed', level: 'byte_reproducible', this_sha256: 'abc', other_sha256: 'abc', recorded_at: 't2' }],
  }));
  await open();
  expect(screen.getAllByText('byte-identical').length).toBe(2);
  expect(screen.getByText('build-r')).toBeTruthy();
  expect(screen.getByText('identical')).toBeTruthy();
});

test('a reproducibility check needs build.execute and opens the new attempt', async () => {
  vi.mocked(readHistory).mockResolvedValue(accepted());
  render(panel(['workspace.read']));
  fireEvent.click(await screen.findByRole('button', { name: 'Inspect build build-a' }));
  const denied = await screen.findByRole('button', { name: 'Request reproducibility check' }) as HTMLButtonElement;
  expect(denied.disabled).toBe(true);
  cleanup();
  await open();
  vi.mocked(readHistory).mockResolvedValue(history({ build_id: 'build-r', state: 'waiting_dispatch', reproduction_of: 'build-a' }));
  fireEvent.click(screen.getByRole('button', { name: 'Request reproducibility check' }));
  await waitFor(() => expect(reproduceBuild).toHaveBeenCalledWith('build-a', 'stage-v3', expect.any(String)));
  await screen.findByText('Build build-r');
  expect(screen.getByText('Reproducibility check of build-a')).toBeTruthy();
});
afterEach(() => { cleanup(); vi.resetAllMocks(); vi.unstubAllGlobals(); });

test('cancellation is requested with the exact state token and is not shown as cancelled', async () => {
  await open();
  expect(screen.queryByText(/confirmed the process stopped\.$/)).toBeNull();
  vi.mocked(readHistory).mockResolvedValue(history({ state: 'cancellation_requested', state_token: 'stage-v4', cancel_available: false, awaiting_runner_confirmation: true }));
  fireEvent.click(screen.getByRole('button', { name: 'Request cancellation' }));
  await waitFor(() => expect(cancelBuild).toHaveBeenCalledWith('build-a', 'stage-v3', expect.any(String)));
  await screen.findByText(/This is not cancelled until the runner confirms/);
  expect(screen.getByText(/Waiting for the runner to confirm termination/)).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Request cancellation' })).toBeNull();
});

test('retry names the exact failed attempt and opens the new attempt', async () => {
  vi.mocked(readHistory).mockResolvedValueOnce(history({ state: 'failed', cancel_available: false, retry_available: true,
    receipt: { outcome: 'failed', exit_code: 3, message: 'tool failed', outputs: [] } }));
  await open();
  expect(screen.getByText(/exit code 3/)).toBeTruthy();
  vi.mocked(readHistory).mockResolvedValue(history({ build_id: 'build-b', state: 'waiting_dispatch', retry_of: 'build-a', cancel_available: true,
    lineage: [{ build_id: 'build-a', state: 'failed', current: false }, { build_id: 'build-b', state: 'waiting_dispatch', current: true }] }));
  fireEvent.click(screen.getByRole('button', { name: 'Retry as a new attempt' }));
  await waitFor(() => expect(retryBuild).toHaveBeenCalledWith('build-a', 'stage-v3', expect.any(String)));
  await screen.findByText('Build build-b');
  expect(screen.getByText('Retry of #1 (build-a)')).toBeTruthy();
  expect(screen.getByText('Attempt #1 · build-a · failed')).toBeTruthy();
  expect(screen.getByText('Attempt #2 · build-b (this) · waiting dispatch')).toBeTruthy();
});

test('unavailable runner offers a resolution that needs a basis and says termination is unconfirmed', async () => {
  vi.mocked(readHistory).mockResolvedValueOnce(history({ state: 'cancellation_requested', cancel_available: false, abandon_available: true, awaiting_runner_confirmation: true,
    outputs: [{ path: 'result.txt', sha256: 'abc', size: 4, rights: 'MIT', accepted: false }] }));
  await open();
  expect(screen.getByText(/Retained evidence only; not an accepted artifact/)).toBeTruthy();
  const resolve = screen.getByRole('button', { name: 'Resolve as failed, termination unconfirmed' }) as HTMLButtonElement;
  expect(resolve.disabled).toBe(true);
  fireEvent.change(screen.getByLabelText('Basis for resolving without runner confirmation'), { target: { value: 'Runner host retired.' } });
  expect(resolve.disabled).toBe(false);
  fireEvent.click(resolve);
  await waitFor(() => expect(abandonBuild).toHaveBeenCalledWith('build-a', 'Runner host retired.', 'stage-v3', expect.any(String)));
});

test('a stale-state conflict rereads instead of retrying with the old token', async () => {
  await open();
  vi.mocked(cancelBuild).mockRejectedValue(new Error('Build changed since expected state.'));
  vi.mocked(readHistory).mockResolvedValue(history({ state: 'failed', state_token: 'stage-v9', cancel_available: false }));
  fireEvent.click(screen.getByRole('button', { name: 'Request cancellation' }));
  await screen.findByText('Build changed since expected state.');
  await waitFor(() => expect(readHistory).toHaveBeenCalledTimes(2));
  expect(screen.queryByRole('button', { name: 'Request cancellation' })).toBeNull();
});

test('read-only members see history but cannot change builds', async () => {
  render(panel(['workspace.read']));
  fireEvent.click(await screen.findByRole('button', { name: 'Inspect build build-a' }));
  const cancel = await screen.findByRole('button', { name: 'Request cancellation' }) as HTMLButtonElement;
  expect(cancel.disabled).toBe(true);
  expect(screen.getByRole('note').textContent).toMatch(/Read-only access/);
});

test('a denied refresh clears retained build details', async () => {
  await open();
  vi.mocked(listBuilds).mockRejectedValue(new Error('Current access denied.'));
  fireEvent.click(screen.getByRole('button', { name: 'Refresh builds' }));
  await screen.findByText('Current access denied.');
  expect(screen.queryByLabelText('Build history')).toBeNull();
  expect(screen.queryByText(/synthetic-check-r1/)).toBeNull();
});

test('the original requester may cancel without the build.execute grant, others may not', async () => {
  vi.mocked(readHistory).mockResolvedValue(history({ requested_by_viewer: true }));
  render(panel(['workspace.read']));
  fireEvent.click(await screen.findByRole('button', { name: 'Inspect build build-a' }));
  const cancel = await screen.findByRole('button', { name: 'Request cancellation' }) as HTMLButtonElement;
  expect(cancel.disabled).toBe(false);
  fireEvent.click(cancel);
  await waitFor(() => expect(cancelBuild).toHaveBeenCalledWith('build-a', 'stage-v3', expect.any(String)));
});

test('a requester still cannot retry without the grant', async () => {
  vi.mocked(readHistory).mockResolvedValue(history({ state: 'failed', cancel_available: false, retry_available: true, requested_by_viewer: true }));
  render(panel(['workspace.read']));
  fireEvent.click(await screen.findByRole('button', { name: 'Inspect build build-a' }));
  expect(((await screen.findByRole('button', { name: 'Retry as a new attempt' })) as HTMLButtonElement).disabled).toBe(true);
});

test('the pinned resolved configuration is shown with its exact pins; none pinned is stated', async () => {
  await open();
  expect(screen.getByText(/No configuration pinned/)).toBeTruthy();
  cleanup();
  vi.mocked(readHistory).mockResolvedValue(history({ configuration: {
    resolved_configuration_id: 'config-1', snapshot_id: 'snap-1', snapshot_sha256: 'a'.repeat(64), resolution_sha256: 'b'.repeat(64), option_set_revision_id: 'options-1',
    pins: [{ revision_id: 'rev-x', sha256: 'c'.repeat(64) }],
    choices: [{ option_key: 'count', domain: 'firmware', path: null, status: 'resolved', source: 'selected', revision_id: null, population_option_id: null, value: '7' }],
  } as BuildHistory['configuration'] }));
  await open();
  expect(screen.getByText('Resolved configuration · 1 choices · 1 pinned revisions')).toBeTruthy();
  expect(screen.queryByText(/No configuration pinned/)).toBeNull();
});

test('mixed per-file rights and the derived output rights are shown, unknown never as a default', async () => {
  vi.mocked(readHistory).mockResolvedValueOnce(history({
    staged_inputs: [
      { path: 'a.txt', sha256: 'aa', bytes: 3, media_type: 'text/plain', rights: 'MIT' },
      { path: 'b.txt', sha256: 'bb', bytes: 3, media_type: 'text/plain', rights: 'Proprietary' },
    ],
    output_rights: { rights: 'Proprietary', basis: 'most_restrictive' },
  }));
  await open();
  expect(screen.getByText('MIT')).toBeTruthy();
  expect(screen.getAllByText('Proprietary').length).toBe(1);
  expect(screen.getByText(/Output rights: Proprietary \(most restrictive input\)/)).toBeTruthy();
});

test('an older build without a staged record says its output rights are unknown', async () => {
  vi.mocked(readHistory).mockResolvedValueOnce(history({ staged_inputs: null, output_rights: { rights: 'unknown', basis: 'unknown' } }));
  await open();
  expect(screen.getByText(/not recorded for this older build/)).toBeTruthy();
  expect(screen.getByText(/Output rights: unknown/)).toBeTruthy();
});

const offered = { build_id: 'build-ok', state: 'succeeded', state_token: 'stage-v4', created_at: '2026-01-02T00:00:00Z', reproducibility: 'provenance' as const,
  outputs: [{ output_id: 'out-1', path: 'result.txt', sha256: 'abc', size: 4, media_type: 'text/plain', rights: 'MIT' }] };
test('a failed build shows a reusable identical result with its level, never itself, and only with build.execute', async () => {
  vi.mocked(readHistory).mockResolvedValue(history({ state: 'failed', cancel_available: false, retry_available: true }));
  vi.mocked(findReusable).mockResolvedValue({ reusable: offered });
  render(panel(['workspace.read']));
  fireEvent.click(await screen.findByRole('button', { name: 'Inspect build build-a' }));
  await screen.findByLabelText('Build history');
  expect(findReusable).not.toHaveBeenCalled();
  expect(screen.queryByText('Reusable result available')).toBeNull();
  cleanup();
  await open();
  expect(await screen.findByText('Reusable result available')).toBeTruthy();
  expect(findReusable).toHaveBeenCalledWith({ workspace_id: 'p1', source_revision_id: 'rev-1', recipe_id: 'synthetic-check-r1', resolved_configuration_id: null });
  expect(screen.getByText(/Attempt build-ok succeeded/)).toBeTruthy();
  expect(screen.getAllByText('provenance only').length).toBeGreaterThan(0);
  vi.mocked(reuseResult).mockResolvedValue({ ...offered, reuse_id: 'reuse-9' });
  fireEvent.click(screen.getByRole('button', { name: 'Reuse result of build-ok' }));
  expect((await screen.findByRole('link', { name: 'result.txt' })).getAttribute('href')).toBe('/api/v0/builds/reuse/reuse-9/outputs/out-1');
  expect(retryBuild).not.toHaveBeenCalled();
  cleanup();
  // The attempt being viewed is never offered as a reuse of itself.
  vi.mocked(findReusable).mockResolvedValue({ reusable: { ...offered, build_id: 'build-a' } });
  await open();
  await waitFor(() => expect(findReusable).toHaveBeenCalledTimes(2));
  expect(screen.queryByText('Reusable result available')).toBeNull();
});

test('an interrupted build is described as not final, since its runner can still reconcile it', async () => {
  vi.mocked(readHistory).mockResolvedValue(history({ state: 'interrupted' }));
  await open();
  expect(screen.getByText(/This is not final/)).toBeTruthy();
  expect(screen.getByText(/report its real outcome, including success/)).toBeTruthy();
  expect(screen.queryByText(/never relabeled/)).toBeNull();
});

test('a runner-reported resolved image ID is shown with the pin, even without a receipt', async () => {
  const image = `sha256:${'d'.repeat(64)}`;
  vi.mocked(readHistory).mockResolvedValue(history({ state: 'interrupted', pinned: { ...pinned, resolved_image_id: image } }));
  await open();
  expect(screen.getByText(/resolved image sha256:dddddddddddd…/)).toBeTruthy();
  expect(screen.queryByText(/resolved image not reported/)).toBeNull();
});

test('a deliberately resolved build names the person by username', async () => {
  vi.mocked(readHistory).mockResolvedValue(history({
    state: 'failed', cancel_available: false,
    receipt: { outcome: 'failed', exit_code: null, message: 'Resolved without runner confirmation', outputs: [], resolution: 'abandoned_unreconciled', termination_confirmed: false, basis: 'Runner host retired.', resolved_by: 'synthetic-owner' },
  }));
  await open();
  expect(screen.getByText(/Basis: Runner host retired\. · resolved by synthetic-owner/)).toBeTruthy();
});

test('Jobs table shows When Kind Job By State and opens receipts in a closable side panel', async () => {
  vi.mocked(listBuilds).mockResolvedValue({ builds: [{ ...summary('build-a', 'running'), requested_by: 'synthetic-requester' }], truncated: false });
  await open();
  for (const name of ['When', 'Kind', 'Job', 'By', 'State']) expect(screen.getByRole('columnheader', { name })).toBeTruthy();
  expect(screen.getByText('synthetic-requester')).toBeTruthy();
  expect(screen.getByRole('dialog', { name: 'Build details' })).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Close build details' }));
  await waitFor(() => expect(screen.queryByLabelText('Build history')).toBeNull());
  expect(screen.getByRole('table', { name: 'Builds' })).toBeTruthy();
});
