import { grants } from "../../test/grants";
import { PermissionsProvider } from "../../lib/permissions";
import { MantineProvider } from '@mantine/core';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { StrictMode } from 'react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { CollaborationPanel } from './CollaborationPanel';
import type { Comparison, Review } from './api';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
beforeEach(() => { vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} }); HTMLElement.prototype.scrollIntoView = vi.fn(); });
const pin = (id: string, number: number) => ({ revision_id: id, definition_id: 'original-definition', workspace_id: 'workspace', name: 'Original declared stock', kind: 'wire_stock', number, sha256: `exact-${id}-hash` });
const comparison: Comparison = { old: pin('old', 1), candidate: pin('candidate', 2), identity_relation: 'same_definition', changes: [
  { path: ['length_mm'], change: 'changed', old_present: true, candidate_present: true, old: '12.5', candidate: '13.75' },
  { path: ['unknown'], change: 'added', old_present: false, candidate_present: true, old: null, candidate: null },
], next_changes_offset: null, parents_side: 'old', parent_scope: 'currently_authorized_captured_snapshot_pins', parents: { results: [{ snapshot_id: 'exact-parent-snapshot', definition_id: 'parent', workspace_id: 'workspace', label: 'Original authorized parent' }], next_after: null }, dependency_pins: { old: [], candidate: [] }, limitations: ['Declared JSON positions are not feature correspondence.'] };
const baseReview: Review = { review_id: 'review', workspace_id: 'workspace', project_id: 'project', title: 'Original private review title', old: comparison.old, candidate: comparison.candidate, state: 'team-review-v3', status: 'open', recipients: [{ user_id: 'viewer', username: 'original-viewer' }], knowledge: { item_id: 'note', number: 1, title: 'Original pinned note', body: 'Private original explanation', attachments: [{ path: 'original.txt', sha256: 'source-hash', rights: 'AGPL-3.0-only' }] }, entries: [{ entry_id: 'entry', number: 1, action: 'opened', basis: 'Original declared basis', author: 'original-owner', created_at: '2026-01-01', evidence: { status: 'unknown' }, upgrade_proposal_id: null }], comparison };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
function fixture() {
  let deny = false, failResponse = false, held: ReturnType<typeof deferred<Response>> | null = null;
  let state = 'team-review-v3';
  const calls: { operation: string; payload: Record<string, unknown>; expected_state?: string; idempotency_key?: string }[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, options?: RequestInit) => {
    if (url.endsWith('/operations')) {
      const body = JSON.parse(String(options?.body)); calls.push(body);
      if (deny) return json({ error: { message: 'Exact source unavailable.' } }, 404);
      if (body.operation === 'collaboration.read') { if (held) return held.promise; return json({ result: { ...baseReview, state } }); }
      if (body.operation === 'collaboration.list') return json({ result: { results: [baseReview], next_after: null } });
      if (body.operation === 'collaboration.inbox') return json({ result: { results: [{ notification_id: 'notice', review_id: 'review', title: baseReview.title, action: 'opened', state: 'notification-unread', read_at: null, old: baseReview.old, candidate: baseReview.candidate }], next_after: null } });
      if (body.operation === 'collaboration.respond') { if (failResponse) { failResponse = false; state = 'team-review-v4'; return json({ error: { message: 'Response not observed; original key is retained.' } }, 503); } return json({ result: { ...baseReview, state: 'team-review-v4' } }); }
      if (body.operation === 'collaboration.compare') return json({ result: comparison });
      return json({ result: { ...baseReview, state } });
    }
    if (url.includes('/catalog/definitions?')) return json({ workspace_id: 'workspace', project_id: 'project', results: [{ definition_id: 'original-definition', name: 'Original declared stock', kind: 'wire_stock' }], next_after: null });
    return json({ definition_id: 'original-definition', name: 'Original declared stock', kind: 'wire_stock', revisions: [{ revision_id: 'old', number: 1 }, { revision_id: 'candidate', number: 2 }], drafts: [] });
  }));
  return { calls, hold: () => { held = deferred<Response>(); return held; }, release: () => { held?.resolve(json({ result: { ...baseReview, state } })); held = null; }, deny: () => { deny = true; }, restore: () => { deny = false; }, failResponse: () => { failResponse = true; } };
}
function panel(principalKey = 'owner', active = true, canEdit = true, projectId = 'project', onAccessLost?: () => void) { return <MantineProvider><PermissionsProvider permissions={grants({ edit: canEdit })}><CollaborationPanel projectId={projectId} principalKey={principalKey} active={active} onAccessLost={onAccessLost} /></PermissionsProvider></MantineProvider>; }
async function selectReview() {
  const input = await screen.findByRole('combobox', { name: 'Retained team review' });
  fireEvent.focus(input); fireEvent.keyDown(input, { key: 'ArrowDown' });
  const popup = document.querySelector(`[role="listbox"][aria-labelledby="${input.id}-label"]`)!;
  fireEvent.click(await within(popup as HTMLElement).findByRole('option', { name: `${baseReview.title} · review`, hidden: true }));
  await screen.findByRole('heading', { name: 'Selected exact review history' });
}
async function prepare() {
  await selectReview();
  fireEvent.click(screen.getByRole('button', { name: 'Review latest state and use a new response token' }));
  fireEvent.change(screen.getByLabelText('Prepared response basis'), { target: { value: 'Original prepared response retained' } });
}

