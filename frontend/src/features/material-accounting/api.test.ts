import { afterEach, expect, test, vi } from 'vitest';
import { CableOperationError } from '../cables/api';
import { authorityDenied, checkAuthority, emptyPlan } from './api';

afterEach(() => { vi.unstubAllGlobals(); document.cookie = 'csrftoken=; Max-Age=0'; });

test('authority posts the raw plan to the fresh read endpoint without an operation key', async () => {
  const plan = { ...emptyPlan(), subject_revision_id: 'exact-subject' };
  document.cookie = 'csrftoken=synthetic%20token';
  const fetcher = vi.fn(async (_url: string, _options: RequestInit) => new Response(JSON.stringify({ authorized: true })));
  vi.stubGlobal('fetch', fetcher);
  expect(await checkAuthority(plan)).toEqual({ authorized: true });
  expect(fetcher).toHaveBeenCalledWith('/api/v0/material-accounting/authority', {
    method: 'POST', credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', 'X-CSRFToken': 'synthetic token' },
    body: JSON.stringify(plan),
  });
  const body = JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body));
  expect(body).not.toHaveProperty('idempotency_key');
  expect(body).not.toHaveProperty('operation');
});

test.each([401, 403, 404, 422])('authority preserves HTTP %s without claiming success', async status => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: { message: 'Exact read denied or invalid' } }), { status })));
  let error: unknown;
  try { await checkAuthority(emptyPlan()); } catch (reason) { error = reason; }
  expect(error).toBeInstanceOf(CableOperationError);
  expect(error).toMatchObject({ status, message: 'Exact read denied or invalid' });
  expect(authorityDenied(error)).toBe(status !== 422);
});
