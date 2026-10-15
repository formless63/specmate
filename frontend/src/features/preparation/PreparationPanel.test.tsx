import { byContent } from "../../test/text";
import { MantineProvider } from '@mantine/core';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { PreparationPanel, FrozenProfile } from './PreparationPanel';
import { ProfileEditor } from './ProfileEditor';
import { CutCalculation } from './CutCalculation';
import { emptyFormula, type Profile, type Result } from './api';
import { PermissionsProvider } from '../../lib/permissions';
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
  vi.stubGlobal('fetch', vi.fn(async (_url: string, options?: RequestInit) => { requests.push(JSON.parse(String(options?.body))); return denied ? response({ error: { message: 'Source denied.' } }, 404) : response(computed); }));
  render(wrap(<CutCalculation definitions={[]} />));
  fireEvent.change(screen.getByLabelText('Preparation subject exact revision ID'), { target: { value: 'cable-rev' } }); fireEvent.change(screen.getByLabelText('Application 1 profile exact revision ID'), { target: { value: 'profile-rev' } }); fireEvent.change(screen.getByLabelText('Requested units'), { target: { value: '2' } }); fireEvent.click(screen.getByText('Compute preparation cuts'));
  await screen.findByText(byContent('1035 mm / 2070 mm · suggestion')); expect(requests[0]).toEqual({ revision_id: 'cable-rev', applications: [{ section_id: null, profile_revision_id: 'profile-rev' }], quantity: 2 }); expect(screen.getByText(byContent('1070 mm'))).toBeTruthy(); expect(screen.getByText('Differs from computed suggestion')).toBeTruthy(); expect(screen.getByText(/Synthetic declared route/)).toBeTruthy();
  denied = true; fireEvent.click(screen.getByText('Refresh computed cut access')); await screen.findByText('Source denied.'); expect(screen.queryByText(/subject-hash/)).toBeNull(); expect(screen.queryByText(byContent(/1035 mm/))).toBeNull();
  denied = false; fireEvent.click(screen.getByText('Compute preparation cuts')); await screen.findByText(byContent('1035 mm / 2070 mm · suggestion')); fireEvent.change(screen.getByLabelText('Requested units'), { target: { value: '' } }); expect(screen.queryByText(byContent(/1035 mm/))).toBeNull(); fireEvent.click(screen.getByText('Compute preparation cuts')); await waitFor(() => expect(requests.at(-1)).toMatchObject({ quantity: null }));
});
test.each(['preparation.create', 'preparation.update', 'preparation.freeze'])('%s denial hides content; refocus restores unsaved values and original token', async operation => {
  let denied = false; let restored = false; let saved = profile; const commands: { operation: string; expected_state?: string; payload: { profile?: Profile } }[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, options?: RequestInit) => {
    if (url.endsWith('/operations')) { const cmd = JSON.parse(String(options?.body)); commands.push(cmd); if (denied && cmd.operation === operation) return response({ error: { message: 'Mutation source denied.' } }, 403); if (restored) return response({ error: { message: 'Draft changed concurrently.' } }, 409); saved = cmd.payload.profile ?? saved; return response({ result: { definition_id: 'profile', draft_id: 'draft', state: 'v1', content: { preparation_profile: saved } } }); }
    if (url.endsWith('/authority')) return denied ? response({ error: { message: 'Still denied.' } }, 404) : response({ authorized: true });
    if (url.includes('/snapshot')) return response({ content: { stock: { structure: { id: 'stock', kind: 'group', children: [] } } } });
    if (url.includes('/drafts/')) return response({ definition_id: 'profile', draft_id: 'draft', state: 'newer-server-token', content: { preparation_profile: profile } });
    if (url.includes('catalog/definitions')) return response({ drafts: [{ draft_id: 'draft', state: 'v1' }], revisions: [] });
    return response([{ definition_id: 'profile', name: 'Synthetic profile', kind: 'preparation_profile' }]);
  }));
  render(wrap(<PreparationPanel />));
  fireEvent.change(screen.getByLabelText('Preparation profile name'), { target: { value: 'Synthetic profile' } }); fireEvent.change(screen.getByLabelText('Preparation stock exact revision ID'), { target: { value: 'stock-rev' } }); fireEvent.click(screen.getByText('Add cut formula')); fireEvent.click(screen.getByText('Add Formula 1 allowance')); fireEvent.change(screen.getByLabelText('Formula 1 allowance 1 mm'), { target: { value: '20.000001' } });
  if (operation !== 'preparation.create') { fireEvent.click(screen.getByText('Save preparation profile')); await screen.findByText('draft · v1', { selector: 'p' }); }
  fireEvent.change(screen.getByLabelText('Formula 1 allowance 1 basis'), { target: { value: 'Unsaved synthetic basis' } }); denied = true; fireEvent.click(screen.getByText(operation === 'preparation.freeze' ? 'Freeze preparation profile' : 'Save preparation profile'));
  await screen.findByText('Mutation source denied.'); expect(screen.queryByLabelText('Formula 1 allowance 1 mm')).toBeNull(); expect(screen.queryByText('Apply exact profiles to frozen cable or harness')).toBeNull();
  await act(async () => { window.dispatchEvent(new Event('focus')); }); await screen.findByText('Still denied.'); expect(screen.queryByLabelText('Formula 1 allowance 1 mm')).toBeNull(); denied = false; restored = true;
  await act(async () => { window.dispatchEvent(new Event('focus')); }); await screen.findByLabelText('Formula 1 allowance 1 mm'); expect((screen.getByLabelText('Formula 1 allowance 1 mm') as HTMLInputElement).value).toBe('20.000001'); expect((screen.getByLabelText('Formula 1 allowance 1 basis') as HTMLInputElement).value).toBe('Unsaved synthetic basis');
  fireEvent.click(screen.getByText('Save preparation profile')); await screen.findByText('Draft changed concurrently.'); if (operation !== 'preparation.create') expect(commands.at(-1)!.expected_state).toBe('v1'); expect((screen.getByLabelText('Formula 1 allowance 1 mm') as HTMLInputElement).value).toBe('20.000001');
});
test('frozen provenance hides after denial and notifies enclosing editor', async () => {
  let denied = false; const onDenied = vi.fn(); vi.stubGlobal('fetch', vi.fn(async () => denied ? response({ error: { message: 'Hidden evidence.' } }, 404) : response({ revision_id: 'profile-rev', sha256: 'immutable-hash', stock_sha256: 'stock-hash', profile, conductive_features: [] })));
  render(wrap(<FrozenProfile revisionId="profile-rev" onDenied={onDenied} />)); await screen.findByText(/immutable-hash/); denied = true; fireEvent.click(screen.getByText('Refresh frozen preparation access')); await screen.findByText('Hidden evidence.'); expect(screen.queryByText(/immutable-hash/)).toBeNull(); expect(onDenied).toHaveBeenCalled();
});

