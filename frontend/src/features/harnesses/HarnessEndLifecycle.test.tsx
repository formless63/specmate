import { MantineProvider } from '@mantine/core';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { StrictMode } from 'react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { DraftEditor } from './HarnessPanel';
import { initialHarness, type Draft, type Harness } from './api';

beforeEach(() => vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} }));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const initial: Harness = { ...initialHarness(), sections: [{ local_id: 'piece', stock_revision_id: 'stock', planned_cut_length_mm: null, cut_basis: null, physical_ends: [{ local_id: 'cut', label: null, segment_ends: [{ segment_id: 'span', end: 'b' }], endpoint_id: null, basis: 'original basis', review: 'unreviewed' }] }], segments: [{ local_id: 'span', section_id: 'piece', label: null, element_paths: null }] };
const draft = (state = 'v1', harness = initial): Draft => ({ definition_id: 'definition', draft_id: 'draft', state, content: { harness } });
function deferred<T>() { let resolve!: (v: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
function wrapper(children: React.ReactNode) { return <StrictMode><MantineProvider><QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{children}</QueryClientProvider></MantineProvider></StrictMode>; }
const onSaved = async () => {}; const onAuthorityChange = () => {};
function fill(value: string) { fireEvent.change(screen.getByLabelText('Physical end piece/cut basis'), { target: { value } }); }

test('same-draft read refresh preserves unsaved physical declarations and original CAS', async () => {
  const requests: { expected_state: string; payload: { harness: Harness } }[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, options?: RequestInit) => { if (url.endsWith('operations')) { const request = JSON.parse(String(options?.body)); requests.push(request); return response({ result: draft('v2', request.payload.harness) }); } return response({ content: { stock: { structure: { kind: 'conductor', id: 'wire' } } } }); }));
  const view = render(wrapper(<DraftEditor draft={draft()} definitions={[]} onSaved={onSaved} onAuthorityChange={onAuthorityChange} />)); fill('unsaved exact material basis');
  view.rerender(wrapper(<DraftEditor draft={draft('newer-server-token', { ...initial, sections: [] })} definitions={[]} onSaved={onSaved} onAuthorityChange={onAuthorityChange} />));
  expect((screen.getByLabelText('Physical end piece/cut basis') as HTMLInputElement).value).toBe('unsaved exact material basis'); fireEvent.click(screen.getByText('Save harness draft')); await waitFor(() => expect(requests).toHaveLength(1)); expect(requests[0]).toMatchObject({ expected_state: 'v1', payload: { harness: { sections: [{ physical_ends: [{ basis: 'unsaved exact material basis' }] }] } } }); await screen.findByText('v2');
});

test('accepted pending save preserves newer edits while advancing CAS', async () => {
  const pending = deferred<Response>(); const requests: { expected_state: string; payload: { harness: Harness } }[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, options?: RequestInit) => { if (url.endsWith('operations')) { const request = JSON.parse(String(options?.body)); requests.push(request); return requests.length === 1 ? pending.promise : response({ result: draft('v3', request.payload.harness) }); } return response({ content: { stock: { structure: { kind: 'conductor', id: 'wire' } } } }); }));
  render(wrapper(<DraftEditor draft={draft()} definitions={[]} onSaved={onSaved} onAuthorityChange={onAuthorityChange} />)); fill('submitted basis'); fireEvent.click(screen.getByText('Save harness draft')); await waitFor(() => expect(requests).toHaveLength(1)); fill('newer unsaved basis'); await act(async () => { pending.resolve(response({ result: draft('v2', requests[0]!.payload.harness) })); }); await screen.findByText('v2'); expect((screen.getByLabelText('Physical end piece/cut basis') as HTMLInputElement).value).toBe('newer unsaved basis'); fireEvent.click(screen.getByText('Save harness draft')); await waitFor(() => expect(requests).toHaveLength(2)); expect(requests[1]).toMatchObject({ expected_state: 'v2', payload: { harness: { sections: [{ physical_ends: [{ basis: 'newer unsaved basis' }] }] } } });
});

