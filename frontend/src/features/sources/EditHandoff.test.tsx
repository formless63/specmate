import { grants } from "../../test/grants";
import { PermissionsProvider } from "../../lib/permissions";
import { MantineProvider } from '@mantine/core';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { EditHandoff, EditProvenanceCard, folderPaths } from './EditHandoff';
import * as api from './api';

const detail: api.RevisionDetail = {
  revision_id: 'base-id', name: 'Synthetic board', role: 'derivative', number: 1, manifest_sha256: 'base-manifest', derived_from: 'orig-id',
  expansion: null, manifest: { ancestry: ['orig-id'], files: [{ path: 'board.native', sha256: 'old-hash', bytes: 4, media_type: 'text/plain', rights: 'synthetic' }] },
};
function review(overrides: Partial<api.EditReview> = {}): api.EditReview {
  return {
    baseline: { revision_id: 'base-id', number: 1, name: 'Synthetic board', role: 'derivative', manifest_sha256: 'base-manifest' },
    source: { kind: 'zip', revision_id: 'upload-id', path: 'edited.zip', sha256: 'zip-hash', parser: 'specmate-classic-zip-v1' },
    marker: 'matched', root_prefix: '',
    files: [
      { path: 'board.native', change: 'modified', sha256: 'new-hash', bytes: 5, baseline_sha256: 'old-hash', media_type: 'text/plain', rights: 'synthetic', rights_source: 'baseline', suggested_exclusion: false },
      { path: 'added.native', change: 'added', sha256: 'added-hash', bytes: 3, baseline_sha256: null, media_type: 'application/octet-stream', rights: null, rights_source: 'missing', suggested_exclusion: false },
      { path: '.DS_Store', change: 'added', sha256: 'junk-hash', bytes: 1, baseline_sha256: null, media_type: 'application/octet-stream', rights: null, rights_source: 'missing', suggested_exclusion: true },
    ],
    removed: [{ path: 'notes.txt', baseline_sha256: 'notes-hash', rights: 'synthetic' }], excluded: [],
    counts: { added: 2, modified: 1, rights_changed: 0, unchanged: 0, removed: 1, excluded: 0 },
    missing_rights: ['added.native', '.DS_Store'], ready: false, reasons: ['Declare rights for every added file (unknown is allowed).'],
    review_sha256: 'review-1', head_revision_id: 'base-id', head_number: 1, state: 'bundle-r1', baseline_is_head: true, next_revision_allowed: true,
    ...overrides,
  };
}
const ready = review({
  files: review().files.slice(0, 2).map(row => row.path === 'added.native' ? { ...row, rights: 'unknown', rights_source: 'declared' as const } : row),
  excluded: [{ path: '.DS_Store', sha256: 'junk-hash', bytes: 1, suggested_exclusion: true }],
  missing_rights: [], ready: true, reasons: [], review_sha256: 'review-2',
});
function reply(value: unknown, status = 200) { return new Response(JSON.stringify(value), { status }); }
beforeEach(() => { vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} }); Element.prototype.scrollIntoView = vi.fn(); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function setup(responses: Response[], canWrite = true) {
  const bodies: Record<string, unknown>[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    expect(url).toBe('/api/v0/operations');
    bodies.push(JSON.parse(String(init?.body)));
    const next = responses.shift();
    if (!next) throw new Error('Unexpected request');
    return next;
  }));
  const preserved = vi.spyOn(api, 'preserve').mockResolvedValue({ revision_id: 'upload-id' });
  const onSubmitted = vi.fn(async () => {});
  const onAuthorityFailure = vi.fn();
  function Harness() {
    return <MantineProvider><PermissionsProvider permissions={grants({ register: canWrite })}><EditHandoff workspaceId="project-a" detail={detail} busy={false} setBusy={() => {}} onAuthorityFailure={onAuthorityFailure} onSubmitted={onSubmitted} /></PermissionsProvider></MantineProvider>;
  }
  render(<Harness />);
  return { bodies, preserved, onSubmitted, onAuthorityFailure };
}
async function chooseAndReview() {
  fireEvent.change(screen.getByLabelText('Edited ZIP'), { target: { files: [new File(['zip'], 'edited.zip')] } });
  fireEvent.click(screen.getByRole('button', { name: 'Review changes' }));
  await screen.findByText('Review against revision 1 (base-id)');
}

test('readers can download the exact handoff without submission controls', () => {
  setup([], false);
  expect(screen.getByRole('link', { name: 'Download editing handoff ZIP' }).getAttribute('href')).toBe('/api/v0/sources/revisions/base-id/handoff');
  expect(screen.queryByRole('button', { name: 'Review changes' })).toBeNull();
});

