import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { ContextSelectionProvider, useContextSelection } from './ContextSelectionProvider';
import { readScene } from './reads';
import { contextScene } from './test-fixtures';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const expected = { definitionId: 'root', revisionId: 'root-r1', sha256: contextScene().sha256 };
const response = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });
function Inspection() {
  const { state, controller } = useContextSelection();
  return <><p>{state.status}</p>{state.scene && <><p>Exact scene {state.scene.snapshot_id}</p><button onClick={() => controller.selectOccurrence({ snapshot_id: state.scene!.snapshot_id, path: ['right', 'board'] })}>Pick right</button></>}{state.selection?.kind === 'occurrence' && <p>Selected {state.selection.address.path.join('/')}</p>}</>;
}
const show = (active: boolean) => <ContextSelectionProvider active={active} expectedRoot={expected} scope={{ principal_key: 'actor', project_id: 'library', snapshot_id: 'root-snapshot' }}><Inspection /></ContextSelectionProvider>;

test('selected exact root avoids collection listing and rejects a mismatched response', async () => {
  const scene = contextScene(); const fetcher = vi.fn(async (_url: string) => response(scene)); vi.stubGlobal('fetch', fetcher);
  expect(await readScene('root-snapshot', expected)).toEqual(scene);
  expect(fetcher.mock.calls).toHaveLength(1);
  expect(fetcher.mock.calls[0]?.[0]).toBe('/api/v0/shared-scenes/snapshots/root-snapshot');
  for (const altered of [{ ...scene, snapshot_id: 'other' }, { ...scene, sha256: 'other' }, { ...scene, root: { ...scene.root, revision_id: 'other' } }, { ...scene, root: { ...scene.root, definition_id: 'other' } }]) {
    fetcher.mockResolvedValueOnce(response(altered));
    await expect(readScene('root-snapshot', expected)).rejects.toThrow('selected exact device state');
  }
});

test('hidden scope withdraws retained selection, ignores a held read, and reauthorizes on resume', async () => {
  let finish: (value: Response) => void = () => {}; const held = new Promise<Response>(resolve => { finish = resolve; });
  const fetcher = vi.fn(async (_url: string) => response(contextScene())); vi.stubGlobal('fetch', fetcher);
  const view = render(show(true)); await screen.findByText('ready'); fireEvent.click(screen.getByText('Pick right'));
  expect(screen.getByText('Selected right/board')).toBeTruthy();
  fetcher.mockReturnValueOnce(held); fireEvent(window, new Event('focus'));
  await screen.findByText('checking'); view.rerender(show(false));
  await act(async () => { finish(response(contextScene())); await held; });
  expect(screen.queryByText(/Exact scene/)).toBeNull(); expect(screen.queryByText(/Selected right/)).toBeNull();
  const reads = fetcher.mock.calls.length; fireEvent(window, new Event('focus')); expect(fetcher.mock.calls).toHaveLength(reads);
  fetcher.mockResolvedValueOnce(response({ error: { message: 'Current source denied' } }, 403)); view.rerender(show(true));
  await screen.findByText('unavailable'); expect(screen.queryByText(/Exact scene/)).toBeNull();
  await waitFor(() => expect(fetcher.mock.calls.length).toBe(reads + 1));
});

test('record retention keeps section buffers while changing exact snapshots clears selection and fences held old reads', async () => {
  let finish: (value: Response) => void = () => {}; const held = new Promise<Response>(resolve => { finish = resolve; });
  const old = contextScene(), next = structuredClone(old); next.snapshot_id = 'next-snapshot'; next.root.revision_id = 'root-r2'; next.sha256 = 'c'.repeat(64); next.root.snapshot_sha256 = next.sha256;
  next.nodes.forEach(node => { node.address.snapshot_id = next.snapshot_id; node.features.forEach(feature => { feature.address.snapshot_id = next.snapshot_id; }); });
  const fetcher = vi.fn(async (path: string) => response(path.endsWith('/next-snapshot') ? next : old)); vi.stubGlobal('fetch', fetcher);
  const tree = (snapshot: string, actor = 'actor') => <ContextSelectionProvider recordKey="same-device" scope={{ principal_key: actor, project_id: 'library', snapshot_id: snapshot }} expectedRoot={snapshot === old.snapshot_id ? expected : { ...expected, revisionId: 'root-r2', sha256: next.sha256 }}><input aria-label="Secondary record buffer" defaultValue="" /><Inspection /></ContextSelectionProvider>;
  const view = render(tree(old.snapshot_id)); await screen.findByText('ready'); fireEvent.click(screen.getByText('Pick right')); fireEvent.change(screen.getByLabelText('Secondary record buffer'), { target: { value: 'Retained secondary declaration' } });
  fetcher.mockReturnValueOnce(held); fireEvent(window, new Event('focus')); await screen.findByText('checking'); view.rerender(tree(next.snapshot_id));
  await screen.findByText('Exact scene next-snapshot'); expect(screen.queryByText('Selected right/board')).toBeNull(); expect((screen.getByLabelText('Secondary record buffer') as HTMLInputElement).value).toBe('Retained secondary declaration');
  await act(async () => { finish(response(old)); await held; }); expect(screen.queryByText('Exact scene root-snapshot')).toBeNull();
  view.rerender(tree(next.snapshot_id, 'different-actor')); await screen.findByText('ready'); expect((screen.getByLabelText('Secondary record buffer') as HTMLInputElement).value).toBe('');
});
