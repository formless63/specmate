/** Independent contextual adapter tests. DOM/viewport callbacks do not qualify native rendering. */
import { MantineProvider } from '@mantine/core';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useEffect } from 'react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { ContextualInspectionWorkspace } from './ContextualInspectionWorkspace';
import { contextBom, contextScene } from './test-fixtures';
import { readBom, validBomContext } from './reads';
import { SelectionController } from './selection';

const lifecycle = vi.hoisted(() => ({ mounts: 0, disposals: 0 }));
vi.mock('../shared-scene/SceneViewport', () => ({ default: ({ selected }: { selected: { path: string[] } | null }) => {
  useEffect(() => { lifecycle.mounts += 1; return () => { lifecycle.disposals += 1; }; }, []);
  return <div>Peer viewport context: {selected?.path.join('/') ?? 'None'}</div>;
} }));
const response = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });
const choices = { assemblies: [{ snapshot_id: 'root-snapshot', revision_id: 'root-r1', name: 'Synthetic repeated root', number: 1 }], window: 'latest_50_frozen_revisions' };
const definitions = [{ definition_id: 'root' }];
const show = (principal = 'principal-a') => <MantineProvider><ContextualInspectionWorkspace projectId="project-a" principalKey={principal} /></MantineProvider>;
beforeEach(() => { lifecycle.mounts = 0; lifecycle.disposals = 0; vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} }); Element.prototype.scrollIntoView = vi.fn(); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
function api() {
  const scene = contextScene(), bom = contextBom();
  const fetcher = vi.fn(async (url: string) => response(url.endsWith('/definitions') ? definitions : url.includes('/bom/') ? bom.inspection : url.includes('/revisions/') ? bom.root : url.includes('/snapshots/') ? scene : choices));
  vi.stubGlobal('fetch', fetcher); return { fetcher, scene, bom };
}
async function open() {
  await waitFor(() => expect((screen.getByRole('button', { name: 'Refresh contextual scene choices' }) as HTMLButtonElement).getAttribute('data-loading')).not.toBe('true'));
  fireEvent.change(screen.getByLabelText('Exact contextual root snapshot ID'), { target: { value: 'root-snapshot' } });
  fireEvent.click(screen.getByRole('button', { name: 'Open contextual root' }));
  await screen.findByRole('button', { name: 'Tree right/board · J1' });
  fireEvent.click(screen.getByRole('button', { name: 'Tree right/board · J1' }));
}
const shared = () => within(screen.getByRole('region', { name: 'Shared contextual selection' }));
const tab = (name: string) => fireEvent.click(screen.getByRole('tab', { name }));

 test('held project authority refresh hides connected source data and preserves exact intent only after fresh root success', async () => {
  const { fetcher, scene } = api(); render(show()); await open();
  tab('Context board'); fireEvent.click(screen.getByRole('button', { name: 'Board marker component:one' }));
  let complete: (value: Response) => void = () => {};
  const held = new Promise<Response>(resolve => { complete = resolve; });
  fetcher.mockImplementation(async (url: string) => url.endsWith('/projects/project-a') ? held : response(url.endsWith('/definitions') ? definitions : scene));
  fireEvent.click(screen.getByRole('button', { name: 'Refresh contextual scene choices' }));
  expect(screen.queryByRole('region', { name: 'Shared contextual selection' })).toBeNull();
  await act(async () => { complete(response(choices)); await held; });
  await screen.findByRole('region', { name: 'Shared contextual selection' });
  expect(shared().getByText('Selected occurrence: right/board')).toBeTruthy();
  expect(shared().getByText('Stable feature: component:one')).toBeTruthy();
});

for (const change of ['revision', 'purpose'] as const) {
  test(`an otherwise coherent BOM with a different requested ${change} is rejected`, async () => {
    const bom = contextBom();
    if (change === 'revision') bom.inspection.revision_id = 'different-bom-r1';
    else bom.inspection.purpose = 'procurement';
    vi.stubGlobal('fetch', vi.fn(async (url: string) => response(url.includes('/bom/') ? bom.inspection : bom.root)));
    await expect(readBom('bom-r1', 'assembly_contents')).rejects.toThrow(/requested exact BOM/);
  });
}

test('supplemental demand must bind its declared owning context and orderable pin, independently of grouped physical uses', () => {
  const scene = contextScene(), bom = contextBom();
  bom.inspection.purpose = 'consumables';
  bom.inspection.bom.needs = [{ local_id: 'wipe', context_path: ['right','board'], revision_id: 'wipe-r1', purpose: 'consumables', quantity: { status: 'unknown', amount: null, unit: 'ea' }, basis: 'Independent synthetic process need' }];
  bom.inspection.rows = [{ ...bom.inspection.rows[1]!, revision_id: 'wipe-r1', need_id: 'wipe', quantity: { status: 'unknown', amount: null, unit: 'ea' } }];
  expect(validBomContext(scene, bom)).toBe(true);
  const wrongOwner = structuredClone(bom); wrongOwner.inspection.rows[0]!.address.path = ['left','board'];
  const wrongPin = structuredClone(bom); wrongPin.inspection.rows[0]!.revision_id = 'different-wipe-r1';
  const absentNeed = structuredClone(bom); absentNeed.inspection.rows[0]!.need_id = 'invented-need';
  expect(validBomContext(scene, wrongOwner)).toBe(false);
  expect(validBomContext(scene, wrongPin)).toBe(false);
  expect(validBomContext(scene, absentNeed)).toBe(false);
});