test('saved formulas freeze exact history while later unsaved edits stay independent', async () => {
  let saved = profile; let frozen = profile; const commands: { operation: string; expected_state?: string }[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, options?: RequestInit) => {
    if (url.endsWith('/operations')) { const cmd = JSON.parse(String(options?.body)); commands.push(cmd); saved = cmd.payload.profile ?? saved; const draft = { definition_id: 'profile', draft_id: 'draft', state: cmd.operation === 'preparation.freeze' ? 'v2' : 'v1', content: { preparation_profile: saved } }; if (cmd.operation === 'preparation.freeze') { frozen = structuredClone(saved); return response({ result: { revision_id: 'profile-rev', draft } }); } return response({ result: draft }); }
    if (url.includes('/snapshot')) return response({ content: { stock: { structure: { id: 'stock', kind: 'group', children: [] } } } });
    if (url.includes('preparation/revisions')) return response({ revision_id: 'profile-rev', sha256: 'frozen-formula-hash', stock_sha256: 'exact-stock-hash', profile: frozen, conductive_features: [] });
    if (url.includes('catalog/definitions')) return response({ drafts: [{ draft_id: 'draft', state: 'v1' }], revisions: [{ revision_id: 'profile-rev', number: 1 }] });
    return response([{ definition_id: 'profile', name: 'Synthetic profile', kind: 'preparation_profile' }]);
  }));
  render(wrap(<PreparationPanel />));
  fireEvent.change(screen.getByLabelText('Preparation profile name'), { target: { value: 'Synthetic profile' } }); fireEvent.change(screen.getByLabelText('Preparation stock exact revision ID'), { target: { value: 'stock-rev' } }); fireEvent.click(screen.getByText('Add cut formula')); fireEvent.click(screen.getByText('Add Formula 1 allowance')); fireEvent.change(screen.getByLabelText('Formula 1 allowance 1 mm'), { target: { value: '20' } }); fireEvent.change(screen.getByLabelText('Formula 1 allowance 1 basis'), { target: { value: 'Saved synthetic basis' } }); fireEvent.click(screen.getByText('Save preparation profile')); await screen.findByText('draft · v1', { selector: 'p' });
  fireEvent.change(screen.getByLabelText('Formula 1 allowance 1 mm'), { target: { value: '999' } }); fireEvent.click(screen.getByText('Freeze preparation profile')); await screen.findByText(/frozen-formula-hash/);
  expect(screen.getByText(byContent('allowance-1: preparation 20 mm · whole_piece · Saved synthetic basis'))).toBeTruthy(); expect((screen.getByLabelText('Formula 1 allowance 1 mm') as HTMLInputElement).value).toBe('999'); expect(commands.at(-1)).toMatchObject({ operation: 'preparation.freeze', expected_state: 'v1' }); await screen.findByText('draft · v2', { selector: 'p' });
});

