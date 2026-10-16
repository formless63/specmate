import { MantineProvider } from '@mantine/core';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { PermissionsProvider } from '../../lib/permissions';
import { RecipeComposer } from './RecipeComposer';
import { cable } from '../cable-workbench/fixtures';
import { emptyIntent } from '../intents/api';
import type { Recipe } from '../../components/editor/RecipeBar';
vi.mock('../../components/editor/RecipeBar', () => ({ emptyRecipe: () => ({ fromPort: '', toPort: '', stock: '', fromEnd: '', toEnd: '', lengthMm: null }), RecipeBar: ({ value, onChange, active, onPropose, disabled, busy }: { value: Recipe; onChange: (value: Recipe) => void; active: boolean; onPropose: () => void; disabled: boolean; busy: boolean }) => active ? <section>{(['fromPort','toPort','stock','fromEnd','toEnd'] as const).map(field => <input key={field} aria-label={field} disabled={disabled || busy} value={value[field]} onChange={event => onChange({ ...value, [field]: event.target.value })} />)}<button disabled={disabled || busy} onClick={onPropose}>Propose wiring</button></section> : null }));
vi.mock('../intents/IntentPanel', () => ({ IntentReview: () => <p>Reviewed exact port requirements</p> }));
const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
beforeEach(() => { vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} }); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
function server() {
  let heldIntent:((value:Response)=>void)|null=null;
  const commands: { operation: string; payload: { interface?: unknown }; expected_state: string }[] = []; let deny = false, held: ((value: Response) => void) | null = null, hold = false;
  const value = cable(); const intent = { ...emptyIntent(), from_revision_id: 'from-port', to_revision_id: 'to-port' };
  const proposal = { intent_revision_id: 'exact-frozen-intent', cable: { ...value, intent_revision_id: 'exact-frozen-intent' }, rows: [{ row_id: 'signal', status: 'proposed', assignments: [{ endpoint_id: 'a', element_path: 'stock.core', layer_id: 'connector', terminal_id: '1', terminal_label: 'Pin1', basis: 'Intent row' }], questions: [] }], questions: [], existing_needs: [], check: { rows: [] }, diff: null, status: 'proposed', review: 'required' };
  vi.stubGlobal('fetch', vi.fn(async (path: string, options?: RequestInit) => {
    if (deny) return reply({ error: { message: 'Not found' } }, 404);
    if (path === '/api/v0/access/workspace') return reply({ workspace_id: 'w1', permissions: ['workspace.read','item.create','design.freeze'] });
    if (path.includes('/catalog/revision-labels?')) return reply({ labels: new URL(path, 'http://test').searchParams.getAll('revision_ids').map(id => ({ revision_id: id, readable: true, kind: id.includes('port') ? 'port' : id.includes('intent') ? 'cable_intent' : id.includes('end') ? 'end_assembly' : 'wire_stock', definition_id: 'intent-definition', name: 'Requirements', number: 4 })) });
    if (path === '/api/v0/interfaces/revisions/pinned-intent') return new Promise<Response>(resolve=>{heldIntent=resolve;});
    if (path.includes('/interfaces/intents/propose?')) return reply({ rows: [], open_questions: 0 });
    if (path === '/api/v0/cables/propose') { if (hold) return new Promise<Response>(resolve => { held = resolve; }); return reply(proposal); }
    if (path === '/api/v0/operations') { const command = JSON.parse(String(options?.body)); commands.push(command); return reply({ result: command.operation === 'interface.create' ? { draft_id: 'intent-draft', definition_id: 'intent-definition', state: 'draft-v1', content: { interface: intent } } : { revision_id: 'exact-frozen-intent', number: 4, draft: { draft_id: 'intent-draft', state: 'draft-v2', definition_id: 'intent-definition' } } }); }
    throw new Error('Unexpected read '+path);
  }));
  return { commands, heldIntent:()=>heldIntent, releaseIntent:()=>heldIntent?.(reply({revision_id:'pinned-intent',interface:intent})), deny: (next: boolean) => { deny = next; }, hold: () => { hold = true; }, held: () => held, release: () => held?.(reply(proposal)) };
}
function mount(initial: ReturnType<typeof cable> | null = null) {
  const cache = new QueryClient({ defaultOptions: { queries: { retry: false } } }); const apply = vi.fn();
  const tree = (active = true, principalKey = 'owner', current: ReturnType<typeof cable> | null = initial) => <MantineProvider env="test"><QueryClientProvider client={cache}><PermissionsProvider permissions={['workspace.read','item.create','design.freeze']}><RecipeComposer active={active} workspaceId="w1" principalKey={principalKey} name="Synthetic cable" current={current} onApply={apply} /></PermissionsProvider></QueryClientProvider></MantineProvider>;
  const view = render(tree()); return { apply, rerender: (active = true, principalKey = 'owner', current: ReturnType<typeof cable> | null = initial) => view.rerender(tree(active, principalKey, current)) };
}
async function choose() {
  for (const [field,value] of [['fromPort','from-port'],['toPort','to-port'],['stock','stock'],['fromEnd','from-end'],['toEnd','to-end']]) { const input = await screen.findByLabelText(field!); fireEvent.change(input, { target: { value } }); }
  await waitFor(() => expect((screen.getByRole('button', { name: 'Propose wiring' }) as HTMLButtonElement).disabled).toBe(false));
}
test('ports are reviewed before intent freeze and only the returned exact revision proposes; no cable is auto-created or applied', async () => {
  const api = server(); const { apply } = mount(); await choose(); expect(api.commands).toHaveLength(0); fireEvent.click(screen.getByRole('button', { name: 'Propose wiring' })); await screen.findByText('Reviewed exact port requirements'); expect(api.commands).toHaveLength(0);
  fireEvent.click(screen.getByRole('button', { name: 'Freeze requirements and propose cable' })); await screen.findByRole('table', { name: 'Recipe proposal' }); expect(api.commands.map(row => row.operation)).toEqual(['interface.create','interface.freeze']); expect(api.commands[1]!.expected_state).toBe('draft-v1'); expect(apply).not.toHaveBeenCalled(); const request = vi.mocked(fetch).mock.calls.find(([path]) => path === '/api/v0/cables/propose')!; expect(JSON.parse(String(request[1]!.body)).intent_revision_id).toBe('exact-frozen-intent'); fireEvent.click(screen.getByRole('button', { name: 'Apply reviewed proposal' })); expect(apply).toHaveBeenCalledWith(expect.objectContaining({ intent_revision_id: 'exact-frozen-intent' })); expect(api.commands.some(row => row.operation === 'cable.create')).toBe(false);
});
test('denial on resume hides prepared recipe data; recovery retains it, and held proposals never cross principal scope', async () => {
  const api = server(); const view = mount(); await choose(); view.rerender(false); api.deny(true); view.rerender(true); await screen.findByText(/Recipe references are unavailable/); expect(screen.queryByLabelText('fromPort')).toBeNull(); api.deny(false); fireEvent.click(screen.getByRole('button', { name: 'Retry recipe access' })); expect((await screen.findByLabelText('fromPort') as HTMLInputElement).value).toBe('from-port');
  fireEvent.click(screen.getByRole('button', { name: 'Propose wiring' })); await screen.findByText('Reviewed exact port requirements'); api.hold(); fireEvent.click(screen.getByRole('button', { name: 'Freeze requirements and propose cable' })); await waitFor(() => expect(api.held()).not.toBeNull()); view.rerender(true, 'viewer'); await screen.findByLabelText('fromPort'); await act(async () => api.release()); expect(screen.queryByRole('table', { name: 'Recipe proposal' })).toBeNull(); expect((screen.getByLabelText('fromPort') as HTMLInputElement).value).toBe('');
});

