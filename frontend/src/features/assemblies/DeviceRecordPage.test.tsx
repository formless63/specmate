import { MantineProvider } from '@mantine/core';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { PermissionsProvider } from '../../lib/permissions';
import { ProbeProvider, useProbe } from '../probe';
import type { ProbeTarget } from '../navigation/url';
import { contextBom, contextScene } from '../context-selection/test-fixtures';
import { DeviceRecordPage } from './DeviceRecordPage';
import { emptyAssembly } from './useDeviceRecord';
import type { Assembly } from './api';

// Adapter coverage; real WebGL remains a separate checkpoint.
vi.mock('../shared-scene/SceneViewport', () => ({ default: ({ active, scene, selected, onSelect }: { active: boolean; scene: { snapshot_id: string }; selected: { path: string[] } | null; onSelect: (value: object) => void }) => <div><p>Viewport active {String(active)} · {selected?.path.join('/') ?? 'None'}</p><button onClick={() => onSelect({ snapshot_id: scene.snapshot_id, path: ['right', 'board'] })}>Pick second board in scene</button></div> }));
vi.mock('../../components/editor/Documents', () => ({ RootDocuments: () => <p>Exact frozen documents</p> }));
vi.mock('../parts/RevisionModels', async () => {
 const { ApiError } = await import('../workspace/api');
 return { RevisionModels: ({ active, revisionId, onAccessLost }: { active: boolean; revisionId: string; onAccessLost: (failure: unknown) => void }) => active ? <div data-testid="exact-device-model">Model revision {revisionId}<button onClick={() => onAccessLost(new ApiError(403, 'Synthetic model source denied'))}>Withdraw synthetic model source</button></div> : null };
});
const child = '00000000-0000-4000-8000-000000000001';
const original: Assembly = { ...emptyAssembly(), occurrences: [{ local_id: 'left', revision_id: child, display_ref: 'Left board', placement: { status: 'unknown' } }, { local_id: 'right', revision_id: child, display_ref: 'Right board', placement: { status: 'unknown' } }] };
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
beforeEach(() => { vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} unobserve() {} }); Element.prototype.scrollIntoView = vi.fn(); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
function server() {
  let assembly = structuredClone(original); let state = 'draft-v4'; let denied = false; let conflict = false;
  const posts: { operation: string; expected_state: string; payload: { assembly: Assembly } }[] = []; const scene = contextScene();
  vi.stubGlobal('fetch', vi.fn(async (path: string, init?: RequestInit) => {
    if (path.includes('/catalog/revision-labels')) return response({ labels: [{ revision_id: child, readable: !denied }], source_labels: [] });
    if (path.includes('/record?')) { const working = new URL(path, 'http://test').searchParams.get('working') === 'true'; return response({ definition_id: scene.root.definition_id, workspace_id: 'workspace', name: 'Synthetic device', kind: 'assembly', selected: working ? { kind: 'draft', draft_id: 'd1', state, content: { assembly } } : { kind: 'revision', revision_id: scene.root.revision_id, number: 1, snapshot_id: scene.snapshot_id, sha256: scene.sha256, content: { assembly } } }); }
    if (path.includes('/catalog/definitions/')) return response({ definition_id: scene.root.definition_id, name: 'Synthetic device', kind: 'assembly', drafts: [{ draft_id: 'd1', state }], revisions: [{ revision_id: scene.root.revision_id, number: 1 }] });
    if (path.includes('/assemblies/drafts/')) return response({ definition_id: scene.root.definition_id, draft_id: 'd1', state, content: { assembly } });
    if (path.includes('/captured-snapshots/')) { const capture = structuredClone(scene) as unknown as Record<string, unknown>; const { revision_id: _revision, ...root } = scene.root; capture.root = root; capture.basis = { kind: 'captured_draft', draft_id: 'd1', draft_version: Number(state.slice(7)), snapshot_id: scene.snapshot_id, snapshot_sha256: scene.sha256 }; return response(capture); }
    if (path.includes('/shared-scenes/snapshots/')) return response(denied ? { error: { message: 'Scene unavailable' } } : scene, denied ? 403 : 200);
    if (path.includes('/bom/revisions/')) return response(contextBom().inspection);
    if (path.includes('/revisions/root-r1')) return response(contextBom().root);
    if (path.endsWith('/operations')) { const body = JSON.parse(String(init?.body)); if (body.operation === 'assembly.placement_inputs') return response(denied ? { error: { message: 'Mounting source denied' } } : { result: { draft_id: 'd1', state, occurrences: assembly.occurrences.map(row => ({ path: [row.local_id], revision_id: row.revision_id, snapshot_sha256: 'child-hash', name: row.display_ref, kind: 'board', display_ref: row.display_ref, placement: row.placement })) } }, denied ? 403 : 200); posts.push(body); if (conflict) return response({ error: { message: 'Competing device edit' } }, 409); if (body.operation === 'assembly.snapshot') return response({ result: { snapshot_id: scene.snapshot_id, sha256: scene.sha256 } }); assembly = body.payload.assembly; state = 'draft-v5'; return response({ result: { definition_id: scene.root.definition_id, draft_id: 'd1', state, content: { assembly } } }); }
    return response({});
  }));
  return { scene, posts, deny: (value: boolean) => { denied = value; }, conflict: () => { conflict = true; } };
}
function ProbeReadout() { const shared = useProbe(); return <output data-testid="root-probe">{JSON.stringify(shared?.probe)}</output>; }
function setup({ frozen = false, viewer = false, active = true } = {}) {
  const scene = contextScene(); const cache = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  function Harness({ enabled }: { enabled: boolean }) { const [probe, setProbe] = useState<ProbeTarget | null>({ object: scene.root.definition_id, rev: frozen ? 1 : null, path: [] }); return <ProbeProvider probe={probe} onProbe={setProbe}><ProbeReadout /><DeviceRecordPage active={enabled} principalKey="principal" workspaceId="workspace" definitionId={scene.root.definition_id} revisionNumber={frozen ? 1 : null} draftRequested={!frozen} onCreated={vi.fn()} onSelect={vi.fn()} projects={[]} onBack={vi.fn()} onOpenInProject={vi.fn()} /></ProbeProvider>; }
  const tree = (enabled = active) => <MantineProvider env="test"><PermissionsProvider permissions={viewer ? ['workspace.read'] : ['workspace.read', 'item.create', 'design.edit', 'design.freeze']}><QueryClientProvider client={cache}><Harness enabled={enabled} /></QueryClientProvider></PermissionsProvider></MantineProvider>;
  return { ...render(tree()), tree };
}
const tab = (name: string) => fireEvent.click(screen.getByRole('tab', { name }));

