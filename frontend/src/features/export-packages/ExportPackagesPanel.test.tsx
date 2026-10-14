import { MantineProvider } from '@mantine/core';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { ExportPackagesPanel } from './ExportPackagesPanel';
import type { Review } from './api';

beforeEach(() => { vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} }); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const ROOT = '11111111-1111-4111-8111-111111111111';
function wrap() {
  return <MantineProvider><QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><ExportPackagesPanel projectId="project" /></QueryClientProvider></MantineProvider>;
}
function response(data: unknown, status = 200) { return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } }); }
function reviewed(coherence: 'coherent' | 'incoherent', quantity: number | null): Review {
  const scope = (count: number) => quantity === null ? { status: 'unknown' as const, amount: null, per_root: count } : { status: 'known' as const, amount: count * quantity, per_root: count };
  return { sha256: 'review-hash', manifest: {
    scope: { root: { revision_id: ROOT, definition_id: 'root-def', kind: 'assembly', name: 'Synthetic root', number: 1, sha256: 'root-hash' }, quantity, quantity_status: quantity === null ? 'unknown' : 'known' },
    pins: [{ revision_id: 'cable-rev', definition_id: 'cable-def', kind: 'cable', name: 'Synthetic cable', number: 1, sha256: 'cable-hash', per_root_occurrences: 2, scope_quantity: scope(2) },
      { revision_id: 'stock-rev', definition_id: 'stock-def', kind: 'wire_stock', name: 'Synthetic stock', number: 1, sha256: 'stock-hash', per_root_occurrences: null, scope_quantity: { status: 'not_applicable', amount: null } }],
    sections: { system: { status: 'included' } },
    outputs: [{ id: 'preparation_document_set:set', section: 'cable', kind: 'preparation_document_set', coherence, cited_revisions: [], scope_quantity: scope(2), findings: coherence === 'incoherent' ? [{ status: 'incoherent', reason: 'document_quantity_differs' }] : [], files: [] }],
    coherence, completeness: coherence === 'coherent' ? 'complete' : 'limited', unresolved: [],
    unsupported: [{ id: 'spreadsheet.xlsx', section: 'spreadsheet', reason: 'Spreadsheets are RFC 4180 CSV; no XLSX workbook is generated.' }], files: [],
  } };
}
async function choose(label: string, option: string) {
  const input = await screen.findByRole('combobox', { name: label });
  fireEvent.focus(input); fireEvent.keyDown(input, { key: 'ArrowDown' });
  fireEvent.click(await screen.findByRole('option', { name: option, hidden: true }));
}
function fixture(coherence: 'coherent' | 'incoherent' = 'coherent') {
  const calls: { operation: string; payload: Record<string, unknown>; idempotency_key?: string }[] = [];
  let downloadBody: Record<string, unknown> | null = null;
  vi.stubGlobal('fetch', vi.fn(async (url: string, options?: RequestInit) => {
    if (url.endsWith('/operations')) {
      const body = JSON.parse(String(options?.body)); calls.push(body);
      return response({ result: reviewed(coherence, body.payload.quantity) });
    }
    if (url.endsWith('/export-packages/download')) { downloadBody = JSON.parse(String(options?.body)); return new Response('synthetic-zip'); }
    if (url.includes('/preparation-documents/workspace')) return response({ document_sets: [] });
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
  expect(screen.getByText(/no XLSX workbook/)).toBeTruthy();
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
