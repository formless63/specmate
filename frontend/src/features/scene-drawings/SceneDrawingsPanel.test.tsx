import { MantineProvider } from '@mantine/core';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { SceneDrawingsPanel } from './SceneDrawingsPanel';
import { closedDisplay } from '../shared-scene/display';
import { syntheticScene } from '../shared-scene/test-fixtures';
import { createDrawing, drawingBytes, readDrawing, type Detail, type Options } from './api';
vi.mock('./api', async original => ({ ...(await original<typeof import('./api')>()), createDrawing: vi.fn(), readDrawing: vi.fn(), drawingBytes: vi.fn() }));
const options = (): Options => ({ ...closedDisplay(), view: 'top', opening: null });
const output = (settings = options()): Detail => ({
  drawing_id: 'drawing-one', project_id: 'project-one', snapshot_id: 'root-snapshot', renderer_version: 'scene-line-svg-v1', purpose: 'internal_inspection', options: settings,
  svg_sha256: 'svg-hash', manifest_sha256: 'manifest-hash', svg_bytes: 321, manifest_bytes: 456, created_at: '2026-01-01T00:00:00Z',
  limitations: ['Native mechanical geometry unavailable; fit not evaluated.'], qualification: syntheticScene().qualification,
  manifest: { scene_snapshot_id: 'root-snapshot', scene_snapshot_sha256: syntheticScene().sha256, root: syntheticScene().root, options: settings, source_rights: 'Restricted synthetic rights; no blanket redistribution.', nodes: syntheticScene().nodes, geometry_provenance: syntheticScene().geometry, unresolved: [{ address: { path: ['unknown', 'board'] }, reason: 'Canonical placement unknown; no position assigned.' }], outputs: [{ path: 'drawing.svg', size: 321, sha256: 'svg-hash' }] },
});
let revoke = vi.fn<(url: string) => void>(), objectUrl = vi.fn<(blob: Blob | MediaSource) => string>();
beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} }); Element.prototype.scrollIntoView = vi.fn();
  objectUrl = vi.fn((_blob: Blob | MediaSource) => 'blob:owned-svg'); revoke = vi.fn((_url: string) => {}); URL.createObjectURL = objectUrl; URL.revokeObjectURL = revoke;
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(syntheticScene()))));
  vi.mocked(createDrawing).mockImplementation(async (_project, _snapshot, settings) => output(settings));
  vi.mocked(readDrawing).mockResolvedValue(output()); vi.mocked(drawingBytes).mockResolvedValue(new Blob(['<svg/>'], { type: 'image/svg+xml' }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.resetAllMocks(); });
const panel = (projectId = 'project-one', principalKey = 'actor-one', active = true) => <MantineProvider env="test" theme={{ respectReducedMotion: true }}><SceneDrawingsPanel projectId={projectId} principalKey={principalKey} active={active} /></MantineProvider>;
async function inspect() {
  fireEvent.change(screen.getByLabelText('Drawing frozen scene snapshot ID'), { target: { value: 'root-snapshot' } });
  fireEvent.click(screen.getByRole('button', { name: 'Inspect drawing scene' })); await screen.findByRole('button', { name: 'right/board · known' });
}
async function generate(failure = false) {
  fireEvent.click(screen.getByRole('button', { name: 'Generate inspection SVG and manifest' }));
  if (failure) await screen.findByRole('alert'); else await screen.findByText('Retained inspection output');
}
async function preview() { fireEvent.click(screen.getByRole('button', { name: 'Preview authorized SVG' })); await screen.findByRole('img'); }

test('deliberate readonly record and each preview/download use a fresh read plus authorized bytes', async () => {
  render(panel()); await inspect();
  expect(vi.mocked(fetch).mock.calls[0]?.[0]).toBe('/api/v0/shared-scenes/drawing-scenes/root-snapshot?project_id=project-one');
  expect(createDrawing).not.toHaveBeenCalled(); await generate();
  expect(createDrawing).toHaveBeenCalledWith('project-one', 'root-snapshot', options(), expect.any(String));
  expect(screen.getByText(/Restricted synthetic rights/)).toBeTruthy(); expect(screen.getByText(/Canonical placement unknown/)).toBeTruthy();
  await preview(); expect(readDrawing).toHaveBeenCalledTimes(2);
  expect(drawingBytes).toHaveBeenLastCalledWith(output(), 'svg', expect.any(AbortSignal));
  const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
  fireEvent.click(screen.getByRole('button', { name: 'Download authorized SVG and manifest package' }));
  await waitFor(() => expect(click).toHaveBeenCalledTimes(1));
  expect(readDrawing).toHaveBeenCalledTimes(3); expect(drawingBytes).toHaveBeenLastCalledWith(output(), 'package', expect.any(AbortSignal));
  expect(screen.queryByRole('img')).toBeNull(); expect(revoke).toHaveBeenCalledWith('blob:owned-svg'); click.mockRestore();
});

