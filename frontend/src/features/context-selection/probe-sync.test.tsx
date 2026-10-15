import { MantineProvider } from '@mantine/core';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { formatLocation, parseLocation, type ProbeTarget } from '../navigation/url';
import { ProbeProvider } from '../probe';
import { sceneAddress, sceneRelations, sceneTarget } from '../probe/scene';
import { RelationRegistry } from '../probe/relations';
import { ContextualInspectionWorkspace } from './ContextualInspectionWorkspace';
import { contextScene } from './test-fixtures';

vi.mock('../shared-scene/SceneViewport', () => ({ default: ({ related }: { related?: { path: string[] }[] }) => <p>Viewport related: {(related ?? []).map(a => a.path.join('/')).join(',') || 'none'}</p> }));
const response = (data: unknown) => new Response(JSON.stringify(data), { status: 200 });
const choices = { assemblies: [{ snapshot_id: 'root-snapshot', revision_id: 'root-r1', definition_id: 'root', name: 'Synthetic root', number: 1 }, { snapshot_id: 'root-snapshot-2', revision_id: 'root-r2', definition_id: 'root', name: 'Synthetic root', number: 2 }], window: 'latest_50_frozen_revisions' };
beforeEach(() => { vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} }); Element.prototype.scrollIntoView = vi.fn(); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const area = (probe: ProbeTarget | null) => formatLocation({ area: 'designs', lens: 'shared-scene', project: null, probe });

function Host({ initial = null, registry }: { initial?: ProbeTarget | null; registry?: RelationRegistry }) {
  const [probe, setProbe] = useState<ProbeTarget | null>(initial);
  return <MantineProvider><ProbeProvider probe={probe} onProbe={setProbe} registry={registry}>
    <output aria-label="address">{area(probe)}</output>
    <ContextualInspectionWorkspace projectId="project-one" principalKey="actor-one" />
  </ProbeProvider></MantineProvider>;
}
const address = () => screen.getByLabelText('address').textContent;
async function open() {
  fireEvent.change(screen.getByLabelText('Exact contextual root snapshot ID'), { target: { value: 'root-snapshot' } });
  fireEvent.click(screen.getByRole('button', { name: 'Open contextual root' }));
  await screen.findByRole('button', { name: /^Tree right\/board · J1/ });
}
function install() {
  const scene = contextScene();
  vi.stubGlobal('fetch', vi.fn(async (url: string) => response(url.endsWith('/definitions') ? [{ definition_id: 'root' }] : url.includes('/snapshots/') ? scene : choices)));
  return scene;
}

test('scene uses and features are distinct probe targets; repeated boards never collapse', () => {
  const scene = contextScene();
  const left = sceneTarget(scene, { snapshot_id: scene.snapshot_id, path: ['left', 'board'] });
  const right = sceneTarget(scene, { snapshot_id: scene.snapshot_id, path: ['right', 'board'], feature_id: 'component:one' }, 1);
  expect(left).toEqual({ object: 'root', rev: null, path: ['left', 'board'] });
  expect(right.path).toEqual(['right', 'board', '#component:one']);
  expect(sceneAddress(scene, right)).toEqual({ snapshot_id: scene.snapshot_id, path: ['right', 'board'], feature_id: 'component:one' });
  expect(sceneAddress(scene, { ...left, path: ['right', 'board', '#missing'] })).toBeNull();
  expect(sceneAddress(scene, { ...left, object: 'other' })).toBeNull();
});

test('scene relations name only the other end of the selected use or exact feature', () => {
  const scene = contextScene();
  const registry = new RelationRegistry();
  registry.register(sceneRelations(scene));
  const related = (path: string[]) => registry.related({ object: 'root', rev: null, path }).map(r => `${r.path.join('/')}:${r.relation}`);
  const declared = (path: string[]) => related(path).filter(item => !item.endsWith(':contains') || item.includes('/'));
  expect(declared(['right', 'board'])).toEqual(['right/cable/#endpoint:a:electrical']);
  expect(related(['right', 'board', '#component:one'])).toContain('right/cable/#endpoint:a:electrical');
  expect(related(['left', 'board', '#component:one']).join()).not.toContain('right/cable');
  expect(related(['left', 'board']).join()).not.toContain('right');
  scene.nodes.push({ ...structuredClone(scene.nodes[0]!), address: { snapshot_id: scene.snapshot_id, path: ['right'] }, node_id: 'right', features: [] });
  expect(related(['right'])).toEqual(expect.arrayContaining(['right/board:contains', 'right/cable:contains']));
  expect(related(['right']).join()).not.toContain('left');
});

