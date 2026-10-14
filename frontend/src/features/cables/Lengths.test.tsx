import { MantineProvider } from '@mantine/core';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { emptyLengths, LengthImpactView, LengthInspection, LengthsEditor, type Impact, type LengthPlan, type LengthRow } from './Lengths';

beforeEach(() => vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} }));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
function wrap(children: React.ReactNode, cache = new QueryClient({ defaultOptions: { queries: { retry: false } } })) {
  return <MantineProvider><QueryClientProvider client={cache}>{children}</QueryClientProvider></MantineProvider>;
}
async function select(label: string, option: string) {
  const field = screen.getByRole('combobox', { name: label });
  fireEvent.focus(field); fireEvent.keyDown(field, { key: 'ArrowDown' });
  fireEvent.click(await within(screen.getByRole('listbox', { name: label, hidden: true })).findByText(option));
}
const declaration = { amount_mm: '1000.000001', basis: 'human_declaration' as const, explanation: 'Synthetic reviewed route' };
function row(target: string, amount = '1000.000001'): LengthRow {
  return { target, declaration: { ...declaration, amount_mm: amount }, suggested_mm: null, model: null, status: 'declaration_only', declaration_matches_suggestion: null, stock_revision_id: 'exact-stock' };
}

test('author exact independent lengths, scoped nullable allowance and conductor identity', async () => {
  let saved: LengthPlan | null = null;
  function Editor() {
    const [plan, setPlan] = useState<LengthPlan | null>(emptyLengths());
    saved = plan;
    return <LengthsEditor value={plan} onChange={setPlan} choices={[{ value: 'stock.core', label: 'Core at stock.core' }]} endpoints={['left', 'right']} />;
  }
  render(wrap(<Editor />));
  fireEvent.change(screen.getByLabelText('Route declared mm'), { target: { value: '1000.000001' } });
  fireEvent.change(screen.getByLabelText('Route declaration basis'), { target: { value: 'Synthetic reviewed route' } });
  fireEvent.change(screen.getByLabelText('Stock cut declared mm'), { target: { value: '1040' } });
  fireEvent.change(screen.getByLabelText('Stock cut declaration basis'), { target: { value: 'Existing independent cut' } });
  fireEvent.click(screen.getByLabelText('Finished explicit length model'));
  fireEvent.click(screen.getByText('Add Finished allowance'));
  await select('Finished allowance 1 scope', 'endpoint');
  await select('Finished allowance 1 endpoint', 'left');
  fireEvent.change(screen.getByLabelText('Finished allowance 1 basis'), { target: { value: 'Service loop' } });
  await select('Finished model review', 'reviewed');
  fireEvent.change(screen.getByLabelText('Finished model review basis'), { target: { value: 'Reviewed relationship; slack unresolved' } });
  await select('Conductor cut stock feature', 'Core at stock.core');
  fireEvent.click(screen.getByText('Add conductor cut length'));
  expect(saved).toMatchObject({ route: declaration, stock_cut: { declaration: { amount_mm: '1040' } }, finished: { model: { allowances: [{ amount_mm: null, scope: 'endpoint', endpoint_id: 'left' }], review: 'reviewed' } }, conductor_cuts: [{ element_path: 'stock.core', declaration: { amount_mm: null } }] });
  fireEvent.change(screen.getByLabelText('Route declared mm'), { target: { value: '1100' } });
  expect((screen.getByLabelText('Stock cut declared mm') as HTMLInputElement).value).toBe('1040');
  fireEvent.change(screen.getByLabelText('Finished allowance 1 mm'), { target: { value: '0' } });
  expect(saved!.finished.model!.allowances[0]!.amount_mm).toBe('0');
});

test('frozen inspection keeps declaration, modeled suggestion, mismatch and unknown distinct', () => {
  render(wrap(<LengthInspection projection={{ rows: [row('route'), { ...row('stock_cut', '1040'), suggested_mm: '1050', status: 'suggestion', declaration_matches_suggestion: false }, { ...row('conductor:stock.screen'), declaration: { amount_mm: null, basis: 'unknown', explanation: null } }] }} />));
  expect(screen.getByText('1040 mm')).toBeTruthy();
  expect(screen.getByText(/1050 mm · suggestion/)).toBeTruthy();
  expect(screen.getByText('Declaration differs from model suggestion.')).toBeTruthy();
  expect(screen.getByText('unknown')).toBeTruthy();
});

test('same revision impact refresh removes retained sensitive results on current denial', async () => {
  const cache = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  let denied = false;
  const result: Impact = { before_revision_id: 'old', after_revision_id: 'new', before_sha256: 'before-hash', after_sha256: 'after-hash', route_changed: true, preparation_review_required: true, document_review_required: true, stock_revision_changed: false, changes: [{ target: 'route', before: row('route'), after: row('route', '1100') }], sections: [{ section: 'lengths', status: 'changed', reviews: ['documents', 'preparation'], summary: 'Length declarations or model suggestions changed.', details: [{ target: 'route' }] }] };
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(denied ? { error: { message: 'Length source access denied.' } } : result), { status: denied ? 404 : 200 })));
  render(wrap(<LengthImpactView afterRevision="new" revisions={[{ revision_id: 'old', number: 1 }, { revision_id: 'new', number: 2 }]} />, cache));
  await select('Compare lengths from frozen revision', 'Revision 1');
  await screen.findByText(/route: declared 1000.000001 mm → 1100 mm/);
  denied = true;
  fireEvent.click(screen.getByText('Refresh length impact access'));
  expect(await screen.findByText('Length source access denied.')).toBeTruthy();
  expect(screen.queryByText(/route: declared/)).toBeNull();
  expect(screen.queryByText(/before-hash/)).toBeNull();
  denied = false;
  await act(async () => { await cache.refetchQueries({ queryKey: ['cable-length-impact', 'old', 'new'] }); });
  await waitFor(() => expect(screen.getByText(/route: declared/)).toBeTruthy());
});

test('termination-only impact lists the changed section and requires document review', async () => {
  const result: Impact = { before_revision_id: 'old', after_revision_id: 'new', before_sha256: 'before-hash', after_sha256: 'after-hash', route_changed: false, preparation_review_required: true, document_review_required: true, stock_revision_changed: false, changes: [], sections: [{ section: 'terminations', status: 'changed', reviews: ['documents', 'preparation'], summary: 'Conductor-to-contact terminations changed.', details: [{ element_path: 'stock.screen', endpoint_id: 'b', before_contact_id: 'shell', after_contact_id: 'b' }] }] };
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(result), { status: 200 })));
  render(wrap(<LengthImpactView afterRevision="new" revisions={[{ revision_id: 'old', number: 1 }, { revision_id: 'new', number: 2 }]} />));
  await select('Compare lengths from frozen revision', 'Revision 1');
  expect(await screen.findByText(/Document review required: true/)).toBeTruthy();
  expect(screen.getByText('No length-plan changes.')).toBeTruthy();
  expect(screen.getByRole('table', { name: 'Changed document sections' })).toBeTruthy();
  expect(screen.getByText('terminations')).toBeTruthy();
  expect(screen.getByText('stock.screen at b: contact shell → b')).toBeTruthy();
});