test('right occurrence opening and Restore preserve exact selection and canonical inputs', async () => {
  const scene = syntheticScene(), before = JSON.stringify(scene); render(panel()); await inspect();
  fireEvent.click(screen.getByRole('button', { name: 'right/board · known' })); fireEvent.click(screen.getByRole('button', { name: 'Open displayed occurrence branch' }));
  const moved: Options = { ...options(), opening: { path: ['right', 'board'], axis: 'z', angle_deg: 90, pivot_local_mm: [0, 0, 0] } };
  vi.mocked(readDrawing).mockResolvedValue(output(moved)); await generate();
  expect(createDrawing).toHaveBeenLastCalledWith('project-one', 'root-snapshot', moved, expect.any(String));
  fireEvent.click(screen.getByRole('button', { name: 'Restore canonical display' })); expect(screen.queryByText('Retained inspection output')).toBeNull();
  expect(screen.getByRole('button', { name: 'right/board · known' }).getAttribute('aria-pressed')).toBe('true');
  vi.mocked(readDrawing).mockResolvedValue(output()); await generate();
  expect(createDrawing).toHaveBeenLastCalledWith('project-one', 'root-snapshot', options(), expect.any(String)); expect(JSON.stringify(scene)).toBe(before);
});

test('current denial clears preview and source pins, and stale successful bytes cannot reopen them', async () => {
  render(panel()); await inspect(); await generate(); await preview();
  let complete: (value: Blob) => void = () => {};
  const pending = new Promise<Blob>(resolve => { complete = resolve; }); vi.mocked(drawingBytes).mockReturnValueOnce(pending);
  fireEvent.click(screen.getByRole('button', { name: 'Preview authorized SVG' })); await waitFor(() => expect(drawingBytes).toHaveBeenCalledTimes(2));
  fireEvent(window, new Event('focus'));
  expect(screen.queryByText('Retained inspection output')).toBeNull(); expect(screen.queryByRole('img')).toBeNull();
  vi.mocked(readDrawing).mockRejectedValueOnce(new Error('Current source denied.'));
  fireEvent.click(screen.getByRole('button', { name: 'Inspect retained drawing' })); await screen.findByRole('alert');
  await act(async () => { complete(new Blob(['old'])); await pending; });
  expect(objectUrl).toHaveBeenCalledTimes(1); expect(screen.queryByText(/source-one/)).toBeNull(); expect(screen.queryByRole('img')).toBeNull();
});

test('project and principal changes revoke blobs, clear inputs and fence old generation', async () => {
  const shown = render(panel()); await inspect(); await generate(); await preview();
  shown.rerender(panel('project-one', 'actor-two')); expect(revoke).toHaveBeenCalledWith('blob:owned-svg');
  expect((screen.getByLabelText('Drawing frozen scene snapshot ID') as HTMLInputElement).value).toBe(''); expect(screen.queryByRole('img')).toBeNull();
  await inspect(); let finish: (value: Detail) => void = () => {};
  const pending = new Promise<Detail>(resolve => { finish = resolve; }); vi.mocked(createDrawing).mockReturnValueOnce(pending);
  fireEvent.click(screen.getByRole('button', { name: 'Generate inspection SVG and manifest' })); shown.rerender(panel('project-two', 'actor-two'));
  const calls = vi.mocked(readDrawing).mock.calls.length;
  await act(async () => { finish(output()); await pending; });
  expect(readDrawing).toHaveBeenCalledTimes(calls); expect(screen.queryByText('Retained inspection output')).toBeNull();
});

test('wrong project and options cannot expose output labels', async () => {
  render(panel()); await inspect(); vi.mocked(readDrawing).mockResolvedValueOnce({ ...output(), project_id: 'another-project' });
  await generate(true); expect(screen.queryByText('Retained inspection output')).toBeNull(); expect(drawingBytes).not.toHaveBeenCalled();
  await inspect(); vi.mocked(readDrawing).mockResolvedValueOnce(output({ ...options(), view: 'front' }));
  await generate(true); expect(screen.queryByText('Retained inspection output')).toBeNull();
});