test('reviewed submission binds exclusions, declared rights, state and review hash', async () => {
  const { bodies, preserved, onSubmitted } = setup([
    reply({ result: review() }), reply({ result: ready }), reply({ result: { revision_id: 'edited-id' } }),
  ]);
  await chooseAndReview();
  expect(preserved).toHaveBeenCalledWith('project-a', expect.any(File), 'Synthetic board edited upload', 'unknown');
  expect(bodies[0]).toMatchObject({ operation: 'source.preview_edit', payload: { baseline_revision_id: 'base-id', archive: { revision_id: 'upload-id', path: 'edited.zip' }, rights: [], exclude_paths: [] } });
  expect(bodies[0]).not.toHaveProperty('idempotency_key');
  expect(screen.getByText('was old-hash')).toBeTruthy();
  expect(screen.getByText('Removed')).toBeTruthy();
  // Suggested by-products are pre-selected but must be reviewed again explicitly.
  expect((screen.getByLabelText('Exclude .DS_Store') as HTMLInputElement).checked).toBe(true);
  const submitButton = screen.getByRole('button', { name: 'Submit reviewed derivative' });
  expect((submitButton as HTMLButtonElement).disabled).toBe(true);
  expect((screen.getByRole('button', { name: 'Review again with these decisions' }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.change(screen.getByLabelText('Rights for added.native'), { target: { value: 'unknown' } });
  fireEvent.click(screen.getByRole('button', { name: 'Review again with these decisions' }));
  await screen.findByText('Review SHA-256: review-2 · state bundle-r1');
  expect(bodies[1]).toMatchObject({ payload: { rights: [{ path: 'added.native', rights: 'unknown' }], exclude_paths: ['.DS_Store'] } });
  expect(preserved).toHaveBeenCalledTimes(1);
  fireEvent.change(screen.getByLabelText('Change summary'), { target: { value: 'Synthetic outside edit' } });
  fireEvent.click(screen.getByRole('button', { name: 'Submit reviewed derivative' }));
  await waitFor(() => expect(onSubmitted).toHaveBeenCalledWith('edited-id'));
  expect(bodies[2]).toMatchObject({
    operation: 'source.submit_edit', expected_state: 'bundle-r1',
    payload: { target: 'new_derivative', name: 'Synthetic board edited', reviewed_sha256: 'review-2', summary: 'Synthetic outside edit', rights: [{ path: 'added.native', rights: 'unknown' }], exclude_paths: ['.DS_Store'] },
  });
  expect(bodies[2]).toHaveProperty('idempotency_key');
});

test('stale baseline explains separate derivative and disables next revision', async () => {
  setup([reply({ result: { ...ready, baseline_is_head: false, next_revision_allowed: false, head_number: 3, state: 'bundle-r3' } })]);
  await chooseAndReview();
  expect(screen.getByText(/This bundle now has revision 3/)).toBeTruthy();
  expect(screen.getByText('Only the current head of a derivative can receive the next revision.')).toBeTruthy();
});

test('losing writer keeps files and decisions and must deliberately re-review', async () => {
  const conflict = 'The baseline\'s bundle changed since it was reviewed.';
  const { bodies, preserved, onSubmitted } = setup([
    reply({ result: review() }), reply({ result: ready }), reply({ error: { message: conflict } }, 409),
    reply({ result: { ...ready, baseline_is_head: false, next_revision_allowed: false, head_number: 2, state: 'bundle-r2', review_sha256: 'review-3' } }),
    reply({ result: { revision_id: 'separate-id' } }),
  ]);
  await chooseAndReview();
  fireEvent.change(screen.getByLabelText('Rights for added.native'), { target: { value: 'unknown' } });
  fireEvent.click(screen.getByRole('button', { name: 'Review again with these decisions' }));
  await screen.findByText('Review SHA-256: review-2 · state bundle-r1');
  fireEvent.change(screen.getByLabelText('Derivative bundle name'), { target: { value: 'Writer copy' } });
  fireEvent.click(screen.getByRole('option', { name: 'Next revision of this derivative', hidden: true }));
  fireEvent.change(screen.getByLabelText('Change summary'), { target: { value: 'Synthetic losing edit' } });
  fireEvent.click(screen.getByRole('button', { name: 'Submit reviewed derivative' }));
  expect(await screen.findByText(new RegExp(`Not submitted: ${conflict}`))).toBeTruthy();
  expect(bodies[2]).toMatchObject({ expected_state: 'bundle-r1', payload: { target: 'next_revision', reviewed_sha256: 'review-2' } });
  // Nothing is discarded: the reviewed table, declared rights, exclusions and text remain.
  expect((screen.getByLabelText('Rights for added.native') as HTMLInputElement).value).toBe('unknown');
  expect((screen.getByLabelText('Exclude .DS_Store') as HTMLInputElement).checked).toBe(true);
  expect((screen.getByLabelText('Change summary') as HTMLTextAreaElement).value).toBe('Synthetic losing edit');
  expect((screen.getByRole('button', { name: 'Submit reviewed derivative' }) as HTMLButtonElement).disabled).toBe(true);
  expect(screen.queryByRole('button', { name: 'Review changes' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Review again with these decisions' }));
  await screen.findByText('Review SHA-256: review-3 · state bundle-r2');
  expect(bodies[3]).toMatchObject({ operation: 'source.preview_edit', payload: { archive: { revision_id: 'upload-id' }, rights: [{ path: 'added.native', rights: 'unknown' }], exclude_paths: ['.DS_Store'] } });
  expect(preserved).toHaveBeenCalledTimes(1);
  expect(screen.getByText(/This bundle now has revision 2/)).toBeTruthy();
  // The stale next-revision target is not silently converted into another submission.
  expect(screen.getByText('The next revision is no longer available. Choose how to submit.')).toBeTruthy();
  expect((screen.getByRole('button', { name: 'Submit reviewed derivative' }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole('option', { name: 'Separate derivative bundle', hidden: true }));
  fireEvent.click(screen.getByRole('button', { name: 'Submit reviewed derivative' }));
  await waitFor(() => expect(onSubmitted).toHaveBeenCalledWith('separate-id'));
  expect(bodies[4]).toMatchObject({ expected_state: 'bundle-r2', payload: { target: 'new_derivative', name: 'Writer copy', summary: 'Synthetic losing edit', reviewed_sha256: 'review-3' } });
  expect(bodies[4]!.idempotency_key).not.toBe(bodies[2]!.idempotency_key);
});

test('retrying a lost submission response reuses its key so the server can replay it', async () => {
  const { bodies, onSubmitted } = setup([
    reply({ result: { ...ready, excluded: [] } }), new Response('gateway failure', { status: 502 }), reply({ result: { revision_id: 'edited-id' } }),
  ]);
  await chooseAndReview();
  fireEvent.change(screen.getByLabelText('Change summary'), { target: { value: 'edit' } });
  fireEvent.click(screen.getByRole('button', { name: 'Submit reviewed derivative' }));
  await waitFor(() => expect(bodies).toHaveLength(2));
  await waitFor(() => expect((screen.getByRole('button', { name: 'Submit reviewed derivative' }) as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(screen.getByRole('button', { name: 'Submit reviewed derivative' }));
  await waitFor(() => expect(onSubmitted).toHaveBeenCalledWith('edited-id'));
  expect(bodies[2]!.idempotency_key).toBe(bodies[1]!.idempotency_key);
});

test('authority loss is delegated so the panel clears retained source data', async () => {
  const { onAuthorityFailure } = setup([reply({ error: { message: 'Source revision not found.' } }, 404)]);
  fireEvent.change(screen.getByLabelText('Edited ZIP'), { target: { files: [new File(['zip'], 'edited.zip')] } });
  fireEvent.click(screen.getByRole('button', { name: 'Review changes' }));
  await waitFor(() => expect(onAuthorityFailure).toHaveBeenCalled());
});

test('folder paths drop only the chosen folder name', () => {
  const nested = new File(['x'], 'board.native');
  Object.defineProperty(nested, 'webkitRelativePath', { value: 'my-edit/sub/board.native' });
  const root = new File(['y'], 'SPECMATE-HANDOFF.json');
  Object.defineProperty(root, 'webkitRelativePath', { value: 'my-edit/SPECMATE-HANDOFF.json' });
  expect(folderPaths([nested, root]).map(entry => entry.path)).toEqual(['sub/board.native', 'SPECMATE-HANDOFF.json']);
});

test('reopened revision shows exact re-entry provenance', () => {
  render(<MantineProvider><EditProvenanceCard detail={{ ...detail, edit_submission: {
    baseline_revision_id: 'orig-id', baseline_number: 2, baseline_manifest_sha256: 'orig-manifest', target: 'new_derivative',
    source: { kind: 'zip', revision_id: 'upload-id', path: 'edited.zip', sha256: 'zip-hash', parser: 'specmate-classic-zip-v1' },
    marker: 'matched', root_prefix: 'my-edit', review_sha256: 'review-2', summary: 'Synthetic outside edit', execution: 'none', validation: 'not_performed',
  } }} /></MantineProvider>);
  expect(screen.getByText('Baseline r2')).toBeTruthy();
  expect(screen.getByText('orig-id', { selector: 'code' })).toBeTruthy();
  expect(screen.getByText(/zip-hash/)).toBeTruthy();
  expect(screen.getByText('Handoff marker: matched · root folder my-edit/')).toBeTruthy();
  expect(screen.getByText('Execution: none · Native validation: not performed')).toBeTruthy();
});
