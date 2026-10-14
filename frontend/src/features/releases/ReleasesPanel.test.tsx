import { MantineProvider } from '@mantine/core';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { PermissionsProvider } from '../../lib/permissions';
import { ReleasesPanel } from './ReleasesPanel';
import type { ReleaseReviewBody } from './api';

beforeEach(() => { vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} }); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const ROOT = '11111111-1111-4111-8111-111111111111';
const SENSOR = '22222222-2222-4222-8222-222222222222';
const STALE = { id: 'evidence:stale_earlier_revision:x:fact:1', category: 'evidence' as const, reason: 'Recorded against revision 1. Revision 2 is selected.' };
const RIGHTS = { id: `rights:design:${SENSOR}`, category: 'rights' as const, reason: 'Rights for this exact subject are not cleared (unknown).' };

function body(quantity: number | null): ReleaseReviewBody {
  const pin = (id: string, role: 'root' | 'occurrence', later: number | null) => ({
    revision_id: id, definition_id: `${id}-def`, kind: role === 'root' ? 'assembly' : 'component', name: role === 'root' ? 'Synthetic root' : 'Synthetic sensor',
    number: role === 'root' ? 1 : 2, snapshot_sha256: 'a'.repeat(64), role, per_root_occurrences: 1,
    scope_quantity: quantity === null ? { status: 'unknown' as const, amount: null } : { status: 'known' as const, amount: quantity }, later_revision_number: later,
  });
  const unresolved = quantity === null ? [{ id: 'quantity:root', category: 'quantity' as const, reason: 'The root quantity in scope is unknown.' }, STALE, RIGHTS] : [STALE, RIGHTS];
  return {
    root: { revision_id: ROOT, name: 'Synthetic root', kind: 'assembly', number: 1, sha256: 'b'.repeat(64) },
    quantity: { status: quantity === null ? 'unknown' : 'known', amount: quantity },
    revisions: [pin(ROOT, 'root', null), pin(SENSOR, 'occurrence', 3)],
    configurations: [],
    dependencies: { revisions: [], sources: [], opaque_source_revision_ids: [] },
    artifacts: { package_manifest_sha256: 'c'.repeat(64), coherence: quantity === null ? 'unknown' : 'coherent', completeness: 'limited', outputs: [], files: [], unsupported: [] },
    rights: { subjects: [
      { subject: `design:${ROOT}`, kind: 'design', revision_id: ROOT, declared_rights: null, review: { subject: `design:${ROOT}`, decision: 'permitted', basis: 'Synthetic original' } },
      { subject: `design:${SENSOR}`, kind: 'design', revision_id: SENSOR, declared_rights: null, review: { subject: `design:${SENSOR}`, decision: 'unknown', basis: '' } },
    ], cleared: 1, uncleared: 1, catalog: {
      items: [{ subject: 'source_identifier:7', revision_id: SENSOR, definition_name: 'Synthetic sensor', record: 'library-id', label: 'Synthetic:Restricted', rights_status: 'restricted', declared_rights: 'Vendor terms' }],
      counts: { cleared: 0, restricted: 1, unknown: 0 }, undeclared_revision_ids: [ROOT], unresolved: 1,
    } },
    evidence: { items: [], counts: { stale_earlier_revision: 1 }, evaluated_revisions: 2, not_evaluated_revisions: 0 },
    unresolved, blockers: [], status: 'unresolved',
  };
}

function response(data: unknown, status = 200) { return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } }); }

function fixture() {
  const calls: { operation: string; payload: Record<string, unknown>; idempotency_key?: string }[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, options?: RequestInit) => {
    if (url.endsWith('/operations')) {
      const request = JSON.parse(String(options?.body));
      calls.push(request);
      switch (request.operation) {
        case 'release.list': return response({ result: { releases: [], total: 0 } });
        case 'configuration.list_resolved': return response({ result: { resolved: [], truncated: false } });
        case 'export_package.candidates': return response({ result: { root_revision_id: ROOT, scene_drawings: [], preparation_document_sets: [], test_plans: [], pcb_fabrication_builds: [], firmware_builds: [] } });
        case 'release.review': return response({ result: { review: body(request.payload.quantity), sha256: 'review-hash' } });
        case 'release.create': return response({ result: { release_id: 'release-1' } });
        case 'release.read': return response({ result: {
          release_id: 'release-1', workspace_id: 'ws', name: 'Synthetic release', root: body(2).root, status: 'unresolved', unresolved_count: 2, acknowledged: true,
          record_sha256: 'd'.repeat(64), released_by: 'editor', released_at: '2026-10-14T12:00:00Z', archive_sha256: 'e'.repeat(64), archive_bytes: 10,
          record: { name: 'Synthetic release', notes: '', review: body(2), review_sha256: 'review-hash', acknowledgement: { reason: 'Synthetic evaluation', unresolved_ids: [STALE.id, RIGHTS.id] }, archive: { sha256: 'e'.repeat(64), bytes: 10, manifest_sha256: 'c'.repeat(64) } },
        } });
        default: return response({ result: {} });
      }
    }
    if (url.includes('/catalog/definitions/')) return response({ definition_id: 'root-def', name: 'Synthetic root', kind: 'assembly', revisions: [{ revision_id: ROOT, number: 1 }] });
    if (url.includes('/revisions/') || url.includes('revision_labels') || url.includes('/labels')) return response({});
    return response([{ definition_id: 'root-def', name: 'Synthetic root', kind: 'assembly' }]);
  }));
  return calls;
}

