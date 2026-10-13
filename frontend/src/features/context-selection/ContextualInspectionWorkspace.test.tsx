import { MantineProvider } from '@mantine/core';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { StrictMode } from 'react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { ContextualInspectionWorkspace } from './ContextualInspectionWorkspace';
import { contextBom, contextScene } from './test-fixtures';

// This synthetic viewport callback tests the adapter; actual WebGL remains its own checkpoint.
vi.mock('../shared-scene/SceneViewport', () => ({ default: ({ selected, onSelect, scene }: { selected: { path: string[] } | null; onSelect: (address: object) => void; scene: { snapshot_id: string } }) => <div>
  <p>Viewport containing occurrence: {selected?.path.join('/') ?? 'None'}</p>
  <button onClick={() => onSelect({ snapshot_id: scene.snapshot_id, path: ['right', 'board'] })}>Viewport pick right board</button>
</div> }));
const response = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });
const definitions = [{ definition_id: 'root' }];
const choices = { assemblies: [{ snapshot_id: 'root-snapshot', revision_id: 'root-r1', name: 'Synthetic root', number: 1 }], window: 'latest_50_frozen_revisions' };
beforeEach(() => { vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} }); Element.prototype.scrollIntoView = vi.fn(); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
const show = (projectId = 'project-one', principalKey = 'actor-one') => <MantineProvider><ContextualInspectionWorkspace projectId={projectId} principalKey={principalKey} /></MantineProvider>;
const region = (label: string) => within(screen.getByRole('region', { name: label }));
const selected = () => region('Shared contextual selection');
function installApi() {
  const scene = contextScene(), bom = contextBom();
  const fetcher = vi.fn(async (url: string, _init?: RequestInit) => response(url.endsWith('/definitions') ? definitions : url.includes('/bom/revisions/') ? bom.inspection : url.includes('/revisions/root-r1') ? bom.root : url.includes('/snapshots/') ? scene : choices));
  vi.stubGlobal('fetch', fetcher); return { scene, bom, fetcher };
}
async function open() {
  fireEvent.change(screen.getByLabelText('Exact contextual root snapshot ID'), { target: { value: 'root-snapshot' } });
  fireEvent.click(screen.getByRole('button', { name: 'Open contextual root' }));
  await screen.findByRole('button', { name: 'Tree right/board · J1' });
}
function tab(name: string) { fireEvent.click(screen.getByRole('tab', { name })); }

test('second repeated board/native feature stays selected through board, cable, schematic, scene, inspector and grouped BOM views', async () => {
  const { scene, fetcher } = installApi(), before = structuredClone(scene);
  render(show()); await open(); fireEvent.click(screen.getByRole('button', { name: 'Tree right/board · J1' }));
  tab('Context board'); expect(region('Context board').getByRole('button', { name: 'Board right/board · J1' }).getAttribute('aria-pressed')).toBe('true');
  expect(region('Context board').getByRole('button', { name: 'Board left/board · J1' }).getAttribute('aria-pressed')).toBe('false');
  fireEvent.click(region('Context board').getByRole('button', { name: 'Board marker component:one' }));
  expect(selected().getByText('Stable feature: component:one')).toBeTruthy();
  fireEvent.click(screen.getByRole('combobox', { name: 'Board feature display' })); fireEvent.click(screen.getByRole('option', { name: 'Native pads' }));
  expect(region('Context board').getByText(/outside this board display filter/)).toBeTruthy();
  expect(selected().getByText('Stable feature: component:one')).toBeTruthy();
  tab('Context cable'); expect(region('Context cable').getByText(/right-declared-link/)).toBeTruthy(); expect(region('Context cable').queryByText(/left-declared-link/)).toBeNull();
  expect(selected().getByText('Selected occurrence: right/board')).toBeTruthy();
  tab('Schematic context'); expect(region('Schematic context').getByText('Schematic occurrence context: right/board')).toBeTruthy();
  expect(region('Schematic context').getByText(/Reference\/pin labels do not identify/)).toBeTruthy();
  tab('Context scene'); fireEvent.click(screen.getByRole('button', { name: 'Open connected scene' }));
  await screen.findByText('Viewport containing occurrence: right/board');
  expect(selected().getByText('Stable feature: component:one')).toBeTruthy();
  expect(region('Context scene').getByText(/containing occurrence illustration is highlighted/)).toBeTruthy();
  tab('Context inspector'); expect(region('Context inspector').getByText('Inspector occurrence: right/board')).toBeTruthy();
  expect(region('Context inspector').getByText('Firmware for this use: firmware-right')).toBeTruthy();
  expect(region('Context inspector').getByText('Inspector feature: component:one · native_component')).toBeTruthy();
  tab('BOM context'); fireEvent.change(screen.getByLabelText('Exact contextual BOM plan revision ID'), { target: { value: 'bom-r1' } });
  fireEvent.click(screen.getByRole('button', { name: 'Read exact contextual BOM' }));
  await screen.findByRole('button', { name: 'BOM use right/board' });
  fireEvent.click(screen.getByLabelText('Group BOM rows by reusable revision'));
  expect(region('BOM context').getByText('board-r1 · 2 contextual rows')).toBeTruthy();
  expect(region('BOM context').getByRole('button', { name: 'BOM use right/board' }).getAttribute('aria-pressed')).toBe('true');
  expect(region('BOM context').getByRole('button', { name: 'BOM use left/board' }).getAttribute('aria-pressed')).toBe('false');
  expect(selected().getByText('Stable feature: component:one')).toBeTruthy();
  fireEvent.click(region('BOM context').getByRole('button', { name: 'BOM use left/board' }));
  expect(selected().getByText('Selected occurrence: left/board')).toBeTruthy();
  fireEvent.click(region('BOM context').getByRole('button', { name: 'BOM use right/board' }));
  expect(selected().getByText('Selected occurrence: right/board')).toBeTruthy();
  fireEvent.change(screen.getByLabelText('Filter contextual BOM rows'), { target: { value: 'left' } });
  expect(region('BOM context').getByText(/selection is retained/)).toBeTruthy();
  tab('Context tree'); fireEvent.change(screen.getByLabelText('Filter contextual tree'), { target: { value: 'left' } });
  expect(region('Context tree').getByText(/hidden by this tree filter/)).toBeTruthy();
  expect(selected().getByText('Selected occurrence: right/board')).toBeTruthy(); expect(scene).toEqual(before);
  expect(fetcher.mock.calls.every(([, init]) => !init || !(init as RequestInit).method)).toBe(true);
});

