import { MantineProvider } from '@mantine/core';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { SelectedPackagesPanel } from './SelectedPackagesPanel';
import { review, type Review } from './api';

beforeEach(() => { vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} }); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
function wrap(projectId = 'project') {
  return <MantineProvider><QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><SelectedPackagesPanel projectId={projectId} /></QueryClientProvider></MantineProvider>;
}
function response(data: unknown, status = 200) { return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } }); }
function inspected(path: string[] = []): Review {
  return { sha256: 'review-hash', manifest: {
    scope: { selected_revision_id: path.length ? 'board-revision' : 'root-revision', selected_sha256: 'selected-hash', root_sha256: 'root-hash', occurrence_path: path },
    completeness: 'limited', rights: 'private_review_only_distribution_not_authorized',
    design_revisions: [{ revision_id: 'board-revision', kind: 'board', sha256: 'board-hash', rights_review: { subject: 'design:board-revision', decision: 'unknown', basis: '' } }],
    source_files: [], occurrences: [{ path: [], revision_id: 'board-revision', sha256: 'board-hash', assignments: { firmware_revision_id: path[0] === 'right' ? 'right-fw' : 'left-fw' } }],
    boundary_interfaces: [{ path: [], kind: 'board', boundary_exposure: 'unknown' }], boundary_crossings: [{ kind: 'electrical', selected_terminals: [{ path: [], feature_id: 'port.a' }], external_contract: 'unknown' }],
    unresolved: [{ reason: 'Native/extension reconstruction unsupported for preserved kinds.', kinds: ['board'] }],
  } };
}
async function choose(label: string, option: string) {
  const input = await screen.findByRole('combobox', { name: label });
  fireEvent.focus(input); fireEvent.keyDown(input, { key: 'ArrowDown' });
  fireEvent.click(await screen.findByRole('option', { name: option, hidden: true }));
}
function fixture() {
  const calls: { operation: string; payload: Record<string, unknown>; idempotency_key?: string }[] = [];
  let denyDownload = false;
  let denyReview = false;
  let downloadBody: Record<string, unknown> | null = null;
  const fetch = vi.fn(async (url: string, options?: RequestInit) => {
    if (url.endsWith('/operations')) {
      const body = JSON.parse(String(options?.body)); calls.push(body);
      if (denyReview) return response({ error: { message: 'Source unavailable.' } }, 404);
      return response({ result: inspected(body.payload.occurrence_path) });
    }
    if (url.endsWith('/selected-packages/download')) {
      downloadBody = JSON.parse(String(options?.body));
      if (denyDownload) return response({ error: { message: 'Source unavailable.' } }, 404);
      return new Response('synthetic-zip', { status: 200 });
    }
    if (url.includes('/assemblies/snapshots/')) return response({ occurrences: ['left', 'right'].map(side => ({ address: { path: [side, 'board'] }, revision_id: 'board-revision', display_ref: 'J1', kind: 'board' })) });
    if (url.includes('/revisions/root-revision')) return response({ snapshot_id: 'root-snapshot' });
    if (url.includes('/catalog/definitions/')) return response({ kind: 'assembly', revisions: [{ revision_id: 'root-revision', number: 1 }] });
    return response([{ definition_id: 'assembly', name: 'Synthetic assembly', kind: 'assembly' }]);
  });
  vi.stubGlobal('fetch', fetch);
  return { calls, fetch, denyDownload: () => { denyDownload = true; denyReview = true; }, restore: () => { denyDownload = false; denyReview = false; }, body: () => downloadBody };
}
async function selectRight() {
  await choose('Package root definition', 'Synthetic assembly (assembly)');
  await choose('Exact package root revision', 'Revision 1 · root-revision');
  fireEvent.click(await screen.findByRole('button', { name: 'right/board · J1' }));
  fireEvent.click(screen.getByRole('button', { name: 'Review exact selected package' }));
  await screen.findByText('Selected revision: board-revision');
}

