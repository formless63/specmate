import { MantineProvider } from '@mantine/core';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { PermissionsProvider } from '../../lib/permissions';
import { BuildsPanel } from './BuildsPanel';
import { abandonBuild, cancelBuild, listBuilds, readHistory, retryBuild, type BuildHistory } from './api';

vi.mock('./api', () => ({ listBuilds: vi.fn(), readHistory: vi.fn(), cancelBuild: vi.fn(), retryBuild: vi.fn(), abandonBuild: vi.fn() }));

const summary = (id: string, state: string, retryOf: string | null = null) => ({
  build_id: id, stage_id: `stage-${id}`, state, state_token: 'stage-v3', terminal: false, cancellation_requested: false,
  recipe_id: 'synthetic-check-r1', requested_at: '2026-01-01T00:00:00Z', retry_of: retryOf,
});
const history = (over: Partial<BuildHistory> = {}): BuildHistory => ({
  build_id: 'build-a', state: 'running', state_token: 'stage-v3', receipt: null, recipe_id: 'synthetic-check-r1',
  source_revision_id: 'rev-1', requested_at: '2026-01-01T00:00:00Z', retry_of: null, retried_by: null,
  lineage: [{ build_id: 'build-a', state: 'running', current: true }],
  events: [{ kind: 'requested', at: 't1', detail: {} }], outputs: [],
  cancel_available: true, retry_available: false, abandon_available: false, awaiting_runner_confirmation: false, ...over,
});
const panel = (permissions?: string[]) => <MantineProvider env="test" theme={{ respectReducedMotion: true }}>
  <PermissionsProvider permissions={permissions}><BuildsPanel workspaceId="p1" /></PermissionsProvider></MantineProvider>;
const open = async () => { render(panel(['project.read', 'build.execute'])); fireEvent.click(await screen.findByRole('button', { name: 'Inspect build build-a' })); await screen.findByLabelText('Build history'); };

beforeEach(() => {
  vi.mocked(listBuilds).mockResolvedValue({ builds: [summary('build-a', 'running')], truncated: false });
  vi.mocked(readHistory).mockResolvedValue(history());
  vi.mocked(cancelBuild).mockResolvedValue({});
  vi.mocked(retryBuild).mockResolvedValue({ build_id: 'build-b' });
  vi.mocked(abandonBuild).mockResolvedValue({});
});
afterEach(() => { cleanup(); vi.resetAllMocks(); });

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
  expect(screen.getByText(/build-a failed → build-b \(this\) waiting dispatch/)).toBeTruthy();
});

test('unavailable runner offers a resolution that needs a basis and says termination is unconfirmed', async () => {
  vi.mocked(readHistory).mockResolvedValueOnce(history({ state: 'cancellation_requested', cancel_available: false, abandon_available: true, awaiting_runner_confirmation: true,
    outputs: [{ path: 'result.txt', sha256: 'abc', size: 4, accepted: false }] }));
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
  render(panel(['project.read']));
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