function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
function startProfile() {
  fireEvent.change(screen.getByLabelText('Preparation profile name'), { target: { value: 'Synthetic profile' } });
  fireEvent.change(screen.getByLabelText('Preparation stock exact revision ID'), { target: { value: 'stock-rev' } });
  fireEvent.click(screen.getByText('Add cut formula')); fireEvent.click(screen.getByText('Add Formula 1 allowance'));
  fireEvent.change(screen.getByLabelText('Formula 1 allowance 1 mm'), { target: { value: '20' } });
}
function baseRead(url: string) {
  if (url.includes('/snapshot')) return { content: { stock: { structure: { id: 'stock', kind: 'group', children: [] } } } };
  if (url.includes('catalog/definitions')) return { drafts: [{ draft_id: 'draft', state: 'v1' }], revisions: [{ revision_id: 'profile-rev', number: 1 }] };
  return [{ definition_id: 'profile', name: 'Synthetic profile', kind: 'preparation_profile' }];
}
test('late save retains post-submit edits while advancing only the accepted CAS baseline', async () => {
  const pending = deferred<Response>(); const commands: { expected_state?: string; payload: { profile: Profile } }[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, options?: RequestInit) => {
    if (!url.endsWith('/operations')) return response(baseRead(url));
    const cmd = JSON.parse(String(options?.body)); commands.push(cmd);
    if (commands.length === 1) return pending.promise;
    return response({ result: { definition_id: 'profile', draft_id: 'draft', state: 'v2', content: { preparation_profile: cmd.payload.profile } } });
  }));
  render(wrap(<PreparationPanel />)); startProfile(); fireEvent.click(screen.getByText('Save preparation profile'));
  await waitFor(() => expect(commands).toHaveLength(1));
  fireEvent.change(screen.getByLabelText('Formula 1 allowance 1 mm'), { target: { value: '25' } });
  await act(async () => { pending.resolve(response({ result: { definition_id: 'profile', draft_id: 'draft', state: 'v1', content: { preparation_profile: commands[0]!.payload.profile } } })); });
  await screen.findByText('draft · v1', { selector: 'p' }); expect((screen.getByLabelText('Formula 1 allowance 1 mm') as HTMLInputElement).value).toBe('25');
  fireEvent.click(screen.getByText('Save preparation profile')); await screen.findByText('draft · v2', { selector: 'p' });
  expect(commands[1]).toMatchObject({ expected_state: 'v1', payload: { profile: { formulas: [{ allowances: [{ amount_mm: '25' }] }] } } });
});
test.each(['save', 'load', 'freeze'])('late %s cannot reopen an editor replaced by New', async action => {
  const pending = deferred<Response>(); let waiting = false; let saved = profile;
  vi.stubGlobal('fetch', vi.fn(async (url: string, options?: RequestInit) => {
    if (url.endsWith('/operations')) { const cmd = JSON.parse(String(options?.body)); saved = cmd.payload.profile ?? saved; if ((action === 'save' && cmd.operation === 'preparation.create') || cmd.operation === 'preparation.freeze') { waiting = true; return pending.promise; } return response({ result: { definition_id: 'profile', draft_id: 'draft', state: 'v1', content: { preparation_profile: saved } } }); }
    if (url.includes('preparation/drafts/')) { waiting = true; return pending.promise; }
    return response(baseRead(url));
  }));
  render(wrap(<PreparationPanel />)); startProfile();
  if (action === 'load') { await select('Existing preparation definition', 'Synthetic profile'); await select('Preparation draft to load', 'draft · v1'); fireEvent.click(screen.getByText('Load preparation draft')); }
  else { fireEvent.click(screen.getByText('Save preparation profile')); if (action === 'freeze') { await screen.findByText('draft · v1', { selector: 'p' }); fireEvent.click(screen.getByText('Freeze preparation profile')); } }
  await waitFor(() => expect(waiting).toBe(true)); fireEvent.click(screen.getByRole('button', { name: 'New preparation profile' })); fireEvent.change(screen.getByLabelText('Preparation profile name'), { target: { value: 'Replacement profile' } });
  const draft = { definition_id: 'profile', draft_id: 'draft', state: 'late-token', content: { preparation_profile: saved } };
  await act(async () => { pending.resolve(response(action === 'load' ? draft : { result: action === 'freeze' ? { revision_id: 'profile-rev', draft } : draft })); });
  expect(screen.queryByText('draft · late-token')).toBeNull(); expect(screen.queryByLabelText('Formula 1 allowance 1 mm')).toBeNull(); expect((screen.getByLabelText('Preparation profile name') as HTMLInputElement).value).toBe('Replacement profile'); expect(screen.queryByText('Frozen preparation profile')).toBeNull();
});
test('computed denial gates sibling frozen/editor provenance and checks exact denied inputs before restoring', async () => {
  let denied = false; let saved = profile; const authorityReads: string[] = []; const commands: { expected_state?: string }[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, options?: RequestInit) => {
    if (url.endsWith('/operations')) { const cmd = JSON.parse(String(options?.body)); commands.push(cmd); saved = cmd.payload.profile ?? saved; const draft = { definition_id: 'profile', draft_id: 'draft', state: 'v1', content: { preparation_profile: saved } }; return response({ result: cmd.operation === 'preparation.freeze' ? { revision_id: 'profile-rev', draft } : draft }); }
    if (url.endsWith('/compute')) return denied ? response({ error: { message: 'Computed source denied.' } }, 403) : response(computed);
    if (url.includes('preparation/revisions')) { authorityReads.push(url); return denied ? response({ error: { message: 'Profile source still denied.' } }, 404) : response({ revision_id: 'profile-rev', sha256: 'sibling-private-hash', stock_sha256: 'stock-hash', profile: saved, conductive_features: [] }); }
    if (url.includes('preparation/drafts')) return response({ definition_id: 'profile', draft_id: 'draft', state: 'newer-server-token', content: { preparation_profile: profile } });
    if (url.endsWith('/authority')) return response({ authorized: true });
    if (url.includes('cable-rev/snapshot')) authorityReads.push(url);
    return response(baseRead(url));
  }));
  render(wrap(<PreparationPanel />)); startProfile(); fireEvent.click(screen.getByText('Save preparation profile')); await screen.findByText('draft · v1', { selector: 'p' }); fireEvent.click(screen.getByText('Freeze preparation profile')); await screen.findByText(/sibling-private-hash/);
  fireEvent.change(screen.getByLabelText('Formula 1 allowance 1 mm'), { target: { value: '25' } });
  fireEvent.change(screen.getByLabelText('Preparation subject exact revision ID'), { target: { value: 'cable-rev' } }); fireEvent.change(screen.getByLabelText('Application 1 profile exact revision ID'), { target: { value: 'profile-rev' } }); fireEvent.click(screen.getByText('Compute preparation cuts')); await screen.findByText(byContent(/1035 mm/));
  denied = true; fireEvent.click(screen.getByText('Refresh computed cut access')); await screen.findByText(/Preparation source access must be rechecked/);
  expect(screen.queryByText(/sibling-private-hash/)).toBeNull(); expect(screen.queryByLabelText('Formula 1 allowance 1 mm')).toBeNull();
  fireEvent.click(screen.getByText('Refresh preparation access')); await screen.findByText('Profile source still denied.'); expect(screen.queryByLabelText('Formula 1 allowance 1 mm')).toBeNull();
  denied = false; fireEvent.click(screen.getByText('Refresh preparation access')); await screen.findByLabelText('Formula 1 allowance 1 mm'); expect(authorityReads).toContain('/api/v0/revisions/cable-rev/snapshot'); expect((screen.getByLabelText('Formula 1 allowance 1 mm') as HTMLInputElement).value).toBe('25');
  fireEvent.click(screen.getByText('Save preparation profile')); await waitFor(() => expect(commands).toHaveLength(3)); expect(commands[2]!.expected_state).toBe('v1');
});
test('late computation denial does not gate an unrelated replacement editor', async () => {
  const pending = deferred<Response>(); const onDenied = vi.fn();
  vi.stubGlobal('fetch', vi.fn(() => pending.promise));
  const view = render(wrap(<CutCalculation definitions={[]} onDenied={onDenied} authorityScope={1} />));
  fireEvent.change(screen.getByLabelText('Preparation subject exact revision ID'), { target: { value: 'old-cable' } }); fireEvent.change(screen.getByLabelText('Application 1 profile exact revision ID'), { target: { value: 'old-profile' } }); fireEvent.click(screen.getByText('Compute preparation cuts'));
  view.rerender(wrap(<CutCalculation definitions={[]} onDenied={onDenied} authorityScope={2} />));
  await act(async () => { pending.resolve(response({ error: { message: 'Old source denied.' } }, 403)); });
  await screen.findByText('Old source denied.'); expect(onDenied).not.toHaveBeenCalled();
});