test('explicit cable endpoint and viewport callbacks update all views without label-based board correspondence', async () => {
  installApi(); render(show()); await open(); tab('Context cable');
  fireEvent.click(screen.getByRole('button', { name: 'Cable right/cable · J1' })); fireEvent.click(screen.getByRole('button', { name: 'Select feature endpoint:a · U1' }));
  expect(selected().getByText('Selected occurrence: right/cable')).toBeTruthy();
  tab('Context board'); expect(region('Context board').getByText(/no native board view/)).toBeTruthy(); expect(selected().getByText('Stable feature: endpoint:a')).toBeTruthy();
  tab('Context scene'); fireEvent.click(screen.getByRole('button', { name: 'Open connected scene' })); fireEvent.click(await screen.findByRole('button', { name: 'Viewport pick right board' }));
  expect(selected().getByText('Selected occurrence: right/board')).toBeTruthy(); expect(selected().getByText('Stable feature: Whole occurrence')).toBeTruthy();
  tab('Context inspector'); fireEvent.click(screen.getByRole('button', { name: 'Select reusable revision independently' }));
  expect(selected().getByText(/Independent reusable revision: board-r1/)).toBeTruthy();
  expect(region('Context inspector').getByText(/No occurrence inspector is selected/)).toBeTruthy();
});

