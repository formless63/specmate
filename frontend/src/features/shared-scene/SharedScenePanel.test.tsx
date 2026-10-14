import { MantineProvider } from '@mantine/core';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { SharedScenePanel } from './SharedScenePanel';
import { syntheticScene } from './test-fixtures';

const choices = () => ({ assemblies: [{ snapshot_id: 'root-snapshot', revision_id: 'root-r1', name: 'Synthetic assembly', number: 1 }], window: 'latest_50_frozen_revisions' });
const response = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });
beforeEach(() => { vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} }); Element.prototype.scrollIntoView = vi.fn(); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
const show = (projectId = 'one') => <MantineProvider><SharedScenePanel projectId={projectId} /></MantineProvider>;
async function inspect() {
  await waitFor(() => expect((screen.getByRole('button', { name: 'Refresh scene access' }) as HTMLButtonElement).disabled).toBe(false));
  fireEvent.change(screen.getByLabelText('Exact frozen assembly snapshot ID'), { target: { value: 'root-snapshot' } });
  fireEvent.click(screen.getByRole('button', { name: 'Inspect exact scene' }));
}

test('repeated boards retain independent occurrence and feature selection with exact pins and unknown limits', async () => {
  const api = vi.fn(async (url: string) => response(url.includes('/snapshots/') ? syntheticScene() : choices())); vi.stubGlobal('fetch', api);
  render(show()); await inspect();
  const right = await screen.findByRole('button', { name: 'right/board · J1' }), left = screen.getByRole('button', { name: 'left/board · J1' });
  fireEvent.click(right);
  expect(right.getAttribute('aria-pressed')).toBe('true'); expect(left.getAttribute('aria-pressed')).toBe('false');
  expect(screen.getByText(/Contextual firmware: firmware-right/)).toBeTruthy();
  expect(screen.getAllByText('board', { selector: 'code' }).length).toBeGreaterThan(0);
  expect(screen.getAllByText('board-r1', { selector: 'code' }).length).toBeGreaterThan(0);
  expect(screen.getByText(/component envelopes unknown/)).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'component:one · U1 · native_component' }));
  expect(screen.getByText(/Selected feature component:one · placement unknown/)).toBeTruthy();
  expect(screen.getByText('Context: right/board · pcb_population')).toBeTruthy();
  fireEvent.click(left); expect(screen.getByText(/Contextual firmware: firmware-left/)).toBeTruthy();
  expect(screen.queryByText(/Selected feature/)).toBeNull();
  // Viewing, selection and layout have no engineering write transport.
  expect(api.mock.calls.filter(([url]) => !url.startsWith('/api/v0/catalog/revision-labels')).every(([url]) => url.startsWith('/api/v0/shared-scenes/'))).toBe(true);
  expect(screen.queryByLabelText('Interactive shared engineering scene')).toBeNull();
});

test('new denial clears scene labels and stale successful reads cannot reopen it', async () => {
  let finishOld: (value: Response) => void = () => {}; let reads = 0;
  const old = new Promise<Response>(resolve => { finishOld = resolve; });
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (!url.includes('/snapshots/')) return response(choices());
    reads += 1;
    if (reads === 1) return old;
    return response({ error: { message: 'Scene unavailable.' } }, 404);
  }));
  render(show()); await inspect();
  await waitFor(() => expect(reads).toBe(1));
  // Returning to the browser rechecks current authority while a prior read is outstanding.
  fireEvent(window, new Event('focus'));
  await screen.findByRole('alert'); expect(screen.queryByText(/Synthetic repeated board/)).toBeNull();
  await act(async () => { finishOld(response(syntheticScene())); await old; });
  expect(screen.queryByRole('button', { name: 'right/board · J1' })).toBeNull();
  expect(screen.queryByText(/Root revision root-r1/)).toBeNull();
  expect(screen.getByRole('alert').textContent).toContain('Scene unavailable.');
});

test('refresh hides previously authorized scene and resources immediately then reopens only current readable state', async () => {
  let denied = false;
  vi.stubGlobal('fetch', vi.fn(async (url: string) => denied && url.includes('/snapshots/') ? response({ error: { message: 'Access removed.' } }, 403) : response(url.includes('/snapshots/') ? syntheticScene() : choices())));
  render(show()); await inspect(); await screen.findByRole('button', { name: 'right/board · J1' });
  fireEvent.click(screen.getByRole('button', { name: 'right/board · J1' }));
  expect(screen.getByText(/Source\/model correspondence/)).toBeTruthy(); denied = true;
  fireEvent.click(screen.getByRole('button', { name: 'Refresh scene access' }));
  expect(screen.queryByRole('button', { name: 'right/board · J1' })).toBeNull();
  await screen.findByRole('alert'); expect(screen.queryByText(/source-one/)).toBeNull();
  denied = false; fireEvent.click(screen.getByRole('button', { name: 'Refresh scene access' }));
  await screen.findByRole('button', { name: 'right/board · J1' }); expect(screen.queryByText(/Selected occurrence/)).toBeNull();
});

test('project change clears retained snapshot and defeats prior asynchronous result', async () => {
  let complete: (value: Response) => void = () => {};
  const pending = new Promise<Response>(resolve => { complete = resolve; });
  vi.stubGlobal('fetch', vi.fn(async (url: string) => url.includes('/snapshots/') ? pending : response(choices())));
  const view = render(show()); await inspect(); view.rerender(show('two'));
  await act(async () => { complete(response(syntheticScene())); await pending; });
  await waitFor(() => expect((screen.getByRole('button', { name: 'Refresh scene access' }) as HTMLButtonElement).disabled).toBe(false));
  expect((screen.getByLabelText('Exact frozen assembly snapshot ID') as HTMLInputElement).value).toBe('');
  expect(screen.queryByRole('button', { name: 'right/board · J1' })).toBeNull();
});