test('mutation denial hides declarations and restoration preserves fields and CAS', async () => {
  let denied = true; const requests: { expected_state: string; payload: { harness: Harness } }[] = []; const onAuthority = vi.fn();
  vi.stubGlobal('fetch', vi.fn(async (url: string, options?: RequestInit) => { if (url.endsWith('operations')) { const request = JSON.parse(String(options?.body)); requests.push(request); return denied ? response({ error: { message: 'Current source denied' } }, 404) : response({ result: draft('v2', request.payload.harness) }); } if (url.includes('/drafts/')) return response(draft('newer-server-token')); if (url.endsWith('/authority')) return response({ authorized: true }); return response({ content: { stock: { structure: { kind: 'conductor', id: 'wire' } } } }); }));
  render(wrapper(<DraftEditor draft={draft()} definitions={[]} onSaved={onSaved} onAuthorityChange={onAuthority} />)); fill('retained unsaved basis'); fireEvent.click(screen.getByText('Save harness draft')); await screen.findByText('Current source denied'); expect(screen.queryByLabelText('Physical end piece/cut basis')).toBeNull(); expect(onAuthority).toHaveBeenLastCalledWith(true); denied = false; fireEvent.click(screen.getByText('Restore Harness draft access')); await screen.findByLabelText('Physical end piece/cut basis'); expect((screen.getByLabelText('Physical end piece/cut basis') as HTMLInputElement).value).toBe('retained unsaved basis'); fireEvent.click(screen.getByText('Save harness draft')); await waitFor(() => expect(requests).toHaveLength(2)); expect(requests[1]!.expected_state).toBe('v1');
});

test('actual draft replacement fences late accepted save', async () => {
  const pending = deferred<Response>(); const saved = vi.fn(async () => {});
  vi.stubGlobal('fetch', vi.fn(async (url: string) => url.endsWith('operations') ? pending.promise : response({ content: { stock: { structure: { kind: 'conductor', id: 'wire' } } } })));
  const view = render(wrapper(<DraftEditor key="old" draft={draft()} definitions={[]} onSaved={saved} onAuthorityChange={onAuthorityChange} />)); fireEvent.click(screen.getByText('Save harness draft')); view.rerender(wrapper(<DraftEditor key="new" draft={{ ...draft('replacement'), draft_id: 'other' }} definitions={[]} onSaved={saved} onAuthorityChange={onAuthorityChange} />)); await act(async () => { pending.resolve(response({ result: draft('late') })); }); expect(screen.queryByText('late')).toBeNull(); expect(screen.getByText('replacement')).toBeTruthy(); expect(saved).not.toHaveBeenCalled();
});

test('own accepted freeze advances CAS without replacing unsaved declarations', async () => {
  const requests: { expected_state: string }[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, options?: RequestInit) => { if (url.endsWith('operations')) { const request = JSON.parse(String(options?.body)); requests.push(request); return response({ result: draft('v3', request.payload.harness) }); } return response({ content: { stock: { structure: { kind: 'conductor', id: 'wire' } } } }); }));
  const view = render(wrapper(<DraftEditor draft={draft()} definitions={[]} onSaved={onSaved} onAuthorityChange={onAuthorityChange} />)); fill('unsaved after freeze'); view.rerender(wrapper(<DraftEditor draft={draft('server-token')} acceptedFreeze={{ draftId: 'draft', expected: 'v1', state: 'own-freeze-v2' }} definitions={[]} onSaved={onSaved} onAuthorityChange={onAuthorityChange} />)); await screen.findByText('own-freeze-v2'); expect((screen.getByLabelText('Physical end piece/cut basis') as HTMLInputElement).value).toBe('unsaved after freeze'); fireEvent.click(screen.getByText('Save harness draft')); await waitFor(() => expect(requests).toHaveLength(1)); expect(requests[0]!.expected_state).toBe('own-freeze-v2');
});
