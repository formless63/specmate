import { MantineProvider } from '@mantine/core';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { PermissionsProvider } from '../../lib/permissions';
import { BoardRecordPage } from './BoardRecordPage';
import type { FrozenPopulationReview, Intake } from '../pcb/api';
const source = '00000000-0000-4000-8000-000000000001';
const frozen: FrozenPopulationReview = {
  name: 'Synthetic population', definition_id: 'population', revision_id: 'old-r1', number: 1, snapshot_id: 'snapshot', snapshot_sha256: 'a'.repeat(64), frozen_at: '2026-01-01T00:00:00Z',
  population: { schema_version: '1', interpretation_id: 'old-report', interpretation_sha256: 'b'.repeat(64), source_revision_id: source, source_manifest_sha256: 'c'.repeat(64), options: [{ local_id: 'default', name: 'Default', decisions: [{ component_id: 'component', status: null, basis: null }] }], associations: [] },
  interpretation: { intake_id: 'exact-intake', interpretation_id: 'old-report', sha256: 'b'.repeat(64), attempt_id: 'old-attempt', output_id: 'output', source_revision_id: source, source_manifest_sha256: 'c'.repeat(64), board_path: 'board.kicad_pcb' },
  report: { source_sha256: 'd'.repeat(64), tool_version: '10.0.6', units: 'mm', coordinate_frame: 'KiCad absolute', components: [{ id: 'component', reference: 'R1', value: '10k', footprint: 'Synthetic', position: [2, 3], rotation_deg: 0, side: 'front', dnp: true }], pads: [{ id: 'old-pad', component_id: 'component', terminal: '1', net: 'N1', position: [2, 3], type: 'tht' }], copper_nets: { N1: ['old-pad'] }, outline: [[[0, 0], [20, 0], [20, 10], [0, 10], [0, 0]]], cutouts: [], mounting_holes: [], coverage: { pads: 'native' }, unsupported: [], physical_qualification: false }, associations: [],
};
const intake: Intake = { intake_id: 'exact-intake', workspace_id: 'workspace', source_revision_id: source, source_manifest_sha256: 'c'.repeat(64), board_path: 'board.kicad_pcb', available_recipe_id: null, files: [{ path: 'board.kicad_pcb', sha256: 'd'.repeat(64), size: 12, rights: 'Synthetic test rights', coverage: 'native board', unsupported: null }], attempts: [], interpretations: [{ interpretation_id: 'old-report', sha256: 'b'.repeat(64), attempt_id: 'old-attempt', output_id: 'output', report: frozen.report }, { interpretation_id: 'new-report', sha256: 'e'.repeat(64), attempt_id: 'new-attempt', output_id: 'new-output', report: { ...frozen.report, pads: [] } }] };
beforeEach(() => vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} }));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
function setup() {
  let denyIntake = false; const calls: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string) => { calls.push(url); const reply = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });
    if (url.includes('/workspace/library/')) return reply({ record_id: 'population', family: 'definition', kind: 'pcb_population', label: frozen.name, latest_revision: 2, latest_revision_id: 'new-r2', used_in: [] });
    if (url.includes('/catalog/definitions/')) return reply({ definition_id: 'population', name: frozen.name, kind: 'pcb_population', drafts: [], revisions: [{ revision_id: 'old-r1', number: 1 }, { revision_id: 'new-r2', number: 2 }] });
    if (url.includes('/population-revisions/old-r1/review')) return reply(frozen);
    if (url.includes('/catalog/revisions/')) return reply({ variants: [], lots: [], representations: [], source_identifiers: [] });
    if (url.includes('/revision-labels')) return reply({ labels: [], source_labels: [{ revision_id: source, readable: true }] });
    if (url.endsWith('/pcb/intakes/exact-intake')) return denyIntake ? reply({ error: { message: 'Source unavailable' } }, 403) : reply(intake);
    return reply({}); }));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<MantineProvider env="test"><PermissionsProvider permissions={['workspace.read']}><QueryClientProvider client={client}><BoardRecordPage active kind="pcb_population" principalKey="viewer" workspaceId="workspace" definitionId="population" revisionNumber={1} draftRequested={false} projects={[]} onBack={vi.fn()} onSelect={vi.fn()} onCreated={vi.fn()} onDuplicate={vi.fn()} onOpenInProject={vi.fn()} /></QueryClientProvider></PermissionsProvider></MantineProvider>);
  return { calls, deny: () => { denyIntake = true; } };
}
test('frozen population drawing, DNP and option decisions remain distinct at the exact old report', async () => {
  const api = setup(); const pad = await screen.findByRole('button', { name: 'Native pad 1 · R1' }); fireEvent.keyDown(pad, { key: 'Enter' }); expect(await screen.findByText('Native pad old-pad')).toBeTruthy();
  fireEvent.click(screen.getByRole('tab', { name: 'Components' })); expect(await screen.findByText(/DNP set in source/)).toBeTruthy(); expect(screen.getByRole('combobox', { name: 'R1 population decision' })).toHaveProperty('value', 'unknown'); expect(screen.getByRole('combobox', { name: 'R1 population decision' })).toHaveProperty('disabled', true);
  expect(api.calls.some(url => url.includes('new-r2/review'))).toBe(false); expect(screen.queryByRole('button', { name: 'Save population' })).toBeNull(); expect(screen.getByRole('button', { name: 'Native pad 1 · R1' })).toBeTruthy();
});
test('Sources opens one exact intake and withdraws all retained record data when that source is denied', async () => {
  const api = setup(); await screen.findByRole('button', { name: 'Native pad 1 · R1' }); fireEvent.click(screen.getByRole('tab', { name: 'Sources' })); const download = await screen.findByRole('link', { name: 'board.kicad_pcb' }); expect(download.getAttribute('href')).toContain('/pcb/intakes/exact-intake/original'); expect(await screen.findByText(/accepted report old-report/)).toBeTruthy();
  expect(api.calls.some(url => /workspaces\/.+\/intakes/.test(url))).toBe(false); expect(api.calls.filter(url => url.endsWith('/pcb/intakes/exact-intake'))).toHaveLength(1);
  api.deny(); fireEvent.click(screen.getByRole('button', { name: 'Refresh exact source' })); await screen.findByRole('alert', { name: 'Board state unavailable' }); await waitFor(() => expect(screen.queryByRole('link', { name: 'board.kicad_pcb' })).toBeNull()); expect(screen.queryByRole('button', { name: 'Native pad 1 · R1' })).toBeNull();
});
