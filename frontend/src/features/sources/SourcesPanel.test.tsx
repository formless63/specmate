import { PermissionsProvider } from "../../lib/permissions";
import { MantineProvider } from '@mantine/core';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { SourcesPanel } from './SourcesPanel';
import * as api from './api';

const original = {
  revision_id: 'original-id', bundle_id: 'original-bundle', name: 'Synthetic archive', role: 'original' as const,
  number: 1, manifest_sha256: 'archive-manifest', derived_from: null,
};
const member = { path: 'source.zip', sha256: 'archive-hash', bytes: 200, media_type: 'application/octet-stream', rights: 'unknown' };
const detail: api.RevisionDetail = { ...original, expansion: null, manifest: { ancestry: [], files: [member] } };
const expanded: api.RevisionDetail = { ...detail, name: 'Expanded synthetic', revision_id: 'expanded-id', role: 'derivative', derived_from: 'original-id',
  expansion: { parser: 'specmate-classic-zip-v1', source_revision_id: 'original-id', path: 'source.zip', sha256: 'archive-hash', rights: 'unknown', execution: 'none' },
  manifest: { ancestry: ['original-id'], files: [{ ...member, path: 'src/board.native', sha256: 'member-hash', bytes: 20 }] },
};
function reply(value: unknown, status = 200) { return new Response(JSON.stringify(value), { status }); }
beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  Element.prototype.scrollIntoView = vi.fn();
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
function setup(mode: 'success' | 'reject' | 'deny' = 'success', write = true) {
  let expandedOnce = false;
  let denied = false;
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.includes('sources/workspaces/')) return reply({ revisions: [original], next_after: null });
    if (url.endsWith('sources/revisions/original-id')) return denied ? reply({ error: { message: 'Source revision not found.' } }, 404) : reply(detail);
    if (url.endsWith('sources/revisions/expanded-id')) return reply(expanded);
    if (url.endsWith('operations')) {
      const body = JSON.parse(String(init?.body));
      expect(body.operation).toBe('source.expand_zip');
      expect(body.payload).toEqual({ source_revision_id: 'original-id', path: 'source.zip', name: 'Synthetic archive expanded', format: 'zip' });
      expandedOnce = true;
      if (mode === 'deny') { denied = true; return reply({ error: { message: 'Source revision not found.' } }, 404); }
      if (mode === 'reject') return reply({ error: { message: 'Unsupported or unsafe ZIP archive; no expanded bundle was created.' } }, 422);
      return reply({ result: { revision_id: 'expanded-id' } });
    }
    throw new Error(`Unexpected route ${url}`);
  });
  vi.stubGlobal('fetch', fetchMock);
  const view = render(<MantineProvider><PermissionsProvider permissions={write ? ['workspace.read', 'source.register'] : ['workspace.read']}><SourcesPanel workspaceId="project-a" /></PermissionsProvider></MantineProvider>);
  return { fetchMock, view, hasExpanded: () => expandedOnce };
}

test('expansion is deliberate and reopened derivative shows exact archive provenance', async () => {
  const { hasExpanded } = setup();
  fireEvent.click(await screen.findByRole('button', { name: 'Inspect Synthetic archive revision 1' }));
  await screen.findByRole('heading', { name: 'Exact source revision' });
  // The readable name leads; the exact revision ID stays in the list entry's and the detail's pins.
  expect(screen.getAllByText('original-id', { selector: 'code' }).length).toBeGreaterThanOrEqual(2);
  expect(hasExpanded()).toBe(false);
  fireEvent.click(screen.getByRole('button', { name: 'Expand ZIP into derivative' }));
  expect(await screen.findAllByText('archive-hash')).toBeTruthy();
  expect(screen.getByText(/Archive path: source.zip/)).toBeTruthy();
  expect(screen.getByText(/Inherited declared rights: unknown/)).toBeTruthy();
  expect(screen.getByText('src/board.native')).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Expand ZIP into derivative' })).toBeNull();
});

