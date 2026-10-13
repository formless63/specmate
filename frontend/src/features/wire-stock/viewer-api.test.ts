import { afterEach, expect, test, vi } from 'vitest';
import { listStockRevisions, loadFrozenStock, matchingProfileRevisions } from './viewer-api';
import { profileRevision } from './profile-test-fixtures';
afterEach(() => vi.unstubAllGlobals());
test('loads all exact stock revision pages rather than the latest draft baseline only', async () => {
  const first = Array.from({ length: 100 }, (_, i) => ({ revision_id: `r${i}`, number: i + 1 }));
  const fetcher = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ kind: 'wire_stock', revisions: first })))
    .mockResolvedValueOnce(new Response(JSON.stringify({ kind: 'wire_stock', revisions: [{ revision_id: 'r100', number: 101 }] })));
  vi.stubGlobal('fetch', fetcher);
  expect(await listStockRevisions('stock/definition')).toHaveLength(101);
  expect(fetcher.mock.calls[1]![0]).toBe('/api/v0/catalog/definitions/stock%2Fdefinition?offset=100&limit=100');
  expect(fetcher.mock.calls[0]![1]).toEqual({ credentials: 'same-origin' });
});
test('matches historical frozen profiles by exact stock pin, independent of current profile drafts', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify([profileRevision(), profileRevision('stock-r2', 'profile-r2')]))));
  const result = await matchingProfileRevisions([{ definition_id: 'profile-definition', name: 'Profile', kind: 'workshop_profile' }], 'stock-r1');
  expect(result.map(r => r.revision_id)).toEqual(['profile-r1']);
});
test('propagates authorization failure instead of falling back to editable construction', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: { message: 'Access denied.' } }), { status: 403 })));
  await expect(loadFrozenStock('restricted')).rejects.toThrow('Access denied');
});
test('reports a frozen revision with no typed stock as unavailable, never inventing construction', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ content: { label: 'Unfinished definition' } }))));
  await expect(loadFrozenStock('stock-without-construction')).rejects.toThrow('Selected revision has no stock construction.');
});
