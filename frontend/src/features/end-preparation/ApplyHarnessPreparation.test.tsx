import { MantineProvider } from '@mantine/core';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { ApplyHarnessPreparation } from './ApplyHarnessPreparation';
import { PhysicalEndsEditor } from '../harnesses/PhysicalEndsEditor';
import type { PhysicalEnd } from '../harnesses/api';

beforeEach(() => { vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} }); Element.prototype.scrollIntoView = vi.fn(); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const ends: PhysicalEnd[] = ['one', 'two'].map((local_id, i) => ({ local_id, label: 'same label', segment_ends: [{ segment_id: i ? 'leg' : 'trunk', end: 'b' }], endpoint_id: null, basis: 'Synthetic material identity', review: 'reviewed' }));
const harness = { harness: { sections: [{ local_id: 'shared', stock_revision_id: 'stock', physical_ends: ends }] } };
const applied = { harness_revision_id: 'harness', harness_sha256: 'exact-harness-hash', section_id: 'shared', physical_piece_count: 1, profile_revision_id: 'profile', profile_sha256: 'profile-hash', stock_revision_id: 'stock', stock_sha256: 'stock-hash', mapping_review: 'reviewed', mapping_basis: 'Explicit reverse', ends: [], unresolved: [], actual_bonds: 'not_evaluated', measured_preparation: 'not_evaluated', physical_qualification: 'not_evaluated' };
function wrap(children: React.ReactNode) { return <MantineProvider><QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{children}</QueryClientProvider></MantineProvider>; }
async function choose(label: string, option: string) { const field = await screen.findByRole('combobox', { name: label }); fireEvent.focus(field); fireEvent.keyDown(field, { key: 'ArrowDown' }); fireEvent.click(await within(screen.getByRole('listbox', { name: label, hidden: true })).findByText(option)); fireEvent.keyDown(field, { key: 'Escape' }); }
function fill(label: string, value: string) { fireEvent.change(screen.getByLabelText(label), { target: { value } }); }
async function prepare() { fill('End preparation harness exact revision ID', 'harness'); await choose('End preparation physical section', 'shared · stock stock'); fill('Harness end preparation profile exact revision ID', 'profile'); await choose('Profile A exact physical end', 'two · same label'); await choose('Profile B exact physical end', 'one · same label'); fill('Physical end mapping basis', 'Explicit reverse'); }

test('physical end authoring requires deliberate exact segment membership and basis', async () => {
  let value: PhysicalEnd[] = [];
  function Editor() { const [physical_ends, set] = useState<PhysicalEnd[]>([]); value = physical_ends; return <PhysicalEndsEditor section={{ local_id: 'shared', stock_revision_id: 'stock', planned_cut_length_mm: null, cut_basis: null, physical_ends }} segments={[{ local_id: 'trunk', section_id: 'shared', label: null, element_paths: null }, { local_id: 'other', section_id: 'other', label: null, element_paths: null }]} endpoints={[]} hidden={false} onChange={set} />; }
  render(wrap(<Editor />)); fill('New physical end ID for shared', 'cut'); fireEvent.click(screen.getByText('Add physical end to shared')); expect(value[0]).toMatchObject({ segment_ends: [], endpoint_id: null, review: 'unreviewed' }); await choose('Physical end shared/cut segment ends', 'trunk / b'); fill('Physical end shared/cut basis', 'Synthetic review'); expect(value[0]).toMatchObject({ local_id: 'cut', segment_ends: [{ segment_id: 'trunk', end: 'b' }], basis: 'Synthetic review' }); expect(screen.queryByText('other / b')).toBeNull();
});

test('application submits exact section and reversed physical IDs, without segment expansion', async () => {
  const requests: object[] = []; vi.stubGlobal('fetch', vi.fn(async (url: string, options?: RequestInit) => { if (url.endsWith('apply-harness')) { requests.push(JSON.parse(String(options?.body))); return response(applied); } return response(harness); }));
  render(wrap(<ApplyHarnessPreparation definitions={[]} />)); await prepare(); fireEvent.click(screen.getByText('Apply Harness end preparation')); await screen.findAllByText('exact-harness-hash', { selector: 'code' }); expect(requests).toEqual([{ harness_revision_id: 'harness', section_id: 'shared', profile_revision_id: 'profile', a_physical_end_id: 'two', b_physical_end_id: 'one', mapping_basis: 'Explicit reverse', mapping_review: 'unreviewed' }]); expect(screen.getByText('Section shared · pieces 1')).toBeTruthy();
});

test('detached application denial gates retained evidence after fields change', async () => {
  let resolve!: (value: Response) => void; const pending = new Promise<Response>(done => { resolve = done; }); let calls = 0; const onDenied = vi.fn(); vi.stubGlobal('fetch', vi.fn(async (url: string) => url.endsWith('apply-harness') ? (++calls === 1 ? response(applied) : pending) : response(harness)));
  render(wrap(<ApplyHarnessPreparation definitions={[]} onDenied={onDenied} />)); await prepare(); fireEvent.click(screen.getByText('Apply Harness end preparation')); await screen.findAllByText('exact-harness-hash', { selector: 'code' }); fireEvent.click(screen.getByText('Refresh Harness preparation access')); await waitFor(() => expect(calls).toBe(2)); fill('Physical end mapping basis', 'Unsaved new basis'); await act(async () => { resolve(response({ error: { message: 'Denied' } }, 403)); }); await screen.findByText('Harness preparation access must be restored before retained evidence is shown.'); expect(screen.queryByText(/exact-harness-hash/)).toBeNull(); expect(screen.queryByLabelText('Profile A exact physical end')).toBeNull(); expect(onDenied).toHaveBeenCalledWith(expect.objectContaining({ mapping_basis: 'Explicit reverse' }), 0);
});

test('parent restoration retains deliberately chosen mapping and unsaved basis', async () => {
  let deny = false; vi.stubGlobal('fetch', vi.fn(async (url: string) => url.endsWith('apply-harness') && deny ? response({ error: { message: 'Denied' } }, 404) : response(url.endsWith('apply-harness') ? applied : harness)));
  function Parent() { const [hidden, setHidden] = useState(false); return <><ButtonForRestore run={() => { deny = false; setHidden(false); }} /><ApplyHarnessPreparation definitions={[]} hidden={hidden} onDenied={() => setHidden(true)} /></>; }
  render(wrap(<Parent />)); await prepare(); deny = true; fireEvent.click(screen.getByText('Apply Harness end preparation')); await waitFor(() => expect(screen.queryByLabelText('Physical end mapping basis')).toBeNull()); fireEvent.click(screen.getByText('Authorized restoration')); await screen.findByLabelText('Physical end mapping basis'); expect((screen.getByLabelText('Physical end mapping basis') as HTMLInputElement).value).toBe('Explicit reverse'); await waitFor(() => expect((screen.getByRole('combobox', { name: 'Profile A exact physical end' }) as HTMLInputElement).value).toBe('two · same label'));
});
function ButtonForRestore({ run }: { run: () => void }) { return <button onClick={run}>Authorized restoration</button>; }
