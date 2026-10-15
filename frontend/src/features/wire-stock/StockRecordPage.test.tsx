import { MantineProvider } from '@mantine/core';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { StockRecordPage } from './StockRecordPage';
import { emptyFormula } from '../preparation/api';
import { exampleCoax, generate } from './builder';
import { PermissionsProvider } from '../../lib/permissions';
import type { StockSpecification } from '../../../../packages/section-layout/src';
vi.mock('./StockDisplay', () => ({ StockDisplay: ({ section, active }: { section: { widthMm: number }; active: boolean }) => <div role="img" aria-label={`Selected stock model ${section.widthMm} mm`} data-active={active} /> }));
beforeEach(() => vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} }));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const reply = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
function server() {
  let deny = false; let conflict = false; let newest = 2; let draftState = 'draft-v4'; let saved: StockSpecification = generate(exampleCoax());
  let held: Promise<void> | null = null; let release: (() => void) | null = null;
  const calls: string[] = []; const posts: Record<string, unknown>[] = [];
  vi.stubGlobal('fetch', vi.fn(async (path: string, init?: RequestInit) => {
    calls.push(path);
    if (deny) return reply({ error: { message: 'Access withdrawn' } }, 403);
    if (path.includes('/workspace/library/')) return reply({ record_id: 's1', label: 'Selected synthetic stock', kind: 'wire_stock', family: 'definition', latest_revision: newest, latest_revision_id: `r${newest}`, used_in: [], used_in_total: 0, referenceable: true });
    if (path.includes('/workspace/library-table?')) return reply({ results: path.includes('kinds=preparation_profile') ? [{ record_id: 'profile-one', label: 'Practice one' }] : [], next_after: null });
    if (path.includes('/catalog/definitions/profile-one')) return reply({ definition_id: 'profile-one', drafts: [{ draft_id: 'profile-draft', state: 'draft-v4' }], revisions: [] });
    if (path.includes('/preparation/drafts/profile-draft')) return reply({ definition_id: 'profile-one', draft_id: 'profile-draft', state: 'draft-v4', content: { preparation_profile: { stock_revision_id: 'r2', formulas: [emptyFormula(1)] } } });
    if (path.endsWith('/preparation/authority')) return reply({ readable: true });
    if (path.includes('/catalog/definitions/')) { const offset = Number(new URL(path, 'http://local').searchParams.get('offset') ?? 0); return reply({ definition_id: 's1', revisions: offset === 50 ? [{ number: 75, revision_id: 'r75' }] : [{ number: 1, revision_id: 'r1' }, { number: 2, revision_id: 'r2' }] }); }
    if (path.includes('/snapshot')) { const stock = generate(exampleCoax()); const jacket = stock.structure.children.find(child => child.kind === 'jacket'); if (jacket && jacket.kind !== 'group' && jacket.kind !== 'web') jacket.outer_diameter_mm = path.includes('/r1/') ? 3 : path.includes('/r75/') ? 7.5 : 6; return reply({ content: { stock } }); }
    if (path.includes('/stocks?')) return reply([{ definition_id: 's1', draft_id: 'd1', name: 'Selected synthetic stock', state: draftState, content: { stock: saved } }]);
    if (path.includes('/catalog/revisions/')) return reply({ variants: [{ manufacturer: 'Synthetic', part_number: path.includes('/r1?') ? 'OLD-PN' : 'CURRENT-PN', association_basis: 'Documented exact pin' }], lots: [], representations: [], source_identifiers: [] });
    if (path.includes('/conventions')) return reply({ conventions: [] });
    if (path.endsWith('/operations')) { const command = JSON.parse(String(init?.body)); posts.push(command); if (held) await held;
      if (conflict) return reply({ error: { message: 'Draft changed since expected state.' } }, 409);
      if (command.operation === 'wire_stock.freeze') { newest = 3; draftState = 'draft-v6'; return reply({ result: { number: 3, revision_id: 'r3', draft: { state: draftState } } }); }
      if (command.operation === 'preparation.update') return reply({ result: { definition_id: 'profile-one', draft_id: 'profile-draft', state: 'draft-v5', content: { preparation_profile: command.payload.profile } } });
      saved = command.payload.stock; draftState = 'draft-v5'; return reply({ result: { definition_id: 's1', draft_id: 'd1', name: 'Selected synthetic stock', state: draftState, content: { stock: saved } } });
    }
    return reply({ results: [], next_after: null });
  }));
  return { calls, posts, hold: () => { held = new Promise<void>(resolve => { release = resolve; }); return () => { release?.(); held = null; }; }, deny: (value: boolean) => { deny = value; }, conflict: () => { conflict = true; }, advance: () => { draftState = 'draft-v9'; } };
}
function mount(props: Partial<React.ComponentProps<typeof StockRecordPage>> = {}, permissions = ['workspace.read', 'item.create', 'design.edit', 'design.freeze']) {
  const cache = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const callbacks = { onBack: vi.fn(), onSelect: vi.fn(), onCreated: vi.fn(), onOpenInProject: vi.fn() };
  const base = { active: true, principalKey: 'user:w1', workspaceId: 'w1', definitionId: 's1', revisionNumber: null, draftRequested: false, projects: [], ...callbacks, ...props };
  const tree = (changes = {}) => <MantineProvider env="test"><QueryClientProvider client={cache}><PermissionsProvider permissions={permissions}><StockRecordPage {...base} {...changes} /></PermissionsProvider></QueryClientProvider></MantineProvider>;
  const view = render(tree()); return { cache, callbacks, rerender: (changes: object) => view.rerender(tree(changes)) };
}
const tab = (name: string) => fireEvent.click(screen.getByRole('tab', { name: new RegExp(`^${name}$`) }));
test('direct stock opens one latest frozen state, no all-content startup or duplicate picker', async () => {
  const api = server(); mount();
  expect(await screen.findByRole('img', { name: 'Selected stock model 6 mm' })).toBeTruthy();
  expect(screen.getByText('Frozen r2')).toBeTruthy(); expect(screen.queryByLabelText('Frozen stock definition')).toBeNull(); expect(screen.queryByRole('textbox', { name: 'Stock name' })).toBeNull();
  expect(api.calls.filter(path => path.includes('/snapshot'))).toEqual(['/api/v0/revisions/r2/snapshot']);
  expect(api.calls.some(path => path.includes('/stocks') || path.includes('/workshop-profile'))).toBe(false);
});
test('exact historic r75 reads one catalog page and never substitutes newest', async () => {
  const api = server(); mount({ revisionNumber: 75 });
  expect(await screen.findByRole('img', { name: 'Selected stock model 7.5 mm' })).toBeTruthy(); expect(screen.getByText('Frozen r75')).toBeTruthy();
  expect(api.calls.filter(path => path.includes('/catalog/definitions/'))).toEqual(['/api/v0/catalog/definitions/s1?offset=50&limit=50']);
  expect(api.calls.some(path => path.includes('/r2/snapshot'))).toBe(false);
});
test('missing historical state withdraws every drawing instead of falling forward', async () => {
  const api = server(); mount({ revisionNumber: 33 }); await screen.findByText('Stock unavailable'); expect(screen.queryByRole('img')).toBeNull(); expect(api.calls.some(path => path.includes('/snapshot'))).toBe(false);
});
test('draft uses bounded read; save original CAS and freeze returned state only', async () => {
  const api = server(); const { callbacks } = mount({ draftRequested: true });
  await screen.findByLabelText('Stock name'); expect(screen.getByText('Draft v4')).toBeTruthy();
  expect(api.calls.some(path => path === '/api/v0/stocks?definition_id=s1&latest_only=true')).toBe(true);
  fireEvent.change(screen.getByLabelText('Jacket outer diameter'), { target: { value: '3.2' } });
  expect(screen.getByText('Draft v4 · unsaved')).toBeTruthy(); expect((screen.getByRole('button', { name: 'Freeze saved stock' }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: 'Save stock' })); await screen.findByText('Saved draft.'); expect(api.posts[0]?.expected_state).toBe('draft-v4');
  fireEvent.click(screen.getByRole('button', { name: 'Freeze saved stock' })); await waitFor(() => expect(callbacks.onSelect).toHaveBeenCalledWith(3)); expect(api.posts[1]?.expected_state).toBe('draft-v5');
});
test('success then authority denial withdraws retained model, spec and inspector; unsaved draft recovers', async () => {
  const api = server(); mount({ draftRequested: true }); await screen.findByLabelText('Stock name'); fireEvent.change(screen.getByLabelText('Jacket outer diameter'), { target: { value: '3.3' } });
  api.deny(true); fireEvent.click(screen.getByRole('button', { name: 'Refresh record' })); await screen.findByText('Stock unavailable'); expect(screen.queryByRole('img')).toBeNull(); expect(screen.queryByTitle('Selected stock specification')).toBeNull(); expect(screen.queryByRole('textbox', { name: 'Jacket outer diameter' })).toBeNull();
  api.deny(false); fireEvent.click(screen.getByRole('button', { name: 'Refresh record' })); await screen.findByRole('textbox', { name: 'Stock name' }); expect((screen.getByLabelText('Jacket outer diameter') as HTMLInputElement).value).toBe('3.3'); expect(screen.getByText('Draft v4 · unsaved')).toBeTruthy();
});
test('newer server draft does not overwrite dirty buffer or its CAS after refresh', async () => {
  const api = server(); mount({ draftRequested: true }); await screen.findByLabelText('Stock name'); fireEvent.change(screen.getByLabelText('Jacket outer diameter'), { target: { value: '3.4' } }); api.advance(); fireEvent.click(screen.getByRole('button', { name: 'Refresh record' }));
  await screen.findByText(/A newer draft exists/); expect((screen.getByLabelText('Jacket outer diameter') as HTMLInputElement).value).toBe('3.4'); api.conflict(); fireEvent.click(screen.getByRole('button', { name: 'Save stock' })); await screen.findByText('Draft changed since expected state.'); expect(api.posts[0]?.expected_state).toBe('draft-v4'); expect(screen.getByText('Draft v4 · unsaved')).toBeTruthy();
});
test('new record starts unknown and uses construction central drawing; viewer cannot create or mutate', async () => {
  server(); mount({ definitionId: null }, ['workspace.read']); expect(screen.getByText('New · unsaved')).toBeTruthy(); expect((screen.getByRole('button', { name: 'Save stock' }) as HTMLButtonElement).disabled).toBe(true); expect(screen.getByRole('tab', { name: /^Section$/ }).getAttribute('aria-selected')).toBe('true'); expect(screen.getByText(/Illustrative proportions only/)).toBeTruthy();
});
test('spec sheet and facts come from selected frozen state after draft visits', async () => {
  server(); const { rerender } = mount({ draftRequested: true }); await screen.findByLabelText('Stock name'); fireEvent.change(screen.getByLabelText('Jacket outer diameter'), { target: { value: '3.5' } });
  rerender({ draftRequested: false, revisionNumber: 1 }); await screen.findByRole('tab', { name: /^Spec sheet$/ }); expect(screen.getByText('Frozen r1')).toBeTruthy(); tab('Spec sheet'); const frame = screen.getByTitle('Selected stock specification') as HTMLIFrameElement; expect(frame.srcdoc).toContain('Frozen r1'); expect(frame.srcdoc).toContain('3 mm OD'); expect(frame.srcdoc).not.toContain('3.5 mm OD');
  rerender({ draftRequested: true, revisionNumber: null }); await screen.findByRole('textbox', { name: 'Stock name' }); expect((screen.getByLabelText('Jacket outer diameter') as HTMLInputElement).value).toBe('3.5');
});
test('inactive view disposes model and rechecks authority before showing it again', async () => {
  const api = server(); const { rerender } = mount(); await screen.findByRole('img', { name: /Selected stock model/ }); rerender({ active: false }); expect(screen.getByRole('img', { name: /Selected stock model/, hidden: true }).getAttribute('data-active')).toBe('false'); expect(screen.queryByRole('img')).toBeNull(); api.deny(true); rerender({ active: true }); await screen.findByText('Stock unavailable'); expect(screen.queryByRole('img')).toBeNull();
});

