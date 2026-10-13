import { MantineProvider } from '@mantine/core';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { command, SourceError } from '../sources/api';
import { MountingDetails, MountingEditor, type PlacementInputs } from './MountingEditor';
import { PlacementEditor } from './PlacementEditor';
import type { Draft, Occurrence } from './api';

vi.mock('../sources/api', async original => ({ ...(await original<typeof import('../sources/api')>()), command: vi.fn() }));
const occ: Occurrence = { local_id: 'board', revision_id: 'exact-board', display_ref: 'A1', placement: { status: 'known', translation: [1, 2, 3], rotation_xyzw: [0, 0, 1, 0] } };
const draft: Draft = { definition_id: 'assembly', draft_id: 'draft', state: 'draft-v1', content: { assembly: { occurrences: [], relationships: [] } } };
const inputs: PlacementInputs = { draft_id: 'draft', state: 'draft-v1', occurrences: ['left', 'right'].map(side => ({ path: [side, 'board'], name: 'Synthetic board', kind: 'board', display_ref: 'A1', revision_id: 'exact-board', snapshot_sha256: 'exact-hash', placement: { status: 'unknown' }, feature_existence: 'not_evaluated' })) };
function wrap(children: React.ReactNode) { return <MantineProvider env="test"><QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{children}</QueryClientProvider></MantineProvider>; }
beforeEach(() => vi.mocked(command).mockResolvedValue(inputs));
afterEach(() => { cleanup(); vi.resetAllMocks(); });

