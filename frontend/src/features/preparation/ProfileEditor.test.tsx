import { byContent } from "../../test/text";
import { MantineProvider } from '@mantine/core';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { ProfileEditor } from './ProfileEditor';
import { CutCalculation } from './CutCalculation';
import { emptyFormula, type Profile, type Result } from './api';
beforeEach(() => vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} }));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
function wrap(children: React.ReactNode) { return <MantineProvider><QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{children}</QueryClientProvider></MantineProvider>; }
async function select(label: string, option: string) { const field = await screen.findByRole('combobox', { name: label }); fireEvent.focus(field); fireEvent.keyDown(field, { key: 'ArrowDown' }); fireEvent.click(await within(screen.getByRole('listbox', { name: label, hidden: true })).findByText(option)); }
const formula = { ...emptyFormula(1), review: 'reviewed' as const, review_basis: 'Synthetic arithmetic review', allowances: ['20', '10', '5'].map((amount_mm, i) => ({ local_id: `a${i}`, kind: 'preparation' as const, scope: 'whole_piece' as const, amount_mm, basis: `Synthetic allowance ${i}`, source: null })) };
const profile: Profile = { stock_revision_id: 'stock-rev', formulas: [formula] };
const computed: Result = { revision_id: 'cable-rev', sha256: 'subject-hash', quantity: 2, physical_piece_count: 2, unprofiled_sections: [], rows: [{ section_id: null, segment_ids: [], target: 'stock_piece', element_path: null, element_kind: null, profile_revision_id: 'profile-rev', profile_sha256: 'profile-hash', stock_revision_id: 'stock-rev', stock_sha256: 'stock-hash', formula, input_mm: '1000', input_provenance: { declaration: { amount_mm: '1000', basis: 'human_declaration', explanation: 'Synthetic declared route' } }, cut_mm: '1035', total_mm: '2070', declared_cut_mm: '1070', declaration_matches_result: false, status: 'suggestion' }] };
const response = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });
test('structured authoring retains unknown versus zero and exact feature provenance', async () => {
  let value = profile;
  function Editor() { const [state, setState] = useState(profile); value = state; return <ProfileEditor value={state} onChange={setState} choices={[{ value: 'stock.group.core', label: 'stock.group.core · conductor' }]} />; }
  render(wrap(<Editor />));
  await select('Formula 1 target', 'conductive_feature'); await select('Formula 1 exact stock feature', 'stock.group.core · conductor');
  fireEvent.change(screen.getByLabelText('Formula 1 allowance 1 mm'), { target: { value: '' } }); expect(value.formulas[0]!.allowances[0]!.amount_mm).toBeNull();
  fireEvent.change(screen.getByLabelText('Formula 1 allowance 1 mm'), { target: { value: '0' } });
  await select('Formula 1 allowance 1 source kind', 'source_file');
  for (const [key, val] of Object.entries({ bundle_revision_id: 'exact-source', path: 'synthetic.txt', sha256: 'a'.repeat(64), rights: 'Original synthetic', locator: 'row 1' })) fireEvent.change(screen.getByLabelText(`Formula 1 allowance 1 source ${key}`), { target: { value: val } });
  expect(value.formulas[0]).toMatchObject({ target: 'conductive_feature', element_path: 'stock.group.core', allowances: [{ amount_mm: '0', source: { kind: 'source_file', bundle_revision_id: 'exact-source' } }, { amount_mm: '10' }, { amount_mm: '5' }] });
});
test('exact applications show independent cuts and hide cached results after denial', async () => {
  let denied = false; const requests: unknown[] = [];
  vi.stubGlobal('fetch', vi.fn(async (_url: string, options?: RequestInit) => { if (!options?.body) return response({labels:[]}); requests.push(JSON.parse(String(options.body))); return denied ? response({ error: { message: 'Source denied.' } }, 404) : response(computed); }));
  render(wrap(<CutCalculation definitions={[]} />));
  fireEvent.click(screen.getByRole('button',{name:'Advanced: paste exact revision ID for Preparation subject'}));fireEvent.change(screen.getByLabelText('Preparation subject exact revision ID'), { target: { value: 'cable-rev' } }); fireEvent.click(screen.getByRole('button',{name:'Advanced: paste exact revision ID for Application 1 profile'}));fireEvent.change(screen.getByLabelText('Application 1 profile exact revision ID'), { target: { value: 'profile-rev' } }); fireEvent.change(screen.getByLabelText('Requested units'), { target: { value: '2' } }); fireEvent.click(screen.getByText('Compute preparation cuts'));
  await screen.findByText(byContent('1035 mm / 2070 mm · suggestion')); expect(requests[0]).toEqual({ revision_id: 'cable-rev', applications: [{ section_id: null, profile_revision_id: 'profile-rev' }], quantity: 2 }); expect(screen.getByText(byContent('1070 mm'))).toBeTruthy(); expect(screen.getByText('Differs from computed suggestion')).toBeTruthy(); expect(screen.getByText(/Synthetic declared route/)).toBeTruthy();
  denied = true; fireEvent.click(screen.getByText('Refresh computed cut access')); await screen.findByText('Source denied.'); expect(screen.queryByText(/subject-hash/)).toBeNull(); expect(screen.queryByText(byContent(/1035 mm/))).toBeNull();
  denied = false; fireEvent.click(screen.getByText('Compute preparation cuts')); await screen.findByText(byContent('1035 mm / 2070 mm · suggestion')); fireEvent.change(screen.getByLabelText('Requested units'), { target: { value: '' } }); expect(screen.queryByText(byContent(/1035 mm/))).toBeNull(); fireEvent.click(screen.getByText('Compute preparation cuts')); await waitFor(() => expect(requests.at(-1)).toMatchObject({ quantity: null }));
});