test('draft geometry needs explicit Capture and staging an occurrence never saves or freezes', async () => {
  const api = server(); setup(); const capture = await screen.findByRole('button', { name: 'Capture saved assembly' });
  expect(screen.getByText('No saved scene captured.')).toBeTruthy(); expect(api.posts).toHaveLength(0); fireEvent.click(capture);
  await screen.findByText(/Captured draft preview/); expect(api.posts.map(row => row.operation)).toEqual(['assembly.snapshot']);
  fireEvent.click(await screen.findByRole('button', { name: 'Pick second board in scene' })); tab('Tree');
  expect((await screen.findByRole('button', { name: 'right / board · J1' })).getAttribute('aria-pressed')).toBe('true');
  expect(screen.getByTestId('root-probe').textContent).toContain('"right","board"'); expect(screen.getByText('Captured use right / board')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Inspect containing working occurrence' }));
  fireEvent.change(screen.getByLabelText('Display reference for right'), { target: { value: 'Later local declaration' } });
  tab('Scene'); await screen.findByText('Working declaration changed.');
  expect((screen.getByRole('button', { name: 'Capture saved assembly' }) as HTMLButtonElement).disabled).toBe(true); expect(api.posts).toHaveLength(1);
});

test('frozen selection keeps the second repeated use across scene/tree, board features, cable relationships and BOM', async () => {
  const api = server(); setup({ frozen: true }); await screen.findByRole('button', { name: 'Pick second board in scene' });
  fireEvent.click(await screen.findByRole('button', { name: 'Pick second board in scene' })); tab('Tree');
  expect(screen.getByRole('button', { name: 'Tree right/board · J1' }).getAttribute('aria-pressed')).toBe('true');
  expect(screen.getByRole('button', { name: 'Tree left/board · J1' }).getAttribute('aria-pressed')).toBe('false');
  tab('Context'); fireEvent.click(screen.getByText('Selected native board context')); await screen.findByRole('button', { name: 'Board marker component:one' });
  fireEvent.click(screen.getByRole('button', { name: 'Board marker component:one' })); expect(screen.getByTestId('root-probe').textContent).toContain('#component:one');
  fireEvent.click(screen.getByText('Selected cable context')); expect(await screen.findByText(/right-declared-link/)).toBeTruthy();
  fireEvent.click(screen.getByText('Exact frozen BOM context')); fireEvent.change(await screen.findByLabelText('Exact contextual BOM plan revision ID'), { target: { value: 'bom-r1' } }); fireEvent.click(screen.getByRole('button', { name: 'Read exact contextual BOM' }));
  expect((await screen.findByRole('button', { name: 'BOM use right/board' })).getAttribute('aria-pressed')).toBe('true'); expect(api.posts).toHaveLength(0);
});

test('authority withdrawal hides the working form and restores unapplied fields and original CAS', async () => {
  const api = server(); setup(); await screen.findByRole('button', { name: 'Capture saved assembly' }); tab('Tree'); fireEvent.click(screen.getByRole('button', { name: 'Right board' }));
  fireEvent.change(screen.getByLabelText('Display reference for right'), { target: { value: 'Private working buffer' } });
  api.deny(true); fireEvent(window, new Event('focus')); await screen.findByText('Device state unavailable'); expect(screen.queryByRole('textbox', { name: 'Display reference for right' })).toBeNull();
  api.deny(false); fireEvent.click(screen.getByRole('button', { name: 'Refresh device' })); await screen.findByRole('textbox', { name: 'Display reference for right' }); expect((screen.getByLabelText('Display reference for right') as HTMLInputElement).value).toBe('Private working buffer');
  fireEvent.click(screen.getByRole('button', { name: 'Apply right to working tree' })); api.conflict(); fireEvent.click(screen.getByRole('button', { name: 'Save device' })); await screen.findByText('Competing device edit'); expect(api.posts[0]?.expected_state).toBe('draft-v4');
});

test('viewer selects uses while save, capture, freeze and local authoring stay read-only', async () => {
  const api = server(); setup({ viewer: true }); const save = await screen.findByRole('button', { name: 'Save device' }); expect((save as HTMLButtonElement).disabled).toBe(true);
  expect((screen.getByRole('button', { name: 'Capture saved assembly' }) as HTMLButtonElement).disabled).toBe(true); expect((screen.getByRole('button', { name: 'Freeze saved device' }) as HTMLButtonElement).disabled).toBe(true);
  tab('Tree'); fireEvent.click(screen.getByRole('button', { name: 'Right board' })); await waitFor(() => expect((screen.getByLabelText('Display reference for right') as HTMLInputElement).readOnly).toBe(true));
  expect(screen.queryByText('Add exact occurrence')).toBeNull(); expect(api.posts).toHaveLength(0);
});

test('retained scene becomes inactive when the host leaves the device', async () => {
  server(); const view = setup({ frozen: true }); await screen.findByText('Viewport active true · None'); view.rerender(view.tree(false));
  await act(async () => {}); expect(screen.queryByRole('button', { name: 'Pick second board in scene' })).toBeNull(); expect(screen.getByText('Viewport active false · None')).toBeTruthy();
});


test('phone draft keeps Save and Capture in the header and deliberately discloses revision actions', async () => {
  vi.stubGlobal('matchMedia', (query: string) => ({ matches: query.includes('max-width: 48em'), media: query, addEventListener() {}, removeEventListener() {} }));
  server(); setup(); expect(await screen.findByRole('button', { name: 'Capture saved assembly' })).toBeTruthy(); expect(screen.getByRole('button', { name: 'Save device' })).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Freeze saved device' })).toBeNull(); fireEvent.click(screen.getByRole('button', { name: 'Device actions' }));
  expect(await screen.findByRole('menuitem', { name: 'Freeze saved device' })).toBeTruthy(); expect(screen.getByRole('menuitem', { name: 'Reload saved draft (discard local edits)' })).toBeTruthy();
});

test('current Relationships hosts exact mounting choices, stages locally and blocks dirty Freeze', async () => {
 const api=server();setup();await screen.findByRole('button',{name:'Save device'});tab('Relationships');
 const mounted=await screen.findByLabelText('Mounted contextual occurrence');await waitFor(()=>expect(mounted.querySelectorAll('option')).toHaveLength(4));
 fireEvent.change(mounted,{target:{value:'["left"]'}});fireEvent.change(screen.getByLabelText('Supporting contextual occurrence'),{target:{value:'["right"]'}});fireEvent.change(screen.getByLabelText('Mounting declaration local ID'),{target:{value:'mount-left'}});fireEvent.change(screen.getByLabelText('Mounted unverified stable feature ID (optional)'),{target:{value:'hole-a'}});fireEvent.click(screen.getByRole('button',{name:'Add mounting declaration'}));
 expect(api.posts).toHaveLength(0);expect((screen.getByRole('button',{name:'Freeze saved device'}) as HTMLButtonElement).disabled).toBe(true);
 fireEvent.click(screen.getByRole('button',{name:'Save device'}));await waitFor(()=>expect(api.posts).toHaveLength(1));expect(api.posts[0]).toMatchObject({operation:'assembly.update',expected_state:'draft-v4',payload:{assembly:{relationships:[{local_id:'mount-left',kind:'mounting',mounted:{path:['left'],feature_id:'hole-a'},support:{path:['right'],feature_id:null}}]}}});
});
test('viewer Relationships never opens mounting authoring',async()=>{
 const api=server();setup({viewer:true});await screen.findByRole('button',{name:'Save device'});tab('Relationships');expect(screen.queryByLabelText('Mounting declaration local ID')).toBeNull();expect(api.posts).toHaveLength(0);
});

test('current mounting source denial conceals retained fields and restores local intent without advancing CAS',async()=>{
 const api=server();setup();await screen.findByRole('button',{name:'Save device'});tab('Relationships');const local=await screen.findByLabelText('Mounting declaration local ID');fireEvent.change(local,{target:{value:'private-retained-mount'}});api.deny(true);fireEvent.click(screen.getByRole('button',{name:'Refresh mounting choices'}));await screen.findByText(/Selected drawings and facts are hidden/);expect(screen.queryByLabelText('Mounting declaration local ID')).toBeNull();api.deny(false);fireEvent.click(screen.getByRole('button',{name:'Refresh device'}));await waitFor(()=>expect((screen.getByLabelText('Mounting declaration local ID') as HTMLInputElement).value).toBe('private-retained-mount'));expect(api.posts).toHaveLength(0);
});


test('frozen Model is lazy, exact and inactive on leaving the view or record', async () => {
 const api=server();const page=setup({frozen:true,viewer:true});await screen.findByText('Viewport active true · None');
 expect(screen.queryByTestId('exact-device-model')).toBeNull();tab('Model');
 expect((await screen.findByTestId('exact-device-model')).textContent).toContain(api.scene.root.revision_id);
 expect(screen.getByText(/Source illustration only/)).toBeTruthy();tab('Tree');expect(screen.queryByTestId('exact-device-model')).toBeNull();
 tab('Model');await screen.findByTestId('exact-device-model');page.rerender(page.tree(false));await waitFor(()=>expect(screen.queryByTestId('exact-device-model')).toBeNull());expect(api.posts).toHaveLength(0);
});
test('Device model source denial withdraws retained preview until explicit refresh; drafts expose no model', async () => {
 const api=server();setup({frozen:true});await screen.findByText('Viewport active true · None');tab('Model');await screen.findByTestId('exact-device-model');
 fireEvent.click(screen.getByRole('button',{name:'Withdraw synthetic model source'}));await screen.findByText('Device state unavailable');expect(screen.queryByTestId('exact-device-model')).toBeNull();
 fireEvent.click(screen.getByRole('button',{name:'Refresh device'}));await screen.findByTestId('exact-device-model');expect(api.posts).toHaveLength(0);
 cleanup();server();setup();await screen.findByRole('button',{name:'Save device'});expect(screen.queryByRole('tab',{name:'Model'})).toBeNull();
});
