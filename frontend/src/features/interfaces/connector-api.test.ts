import { afterEach, expect, test, vi } from 'vitest';
import { authorizeConnectorReferences } from './connector-api';
import type { Body } from './api';
afterEach(() => vi.unstubAllGlobals());
const id = (number: number) => `00000000-0000-4000-8000-${String(number).padStart(12, '0')}`;
test('prepared references use fresh closure-aware batches of at most 50 and require every exact ID readable', async () => {
  const calls: URL[] = []; let denied = false;
  vi.stubGlobal('fetch', vi.fn(async (path: string) => { const url = new URL(path, 'http://local'); calls.push(url); return new Response(JSON.stringify({ labels: url.searchParams.getAll('revision_ids').map(revision_id => ({ revision_id, readable: !denied || revision_id !== id(60) })), source_labels: [] })); }));
  const value: Body = { kind: 'connector_body', family: null, mating_role: 'unknown', contacts: [], drawing_orientation: { viewing_side: 'unknown', rotation_degrees: null, datum: null }, mates_with: Array.from({ length: 75 }, (_, index) => ({ body_revision_id: id(index), correspondence: 'same_contact_id', pairs: [], review: 'unreviewed', basis: null })) };
  await authorizeConnectorReferences(value); expect(calls.map(url => url.searchParams.getAll('revision_ids').length)).toEqual([50, 25]); expect(calls.every(url => url.pathname === '/api/v0/catalog/revision-labels')).toBe(true);
  denied = true; await expect(authorizeConnectorReferences(value)).rejects.toThrow('A selected exact reference is unavailable');
});