test('fresh review uses contextual stable path and never a replay key', async () => {
  const f = fixture(); render(wrap()); await selectRight();
  expect(f.calls).toHaveLength(1);
  expect(f.calls[0]).toMatchObject({ operation: 'selected_package.review', payload: { root_revision_id: 'root-revision', occurrence_path: ['right', 'board'], purpose: 'authorized_review', rights_reviews: [] } });
  expect(f.calls[0]?.idempotency_key).toBeUndefined();
  expect(screen.getByText('Selected root · board-revision · firmware right-fw')).toBeTruthy();
  expect(screen.queryByText(/firmware left-fw/)).toBeNull();
  expect(screen.getByText(/port.a.*external contract unknown/)).toBeTruthy();
});

test('rights editing clears reviewed hash, retains declarations on purpose change and sends explicit reviewed download', async () => {
  const f = fixture(); const createObjectURL = vi.fn(() => 'blob:synthetic'); const revokeObjectURL = vi.fn();
  vi.stubGlobal('URL', class extends URL { static createObjectURL = createObjectURL; static revokeObjectURL = revokeObjectURL; });
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
  render(wrap()); await selectRight();
  fireEvent.change(screen.getByLabelText('Rights basis design:board-revision'), { target: { value: 'Synthetic owner declaration' } });
  await choose('Rights decision design:board-revision', 'permitted');
  expect((screen.getByRole('button', { name: 'Download reviewed package' }) as HTMLButtonElement).disabled).toBe(true);
  await choose('Package purpose', 'Reviewed distribution data');
  fireEvent.click(screen.getByRole('button', { name: 'Review exact selected package' }));
  await waitFor(() => expect(f.calls).toHaveLength(2));
  expect(f.calls[1]?.payload).toMatchObject({ purpose: 'distribution', rights_reviews: [{ subject: 'design:board-revision', decision: 'permitted', basis: 'Synthetic owner declaration' }] });
  await waitFor(() => expect((screen.getByRole('button', { name: 'Download reviewed package' }) as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(screen.getByRole('button', { name: 'Download reviewed package' }));
  await waitFor(() => expect(createObjectURL).toHaveBeenCalled());
  expect(f.body()).toMatchObject({ reviewed_sha256: 'review-hash', occurrence_path: ['right', 'board'], purpose: 'distribution' });
  expect(revokeObjectURL).toHaveBeenCalledWith('blob:synthetic');
});

test('revoked download clears review and selection projection until explicit full authority refresh', async () => {
  const f = fixture(); render(wrap()); await selectRight(); f.denyDownload();
  fireEvent.click(screen.getByRole('button', { name: 'Download reviewed package' }));
  await screen.findByText('Source unavailable.');
  expect(screen.queryByText('Selected revision: board-revision')).toBeNull();
  expect(screen.queryByRole('button', { name: 'right/board · J1' })).toBeNull();
  f.restore(); fireEvent.click(screen.getByRole('button', { name: 'Refresh package selection access' }));
  await screen.findByRole('button', { name: 'right/board · J1' });
  expect(screen.queryByRole('button', { name: 'Download reviewed package' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Review exact selected package' }));
  await screen.findByText('Selected revision: board-revision');
});

test('project replacement clears old review and prevents an old deferred download', async () => {
  const f = fixture(); const save = vi.fn();
  vi.stubGlobal('URL', class extends URL { static createObjectURL = save; static revokeObjectURL = vi.fn(); });
  const view = render(wrap()); await selectRight();
  let resolveDownload!: (value: Response) => void;
  const pending = new Promise<Response>(resolve => { resolveDownload = resolve; });
  f.fetch.mockImplementationOnce(() => pending);
  fireEvent.click(screen.getByRole('button', { name: 'Download reviewed package' }));
  view.rerender(wrap('another-project'));
  resolveDownload(new Response('old-deferred-archive'));
  await waitFor(() => expect(screen.queryByText('Selected revision: board-revision')).toBeNull());
  expect(screen.queryByRole('button', { name: 'Download reviewed package' })).toBeNull();
  expect(save).not.toHaveBeenCalled();
  expect(f.calls).toHaveLength(1);
});

test('agent and browser review transport requires fresh evaluation without idempotency', async () => {
  const f = fixture(); await review({ root_revision_id: 'root-revision', occurrence_path: ['right', 'board'], purpose: 'authorized_review', rights_reviews: [] });
  expect(f.calls[0]?.idempotency_key).toBeUndefined();
});
