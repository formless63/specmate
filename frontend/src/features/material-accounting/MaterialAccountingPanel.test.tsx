import { MantineProvider } from '@mantine/core';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { BuildSheetContent } from './BuildSheet';
import { MaterialAccountingPanel } from './MaterialAccountingPanel';
import { emptyPlan, type Plan, type Result } from './api';
import { PermissionsProvider } from '../../lib/permissions';

const wrap = (child: React.ReactNode) => <MantineProvider><QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })}>{child}</QueryClientProvider></MantineProvider>;
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
beforeEach(() => vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} }));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const plan: Plan = { ...emptyPlan(), subject_revision_id: 'subject', quantity: 2, decision: 'make', decision_basis: 'Synthetic make', pieces: [{ section_id: null, installed: { amount_mm: '1000', basis: 'Independent installed declaration', source: null }, cut_basis: 'declaration', profile_revision_id: null, extra_waste: { amount_mm: '5', basis: 'Independent extra loss', source: null }, reconciliation: null }] };
const sheet: Result = { revision_id: 'plan-rev', sha256: 'plan-hash', plan, subject_revision_id: 'subject', subject_sha256: 'subject-hash', quantity: 2, decision: 'make', purchased_subject_quantity: null, unplanned_sections: [], pieces: [{ section_id: null, stock_revision_id: 'stock-rev', stock_sha256: 'stock-hash', segment_ids: [], installed_mm: '1000', installed_total_mm: '2000', cut_mm: '1035', cut_total_mm: '2070', cut_basis: 'preparation_suggestion', declared_cut_mm: '1070', extra_waste_mm: '5', extra_waste_total_mm: '10', cut_minus_installed_mm: '35', procurement_mm: '2080', procurement_status: 'included', preparation: null, reconciliation: null }], consumables: [], end_preparation: null, limitations: ['Cut already includes allowances.'] };

test('sheet separates installed, selected cut, extra waste and procurement without adding allowances twice', () => {
  render(wrap(<BuildSheetContent value={sheet} />));
  expect(screen.getByText('Total: 2000 mm')).toBeTruthy(); expect(screen.getByText('Total: 2070 mm')).toBeTruthy(); expect(screen.getByText('Total: 10 mm')).toBeTruthy(); expect(screen.getByText('2080 mm')).toBeTruthy();
  expect(screen.getByText(/35 mm, unclassified surplus/)).toBeTruthy(); expect(screen.getByText(/Independent extra loss/)).toBeTruthy(); expect(screen.getByText(/Actual retained material and waste not recorded/)).toBeTruthy();
});

test('unknown waste does not hide known installed or cut quantities', () => {
  render(wrap(<BuildSheetContent value={{ ...sheet, pieces: [{ ...sheet.pieces[0]!, extra_waste_mm: null, extra_waste_total_mm: null, procurement_mm: null }] }} />));
  expect(screen.getByText('Total: 2070 mm')).toBeTruthy(); expect(screen.getByText('Total: 2000 mm')).toBeTruthy(); expect(screen.getAllByText('unknown mm').length).toBeGreaterThan(0);
});

test('save and freeze preserve independent unsaved observations and exact editing token', async () => {
  const commands: { operation: string; payload: { plan: Plan }; expected_state?: string }[] = [];
  let saved = emptyPlan();
  vi.stubGlobal('fetch', vi.fn(async (url: string, options?: RequestInit) => {
    if (url.endsWith('/operations')) { const cmd = JSON.parse(String(options?.body)); commands.push(cmd); if (cmd.payload.plan) saved = structuredClone(cmd.payload.plan); const draft = { definition_id: 'definition', draft_id: 'draft', state: 'v1', content: { material_plan: saved } }; return response({ result: cmd.operation === 'material_plan.freeze' ? { revision_id: 'plan-rev', draft: { ...draft, state: 'v2' } } : draft }); }
    if (url.includes('material-accounting/revisions')) return response(sheet);
    if (url.includes('catalog/definitions')) return response({ drafts: [], revisions: [] });
    return response([]);
  }));
  render(wrap(<MaterialAccountingPanel projectId="project" />));
  fireEvent.change(screen.getByLabelText('Material plan name'), { target: { value: 'Synthetic material sheet' } });
  fireEvent.change(screen.getByLabelText('Material subject exact revision ID'), { target: { value: 'subject' } });
  fireEvent.click(screen.getByText('Add physical material piece'));
  fireEvent.change(screen.getByLabelText('Piece 1 installed material mm per piece'), { target: { value: '1000' } });
  fireEvent.change(screen.getByLabelText('Piece 1 extra waste beyond cut mm per piece'), { target: { value: '0' } });
  fireEvent.click(screen.getByText('Save material plan')); await screen.findByText('draft · v1');
  fireEvent.change(screen.getByLabelText('Piece 1 installed material mm per piece'), { target: { value: '999' } });
  fireEvent.click(screen.getByText('Freeze saved material plan')); await screen.findAllByText('plan-rev', { selector: 'code' });
  expect(commands.at(-1)).toMatchObject({ operation: 'material_plan.freeze', expected_state: 'v1' });
  expect(commands[0]!.payload.plan.pieces[0]!.extra_waste.amount_mm).toBe('0');
  expect((screen.getByLabelText('Piece 1 installed material mm per piece') as HTMLInputElement).value).toBe('999');
  await screen.findByText('draft · v2');
});

