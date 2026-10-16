import { MantineProvider } from '@mantine/core';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { FirmwareAssignmentReview } from './FirmwareAssignmentReview';
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
function renderReview(snapshotId: string | null) { const cache = new QueryClient({ defaultOptions: { queries: { retry: false } } }); return render(<MantineProvider><QueryClientProvider client={cache}><FirmwareAssignmentReview active principalKey="viewer" snapshotId={snapshotId} /></QueryClientProvider></MantineProvider>); }
test('current frozen Device reviews exact target assignments read-only without an owner picker', async () => {
  const fetchMock = vi.fn(async (_url: string) => new Response(JSON.stringify({ assembly_snapshot_id: 'exact', assignments: [{ path: ['right', 'board'], firmware_name: 'Synthetic firmware', status: 'invalid', message: 'Wrong target: a different population revision.' }] }))); vi.stubGlobal('fetch', fetchMock);
  renderReview('exact'); await screen.findByText(/Wrong target:/);
  expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/v0/pcb/assemblies/exact/firmware-review');
  expect(screen.queryByRole('combobox')).toBeNull(); expect(screen.queryByRole('button', { name: /Save|Adopt/ })).toBeNull();
});
test('unknown Device state makes no review request', () => { const fetchMock = vi.fn(); vi.stubGlobal('fetch', fetchMock); renderReview(null); expect(screen.getByText(/Freeze a Device revision/)).toBeTruthy(); expect(fetchMock).not.toHaveBeenCalled(); });
test('denied focus recheck withdraws earlier target findings', async () => {
  let denied = false; vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(denied ? { error: { message: 'Review denied' } } : { assignments: [{ path: ['board'], firmware_name: 'Private controller', status: 'unknown', message: 'Not evaluated' }] }), { status: denied ? 403 : 200 })));
  renderReview('exact'); await screen.findByText('Private controller'); denied = true;
  fireEvent.click(screen.getByRole('button', { name: 'Refresh assigned target review' })); await screen.findByText('Review denied'); expect(screen.queryByText('Private controller')).toBeNull();
});
