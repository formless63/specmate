import { grants } from "../../test/grants";
import { PermissionsProvider } from "../../lib/permissions";
import { MantineProvider } from '@mantine/core';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { command } from '../pcb/api';
import { PcbFabricationPanel } from './PcbFabricationPanel';
import { options, review, type Review } from './api';

vi.mock('./api', async original => ({ ...(await original<typeof import('./api')>()), options: vi.fn(), review: vi.fn() }));
vi.mock('../pcb/api', async original => ({ ...(await original<typeof import('../pcb/api')>()), command: vi.fn() }));
const evidence: Review = {
  intake_id: 'intake-a', build_id: 'build-a', recipe_id: 'approved-fabrication', image: 'pinned-image', report_sha256: 'report-hash',
  source: { path: 'original-board.kicad_pcb', sha256: 'source-hash', source_revision_id: 'revision-a', manifest_sha256: 'manifest-hash', rights: 'synthetic-original' },
  report: { layers: ['F.Cu', 'B.Cu'], drill_format: 'excellon', source_unchanged: true, drc_counts: { violations: 2, unconnected_items: 1, schematic_parity: 0 }, unsupported: ['Assembly output unsupported'], manufacturing_approval: false, physical_qualification: false },
  outputs: [{ output_id: 'output-a', path: 'board-F_Cu.gbr', sha256: 'output-hash', size: 1000, media_type: 'application/vnd.gerber', rights: 'synthetic-original' }],
};
beforeEach(() => {
  vi.mocked(options).mockResolvedValue({ available_recipe_id: 'approved-fabrication', unavailable_reason: null, builds: [{ build_id: 'build-a', state: 'succeeded' }], limit: 100 });
  vi.mocked(review).mockResolvedValue(evidence);
  vi.mocked(command).mockResolvedValue({ build_id: 'new-build' });
});
afterEach(() => { cleanup(); vi.resetAllMocks(); });
// Mantine env="test" skips transition styles but still schedules animation hooks.
// Honor the test environment's reduced-motion preference for busy-button updates.
const panel = (intakeId = 'intake-a', canExecute = false) => <MantineProvider env="test" theme={{ respectReducedMotion: true }}><PermissionsProvider permissions={grants({ execute: canExecute })}><PcbFabricationPanel intakeId={intakeId} /></PermissionsProvider></MantineProvider>;
async function inspect() {
  fireEvent.click(await screen.findByRole('button', { name: 'Inspect fabrication build build-a' }));
  await screen.findByText('Registered export evidence');
}

test('viewer sees exact evidence and separate DRC findings without execution control', async () => {
  render(panel()); await inspect();
  expect(screen.getByText(/2 violations, 1 unconnected items/)).toBeTruthy();
  expect(screen.getByText(/original-board.kicad_pcb.*source-hash/)).toBeTruthy();
  expect(screen.getByRole('link', { name: 'board-F_Cu.gbr' }).getAttribute('href')).toContain('/builds/build-a/outputs/output-a');
  expect(screen.queryByRole('button', { name: 'Request native fabrication outputs' })).toBeNull();
});

test('request is deliberate and uses the approved exact intake recipe', async () => {
  render(panel('intake-a', true));
  await waitFor(() => expect((screen.getByRole('button', { name: 'Request native fabrication outputs' }) as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(screen.getByRole('button', { name: 'Request native fabrication outputs' }));
  await waitFor(() => expect(command).toHaveBeenCalledWith('pcb_fabrication.request', { intake_id: 'intake-a', recipe_id: 'approved-fabrication' }, expect.any(AbortSignal)));
});

test('denied refresh clears retained source names and download links', async () => {
  render(panel()); await inspect();
  vi.mocked(review).mockRejectedValue(new Error('Current access denied.'));
  fireEvent.click(screen.getByRole('button', { name: 'Refresh fabrication evidence' }));
  expect(screen.queryByText(/original-board.kicad_pcb/)).toBeNull();
  await screen.findByText('Current access denied.');
  expect(screen.queryByRole('link', { name: 'board-F_Cu.gbr' })).toBeNull();
  expect(screen.queryByText('Registered export evidence')).toBeNull();
});

test('changing intake immediately discards captured evidence', async () => {
  const view = render(panel()); await inspect();
  view.rerender(panel('intake-b'));
  expect(screen.queryByText(/original-board.kicad_pcb/)).toBeNull();
  expect(screen.queryByRole('link', { name: 'board-F_Cu.gbr' })).toBeNull();
  await waitFor(() => expect(options).toHaveBeenLastCalledWith('intake-b', expect.any(AbortSignal)));
});

test('failed request hides previously reviewed output until explicit refresh', async () => {
  render(panel('intake-a', true)); await inspect();
  vi.mocked(command).mockRejectedValue(new Error('Execution authority revoked.'));
  fireEvent.click(screen.getByRole('button', { name: 'Request native fabrication outputs' }));
  await screen.findByText('Execution authority revoked.');
  expect(screen.queryByRole('link', { name: 'board-F_Cu.gbr' })).toBeNull();
});

test('busy-state updates do not leave decorative animation work in the DOM test harness', async () => {
  const frames = vi.spyOn(window, 'requestAnimationFrame');
  try {
    const view = render(panel('intake-a', true));
    await inspect();
    fireEvent.click(screen.getByRole('button', { name: 'Refresh fabrication evidence' }));
    await screen.findByText('Registered export evidence');
    view.unmount();
    expect(frames).not.toHaveBeenCalled();
  } finally {
    frames.mockRestore();
  }
});