test('browsing history while a save is pending does not discard same-editor authority denial', async () => {
  const pending = deferred<Response>(); let count = 0;
  vi.stubGlobal('fetch', vi.fn(async (url: string, options?: RequestInit) => {
    if (url.endsWith('/operations')) { const cmd = JSON.parse(String(options?.body)); count += 1; if (count === 2) return pending.promise; return response({ result: { definition_id: 'profile', draft_id: 'draft', state: 'v1', content: { preparation_profile: cmd.payload.profile } } }); }
    if (url.includes('/definitions') && !url.includes('catalog/definitions')) return response([...baseRead(url) as object[], { definition_id: 'other', name: 'Other history', kind: 'preparation_profile' }]);
    return response(baseRead(url));
  }));
  render(wrap(<PreparationPanel />)); startProfile(); fireEvent.click(screen.getByText('Save preparation profile')); await screen.findByText('draft · v1', { selector: 'p' });
  fireEvent.change(screen.getByLabelText('Formula 1 allowance 1 mm'), { target: { value: '25' } }); fireEvent.click(screen.getByText('Save preparation profile')); await waitFor(() => expect(count).toBe(2));
  await select('Existing preparation definition', 'Other history'); expect((screen.getByLabelText('Formula 1 allowance 1 mm') as HTMLInputElement).value).toBe('25');
  await act(async () => { pending.resolve(response({ error: { message: 'Retained editor source denied.' } }, 403)); });
  await screen.findByText(/Preparation source access must be rechecked/); expect(screen.queryByLabelText('Formula 1 allowance 1 mm')).toBeNull(); expect(screen.queryByText('draft · v1', { selector: 'p' })).toBeNull();
});