test('a pending proposal cannot overwrite newer unsaved cable edits', async () => {
  const api = server(), view = mount(); await choose(); fireEvent.click(screen.getByRole('button', {name:'Propose wiring'})); await screen.findByText('Reviewed exact port requirements'); api.hold(); fireEvent.click(screen.getByRole('button', {name:'Freeze requirements and propose cable'})); await waitFor(()=>expect(api.held()).not.toBeNull());
  const newer = cable(); newer.endpoints[0]!.label = 'Newer unsaved label'; view.rerender(true,'owner',newer); await act(async()=>api.release()); await screen.findByText(/The cable changed after this proposal was requested/); expect(screen.queryByRole('button', {name:'Apply reviewed proposal'})).toBeNull(); expect(view.apply).not.toHaveBeenCalled(); expect(newer.endpoints[0]!.label).toBe('Newer unsaved label');
});

test('stock edits while an exact retained recipe loads do not suppress untouched port picks',async()=>{const api=server(),current=cable();current.intent_revision_id='pinned-intent';mount(current);await screen.findByLabelText('stock');await waitFor(()=>expect(api.heldIntent()).not.toBeNull());fireEvent.change(screen.getByLabelText('stock'),{target:{value:'changed-stock'}});await act(async()=>api.releaseIntent());await waitFor(()=>expect((screen.getByLabelText('fromPort') as HTMLInputElement).value).toBe('from-port'));expect((screen.getByLabelText('toPort') as HTMLInputElement).value).toBe('to-port');expect((screen.getByLabelText('stock') as HTMLInputElement).value).toBe('changed-stock');expect(api.commands).toHaveLength(0);});
test('a late retained recipe never replaces an explicitly picked port',async()=>{const api=server(),current=cable();current.intent_revision_id='pinned-intent';mount(current);await screen.findByLabelText('fromPort');await waitFor(()=>expect(api.heldIntent()).not.toBeNull());fireEvent.change(screen.getByLabelText('fromPort'),{target:{value:'hand-picked-port'}});await act(async()=>api.releaseIntent());await waitFor(()=>expect((screen.getByLabelText('fromPort') as HTMLInputElement).value).toBe('hand-picked-port'));expect((screen.getByLabelText('toPort') as HTMLInputElement).value).toBe('');expect(api.commands).toHaveLength(0);});