test('current BOM authority denial clears every connected view and no old scene response can reopen it', async () => {
  const scene = contextScene(); let sceneReads = 0, finishOld: (value: Response) => void = () => {};
  const old = new Promise<Response>(resolve => { finishOld = resolve; });
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url.endsWith('/definitions')) return response(definitions);
    if (url.includes('/bom/')) return response({ error: { message: 'BOM source denied.' } }, 403);
    if (url.includes('/snapshots/')) { sceneReads += 1; return sceneReads === 2 ? old : sceneReads > 2 ? response({ error: { message: 'Scene source denied.' } }, 404) : response(scene); }
    return response(choices);
  }));
  render(show()); await open(); fireEvent.click(screen.getByRole('button', { name: 'Tree right/board · J1' })); tab('BOM context');
  fireEvent.change(screen.getByLabelText('Exact contextual BOM plan revision ID'), { target: { value: 'bom-r1' } }); fireEvent.click(screen.getByRole('button', { name: 'Read exact contextual BOM' }));
  await screen.findByText('BOM source denied.'); expect(screen.queryByRole('region', { name: 'Shared contextual selection' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Refresh all connected view access' })); await waitFor(() => expect(sceneReads).toBe(2));
  fireEvent(window, new Event('focus')); await screen.findByText('Scene source denied.');
  await act(async () => { finishOld(response(scene)); await old; });
  expect(screen.queryByRole('region', { name: 'Shared contextual selection' })).toBeNull(); expect(screen.queryByText(/firmware-right/)).toBeNull();
});

test('wrong-root BOM is rejected without remapping current occurrence or stable feature', async () => {
  const scene = contextScene(), bom = contextBom(); bom.root.snapshot_id = 'another-root';
  vi.stubGlobal('fetch', vi.fn(async (url: string) => response(url.endsWith('/definitions') ? definitions : url.includes('/bom/') ? bom.inspection : url.includes('/revisions/') ? bom.root : url.includes('/snapshots/') ? scene : choices)));
  render(show()); await open(); fireEvent.click(screen.getByRole('button', { name: 'Tree right/board · J1' })); tab('Context board'); fireEvent.click(screen.getByRole('button', { name: 'Board marker component:one' }));
  tab('BOM context'); fireEvent.change(screen.getByLabelText('Exact contextual BOM plan revision ID'), { target: { value: 'bom-r1' } }); fireEvent.click(screen.getByRole('button', { name: 'Read exact contextual BOM' }));
  await screen.findByText(/BOM plan does not pin this exact root/); expect(selected().getByText('Selected occurrence: right/board')).toBeTruthy(); expect(selected().getByText('Stable feature: component:one')).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'BOM use right/board' })).toBeNull();
});

test('project and principal change clears selection and defeats the prior root reply; strict remount is safe', async () => {
  const scene = contextScene(); let complete: (value: Response) => void = () => {};
  const pending = new Promise<Response>(resolve => { complete = resolve; });
  vi.stubGlobal('fetch', vi.fn(async (url: string) => url.includes('/snapshots/') ? pending.then(value => value.clone()) : response(url.endsWith('/definitions') ? definitions : choices)));
  const view = render(<StrictMode>{show()}</StrictMode>);
  fireEvent.change(screen.getByLabelText('Exact contextual root snapshot ID'), { target: { value: 'root-snapshot' } }); fireEvent.click(screen.getByRole('button', { name: 'Open contextual root' }));
  view.rerender(<StrictMode>{show('project-two', 'actor-two')}</StrictMode>);
  await act(async () => { complete(response(scene)); await pending; });
  expect(screen.queryByRole('region', { name: 'Shared contextual selection' })).toBeNull();
  expect((screen.getByLabelText('Exact contextual root snapshot ID') as HTMLInputElement).value).toBe('');
  fireEvent.change(screen.getByLabelText('Exact contextual root snapshot ID'), { target: { value: 'root-snapshot' } }); fireEvent.click(screen.getByRole('button', { name: 'Open contextual root' }));
  await screen.findByRole('button', { name: 'Tree right/board · J1' }); expect(selected().getByText('No contextual occurrence selected.')).toBeTruthy();
});

test('principal change clears an existing selection, and an accessible root from another project is rejected', async () => {
  const { fetcher } = installApi(); const view = render(show()); await open();
  fireEvent.click(screen.getByRole('button', { name: 'Tree right/board · J1' }));
  view.rerender(show('project-one', 'actor-two'));
  expect(screen.queryByRole('region', { name: 'Shared contextual selection' })).toBeNull();
  await open(); expect(selected().getByText('No contextual occurrence selected.')).toBeTruthy();
  fetcher.mockImplementation(async (url: string) => response(url.endsWith('/definitions') ? [{ definition_id: 'different-project-root' }] : url.includes('/snapshots/') ? contextScene() : choices));
  fireEvent.click(screen.getByRole('button', { name: 'Refresh all connected view access' }));
  await screen.findByText('Scene is unavailable in this project context.');
  expect(screen.queryByRole('region', { name: 'Shared contextual selection' })).toBeNull();
});

test('a denied project choice refresh also clears every previously connected view', async () => {
  const { fetcher } = installApi(); render(show()); await open();
  fireEvent.click(screen.getByRole('button', { name: 'Tree right/board · J1' }));
  fetcher.mockImplementation(async () => response({ error: { message: 'Project unavailable.' } }, 404));
  fireEvent.click(screen.getByRole('button', { name: 'Refresh contextual scene choices' }));
  await screen.findByText('Project unavailable.');
  expect(screen.queryByRole('region', { name: 'Shared contextual selection' })).toBeNull();
});