test('save response advances CAS without replacing edits made during its request', async () => {
  const api = server(); mount({ draftRequested: true }); await screen.findByLabelText('Jacket outer diameter'); const release = api.hold();
  fireEvent.click(screen.getByRole('button', { name: 'Save stock' })); fireEvent.change(screen.getByLabelText('Jacket outer diameter'), { target: { value: '3.9' } }); await act(async () => release());
  await screen.findByText('Draft v5 · unsaved'); expect((screen.getByLabelText('Jacket outer diameter') as HTMLInputElement).value).toBe('3.9'); expect(api.posts[0]?.expected_state).toBe('draft-v4');
});
test('freeze response keeps edits made while freezing and does not navigate away', async () => {
  const api = server(); const { callbacks } = mount({ draftRequested: true }); await screen.findByLabelText('Jacket outer diameter'); const release = api.hold();
  fireEvent.click(screen.getByRole('button', { name: 'Freeze saved stock' })); fireEvent.change(screen.getByLabelText('Jacket outer diameter'), { target: { value: '3.7' } }); await act(async () => release());
  await screen.findByText('Draft v6 · unsaved'); expect((screen.getByLabelText('Jacket outer diameter') as HTMLInputElement).value).toBe('3.7'); expect(callbacks.onSelect).not.toHaveBeenCalled();
});