test('duplicate stable feature addresses cannot ambiguously enter contextual selection', () => {
  const controller = new SelectionController({ project_id:'project-a', principal_key:'principal-a', snapshot_id:'root-snapshot' });
  const scene = contextScene();
  scene.nodes[1]!.features.push({ ...structuredClone(scene.nodes[1]!.features[0]!), label: 'Contradictory repeated identity' });
  expect(controller.accept(controller.beginRead(), scene)).toBe(false);
  expect(controller.getSnapshot().scene).toBeNull();
});

test('actual adapter disposal follows principal changes and newer root denial without retaining a viewport', async () => {
  const { fetcher } = api(); const view = render(show()); await open();
  tab('Context scene'); fireEvent.click(screen.getByRole('button', { name: 'Open connected scene' }));
  await screen.findByText('Peer viewport context: right/board'); expect(lifecycle.mounts).toBe(1);
  view.rerender(show('principal-b'));
  expect(screen.queryByText('Peer viewport context: right/board')).toBeNull(); expect(lifecycle.disposals).toBe(1);
  await open(); tab('Context scene'); fireEvent.click(screen.getByRole('button', { name: 'Open connected scene' }));
  await screen.findByText('Peer viewport context: right/board');
  fetcher.mockImplementation(async () => response({ error: { message: 'Exact source closure denied.' } }, 404));
  fireEvent.click(screen.getByRole('button', { name: 'Refresh all connected view access' }));
  await screen.findByText('Exact source closure denied.'); expect(lifecycle.disposals).toBe(2);
});

test('grouped dimensional needs preserve unknown/fractional rows and select their owning repeated board', async () => {
  const { bom } = api(); bom.inspection.purpose = 'consumables';
  bom.inspection.bom.needs = ['left','right'].map(side => ({ local_id: side+'-wipe', context_path:[side,'board'], revision_id:'wipe-r1', purpose:'consumables',
    quantity: side==='left' ? { status:'unknown', amount:null, unit:'m' } : { status:'known', amount:'0.125', unit:'m' }, basis:'Synthetic declared preparation material' }));
  bom.inspection.rows.forEach((row,index) => { row.revision_id='wipe-r1'; row.need_id=index===0 ? 'left-wipe' : 'right-wipe'; row.quantity=bom.inspection.bom.needs[index]!.quantity; });
  render(show()); await open(); tab('Context board'); fireEvent.click(screen.getByRole('button', { name:'Board marker component:one' }));
  tab('BOM context'); fireEvent.change(screen.getByLabelText('Exact contextual BOM plan revision ID'),{target:{value:'bom-r1'}});
  fireEvent.click(screen.getByRole('combobox', { name:'Contextual BOM purpose' })); fireEvent.click(screen.getByRole('option', { name:'consumables' }));
  fireEvent.click(screen.getByRole('button', { name:'Read exact contextual BOM' }));
  await screen.findByRole('button', { name:'BOM use right/board · need right-wipe context' });
  fireEvent.click(screen.getByLabelText('Group BOM rows by reusable revision'));
  expect(screen.getByText(/· 2 contextual rows/)).toBeTruthy(); expect(screen.getAllByText('wipe-r1', { selector: 'code' }).length).toBeGreaterThan(0);
  expect(screen.getByText(/Unknown m/)).toBeTruthy(); expect(screen.getByText(/0.125 m/)).toBeTruthy();
  expect(shared().getByText('Stable feature: component:one')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name:'BOM use left/board · need left-wipe context' }));
  expect(shared().getByText('Selected occurrence: left/board')).toBeTruthy();
  expect(shared().getByText('Stable feature: Whole occurrence')).toBeTruthy();
  expect(shared().queryByText(/Independent reusable revision: wipe-r1/)).toBeNull();
});

test('older held BOM denial cannot discard a newer deliberately selected coherent plan', async () => {
  const { fetcher, scene, bom }=api(); let finish: (value:Response)=>void=()=>{};
  const held=new Promise<Response>(resolve=>{finish=resolve;});
  const newer=structuredClone(bom); newer.inspection.revision_id='bom-r2';
  fetcher.mockImplementation(async(url:string)=>url.includes('/bom/revisions/bom-r1') ? held : response(url.endsWith('/definitions') ? definitions : url.includes('/bom/') ? newer.inspection : url.includes('/revisions/') ? newer.root : url.includes('/snapshots/') ? scene : choices));
  render(show()); await open(); tab('BOM context');
  fireEvent.change(screen.getByLabelText('Exact contextual BOM plan revision ID'),{target:{value:'bom-r1'}}); fireEvent.click(screen.getByRole('button',{name:'Read exact contextual BOM'}));
  fireEvent.change(screen.getByLabelText('Exact contextual BOM plan revision ID'),{target:{value:'bom-r2'}}); fireEvent.click(screen.getByRole('button',{name:'Read exact contextual BOM'}));
  await screen.findAllByText('bom-r2', { selector: 'code' });
  await act(async()=>{finish(response({error:{message:'Older plan source denied.'}},404));await held;});
  expect(screen.queryByText('Older plan source denied.')).toBeNull();
  expect(screen.getAllByText('bom-r2', { selector: 'code' }).length).toBeGreaterThan(0);
  expect(shared().getByText('Selected occurrence: right/board')).toBeTruthy();
});