test('unsupported archive keeps its preserved original available', async () => {
  setup('reject');
  fireEvent.click(await screen.findByRole('button', { name: 'Inspect Synthetic archive revision 1' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Expand ZIP into derivative' }));
  expect(await screen.findByText('Unsupported or unsafe ZIP archive; no expanded bundle was created.')).toBeTruthy();
  expect(screen.getByRole('heading', { name: 'Exact source revision' })).toBeTruthy();
  expect(screen.getByRole('link', { name: 'Download source.zip' }).getAttribute('href')).toContain('original-id/file?path=source.zip');
  expect(screen.queryByText('ZIP expansion provenance')).toBeNull();
});

test('authority denial clears retained file metadata and source list', async () => {
  setup('deny');
  fireEvent.click(await screen.findByRole('button', { name: 'Inspect Synthetic archive revision 1' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Expand ZIP into derivative' }));
  expect(await screen.findByText('Source revision not found.')).toBeTruthy();
  expect(screen.queryByText('archive-hash')).toBeNull();
  expect(screen.queryByRole('heading', { name: 'Exact source revision' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Inspect Synthetic archive revision 1' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Preserve source' })).toBeNull();
});

test('read-only viewer can inspect source rights without intake controls', async () => {
  setup('success', false);
  fireEvent.click(await screen.findByRole('button', { name: 'Inspect Synthetic archive revision 1' }));
  expect(await screen.findByText('archive-hash')).toBeTruthy();
  expect(screen.getByText('unknown')).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Preserve source' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Expand ZIP into derivative' })).toBeNull();
});

test('project change discards the prior detail and late response', async () => {
  const { view } = setup();
  fireEvent.click(await screen.findByRole('button', { name: 'Inspect Synthetic archive revision 1' }));
  await screen.findByRole('heading', { name: 'Exact source revision' });
  vi.stubGlobal('fetch', vi.fn(async () => reply({ revisions: [], next_after: null })));
  view.rerender(<MantineProvider><PermissionsProvider permissions={['workspace.read']}><SourcesPanel workspaceId="project-b" /></PermissionsProvider></MantineProvider>);
  await waitFor(() => expect(screen.queryByRole('heading', { name: 'Exact source revision' })).toBeNull());
  expect(screen.queryByText('archive-hash')).toBeNull();
});

test('preservation calls the upload workflow without implicit expansion', async () => {
  const preserved = vi.spyOn(api, 'preserve').mockResolvedValue({ revision_id: 'original-id' });
  const { hasExpanded } = setup();
  fireEvent.change(screen.getByLabelText('Original source file'), { target: { files: [new File(['original'], 'source.zip')] } });
  fireEvent.click(screen.getByRole('button', { name: 'Preserve source' }));
  await screen.findByRole('heading', { name: 'Exact source revision' });
  expect(preserved).toHaveBeenCalledWith('project-a', expect.any(File), 'source.zip', 'unknown');
  expect(hasExpanded()).toBe(false);
});

test.each(['refresh', 'inspect'])('late same-project %s denial clears newer inspection and retained inventory', async action => {
  let rejectRead!: (value: Response) => void;
  const lateDenial = new Promise<Response>(resolve => { rejectRead = resolve; });
  let defer = false;
  let usedDeferred = false;
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const isList = url.includes('sources/workspaces/');
    if (defer && !usedDeferred && (action === 'refresh' ? isList : !isList)) {
      usedDeferred = true; return lateDenial;
    }
    return reply(isList ? { revisions: [original], next_after: null } : detail);
  }));
  render(<MantineProvider><PermissionsProvider permissions={['workspace.read']}><SourcesPanel workspaceId="project-a" /></PermissionsProvider></MantineProvider>);
  const inspect = await screen.findByRole('button', { name: 'Inspect Synthetic archive revision 1' });
  defer = true;
  fireEvent.click(action === 'refresh' ? screen.getByRole('button', { name: 'Refresh sources' }) : inspect);
  fireEvent.click(inspect);
  await screen.findByRole('heading', { name: 'Exact source revision' });
  rejectRead(reply({ error: { message: 'Source revision not found.' } }, 404));
  await screen.findByText('Source revision not found.');
  expect(screen.queryByRole('heading', { name: 'Exact source revision' })).toBeNull();
  expect(screen.queryByText('archive-hash')).toBeNull();
  expect(screen.queryByRole('button', { name: 'Inspect Synthetic archive revision 1' })).toBeNull();
});