test('historic record manufacturer number follows the exact selected catalog, not latest', async () => {
  server(); mount({ revisionNumber: 1 }); expect(await screen.findByText('PN Synthetic OLD-PN')).toBeTruthy(); expect(screen.queryByText('PN Synthetic CURRENT-PN')).toBeNull();
});
test('central section jacket handle edits the actual draft and requires saving again', async () => {
  server(); mount({ draftRequested: true }); await screen.findByLabelText('Jacket outer diameter'); tab('Section'); const handle = screen.getByRole('slider', { name: 'Jacket outer diameter handle' }); const before = Number(handle.getAttribute('aria-valuenow')); fireEvent.keyDown(handle, { key: 'ArrowRight' }); expect(Number(handle.getAttribute('aria-valuenow'))).toBeGreaterThan(before); expect(screen.getByText('Draft v4 · unsaved')).toBeTruthy(); expect((screen.getByRole('button', { name: 'Freeze saved stock' }) as HTMLButtonElement).disabled).toBe(true);
});

test('create name is locked until its accepted identity is known', async () => {
  const api = server(); const { callbacks } = mount({ definitionId: null }); fireEvent.change(screen.getByLabelText('Stock name'), { target: { value: 'Submitted identity' } }); const release = api.hold(); fireEvent.click(screen.getByRole('button', { name: 'Save stock' })); expect((screen.getByLabelText('Stock name') as HTMLInputElement).disabled).toBe(true); await act(async () => release()); await waitFor(() => expect(callbacks.onCreated).toHaveBeenCalledWith('s1', true));
});