test('authorized exact comparison renders declared values, absent/null, captured parents, source rights and limits', async () => {
  fixture(); render(panel()); await selectReview();
  expect(screen.getByText('Original authorized parent')).toBeTruthy();
  expect(screen.getAllByText('exact-parent-snapshot', { selector: 'code' }).length).toBeGreaterThan(0);
  expect(screen.getByRole('cell', { name: '"12.5"' })).toBeTruthy();
  expect(screen.getByRole('cell', { name: '"13.75"' })).toBeTruthy();
  expect(screen.getByRole('cell', { name: 'Absent' })).toBeTruthy();
  expect(screen.getByRole('cell', { name: 'null' })).toBeTruthy();
  expect(screen.getByText('original.txt · source-hash · AGPL-3.0-only')).toBeTruthy();
  expect(screen.getByText(/recommendation changes only this discussion/i)).toBeTruthy();
});

test('held current-authority refresh removes cached review, knowledge, parent and inbox labels while staging stays inert', async () => {
  const f = fixture(); render(panel()); await prepare(); f.hold();
  fireEvent.click(screen.getByRole('button', { name: 'Refresh review access' }));
  await waitFor(() => expect(screen.queryByRole('heading', { name: 'Selected exact review history' })).toBeNull());
  expect(screen.queryByText('Private original explanation')).toBeNull();
  expect(screen.queryByText(/Original authorized parent/)).toBeNull();
  expect(screen.getByLabelText('Prepared response basis').closest('fieldset')!.hasAttribute('inert')).toBe(true);
  f.release(); await screen.findByRole('heading', { name: 'Selected exact review history' });
  expect((screen.getByLabelText('Prepared response basis') as HTMLTextAreaElement).value).toBe('Original prepared response retained');
});

test('lost response and denial recovery preserve original basis, CAS token and exact retry key until deliberate advance', async () => {
  const f = fixture(), lost = vi.fn(); render(panel('owner', true, true, 'project', lost)); await prepare(); f.failResponse();
  fireEvent.click(screen.getByRole('button', { name: 'Submit prepared team response' }));
  await screen.findByText('Response not observed; original key is retained.');
  const first = f.calls.find(c => c.operation === 'collaboration.respond')!;
  expect(first.expected_state).toBe('team-review-v3');
  f.deny(); fireEvent.click(screen.getByRole('button', { name: 'Refresh review access' }));
  await screen.findByText(/Current access is unavailable/); expect(lost).toHaveBeenCalled();
  expect(screen.queryByText('Private original explanation')).toBeNull();
  f.restore(); fireEvent.click(screen.getByRole('button', { name: 'Refresh review access' }));
  await screen.findByRole('heading', { name: 'Selected exact review history' });
  expect((screen.getByLabelText('Prepared response basis') as HTMLTextAreaElement).value).toBe('Original prepared response retained');
  fireEvent.click(screen.getByRole('button', { name: 'Submit prepared team response' }));
  await waitFor(() => expect(f.calls.filter(c => c.operation === 'collaboration.respond')).toHaveLength(2));
  const second = f.calls.filter(c => c.operation === 'collaboration.respond')[1]!;
  expect([second.payload, second.expected_state, second.idempotency_key]).toEqual([first.payload, first.expected_state, first.idempotency_key]);
});

