import { MantineProvider } from '@mantine/core';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { StockPreparationEditor } from './StockPreparationEditor';
import { emptyFormula } from '../preparation/api';
import { generate, exampleCoax } from './builder';
import { PermissionsProvider } from '../../lib/permissions';
const reply = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
beforeEach(() => vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} }));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
function mount(kind: 'cut' | 'end', permissions = ['workspace.read', 'item.create', 'design.edit', 'design.freeze'], existing = false) {
  const commands: { operation: string; payload: { profile?: { stock_revision_id: string; formulas?: { label: string }[] } }; expected_state?: string }[] = []; let deny = false; let incomplete = false; let holdLoad: Promise<void> | null = null; let releaseLoad = () => {}; const reads: string[] = []; let held: Promise<void> | null = null; let release = () => {};
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    reads.push(url);
    if (deny) return reply({ error: { message: 'Preparation denied' } }, 403);
    if (url.includes('library-table')) return reply({ results: existing ? [{ record_id: 'profile-one', label: 'Practice one' }, { record_id: 'profile-two', label: 'Practice two' }] : [], next_after: null });
    if (url.includes('/catalog/definitions/')) return reply({ drafts: [{ draft_id: 'loaded-draft', state: 'draft-v4' }], revisions: [] });
    if (url.includes('/drafts/loaded-draft')) { if (holdLoad) await holdLoad; return reply({ definition_id: 'profile-one', draft_id: 'loaded-draft', state: 'draft-v4', content: { preparation_profile: { stock_revision_id: 'r-old', formulas: [emptyFormula(1)] } } }); }
    if (url.endsWith('/authority')) return incomplete ? reply({ error: { message: 'Incomplete local source declaration' } }, 422) : reply({ readable: true });
    if (url.endsWith('/operations')) { const command = JSON.parse(String(init?.body)); commands.push(command); if (held) await held;
      if (command.operation.endsWith('.freeze')) return reply({ result: { revision_id: 'p1', draft: { state: 'draft-v2' } } });
      return reply({ result: { definition_id: 'pd1', draft_id: 'draft1', state: 'draft-v1', content: kind === 'cut' ? { preparation_profile: command.payload.profile } : { end_preparation_profile: command.payload.profile } } });
    }
    if (url.includes('/revisions/p1')) return reply({ revision_id: 'p1', profile: kind === 'cut' ? { stock_revision_id: 'r-old', formulas: [] } : { stock_revision_id: 'r-old', a: { instructions: [], review: 'unreviewed' }, b: { instructions: [], review: 'unreviewed' } } });
    return reply({ content: kind === 'cut' ? { preparation_profile: commands[0]?.payload.profile } : { end_preparation_profile: commands[0]?.payload.profile } });
  }));
  const cache = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const tree = (active: boolean) => <MantineProvider env="test"><QueryClientProvider client={cache}><PermissionsProvider permissions={permissions}><StockPreparationEditor active={active} principalKey="user:w1" kind={kind} stock={generate(exampleCoax())} revisionId="r-old" /></PermissionsProvider></QueryClientProvider></MantineProvider>;
  const view = render(tree(true));
  return { commands, reads, incomplete: (value: boolean) => { incomplete = value; }, setActive: (active: boolean) => view.rerender(tree(active)), holdLoad: () => { holdLoad = new Promise(resolve => { releaseLoad = resolve; }); return () => { releaseLoad(); holdLoad = null; }; }, deny: (value: boolean) => { deny = value; }, hold: () => { held = new Promise(resolve => { release = resolve; }); return () => { release(); held = null; }; } };
}
test.each(['cut', 'end'] as const)('contextual %s practice saves and freezes its exact stock pin using existing operations', async kind => {
  const api = mount(kind); const noun = kind === 'cut' ? 'cut preparation' : 'end preparation';
  fireEvent.change(await screen.findByLabelText(`${noun} name`), { target: { value: 'Exact practice' } });
  if (kind === 'cut') fireEvent.click(screen.getByRole('button', { name: 'Add cut formula' })); else fireEvent.click(screen.getByRole('button', { name: 'Add End A instruction' }));
  expect(screen.queryByLabelText('Preparation stock definition')).toBeNull(); fireEvent.click(screen.getByRole('button', { name: `Save ${noun}` })); await screen.findByText('draft-v1 · saved draft');
  expect(api.commands[0]?.operation).toBe(kind === 'cut' ? 'preparation.create' : 'end_preparation.create'); expect(api.commands[0]?.payload.profile?.stock_revision_id).toBe('r-old');
  fireEvent.click(screen.getByRole('button', { name: `Freeze ${noun}` })); await waitFor(() => expect(api.commands).toHaveLength(2)); expect(api.commands[1]?.expected_state).toBe('draft-v1');
});
test('permission denial hides retained practice fields and recovers original buffer', async () => {
  const api = mount('cut'); fireEvent.change(await screen.findByLabelText('cut preparation name'), { target: { value: 'Retained practice' } }); fireEvent.click(screen.getByRole('button', { name: 'Add cut formula' })); fireEvent.change(screen.getByLabelText('Formula 1 label'), { target: { value: 'Retained formula' } }); api.deny(true);
  fireEvent.click(screen.getByRole('button', { name: 'Save cut preparation' })); await screen.findByText(/Preparation access must be rechecked/); expect(screen.queryByLabelText('Formula 1 label')).toBeNull();
  api.deny(false); fireEvent.click(screen.getByRole('button', { name: 'Refresh cut preparation access' })); expect((await screen.findByLabelText('Formula 1 label') as HTMLInputElement).value).toBe('Retained formula');
});
test('late save accepts its token without replacing a newer local practice edit', async () => {
  const api = mount('cut'); fireEvent.change(await screen.findByLabelText('cut preparation name'), { target: { value: 'Practice' } }); fireEvent.click(screen.getByRole('button', { name: 'Add cut formula' })); const release = api.hold(); fireEvent.click(screen.getByRole('button', { name: 'Save cut preparation' })); fireEvent.change(screen.getByLabelText('Formula 1 label'), { target: { value: 'Typed during save' } }); await act(async () => release());
  await screen.findByText('draft-v1 · unsaved'); expect((screen.getByLabelText('Formula 1 label') as HTMLInputElement).value).toBe('Typed during save'); expect((screen.getByRole('button', { name: 'Freeze cut preparation' }) as HTMLButtonElement).disabled).toBe(true);
});
test('viewer cannot alter or save contextual practice', async () => {
  mount('cut', ['workspace.read']); await screen.findByLabelText('cut preparation name'); expect((screen.getByRole('button', { name: 'Save cut preparation' }) as HTMLButtonElement).disabled).toBe(true); fireEvent.click(screen.getByRole('button', { name: 'Add cut formula' })); expect(screen.queryByLabelText('Formula 1 label')).toBeNull();
});

