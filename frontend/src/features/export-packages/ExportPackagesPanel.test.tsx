import { MantineProvider } from '@mantine/core';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { ExportPackagesPanel } from './ExportPackagesPanel';
import type { Review } from './api';

beforeEach(() => { vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} }); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const ROOT = '11111111-1111-4111-8111-111111111111';
const CANDIDATES = {
  root_revision_id: ROOT,
  scene_drawings: [{ drawing_id: 'drawing-one', revision_id: ROOT, name: 'Synthetic root', renderer_version: 'scene-line-svg-v1', created_at: '2026-10-14' }],
  preparation_document_sets: [{ document_set_id: 'set-one', root_revision_id: 'cable-rev', name: 'Synthetic cable', quantity: 6, created_at: '2026-10-14' }],
  test_plans: [{ revision_id: 'plan-one', name: 'Synthetic plan', number: 2, root_revision_id: ROOT, occurrence_path: ['left'] }],
  pcb_fabrication_builds: [{ intake_id: 'intake-0001', build_id: 'build-0001' }],
  firmware_builds: [{ firmware_revision_id: 'firmware-rev-0001', assembly_snapshot_id: 'snapshot-0001', path: ['right'], build_id: 'fwbuild-0001' }],
};
function wrap() {
  return <MantineProvider><QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><ExportPackagesPanel projectId="project" /></QueryClientProvider></MantineProvider>;
}
function response(data: unknown, status = 200) { return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } }); }
const CLEARED = { items: [], counts: { cleared: 0, restricted: 0, unknown: 0 }, undeclared_revision_ids: [], acknowledgement_required: false };
const RESTRICTED = { items: [{ subject: 'source_identifier:one', revision_id: 'cable-rev', definition_name: 'Synthetic cable', record: 'library-id', label: 'Library id', rights_status: 'restricted' as const, declared_rights: 'Vendor terms' }], counts: { cleared: 0, restricted: 1, unknown: 0 }, undeclared_revision_ids: ['stock-rev'], acknowledgement_required: true };
function reviewed(coherence: 'coherent' | 'incoherent', quantity: number | null, rights: Review['manifest']['rights'] = CLEARED): Review {
  const scope = (count: number) => quantity === null ? { status: 'unknown' as const, amount: null, per_root: count } : { status: 'known' as const, amount: count * quantity, per_root: count };
  return { sha256: 'review-hash', manifest: {
    scope: { root: { revision_id: ROOT, definition_id: 'root-def', kind: 'assembly', name: 'Synthetic root', number: 1, sha256: 'root-hash' }, quantity, quantity_status: quantity === null ? 'unknown' : 'known' },
    pins: [{ revision_id: 'cable-rev', definition_id: 'cable-def', kind: 'cable', name: 'Synthetic cable', number: 1, sha256: 'cable-hash', per_root_occurrences: 2, scope_quantity: scope(2) },
      { revision_id: 'stock-rev', definition_id: 'stock-def', kind: 'wire_stock', name: 'Synthetic stock', number: 1, sha256: 'stock-hash', per_root_occurrences: null, scope_quantity: { status: 'not_applicable', amount: null } }],
    sections: { system: { status: 'included' } },
    outputs: [{ id: 'preparation_document_set:set', section: 'cable', kind: 'preparation_document_set', coherence, cited_revisions: [], scope_quantity: scope(2), findings: coherence === 'incoherent' ? [{ status: 'incoherent', reason: 'document_quantity_differs' }] : [], files: [] }],
    coherence, completeness: coherence === 'coherent' ? 'complete' : 'limited', unresolved: [],
    unsupported: [{ id: 'test.results', section: 'test', reason: 'No physical test was performed.' }], files: [],
    rights,
  } };
}
async function choose(label: string, option: string) {
  const input = await screen.findByRole('combobox', { name: label });
  fireEvent.focus(input); fireEvent.keyDown(input, { key: 'ArrowDown' });
  fireEvent.click(await screen.findByRole('option', { name: option, hidden: true }));
}
function fixture(coherence: 'coherent' | 'incoherent' = 'coherent', rights: Review['manifest']['rights'] = CLEARED) {
  const calls: { operation: string; payload: Record<string, unknown>; idempotency_key?: string }[] = [];
  let downloadBody: Record<string, unknown> | null = null;
  vi.stubGlobal('fetch', vi.fn(async (url: string, options?: RequestInit) => {
    if (url.endsWith('/operations')) {
      const body = JSON.parse(String(options?.body));
      if (body.operation === 'export_package.candidates') return response({ result: CANDIDATES });
      calls.push(body);
      return response({ result: reviewed(coherence, body.payload.quantity, rights) });
    }
    if (url.endsWith('/export-packages/download')) { downloadBody = JSON.parse(String(options?.body)); return new Response('synthetic-zip'); }
    if (url.includes('/catalog/definitions/')) return response({ definition_id: 'root-def', name: 'Synthetic root', kind: 'assembly', revisions: [{ revision_id: ROOT, number: 1 }] });
    if (url.includes('/revisions/')) return response({});
    return response([{ definition_id: 'root-def', name: 'Synthetic root', kind: 'assembly' }]);
  }));
  return { calls, body: () => downloadBody };
}
async function selectRoot() {
  render(wrap());
  await choose('Package root definition', 'Synthetic root (assembly)');
  await waitFor(() => expect((screen.getByRole('combobox', { name: 'Package root revision' }) as HTMLInputElement).disabled).toBe(false));
  await choose('Package root revision', 'Synthetic root · r1');
}