test('source denial hides retained evidence and restores unsaved state without adopting new server token', async () => {
  let denied = false; let restored = false; const commands: { expected_state?: string; operation: string }[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, options?: RequestInit) => {
    if (url.endsWith('/material-accounting/authority')) return denied ? response({ error: { message: 'Evidence still hidden.' } }, 404) : response({ authorized: true });
    if (url.endsWith('/operations')) { const cmd = JSON.parse(String(options?.body)); commands.push(cmd); if (denied) return response({ error: { message: 'Source revoked.' } }, 403); if (restored) return response({ error: { message: 'Concurrent edit.' } }, 409); return response({ result: { definition_id: 'definition', draft_id: 'draft', state: 'original-token', content: { material_plan: plan } } }); }
    if (url.includes('/drafts/')) return response({ definition_id: 'definition', draft_id: 'draft', state: 'new-server-token', content: { material_plan: plan } });
    if (url.includes('catalog/definitions')) return response({ drafts: [], revisions: [] });
    return response([]);
  }));
  render(wrap(<MaterialAccountingPanel projectId="project" />));
  fireEvent.change(screen.getByLabelText('Material plan name'), { target: { value: 'Synthetic material sheet' } }); fireEvent.change(screen.getByLabelText('Material subject exact revision ID'), { target: { value: 'subject' } }); fireEvent.click(screen.getByText('Add physical material piece'));
  fireEvent.change(screen.getByLabelText('Piece 1 installed material mm per piece'), { target: { value: '1000.000001' } }); fireEvent.click(screen.getByText('Save material plan')); await screen.findByText('draft · original-token');
  denied = true; fireEvent.click(screen.getByText('Save material plan')); await screen.findByText('Source revoked.'); expect(screen.queryByLabelText('Piece 1 installed material mm per piece')).toBeNull();
  fireEvent.click(screen.getByText('Refresh material accounting access')); await screen.findByText('Evidence still hidden.');
  denied = false; restored = true; await act(async () => { fireEvent.click(screen.getByText('Refresh material accounting access')); }); await screen.findByLabelText('Piece 1 installed material mm per piece');
  expect((screen.getByLabelText('Piece 1 installed material mm per piece') as HTMLInputElement).value).toBe('1000.000001');
  fireEvent.click(screen.getByText('Save material plan')); await screen.findByText('Concurrent edit.'); expect(commands.at(-1)?.expected_state).toBe('original-token');
});

function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
function start() { fireEvent.change(screen.getByLabelText('Material plan name'), { target: { value: 'Synthetic material sheet' } }); fireEvent.change(screen.getByLabelText('Material subject exact revision ID'), { target: { value: 'subject' } }); }
async function select(label: string, option: string) {
  const field = await screen.findByRole('combobox', { name: label }); fireEvent.focus(field); fireEvent.keyDown(field, { key: 'ArrowDown' });
  fireEvent.click(await within(screen.getByRole('listbox', { name: label, hidden: true })).findByText(option));
}
const draft = { definition_id: 'definition', draft_id: 'draft', state: 'original-token', content: { material_plan: plan } };
const identities = { drafts: [{ draft_id: 'draft', state: 'original-token' }], revisions: [{ revision_id: 'first', number: 1 }, { revision_id: 'second', number: 2 }] };
function readBody(url: string) {
  if (url.includes('/drafts/')) return draft;
  if (url.includes('catalog/definitions')) return identities;
  if (url.includes('/revisions/')) return sheet;
  return [{ definition_id: 'definition', kind: 'material_plan', name: 'Synthetic sheet identity' }];
}