test('a lost generation response is recovered with the same exact key and reviewed options', async () => {
  render(panel()); await inspect(); vi.mocked(createDrawing).mockRejectedValueOnce(new Error('Response lost.'));
  await generate(true); const original = vi.mocked(createDrawing).mock.calls[0]!;
  expect(screen.queryByRole('button', { name: 'right/board · known' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Retry exact inspection request' }));
  await screen.findByText('Retained inspection output');
  expect(vi.mocked(createDrawing).mock.calls[1]).toEqual(original);
});


test('an unknown occurrence frame disables opening and never becomes known through display controls', async () => {
  const scene = syntheticScene();
  const original = scene.nodes[1]!;
  scene.nodes.push({ ...original, node_id: 'unknown-board', address: { snapshot_id: scene.snapshot_id, path: ['unknown', 'board'] }, world_status: 'unknown', world_transform: null });
  vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify(scene)));
  render(panel()); await inspect();
  fireEvent.click(screen.getByRole('button', { name: 'unknown/board · unknown' }));
  expect((screen.getByRole('button', { name: 'Open displayed occurrence branch' }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByLabelText('Exploded display'));
  expect(screen.getByRole('button', { name: 'unknown/board · unknown' }).getAttribute('aria-pressed')).toBe('true');
  expect((screen.getByRole('button', { name: 'Open displayed occurrence branch' }) as HTMLButtonElement).disabled).toBe(true);
});


test('retained host tab deactivation revokes preview and returning starts a fresh empty inspection', async () => {
  const shown = render(panel()); await inspect(); await generate(); await preview();
  shown.rerender(panel('project-one', 'actor-one', false));
  expect(revoke).toHaveBeenCalledWith('blob:owned-svg'); expect(screen.queryByRole('img')).toBeNull();
  shown.rerender(panel());
  expect((screen.getByLabelText('Retained drawing ID') as HTMLInputElement).value).toBe('');
  expect(screen.queryByText('Retained inspection output')).toBeNull(); expect(screen.queryByRole('img')).toBeNull();
});


test('held generation hides cached scene controls until fresh authority succeeds and keeps selected occurrence and intent', async () => {
  render(panel()); await inspect();
  fireEvent.click(screen.getByRole('button', { name: 'right/board · known' }));
  let finish: (value: Detail) => void = () => {};
  const held = new Promise<Detail>(resolve => { finish = resolve; }); vi.mocked(createDrawing).mockReturnValueOnce(held);
  fireEvent.click(screen.getByRole('button', { name: 'Generate inspection SVG and manifest' }));
  await waitFor(() => expect(createDrawing).toHaveBeenCalledTimes(1));
  const captured = vi.mocked(createDrawing).mock.calls[0]!;
  expect(screen.queryByRole('button', { name: 'right/board · known' })).toBeNull();
  expect(screen.queryByRole('region', { name: 'Transient scene display arrangements' })).toBeNull();
  expect(screen.queryByText(/Root revision root-r1/)).toBeNull();
  await act(async () => { finish(output()); await held; });
  await screen.findByText('Retained inspection output');
  expect(screen.getByRole('button', { name: 'right/board · known' }).getAttribute('aria-pressed')).toBe('true');
  expect(createDrawing).toHaveBeenCalledTimes(1);
  expect(captured).toEqual(['project-one', 'root-snapshot', options(), expect.any(String)]);
});

test('held generation denial clears source controls and retains only the exact deliberate retry intent', async () => {
  render(panel()); await inspect();
  let deny: (reason: Error) => void = () => {};
  const held = new Promise<Detail>((_resolve, reject) => { deny = reject; }); vi.mocked(createDrawing).mockReturnValueOnce(held);
  fireEvent.click(screen.getByRole('button', { name: 'Generate inspection SVG and manifest' }));
  await waitFor(() => expect(createDrawing).toHaveBeenCalledTimes(1));
  const captured = vi.mocked(createDrawing).mock.calls[0]!;
  expect(screen.queryByRole('button', { name: 'right/board · known' })).toBeNull();
  await act(async () => { deny(new Error('Current source denied.')); await held.catch(() => {}); });
  await screen.findByRole('alert'); expect(screen.queryByText(/Root revision root-r1/)).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Retry exact inspection request' })); await screen.findByText('Retained inspection output');
  expect(vi.mocked(createDrawing).mock.calls[1]).toEqual(captured);
});