test('quantity edits cannot discard a pending computed denial affecting the retained editor', async () => {
  const pending = deferred<Response>(); let computations = 0;
  vi.stubGlobal('fetch', vi.fn(async (url: string, options?: RequestInit) => {
    if (url.endsWith('/operations')) { const cmd = JSON.parse(String(options?.body)); return response({ result: { definition_id: 'profile', draft_id: 'draft', state: 'v1', content: { preparation_profile: cmd.payload.profile } } }); }
    if (url.endsWith('/compute')) { computations += 1; return computations === 1 ? response(computed) : pending.promise; }
    return response(baseRead(url));
  }));
  render(wrap(<PreparationPanel />)); startProfile(); fireEvent.click(screen.getByText('Save preparation profile')); await screen.findByText('draft · v1', { selector: 'p' });
  fireEvent.change(screen.getByLabelText('Formula 1 allowance 1 mm'), { target: { value: '25' } }); fireEvent.change(screen.getByLabelText('Preparation subject exact revision ID'), { target: { value: 'cable-rev' } }); fireEvent.change(screen.getByLabelText('Application 1 profile exact revision ID'), { target: { value: 'profile-rev' } }); fireEvent.click(screen.getByText('Compute preparation cuts')); await screen.findByText(byContent(/1035 mm/));
  fireEvent.click(screen.getByText('Refresh computed cut access')); await waitFor(() => expect(computations).toBe(2)); fireEvent.change(screen.getByLabelText('Requested units'), { target: { value: '3' } }); expect(screen.queryByText(byContent(/1035 mm/))).toBeNull(); expect((screen.getByLabelText('Formula 1 allowance 1 mm') as HTMLInputElement).value).toBe('25');
  await act(async () => { pending.resolve(response({ error: { message: 'Superseded read source denied.' } }, 403)); });
  await screen.findByText(/Preparation source access must be rechecked/); expect(screen.queryByLabelText('Formula 1 allowance 1 mm')).toBeNull(); expect(screen.queryByText('Apply exact profiles to frozen cable or harness')).toBeNull();
});