test('a denied malformed reference can be discarded from the authority gate', async () => {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => url.endsWith('/operations') ? response({ error: { message: 'Reference unavailable.' } }, 404) : response([])));
  render(wrap(<MaterialAccountingPanel projectId="project" />)); start(); fireEvent.click(screen.getByText('Save material plan')); await screen.findByText('Reference unavailable.');
  expect(screen.queryByLabelText('Material subject exact revision ID')).toBeNull(); fireEvent.click(screen.getByText('Discard unsaved material values and start new'));
  expect((await screen.findByLabelText('Material subject exact revision ID') as HTMLInputElement).value).toBe('');
});

test('late denied mutation from a replaced editor cannot hide the new editor', async () => {
  const pending = deferred<Response>();
  vi.stubGlobal('fetch', vi.fn(async (url: string) => url.endsWith('/operations') ? pending.promise : response([])));
  render(wrap(<MaterialAccountingPanel projectId="project" />)); start(); fireEvent.click(screen.getByText('Save material plan')); fireEvent.click(screen.getByText('Discard unsaved material values and start new'));
  fireEvent.change(screen.getByLabelText('Material subject exact revision ID'), { target: { value: 'new-subject' } });
  await act(async () => { pending.resolve(response({ error: { message: 'Old editor source revoked.' } }, 403)); });
  expect((screen.getByLabelText('Material subject exact revision ID') as HTMLInputElement).value).toBe('new-subject'); expect(screen.queryByText('Refresh material accounting access')).toBeNull();
});

test('history browsing retains the same editor and cannot suppress its late denial', async () => {
  const pending = deferred<Response>(); let writes = 0;
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url.endsWith('/operations')) return ++writes === 1 ? response({ result: draft }) : pending.promise;
    if (url.includes('catalog/definitions')) return response({ ...identities, revisions: Array.from({ length: 50 }, (_, i) => ({ revision_id: `revision-${i}`, number: i + 1 })) });
    return response(readBody(url));
  }));
  render(wrap(<MaterialAccountingPanel projectId="project" />)); start(); fireEvent.click(screen.getByText('Save material plan')); await screen.findByText('draft · original-token');
  await screen.findByText('Later material history'); fireEvent.click(screen.getByText('Save material plan')); fireEvent.click(screen.getByText('Later material history'));
  await act(async () => { pending.resolve(response({ error: { message: 'Same draft source revoked.' } }, 404)); });
  await screen.findByText('Same draft source revoked.'); expect(screen.queryByLabelText('Material subject exact revision ID')).toBeNull(); expect(screen.getByText('Refresh material accounting access')).toBeTruthy();
});

test('recovery reauthorizes selected identity before revealing its cached history', async () => {
  let writes = 0; let identityDenied = false;
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url.endsWith('/material-accounting/authority')) return response({ authorized: true });
    if (url.endsWith('/operations')) { return ++writes === 1 ? response({ result: draft }) : response({ error: { message: 'Mutation source denied.' } }, 403); }
    if (url.includes('catalog/definitions') && identityDenied) return response({ error: { message: 'Selected identity denied.' } }, 404);
    return response(readBody(url));
  }));
  render(wrap(<MaterialAccountingPanel projectId="project" />)); start(); fireEvent.click(screen.getByText('Save material plan')); await screen.findByText('draft · original-token'); await screen.findByRole('combobox', { name: 'Frozen material revision' });
  fireEvent.click(screen.getByText('Save material plan')); await screen.findByText('Mutation source denied.'); identityDenied = true; fireEvent.click(screen.getByText('Refresh material accounting access')); await screen.findByText('Selected identity denied.');
  expect(screen.queryByRole('combobox', { name: 'Frozen material revision' })).toBeNull(); expect(screen.queryByLabelText('Material subject exact revision ID')).toBeNull(); identityDenied = false; fireEvent.click(screen.getByText('Refresh material accounting access')); await screen.findByRole('combobox', { name: 'Frozen material revision' }); expect(screen.getByText('draft · original-token', { selector: 'p' })).toBeTruthy();
});