test('unknown root quantity is sent as null and shown as unknown, never zero', async () => {
  const f = fixture(); await selectRoot();
  fireEvent.click(screen.getByRole('button', { name: 'Review export package' }));
  await screen.findByText('Export package review');
  expect(f.calls[0]).toMatchObject({ operation: 'export_package.review', payload: { root_revision_id: ROOT, quantity: null, purpose: 'authorized_review' } });
  expect(f.calls[0]?.idempotency_key).toBeUndefined();
  expect(screen.getByText('Root quantity unknown')).toBeTruthy();
  expect(screen.queryByText(/^0$/)).toBeNull();
  expect(screen.getByText(/No physical test was performed/)).toBeTruthy();
});

test('known quantity review downloads with the reviewed hash; edits require rereview', async () => {
  const f = fixture();
  vi.stubGlobal('URL', class extends URL { static createObjectURL = vi.fn(() => 'blob:synthetic'); static revokeObjectURL = vi.fn(); });
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
  await selectRoot();
  fireEvent.change(screen.getByLabelText('Root quantity in scope'), { target: { value: '3' } });
  fireEvent.click(screen.getByRole('button', { name: 'Review export package' }));
  await screen.findByText('Export package review');
  expect(f.calls[0]?.payload.quantity).toBe(3);
  expect(screen.getAllByText('6').length).toBeGreaterThan(0);
  fireEvent.click(screen.getByRole('button', { name: 'Download export package' }));
  await waitFor(() => expect(f.body()).toMatchObject({ root_revision_id: ROOT, quantity: 3, reviewed_sha256: 'review-hash' }));
  fireEvent.change(screen.getByLabelText('Root quantity in scope'), { target: { value: '4' } });
  expect((screen.getByRole('button', { name: 'Download export package' }) as HTMLButtonElement).disabled).toBe(true);
  expect(screen.getByText(/Review the export package again/)).toBeTruthy();
});

test('incoherent outputs are explained and cannot be downloaded', async () => {
  fixture('incoherent'); await selectRoot();
  fireEvent.click(screen.getByRole('button', { name: 'Review export package' }));
  await screen.findByText('document_quantity_differs');
  expect((screen.getByRole('button', { name: 'Download export package' }) as HTMLButtonElement).disabled).toBe(true);
  expect(screen.getByText(/cite different revisions or quantities/)).toBeTruthy();
});

test('retained outputs are chosen from root candidates and sent as exact references', async () => {
  const f = fixture(); await selectRoot();
  await choose('Preparation document sets', 'Synthetic cable · quantity 6 · 2026-10-14');
  await choose('Cable test plans', 'Synthetic plan · r2 · left');
  await choose('PCB fabrication builds', 'Build build-00 · intake intake-0');
  await choose('Firmware builds', 'Build fwbuild- · firmware firmware · right');
  await choose('Scene drawings', 'Synthetic root · scene-line-svg-v1 · 2026-10-14');
  fireEvent.click(screen.getByRole('button', { name: 'Review export package' }));
  await screen.findByText('Export package review');
  expect(f.calls[0]?.payload).toMatchObject({
    firmware_builds: [{ firmware_revision_id: 'firmware-rev-0001', assembly_snapshot_id: 'snapshot-0001', path: ['right'], build_id: 'fwbuild-0001' }],
    preparation_document_set_ids: ['set-one'], test_plan_revision_ids: ['plan-one'],
    pcb_fabrication_builds: [{ intake_id: 'intake-0001', build_id: 'build-0001' }], scene_drawing_ids: ['drawing-one'],
  });
});

test('restricted or unknown rights require an explicit acknowledgement before download', async () => {
  const f = fixture('coherent', RESTRICTED);
  vi.stubGlobal('URL', class extends URL { static createObjectURL = vi.fn(() => 'blob:synthetic'); static revokeObjectURL = vi.fn(); });
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
  await selectRoot();
  fireEvent.click(screen.getByRole('button', { name: 'Review export package' }));
  await screen.findByText('Vendor terms');
  expect(screen.getByText(/1 pinned revisions have no rights declaration/)).toBeTruthy();
  const button = screen.getByRole('button', { name: 'Download export package' }) as HTMLButtonElement;
  expect(button.disabled).toBe(true);
  fireEvent.click(screen.getByRole('checkbox'));
  expect(button.disabled).toBe(false);
  fireEvent.click(button);
  await waitFor(() => expect(f.body()).toMatchObject({ reviewed_sha256: 'review-hash', rights_acknowledged: true }));
});
