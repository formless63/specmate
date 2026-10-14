import { MantineProvider } from '@mantine/core';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { StrictMode } from 'react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { HarnessPanel } from './HarnessPanel';
import { initialHarness, type Harness } from './api';

beforeEach(() => { vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} }); Element.prototype.scrollIntoView = vi.fn(); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
function fixture(basis: string): Harness { return { ...initialHarness(), sections: [{ local_id: 'piece', stock_revision_id: 'stock', planned_cut_length_mm: null, cut_basis: null, physical_ends: [{ local_id: 'cut', label: null, segment_ends: [{ segment_id: 'span', end: 'b' }], endpoint_id: null, basis, review: 'unreviewed' }] }], segments: [{ local_id: 'span', section_id: 'piece', label: null, element_paths: null }] }; }
function inspection(id: string) { return { revision_id: id, harness: fixture(`frozen ${id} basis`), terminals: [], declared_relationships: [], breakout_fates: [], quantities: { physical_piece_count: 1, segment_count: 1, stock: [] }, continuity: 'not_evaluated', compatibility: 'not_evaluated', physical_qualification: 'not_evaluated' }; }
function wrap(children: React.ReactNode) { return <StrictMode><MantineProvider><QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{children}</QueryClientProvider></MantineProvider></StrictMode>; }
async function choose(label: string, option: string) { const input = await screen.findByRole('combobox', { name: label }); fireEvent.focus(input); fireEvent.keyDown(input, { key: 'ArrowDown' }); fireEvent.click(await within(screen.getByRole('listbox', { name: label, hidden: true })).findByText(option)); fireEvent.keyDown(input, { key: 'Escape' }); }
function server() {
  let deny = false; let newer = false; let pending: ReturnType<typeof deferred<Response>> | null = null;
  const reads: string[] = []; const payloads: Harness[] = []; const commands: { expected_state: string; payload: { harness: Harness } }[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, options?: RequestInit) => {
    reads.push(url);
    if (url.endsWith('/operations')) { const command = JSON.parse(String(options?.body)); commands.push(command); return response({ result: { definition_id: 'harness', draft_id: 'draft', state: 'accepted-v2', content: { harness: command.payload.harness } } }); }
    if (url.endsWith('/harnesses/authority')) { payloads.push(JSON.parse(String(options?.body))); return response({ authorized: true }); }
    if (url.includes('/harnesses/revisions/')) { const id = url.split('/harnesses/revisions/')[1]!.split('?')[0]!; if (id === 'old' && pending) { const retained = pending; pending = null; return retained.promise; } if (id === 'old' && deny) return response({ error: { message: 'Frozen source unavailable' } }, 404); return response(inspection(id)); }
    if (url.includes('/harnesses/drafts/')) { const id = url.split('/').at(-1)!; return response({ definition_id: 'harness', draft_id: id, state: newer ? 'unreviewed-server-v99' : 'original-v1', content: { harness: fixture(id === 'draft' ? newer ? 'server replacement' : 'original basis' : 'replacement draft basis') } }); }
    if (url.includes('/catalog/definitions/')) return response({ definition_id: 'harness', drafts: [{ draft_id: 'draft', state: 'original-v1' }, { draft_id: 'other', state: 'other-v1' }], revisions: [{ revision_id: 'old', number: 1 }, { revision_id: 'new', number: 2 }] });
    if (url.includes('/snapshot')) return response({ content: { stock: { structure: { kind: 'conductor', id: 'wire' } } } });
    return response([{ definition_id: 'harness', kind: 'harness', name: 'Synthetic Harness' }]);
  }));
  return { reads, payloads, commands, deny: (value: boolean) => { deny = value; }, newer: () => { newer = true; }, pending: () => { pending = deferred<Response>(); return pending; }, clearPending: () => { pending = null; } };
}
async function open() { await choose('Existing harness definition', 'Synthetic Harness (harness)'); await choose('Edit harness draft', 'draft · original-v1'); await screen.findByLabelText('Physical end piece/cut basis'); fireEvent.change(screen.getByLabelText('Physical end piece/cut basis'), { target: { value: 'retained unsaved declaration' } }); await choose('Inspect frozen harness', 'Revision 1'); await screen.findByText(/frozen old basis/); }

