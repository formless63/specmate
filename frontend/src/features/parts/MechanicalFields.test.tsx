import { MantineProvider, Select } from '@mantine/core';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { act } from 'react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { MechanicalFields } from './MechanicalFields';
vi.mock('../cables/RevisionPicker', () => ({ RevisionPicker: ({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) => <input aria-label={label} value={value} onChange={event => onChange(event.target.value)} /> }));
const reply = (value: unknown) => new Response(JSON.stringify(value));
const choice = { representation_id: 'model', label: 'Synthetic mesh', path: 'shape.stl', sha256: 'b'.repeat(64), revision_id: 'part-r1', snapshot_sha256: 'a'.repeat(64), source_revision_id: 'source', source_manifest_sha256: 'c'.repeat(64) };
const content = { mechanical_source: { item_role: 'enclosure', sources: [], models: [], targets: [{ local_id: 'target1', revision_id: 'board-r1', snapshot_sha256: 'd'.repeat(64), role: 'hardware', board: null, native_component_id: null, basis: 'Synthetic target' }], limitations: [] } };
beforeEach(() => { vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} unobserve() {} }); Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() }); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
function mount() {
  const change = vi.fn(), cache = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const props = { content, change, active: true, editable: true, workspaceId: 'workspace', principalKey: 'member' };
  const tree = (active = true) => <MantineProvider env="test" theme={{ components: { Select: Select.extend({ defaultProps: { comboboxProps: { transitionProps: { duration: 0 } } } }) } }}><QueryClientProvider client={cache}><MechanicalFields {...props} active={active} /></QueryClientProvider></MantineProvider>;
  const view = render(tree()); return { change, rerender: (active: boolean) => view.rerender(tree(active)) };
}
async function prepare() {
  fireEvent.change(screen.getByLabelText('Model-bearing part'), { target: { value: 'part-r1' } });
  fireEvent.click(screen.getByRole('combobox', { name: 'Exact source model' })); fireEvent.click(await screen.findByRole('option', { name: 'Synthetic mesh · shape.stl' }));
  fireEvent.click(screen.getByRole('combobox', { name: 'Model target' })); fireEvent.click(screen.getByRole('option', { name: 'target1' }));
  fireEvent.change(screen.getByLabelText('Model correspondence basis'), { target: { value: 'Authored illustrative correspondence' } });
}
test('model addition stages original exact representation/source pins with unknown units and unchanged targets', async () => {
  const calls: string[] = []; vi.stubGlobal('fetch', vi.fn(async (path: string) => { calls.push(path); return reply(path.includes('/targets/') ? { models: [choice] } : path.includes('/revisions/source') ? { revision_id: 'source', manifest_sha256: choice.source_manifest_sha256, manifest: { files: [{ path: choice.path, sha256: choice.sha256, rights: 'synthetic-original' }] } } : { revisions: [] }); }));
  const view = mount(); await prepare(); fireEvent.click(screen.getByRole('button', { name: 'Add exact model declaration' }));
  await waitFor(() => expect(view.change).toHaveBeenCalledTimes(1));
  expect(view.change).toHaveBeenCalledWith({ mechanical_source: { ...content.mechanical_source, sources: [{ local_id: 'source1', source_revision_id: 'source', source_manifest_sha256: choice.source_manifest_sha256, files: [{ path: 'shape.stl', sha256: choice.sha256, rights: 'synthetic-original', role: 'model', format: 'mesh' }] }], models: [{ local_id: 'model1', representation_id: 'model', revision_id: 'part-r1', snapshot_sha256: choice.snapshot_sha256, source_local_id: 'source1', path: 'shape.stl', target_local_id: 'target1', purpose: 'illustration', units: null, frame: null, accuracy: null, basis: 'Authored illustrative correspondence' }] } });
  expect(calls.some(path => path === '/api/v0/operations')).toBe(false);
});
test('held source detail cannot add a model after the record becomes inactive', async () => {
  let release!: (response: Response) => void;
  vi.stubGlobal('fetch', vi.fn((path: string) => path.includes('/revisions/source') ? new Promise<Response>(resolve => { release = resolve; }) : Promise.resolve(reply(path.includes('/targets/') ? { models: [choice] } : { revisions: [] }))));
  const view = mount(); await prepare(); fireEvent.click(screen.getByRole('button', { name: 'Add exact model declaration' })); view.rerender(false);
  await act(async () => release(reply({ revision_id: 'source', manifest_sha256: choice.source_manifest_sha256, manifest: { files: [{ path: choice.path, sha256: choice.sha256, rights: 'synthetic-original' }] } })));
  expect(view.change).not.toHaveBeenCalled();
});