test('contextual preparation retains a dirty exact profile and original CAS across record refresh, rail hide, focus and denied parent recovery', async () => {
  const api = server(); const { rerender } = mount(); await screen.findByText('Frozen r2'); tab('Practices');
  fireEvent.click(screen.getByText('Cut arithmetic profiles')); await screen.findByLabelText('cut preparation name');
  fireEvent.click(screen.getByText('Saved cut preparation profiles')); fireEvent.click(screen.getByRole('combobox', { name: 'cut preparation definition' })); fireEvent.click(await screen.findByRole('option', { name: 'Practice one' }));
  fireEvent.click(await screen.findByRole('combobox', { name: 'cut preparation draft' })); fireEvent.click(await screen.findByRole('option', { name: 'draft-v4' })); fireEvent.click(screen.getByRole('button', { name: 'Load cut preparation draft (replace local edits)' })); await screen.findByText('draft-v4 · saved draft');
  fireEvent.change(screen.getByLabelText('Formula 1 label'), { target: { value: 'Unsaved contextual formula' } });
  fireEvent.click(screen.getByRole('button', { name: 'Refresh record' })); await waitFor(() => expect((screen.getByLabelText('Formula 1 label') as HTMLInputElement).value).toBe('Unsaved contextual formula'));
  rerender({ active: false }); expect(screen.queryByRole('textbox', { name: 'Formula 1 label' })).toBeNull(); rerender({ active: true }); await waitFor(() => expect((screen.getByLabelText('Formula 1 label') as HTMLInputElement).value).toBe('Unsaved contextual formula'));
  api.deny(true); act(() => window.dispatchEvent(new Event('focus'))); fireEvent.click(screen.getByRole('button', { name: 'Refresh record' })); await screen.findByText('Stock unavailable'); expect(screen.queryByRole('textbox', { name: 'Formula 1 label' })).toBeNull(); expect(screen.queryByRole('img')).toBeNull();
  api.deny(false); fireEvent.click(screen.getByRole('button', { name: 'Refresh record' })); await screen.findByText('Frozen r2');
  const recovery = screen.queryByRole('button', { name: 'Refresh cut preparation access' }); if (recovery) fireEvent.click(recovery);
  await waitFor(() => expect((screen.getByLabelText('Formula 1 label') as HTMLInputElement).value).toBe('Unsaved contextual formula'));
  fireEvent.click(screen.getByRole('button', { name: 'Save cut preparation' })); await waitFor(() => expect(api.posts).toHaveLength(1)); expect(api.posts[0]?.expected_state).toBe('draft-v4'); expect(api.posts[0]?.payload).toEqual(expect.objectContaining({ profile: expect.objectContaining({ stock_revision_id: 'r2', formulas: [expect.objectContaining({ label: 'Unsaved contextual formula' })] }) }));
});