test.each([false, true])('detached frozen read denial is fenced only by genuine editor replacement=%s', async replacement => {
  const first = deferred<Response>(); let firstStarted = false;
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url.endsWith('/operations')) return response({ result: draft });
    if (url.endsWith('/revisions/first')) { firstStarted = true; return first.promise; }
    return response(readBody(url));
  }));
  render(wrap(<MaterialAccountingPanel projectId="project" />)); start(); fireEvent.click(screen.getByText('Save material plan')); await screen.findByText('draft · original-token');
  await select('Frozen material revision', 'Revision 1'); await waitFor(() => expect(firstStarted).toBe(true));
  if (replacement) fireEvent.click(screen.getByText('Discard unsaved material values and start new'));
  else { await select('Frozen material revision', 'Revision 2'); await screen.findAllByText('plan-rev', { selector: 'code' }); }
  await act(async () => { first.resolve(response({ error: { message: 'Detached source revoked.' } }, 403)); });
  if (replacement) { expect(screen.getByLabelText('Material subject exact revision ID')).toBeTruthy(); expect(screen.queryByText('Refresh material accounting access')).toBeNull(); }
  else { expect(screen.queryByLabelText('Material subject exact revision ID')).toBeNull(); expect(screen.getByText('Refresh material accounting access')).toBeTruthy(); expect(screen.queryAllByText('plan-rev', { selector: 'code' })).toHaveLength(0); }
});

test('a later detached denial keeps recovery closed when an earlier refresh succeeds', async () => {
  const first = deferred<Response>(); const recovery = deferred<Response>(); let writes = 0; let firstStarted = false; let firstReads = 0; let recoveredIdentity = false;
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url.endsWith('/material-accounting/authority')) return recovery.promise;
    if (url.endsWith('/operations')) { return ++writes === 1 ? response({ result: draft }) : response({ error: { message: 'Initial source denied.' } }, 403); }
    if (url.endsWith('/revisions/first')) { firstStarted = true; return ++firstReads === 1 ? first.promise : response(sheet); }
    if (url.includes('catalog/definitions') && firstReads > 1) recoveredIdentity = true;
    return response(readBody(url));
  }));
  render(wrap(<MaterialAccountingPanel projectId="project" />)); start(); fireEvent.click(screen.getByText('Save material plan')); await screen.findByText('draft · original-token'); await select('Frozen material revision', 'Revision 1'); await waitFor(() => expect(firstStarted).toBe(true));
  fireEvent.click(screen.getByText('Save material plan')); await screen.findByText('Initial source denied.'); fireEvent.click(screen.getByText('Refresh material accounting access'));
  await act(async () => { first.resolve(response({ error: { message: 'Later source denied.' } }, 404)); recovery.resolve(response({ result: { authorized: true } })); });
  await waitFor(() => expect(recoveredIdentity).toBe(true));
  expect(screen.queryByLabelText('Material subject exact revision ID')).toBeNull(); expect(screen.getByText('Refresh material accounting access')).toBeTruthy();
});

test('reference-page denial hides retained material and recovery rechecks the selected page without a picked revision', async () => {
  let blocked = true; const pages: string[] = [];
  const references = { drafts: [], revisions: Array.from({ length: 50 }, (_, index) => ({ revision_id: `subject-${index}`, number: index + 1 })) };
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url.endsWith('/material-accounting/authority')) return response({ authorized: true });
    if (url.endsWith('/operations')) return response({ result: draft });
    if (url.includes('catalog/definitions/subject-definition')) {
      pages.push(url);
      return url.endsWith('offset=50') && blocked ? response({ error: { message: 'Subject reference denied.' } }, 404) : response(references);
    }
    if (url.includes('catalog/definitions')) return response(identities);
    if (url.includes('/drafts/')) return response(draft);
    return response([{ definition_id: 'subject-definition', kind: 'cable', name: 'Exact subject identity' }]);
  }));
  render(wrap(<MaterialAccountingPanel projectId="project" />)); start();
  fireEvent.click(screen.getByText('Save material plan')); await screen.findByText('draft · original-token');
  await select('Material subject definition', 'Exact subject identity');
  fireEvent.click(await screen.findByText('Later Material subject revisions'));
  await screen.findByText('Refresh material accounting access');
  expect(screen.queryByLabelText('Material subject exact revision ID')).toBeNull();
  const callsBefore = pages.length;
  fireEvent.click(screen.getByText('Refresh material accounting access'));
  await screen.findByText('Subject reference denied.');
  expect(pages.length).toBeGreaterThan(callsBefore);
  expect(pages.at(-1)).toContain('offset=50');
  expect(screen.queryByLabelText('Material subject exact revision ID')).toBeNull();
  blocked = false;
  fireEvent.click(screen.getByText('Refresh material accounting access'));
  await screen.findByLabelText('Material subject exact revision ID');
  expect((screen.getByLabelText('Material subject exact revision ID') as HTMLInputElement).value).toBe('subject');
  expect((screen.getByRole('combobox', { name: 'Material subject definition' }) as HTMLInputElement).value).toBe('Exact subject identity');
  expect(pages.at(-1)).toContain('offset=50');
});