async function selectLoadedDraft() {
  fireEvent.click(await screen.findByText('Saved cut preparation profiles')); fireEvent.click(screen.getByRole('combobox', { name: 'cut preparation definition' })); fireEvent.click(await screen.findByRole('option', { name: 'Practice one' })); fireEvent.click(await screen.findByRole('combobox', { name: 'cut preparation draft' })); fireEvent.click(await screen.findByRole('option', { name: 'draft-v4' }));
}
test('loaded current practice is freshly authorized after hidden revocation; dirty buffer retains original CAS', async () => {
  const api = mount('cut', undefined, true); await selectLoadedDraft(); fireEvent.click(screen.getByRole('button', { name: 'Load cut preparation draft (replace local edits)' })); await screen.findByText('draft-v4 · saved draft'); fireEvent.change(screen.getByLabelText('Formula 1 label'), { target: { value: 'Unsaved retained practice' } }); api.setActive(false); api.deny(true); api.setActive(true);
  await screen.findByText(/Preparation access must be rechecked/); expect(screen.queryByLabelText('Formula 1 label')).toBeNull(); api.deny(false); fireEvent.click(screen.getByRole('button', { name: 'Refresh cut preparation access' })); expect((await screen.findByLabelText('Formula 1 label') as HTMLInputElement).value).toBe('Unsaved retained practice'); fireEvent.click(screen.getByRole('button', { name: 'Save cut preparation' })); await waitFor(() => expect(api.commands).toHaveLength(1)); expect(api.commands[0]?.expected_state).toBe('draft-v4'); expect(api.reads.filter(url => url.includes('/drafts/loaded-draft')).length).toBeGreaterThan(1);
});
test('pending load locks selection transitions so an old response cannot appear under a different definition', async () => {
  const api = mount('cut', undefined, true); await selectLoadedDraft(); const release = api.holdLoad(); fireEvent.click(screen.getByRole('button', { name: 'Load cut preparation draft (replace local edits)' })); expect((screen.getByRole('combobox', { name: 'cut preparation definition' }) as HTMLInputElement).disabled).toBe(true); expect((screen.getByRole('combobox', { name: 'cut preparation draft' }) as HTMLInputElement).disabled).toBe(true); await act(async () => release()); await screen.findByText('draft-v4 · saved draft'); expect((screen.getByRole('combobox', { name: 'cut preparation definition' }) as HTMLInputElement).value).toBe('Practice one');
});

test('window focus rechecks current practice and restores it only after a fresh successful closure read', async () => {
  const api = mount('cut', undefined, true); await selectLoadedDraft(); fireEvent.click(screen.getByRole('button', { name: 'Load cut preparation draft (replace local edits)' })); await screen.findByText('draft-v4 · saved draft'); fireEvent.change(screen.getByLabelText('Formula 1 label'), { target: { value: 'Local focus buffer' } }); api.deny(true); act(() => window.dispatchEvent(new Event('focus'))); await screen.findByText(/Preparation access must be rechecked/); expect(screen.queryByLabelText('Formula 1 label')).toBeNull(); api.deny(false); act(() => window.dispatchEvent(new Event('focus'))); expect((await screen.findByLabelText('Formula 1 label') as HTMLInputElement).value).toBe('Local focus buffer'); expect(screen.getByText('draft-v4 · unsaved')).toBeTruthy();
});
test('a partial local declaration can be corrected after authority validation returns 422', async () => {
  const api = mount('cut'); fireEvent.change(await screen.findByLabelText('cut preparation name'), { target: { value: 'Incomplete local practice' } }); api.incomplete(true); act(() => window.dispatchEvent(new Event('focus'))); await screen.findByText(/Local preparation is incomplete/); expect((screen.getByLabelText('cut preparation name') as HTMLInputElement).value).toBe('Incomplete local practice'); fireEvent.click(screen.getByRole('button', { name: 'Add cut formula' })); expect(screen.getByLabelText('Formula 1 label')).toBeTruthy();
});