function wrap(permissions?: string[]) {
  return <MantineProvider><QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <PermissionsProvider permissions={permissions}><ReleasesPanel workspaceId="ws" projectId="project-1" /></PermissionsProvider>
  </QueryClientProvider></MantineProvider>;
}

async function choose(label: string, option: string) {
  const input = await screen.findByRole('combobox', { name: label });
  fireEvent.focus(input); fireEvent.keyDown(input, { key: 'ArrowDown' });
  fireEvent.click(await screen.findByRole('option', { name: option, hidden: true }));
}

async function reviewRoot(permissions?: string[], quantity = '') {
  render(wrap(permissions));
  await choose('Release root definition', 'Synthetic root (assembly)');
  await waitFor(() => expect((screen.getByRole('combobox', { name: 'Release root revision' }) as HTMLInputElement).disabled).toBe(false));
  await choose('Release root revision', 'Synthetic root · r1');
  if (quantity) fireEvent.change(screen.getByLabelText('Root quantity in scope'), { target: { value: quantity } });
  fireEvent.click(screen.getByRole('button', { name: 'Review release closure' }));
  await screen.findByText('Release review');
}

test('unresolved items are listed and releasing needs an acknowledgement reason', async () => {
  const calls = fixture();
  await reviewRoot(['workspace.read', 'design.freeze', 'project.edit'], '2');
  expect(screen.getByText(STALE.reason)).toBeTruthy();
  expect(screen.getByText(RIGHTS.reason)).toBeTruthy();
  expect(screen.getByText('r3 exists')).toBeTruthy();
  fireEvent.change(screen.getByLabelText('Release name'), { target: { value: 'Synthetic release' } });
  const button = screen.getByRole('button', { name: 'Acknowledge and release' }) as HTMLButtonElement;
  expect(button.disabled).toBe(true);
  fireEvent.change(screen.getByLabelText(/Acknowledgement reason/), { target: { value: 'Synthetic evaluation' } });
  expect(button.disabled).toBe(false);
  fireEvent.click(button);
  await screen.findByText('Released with acknowledged unresolved items');
  const create = calls.find(c => c.operation === 'release.create');
  expect(create?.payload).toMatchObject({ root_revision_id: ROOT, quantity: 2, reviewed_sha256: 'review-hash', acknowledgement: { reason: 'Synthetic evaluation' }, project_id: 'project-1', name: 'Synthetic release' });
  expect(create?.idempotency_key).toBeTruthy();
});

test('unknown root quantity stays unknown and rights edits require rereview', async () => {
  const calls = fixture();
  await reviewRoot(['workspace.read', 'design.freeze']);
  expect(calls.find(c => c.operation === 'release.review')?.payload.quantity).toBeNull();
  expect(screen.getAllByText('Root quantity unknown').length).toBeGreaterThan(0);
  fireEvent.change(screen.getByLabelText(`Rights basis design:${SENSOR}`), { target: { value: 'Synthetic original' } });
  expect(screen.getByText(/Review the release closure again/)).toBeTruthy();
  fireEvent.change(screen.getByLabelText('Release name'), { target: { value: 'Synthetic release' } });
  fireEvent.change(screen.getByLabelText(/Acknowledgement reason/), { target: { value: 'Synthetic' } });
  expect((screen.getByRole('button', { name: 'Acknowledge and release' }) as HTMLButtonElement).disabled).toBe(true);
});

test('read-only members review the closure but cannot decide rights or release', async () => {
  fixture();
  await reviewRoot(['workspace.read'], '2');
  expect(screen.getByText(STALE.reason)).toBeTruthy();
  expect(screen.queryByRole('button', { name: /release$/i })).toBeNull();
  expect(screen.getByText(/Read-only access: requires Freeze/)).toBeTruthy();
  // Declared catalog rights from the export package are shown as recorded, not as cleared.
  expect(screen.getByText('Declared catalog rights')).toBeTruthy();
  expect(screen.getByText('library-id: Synthetic:Restricted')).toBeTruthy();
  expect(screen.getByText('Vendor terms')).toBeTruthy();
  expect(screen.getByText(/0 cleared, 1 restricted, 0 unknown; 1 revisions declare none/)).toBeTruthy();
});