test('selecting the second repeated board in a view updates the URL probe and marks related uses; the URL selects it back', async () => {
  install();
  const { unmount } = render(<Host />); await open();
  fireEvent.click(screen.getByRole('button', { name: /^Tree right\/board · J1/ }));
  expect(address()).toBe('/designs/root@1/~/right/board?tool=shared-scene');
  fireEvent.click(screen.getByRole('tab', { name: 'Context cable' }));
  const cable = within(screen.getByRole('region', { name: 'Context cable' }));
  const mark = cable.getByRole('button', { name: /^Cable right\/cable · J1/ });
  expect(mark.getAttribute('data-probe')).toBe('related');
  expect(cable.getByRole('button', { name: /^Cable left\/cable · J1/ }).getAttribute('data-probe')).toBeNull();
  fireEvent.click(mark);
  expect(address()).toBe('/designs/root@1/~/right/cable?tool=shared-scene');
  fireEvent.click(screen.getByRole('tab', { name: 'Context board' }));
  fireEvent.click(screen.getByRole('button', { name: /^Board left\/board · J1/ }));
  fireEvent.click(await screen.findByRole('button', { name: 'Board marker component:one' }));
  expect(address()).toBe('/designs/root@1/~/left/board/%23component%3Aone?tool=shared-scene');
  fireEvent.click(screen.getByRole('button', { name: 'Clear shared selection' }));
  expect(address()).toBe('/designs?tool=shared-scene');
  unmount();
});

test('a link to a repeated use opens with exactly that use selected; clearing the probe clears the selection', async () => {
  install();
  render(<Host initial={{ object: 'root', rev: null, path: ['right', 'board', '#component:one'] }} />); await open();
  await waitFor(() => expect(within(screen.getByRole('region', { name: 'Shared contextual selection' })).getByText('Stable feature: component:one')).toBeTruthy());
  expect(within(screen.getByRole('region', { name: 'Shared contextual selection' })).getByText('Selected occurrence: right/board')).toBeTruthy();
  expect(screen.getByRole('button', { name: /^Tree left\/board · J1/ }).getAttribute('aria-pressed')).toBe('false');
  expect(address()).toBe('/designs/root@1/~/right/board/%23component%3Aone?tool=shared-scene');
});

test('the 3D viewport receives the related uses (not the selected one, not other repeated uses)', async () => {
  install(); render(<Host />); await open();
  fireEvent.click(screen.getByRole('button', { name: /^Tree right\/board · J1/ }));
  fireEvent.click(screen.getByRole('tab', { name: 'Context scene' }));
  fireEvent.click(screen.getByRole('button', { name: 'Open connected scene' }));
  await screen.findByText('Viewport related: right/cable');
});

test('an exact older root revision stays in the URL after selecting a use, and a reload restores it', async () => {
  install();
  const first = render(<Host />); await open();
  fireEvent.click(screen.getByRole('button', { name: /^Tree right\/board · J1/ }));
  expect(address()).toBe('/designs/root@1/~/right/board?tool=shared-scene');
  const url = address()!; first.unmount();
  const [path, search = ''] = url.split('?'); const location = parseLocation(path!, search ? '?' + search : '');
  render(<Host initial={location.probe} />);
  await waitFor(() => expect(within(screen.getByRole('region', { name: 'Shared contextual selection' })).getByText('Selected occurrence: right/board')).toBeTruthy());
  expect(address()).toBe(url);
  expect(location.probe?.rev).toBe(1);
});