test('frozen denial gates draft and failed restoration cannot reveal newer saved or unsaved evidence', async () => {
  const api = server(); render(wrap(<HarnessPanel projectId="project" />)); await open(); api.deny(true); fireEvent.click(screen.getByText('Refresh frozen Harness access')); await screen.findByText(/Frozen Harness access must be rechecked/); expect(screen.queryByLabelText('Physical end piece/cut basis')).toBeNull(); expect(screen.queryByText(/frozen old basis/)).toBeNull();
  api.newer(); fireEvent.click(screen.getByText('Restore Harness draft access')); await screen.findByText('Frozen source unavailable'); expect(screen.queryByLabelText('Physical end piece/cut basis')).toBeNull(); expect(screen.queryByText(/server replacement/)).toBeNull(); expect(screen.queryByText(/frozen old basis/)).toBeNull();
  const start = api.reads.length; api.deny(false); fireEvent.click(screen.getByText('Restore Harness draft access')); await screen.findByLabelText('Physical end piece/cut basis'); expect((screen.getByLabelText('Physical end piece/cut basis') as HTMLInputElement).value).toBe('retained unsaved declaration'); expect(api.reads.slice(start)).toEqual(expect.arrayContaining(['/api/v0/workspace/definitions', '/api/v0/catalog/definitions/harness', '/api/v0/harnesses/drafts/draft', '/api/v0/harnesses/revisions/old'])); expect(api.payloads.at(-1)!.sections[0]!.physical_ends![0]!.basis).toBe('retained unsaved declaration'); await screen.findByText(/frozen old basis/); fireEvent.click(screen.getByText('Save harness draft')); await waitFor(() => expect(api.commands).toHaveLength(1)); expect(api.commands[0]!.expected_state).toBe('original-v1'); expect(api.commands[0]!.payload.harness.sections[0]!.physical_ends![0]!.basis).toBe('retained unsaved declaration');
});

test.each(['revision', 'quantity'])('detached inspector denial after %s browsing still gates the same editor', async mode => {
  const api = server(); render(wrap(<HarnessPanel projectId="project" />)); await open(); const pending = api.pending(); fireEvent.click(screen.getByText('Refresh frozen Harness access')); await waitFor(() => expect(api.reads.filter(path => path.includes('/revisions/old?'))).toHaveLength(2));
  if (mode === 'revision') { await choose('Inspect frozen harness', 'Revision 2'); await screen.findByText(/frozen new basis/); }
  else { fireEvent.change(screen.getByLabelText('Harness quantity'), { target: { value: '2' } }); await screen.findByText(/frozen old basis/); }
  api.clearPending(); api.deny(true); await act(async () => { pending.resolve(response({ error: { message: 'Detached frozen denial' } }, 403)); }); await screen.findByText(/Frozen Harness access must be rechecked/); expect(screen.queryByLabelText('Physical end piece/cut basis')).toBeNull(); fireEvent.click(screen.getByText('Restore Harness draft access')); await screen.findByText('Frozen source unavailable'); expect(screen.queryByLabelText('Physical end piece/cut basis')).toBeNull();
});

test('late inspector denial cannot gate a genuinely replaced draft editor', async () => {
  const api = server(); render(wrap(<HarnessPanel projectId="project" />)); await open(); const pending = api.pending(); fireEvent.click(screen.getByText('Refresh frozen Harness access')); await waitFor(() => expect(api.reads.filter(path => path.includes('/revisions/old?'))).toHaveLength(2)); await choose('Edit harness draft', 'other · other-v1'); await waitFor(() => expect((screen.getByLabelText('Physical end piece/cut basis') as HTMLInputElement).value).toBe('replacement draft basis')); api.clearPending(); await act(async () => { pending.resolve(response({ error: { message: 'Previous draft denial' } }, 404)); }); expect(screen.queryByText(/Frozen Harness access must be rechecked/)).toBeNull(); expect((screen.getByLabelText('Physical end piece/cut basis') as HTMLInputElement).value).toBe('replacement draft basis');
});

test('late inspector denial cannot gate a replacement project workspace', async () => {
  const api = server(); const view = render(wrap(<HarnessPanel projectId="project" />)); await open(); const pending = api.pending(); fireEvent.click(screen.getByText('Refresh frozen Harness access')); await waitFor(() => expect(api.reads.filter(path => path.includes('/revisions/old?'))).toHaveLength(2));
  view.rerender(wrap(<HarnessPanel projectId="replacement-project" />)); await choose('Existing harness definition', 'Synthetic Harness (harness)'); await choose('Edit harness draft', 'other · other-v1'); await waitFor(() => expect((screen.getByLabelText('Physical end piece/cut basis') as HTMLInputElement).value).toBe('replacement draft basis'));
  await act(async () => { pending.resolve(response({ error: { message: 'Previous project denial' } }, 403)); }); expect(screen.queryByText(/Frozen Harness access must be rechecked/)).toBeNull(); expect((screen.getByLabelText('Physical end piece/cut basis') as HTMLInputElement).value).toBe('replacement draft basis');
});