test.each([false, true])('detached reference denial is fenced only by genuine editor replacement=%s', async replacement => {
  const pending = deferred<Response>(); let requested = false;
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url.includes('catalog/definitions/subject-definition')) { requested = true; return pending.promise; }
    if (url.includes('catalog/definitions')) return response(identities);
    return response([{ definition_id: 'subject-definition', kind: 'cable', name: 'Exact subject identity' }, { definition_id: 'definition', kind: 'material_plan', name: 'Unrelated history choice' }]);
  }));
  render(wrap(<MaterialAccountingPanel projectId="project" />)); start();
  await select('Material subject definition', 'Exact subject identity');
  await waitFor(() => expect(requested).toBe(true));
  if (replacement) fireEvent.click(screen.getByText('Discard unsaved material values and start new'));
  else await select('Existing material plan', 'Unrelated history choice');
  await act(async () => { pending.resolve(response({ error: { message: 'Detached subject denied.' } }, 404)); });
  if (replacement) {
    expect((screen.getByLabelText('Material subject exact revision ID') as HTMLInputElement).value).toBe('');
    expect((screen.getByRole('combobox', { name: 'Material subject definition' }) as HTMLInputElement).value).toBe('');
    expect(screen.queryByText('Refresh material accounting access')).toBeNull();
  } else {
    await screen.findByText('Refresh material accounting access');
    expect(screen.queryByLabelText('Material subject exact revision ID')).toBeNull();
  }
});

test.each([
  ['read-only', ['workspace.read'], true, true],
  ['contributor', ['workspace.read', 'item.create'], false, true],
  ['editor', ['workspace.read', 'item.create', 'design.edit'], false, true],
  ['editor with freeze', ['workspace.read', 'item.create', 'design.edit', 'design.freeze'], false, false],
] as const)('%s permissions gate Save material plan and Freeze saved material plan', async (_name, permissions, saveOff, freezeOff) => {
  let saved = emptyPlan();
  vi.stubGlobal('fetch', vi.fn(async (url: string, options?: RequestInit) => {
    if (url.endsWith('/operations')) { const cmd = JSON.parse(String(options?.body)); if (cmd.payload.plan) saved = structuredClone(cmd.payload.plan); return response({ result: { definition_id: 'definition', draft_id: 'draft', state: 'v1', content: { material_plan: saved } } }); }
    if (url.includes('catalog/definitions')) return response({ drafts: [], revisions: [] });
    return response([]);
  }));
  render(wrap(<PermissionsProvider permissions={[...permissions]}><MaterialAccountingPanel projectId="project" /></PermissionsProvider>));
  fireEvent.change(screen.getByLabelText('Material plan name'), { target: { value: 'Synthetic material sheet' } });
  fireEvent.change(screen.getByLabelText('Material subject exact revision ID'), { target: { value: 'subject' } });
  const save = screen.getByRole('button', { name: 'Save material plan' }) as HTMLButtonElement;
  const freeze = screen.getByRole('button', { name: 'Freeze saved material plan' }) as HTMLButtonElement;
  expect(save.disabled).toBe(saveOff);
  // A first save creates a workspace item, so it needs item.create.
  expect(save.title).toBe(saveOff ? 'Read-only access: requires Contributor access' : '');
  expect(screen.queryAllByText(/Read-only access: requires Contributor access/).length > 0).toBe(saveOff);
  if (saveOff) { expect(freeze.disabled).toBe(true); return; }
  fireEvent.click(save); await screen.findByText('draft · v1');
  expect((screen.getByRole('button', { name: 'Freeze saved material plan' }) as HTMLButtonElement).disabled).toBe(freezeOff);
  expect((screen.getByRole('button', { name: 'Freeze saved material plan' }) as HTMLButtonElement).title).toBe(freezeOff ? 'Read-only access: requires Freeze' : '');
});