test('inactive and unit focus lifecycle fence history, preserve prepared values and require fresh selected proof', async () => {
  const f = fixture(); const view = render(panel()); await prepare();
  view.rerender(panel('owner', false));
  expect(screen.queryByRole('heading', { name: 'Selected exact review history' })).toBeNull();
  expect(screen.queryByText('Private original explanation')).toBeNull();
  const held = f.hold(); view.rerender(panel('owner', true));
  await waitFor(() => expect(f.calls.filter(c => c.operation === 'collaboration.read').length).toBeGreaterThan(1));
  expect(screen.queryByRole('heading', { name: 'Selected exact review history' })).toBeNull();
  f.release(); await screen.findByRole('heading', { name: 'Selected exact review history' });
  fireEvent(window, new Event('blur')); expect(screen.queryByRole('heading', { name: 'Selected exact review history' })).toBeNull();
  fireEvent(window, new Event('focus')); await screen.findByRole('heading', { name: 'Selected exact review history' });
  expect((screen.getByLabelText('Prepared response basis') as HTMLTextAreaElement).value).toBe('Original prepared response retained');
  expect(held).toBeTruthy();
});

test('project/principal reset rejects held results and clears prepared forms', async () => {
  const f = fixture(); const view = render(panel()); await prepare(); f.hold();
  fireEvent.click(screen.getByRole('button', { name: 'Refresh review access' }));
  view.rerender(panel('different-principal', true, true, 'different-project')); f.release();
  await screen.findByLabelText('Change review title');
  expect(screen.queryByRole('heading', { name: 'Selected exact review history' })).toBeNull();
  expect((screen.getByLabelText('Prepared response basis') as HTMLTextAreaElement).value).toBe('');
});

test('viewer can inspect and acknowledge personal inbox but cannot send engineering review responses', async () => {
  const f = fixture(); render(panel('viewer', true, false)); await selectReview();
  expect(screen.queryByRole('button', { name: 'Submit prepared team response' })).toBeNull();
  expect(screen.getByRole('note').textContent).toContain('Read-only access: requires Edit');
  fireEvent.click(screen.getByRole('button', { name: 'Mark notification read' }));
  await waitFor(() => expect(f.calls.some(c => c.operation === 'collaboration.mark_read')).toBe(true));
  expect(f.calls.some(c => c.operation === 'collaboration.respond')).toBe(false);
});

test('StrictMode initial authorization settles without a stranded pending display', async () => {
  fixture(); render(<StrictMode>{panel()}</StrictMode>);
  await screen.findByRole('combobox', { name: 'Retained team review' });
  expect((screen.getByLabelText('Change review title') as HTMLInputElement).disabled).toBe(false);
});

test('closing denied historic selection permits a clean context without reviving its private metadata', async () => {
  const f = fixture(); render(panel()); await prepare(); f.deny();
  fireEvent.click(screen.getByRole('button', { name: 'Refresh review access' }));
  await screen.findByText(/Current access is unavailable/);
  expect(screen.queryByText('Private original explanation')).toBeNull();
  f.restore(); fireEvent.click(screen.getByRole('button', { name: 'Close selected team review' }));
  await screen.findByRole('combobox', { name: 'Retained team review' });
  expect(screen.queryByRole('heading', { name: 'Selected exact review history' })).toBeNull();
  expect(screen.queryByText('Private original explanation')).toBeNull();
  expect((screen.getByLabelText('Prepared response basis') as HTMLTextAreaElement).value).toBe('Original prepared response retained');
});

test('inactive scope fences retained review choices and protected labels', async () => {
  fixture(); const view = render(panel());
  await screen.findByRole('combobox', { name: 'Retained team review' });
  view.rerender(panel('owner', false));
  expect(screen.queryByRole('combobox', { name: 'Retained team review' })).toBeNull();
  expect(screen.queryByText(/Original private review title/)).toBeNull();
});

test('reviews and inbox are workspace reads; a project is only ordering context', async () => {
  const f = fixture(); const view = render(panel());
  await screen.findByRole('combobox', { name: 'Retained team review' });
  const scoped = f.calls.filter(c => c.operation === 'collaboration.list' || c.operation === 'collaboration.inbox');
  expect(scoped.length).toBeGreaterThan(0);
  expect(scoped.every(c => c.payload.project_id === 'project')).toBe(true);
  view.unmount();
  const g = fixture(); render(<MantineProvider><PermissionsProvider permissions={grants({ edit: true })}><CollaborationPanel principalKey="owner" active /></PermissionsProvider></MantineProvider>);
  await screen.findByRole('combobox', { name: 'Retained team review' });
  const library = g.calls.filter(c => c.operation === 'collaboration.list' || c.operation === 'collaboration.inbox');
  expect(library.every(c => !('project_id' in c.payload))).toBe(true);
});