test('post-preservation inventory denial prevents a subsequent detail request', async () => {
  vi.spyOn(api, 'preserve').mockResolvedValue({ revision_id: 'original-id' });
  let deny = false;
  const fetchMock = vi.fn(async (url: string) => {
    if (!url.includes('sources/workspaces/')) throw new Error('No detail may be requested after denial');
    return deny ? reply({ error: { message: 'Source revision not found.' } }, 404) : reply({ revisions: [original], next_after: null });
  });
  vi.stubGlobal('fetch', fetchMock);
  render(<MantineProvider><PermissionsProvider permissions={['source.register']}><SourcesPanel workspaceId="project-a" /></PermissionsProvider></MantineProvider>);
  await screen.findByRole('button', { name: 'Inspect Synthetic archive revision 1' });
  deny = true;
  fireEvent.change(screen.getByLabelText('Original source file'), { target: { files: [new File(['original'], 'source.zip')] } });
  fireEvent.click(screen.getByRole('button', { name: 'Preserve source' }));
  await screen.findByText('Source revision not found.');
  expect(fetchMock.mock.calls.every(([url]) => url.includes('sources/workspaces/'))).toBe(true);
  expect(screen.queryByRole('heading', { name: 'Exact source revision' })).toBeNull();
});

test('an edited derivative can be registered as a PCB intake from the source view', async () => {
  const edited: api.RevisionDetail = { ...detail, name: 'Edited board', revision_id: 'edited-id', role: 'derivative', derived_from: 'original-id',
    manifest: { ancestry: ['original-id'], files: [{ ...member, path: 'board.kicad_pcb', sha256: 'board-hash' }, { ...member, path: 'notes.txt', sha256: 'notes-hash' }] } };
  const posts: { operation: string; payload: Record<string, unknown> }[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (url.includes('sources/workspaces/')) return reply({ revisions: [{ ...original, revision_id: 'edited-id', name: 'Edited board', role: 'derivative' }], next_after: null });
    if (url.endsWith('sources/revisions/edited-id')) return reply(edited);
    if (url.endsWith('operations')) { posts.push(JSON.parse(String(init?.body))); return reply({ result: { intake_id: 'intake-9' } }); }
    return reply({ revisions: [], next_after: null });
  }));
  render(<MantineProvider><PermissionsProvider permissions={['workspace.read', 'source.register']}><SourcesPanel workspaceId="ws-1" projectId="project-1" /></PermissionsProvider></MantineProvider>);
  fireEvent.click(await screen.findByRole('button', { name: 'Inspect Edited board revision 1' }));
  await screen.findByRole('heading', { name: 'Register a PCB intake' });
  expect(posts).toHaveLength(0);
  fireEvent.click(screen.getByRole('button', { name: 'Register PCB intake' }));
  await screen.findByText(/registered for board.kicad_pcb/);
  expect(posts[0]).toMatchObject({ operation: 'pcb.register_intake', payload: { workspace_id: 'ws-1', source_revision_id: 'edited-id', board_path: 'board.kicad_pcb', project_id: 'project-1' } });
});

test('registering a PCB intake is hidden without source.register and without a board', async () => {
  setup('success', false);
  fireEvent.click(await screen.findByRole('button', { name: 'Inspect Synthetic archive revision 1' }));
  await screen.findByRole('heading', { name: 'Exact source revision' });
  expect(screen.queryByRole('heading', { name: 'Register a PCB intake' })).toBeNull();
});