test.each([
  ['read-only', ['workspace.read'], true, true],
  ['contributor', ['workspace.read', 'item.create'], false, true],
  ['editor', ['workspace.read', 'item.create', 'design.edit'], false, true],
  ['editor with freeze', ['workspace.read', 'item.create', 'design.edit', 'design.freeze'], false, false],
] as const)('%s permissions gate Save preparation profile and Freeze preparation profile', async (_name, permissions, saveOff, freezeOff) => {
  let saved: unknown = profile;
  vi.stubGlobal('fetch', vi.fn(async (url: string, options?: RequestInit) => {
    if (url.endsWith('/operations')) { const cmd = JSON.parse(String(options?.body)); saved = cmd.payload.profile ?? saved; return response({ result: { definition_id: 'profile', draft_id: 'draft', state: 'v1', content: { preparation_profile: saved } } }); }
    return response(baseRead(url));
  }));
  render(wrap(<PermissionsProvider permissions={[...permissions]}><PreparationPanel /></PermissionsProvider>)); startProfile();
  const save = screen.getByRole('button', { name: 'Save preparation profile' }) as HTMLButtonElement;
  expect(save.disabled).toBe(saveOff);
  // A first save creates a workspace item, so it needs item.create.
  expect(save.title).toBe(saveOff ? 'Read-only access: requires Contributor access' : '');
  expect(screen.queryAllByText(/Read-only access: requires Contributor access/).length > 0).toBe(saveOff);
  if (saveOff) { expect(screen.queryByRole('button', { name: 'Freeze preparation profile' })).toBeNull(); return; }
  fireEvent.click(save); await screen.findByText('draft · v1', { selector: 'p' });
  const freeze = screen.getByRole('button', { name: 'Freeze preparation profile' }) as HTMLButtonElement;
  expect(freeze.disabled).toBe(freezeOff);
  expect(freeze.title).toBe(freezeOff ? 'Read-only access: requires Freeze' : '');
});