test('translation edit preserves exact canonical quaternion without defaulting to identity', () => {
  const save = vi.fn(); render(wrap(<PlacementEditor occurrence={occ} busy={false} onSave={save} onRemove={vi.fn()} />));
  fireEvent.change(screen.getByLabelText('board X (mm)'), { target: { value: '-10.5' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save board' }));
  expect(save).toHaveBeenCalledWith(expect.objectContaining({ placement: { status: 'known', unit: 'mm', frame: 'right_handed_z_up', translation: [-10.5, 2, 3], rotation_xyzw: [0, 0, 1, 0] } }));
});

test('known placement requires explicit complete coordinates and rotation', () => {
  const save = vi.fn(); render(wrap(<PlacementEditor occurrence={{ ...occ, placement: { status: 'unknown' } }} busy={false} onSave={save} onRemove={vi.fn()} />));
  fireEvent.click(screen.getByLabelText('Known placement for board'));
  expect((screen.getByRole('button', { name: 'Save board' }) as HTMLButtonElement).disabled).toBe(true);
  for (const label of ['board X (mm)', 'board Y (mm)', 'board Z (mm)', 'board rotation X', 'board rotation Y', 'board rotation Z']) fireEvent.change(screen.getByLabelText(label), { target: { value: '0' } });
  fireEvent.change(screen.getByLabelText('board rotation W'), { target: { value: '1' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save board' }));
  expect(save).toHaveBeenCalledWith(expect.objectContaining({ placement: expect.objectContaining({ translation: [0, 0, 0], rotation_xyzw: [0, 0, 0, 1] }) }));
});

test('nonunit rotation is saved only after deliberate normalization', () => {
  const save = vi.fn(); render(wrap(<PlacementEditor occurrence={occ} busy={false} onSave={save} onRemove={vi.fn()} />));
  fireEvent.change(screen.getByLabelText('board rotation Z'), { target: { value: '2' } });
  expect((screen.getByRole('button', { name: 'Save board' }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: 'Normalize rotation for board' }));
  fireEvent.click(screen.getByRole('button', { name: 'Save board' }));
  expect(save).toHaveBeenCalledWith(expect.objectContaining({ placement: expect.objectContaining({ rotation_xyzw: [0, 0, 1, 0] }) }));
});

test('an erased coordinate cannot silently become zero', () => {
  render(wrap(<PlacementEditor occurrence={occ} busy={false} onSave={vi.fn()} onRemove={vi.fn()} />));
  fireEvent.change(screen.getByLabelText('board Z (mm)'), { target: { value: '' } });
  expect((screen.getByRole('button', { name: 'Save board' }) as HTMLButtonElement).disabled).toBe(true);
});

test('explicit unknown placement drops all prior transform coordinates', () => {
  const save = vi.fn(); render(wrap(<PlacementEditor occurrence={occ} busy={false} onSave={save} onRemove={vi.fn()} />));
  fireEvent.click(screen.getByLabelText('Known placement for board')); fireEvent.click(screen.getByRole('button', { name: 'Save board' }));
  expect(save).toHaveBeenCalledWith({ display_ref: 'A1', placement: { status: 'unknown' } });
});

test('named repeated mounted/support choices pin independent exact nested paths', async () => {
  const save = vi.fn(); render(wrap(<MountingEditor draft={draft} busy={false} onSave={save} onDenied={vi.fn()} />));
  await screen.findAllByRole('option', { name: 'right/board · A1 (board)' });
  fireEvent.change(screen.getByLabelText('Mounted contextual occurrence'), { target: { value: '["right","board"]' } });
  fireEvent.change(screen.getByLabelText('Supporting contextual occurrence'), { target: { value: '["left","board"]' } });
  fireEvent.change(screen.getByLabelText('Mounting declaration local ID'), { target: { value: 'mount' } });
  fireEvent.change(screen.getByLabelText('Mounted unverified stable feature ID (optional)'), { target: { value: 'candidate-hole' } });
  fireEvent.click(screen.getByRole('button', { name: 'Add mounting declaration' }));
  expect(save).toHaveBeenCalledWith(expect.objectContaining({ relationships: [{ kind: 'mounting', local_id: 'mount', mounted: { kind: 'occurrence', path: ['right', 'board'], feature_id: 'candidate-hole' }, support: { kind: 'occurrence', path: ['left', 'board'], feature_id: null } }] }));
  expect(command).toHaveBeenCalledWith('assembly.placement_inputs', { draft_id: 'draft' }, { idempotent: false });
  expect(screen.getByText(/Their existence and correspondence remain unknown here/)).toBeTruthy();
});

test('new server draft cannot replace staged edit concurrency token through mounting refresh', async () => {
  vi.mocked(command).mockResolvedValue({ ...inputs, state: 'draft-v2' });
  render(wrap(<MountingEditor draft={draft} busy={false} onSave={vi.fn()} onDenied={vi.fn()} />));
  await screen.findByText(/The saved assembly changed/);
  expect((screen.getByRole('button', { name: 'Add mounting declaration' }) as HTMLButtonElement).disabled).toBe(true);
});

test('current source denial clears cached nested labels and asks parent to discard evidence', async () => {
  const denied = vi.fn(); render(wrap(<MountingEditor draft={draft} busy={false} onSave={vi.fn()} onDenied={denied} />));
  await screen.findAllByRole('option', { name: 'right/board · A1 (board)' });
  vi.mocked(command).mockRejectedValueOnce(new SourceError(404, 'Current model source unavailable'));
  fireEvent.click(screen.getByRole('button', { name: 'Refresh mounting choices' }));
  await waitFor(() => expect(denied).toHaveBeenCalled());
  expect(screen.queryAllByRole('option', { name: 'right/board · A1 (board)' })).toHaveLength(0);
  expect(screen.queryAllByText('exact-hash')).toHaveLength(0);
});

test('nested frozen mounting details retain their containing context and unverified features', () => {
  render(wrap(<MountingDetails relationships={[{ kind: 'mounting', local_id: 'mount', context_path: ['right'], mounted: { kind: 'occurrence', path: ['board'], feature_id: 'candidate-hole' }, support: { kind: 'occurrence', path: [], feature_id: null } }]} />));
  expect(screen.getByText('right/board / unverified feature candidate-hole')).toBeTruthy();
  expect(screen.getByText('right / whole occurrence')).toBeTruthy();
  expect(screen.getByText(/fit and clearance: not evaluated/)).toBeTruthy();
});
