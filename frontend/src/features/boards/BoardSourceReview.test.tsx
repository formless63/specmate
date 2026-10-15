import { MantineProvider } from '@mantine/core';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { PermissionsProvider } from '../../lib/permissions';
import type { PopulationReview } from '../pcb/api';
import { BoardSourceReview } from './BoardSourceReview';
const source = '00000000-0000-4000-8000-000000000001';
const review: PopulationReview = { name: 'Synthetic population', population: { schema_version: '1', interpretation_id: 'interpretation', interpretation_sha256: 'a'.repeat(64), source_revision_id: source, source_manifest_sha256: 'b'.repeat(64), options: [], associations: [] }, interpretation: { intake_id: 'intake', interpretation_id: 'interpretation', sha256: 'a'.repeat(64), attempt_id: 'attempt', output_id: 'output', source_revision_id: source, source_manifest_sha256: 'b'.repeat(64), board_path: 'board.kicad_pcb' }, report: { source_sha256: 'c'.repeat(64), units: 'mm', tool_version: '10.0.6', coordinate_frame: 'KiCad absolute', components: [], pads: [], copper_nets: {}, outline: [], cutouts: [], mounting_holes: [], coverage: {}, unsupported: [], physical_qualification: false }, associations: [] };
beforeEach(() => vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} }));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
test('actual human assertion editor retains partial terminal fields on hidden denial and submits exact preserved pins', async () => {
  let denied = false; const posts: { operation: string; payload: { value: { source: object; coverage_basis: string } } }[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => { const reply = (data: unknown) => new Response(JSON.stringify(data));
    const pin = { source_revision_id: source, manifest_sha256: 'b'.repeat(64), path: 'board.kicad_pcb', sha256: 'c'.repeat(64), rights: 'Synthetic rights' };
    if (url.endsWith('/pcb/intakes/intake')) return reply({ intake_id: 'intake', source_revision_id: source, source_manifest_sha256: 'b'.repeat(64), files: [{ path: pin.path, sha256: pin.sha256, rights: pin.rights }], interpretations: [] });
    if (url.includes('/catalog/revision-labels')) return reply({ labels: [], source_labels: [{ revision_id: source, readable: !denied }] });
    if (url.includes('/pcb-disagreement/sources/')) return reply({ files: [pin], coverage: 'preserved' });
    if (url.endsWith('/operations')) { const body = JSON.parse(String(init?.body)); posts.push(body); return reply({ result: { definition_id: 'assertion', draft_id: 'draft', state: 'draft-v1', content: { pcb_assertion: body.payload.value }, projection: {} } }); }
    if (url.includes('/pcb-disagreement/drafts/')) return reply({ definition_id: 'assertion', draft_id: 'draft', state: 'draft-v1', content: { pcb_assertion: posts[0]?.payload.value }, projection: {} });
    return reply({}); }));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const tree = (active: boolean) => <MantineProvider env="test"><PermissionsProvider permissions={['workspace.read', 'item.create', 'design.edit', 'design.freeze']}><QueryClientProvider client={client}><BoardSourceReview review={review} active={active} principalKey="principal" workspaceId="workspace" onAccessLost={vi.fn()} /></QueryClientProvider></PermissionsProvider></MantineProvider>;
  const view = render(tree(true)); const name = await screen.findByRole('textbox', { name: 'Assertion name' }); fireEvent.change(name, { target: { value: 'Synthetic assertion' } }); fireEvent.change(screen.getByRole('textbox', { name: 'Coverage declaration basis' }), { target: { value: 'Reviewed preserved drawing' } }); fireEvent.change(screen.getByRole('textbox', { name: 'Assertion terminal ID' }), { target: { value: 'partial-unsaved-terminal' } });
  view.rerender(tree(false)); denied = true; view.rerender(tree(true)); await screen.findByText(/Source review unavailable/); expect(screen.queryByRole('textbox', { name: 'Assertion terminal ID' })).toBeNull();
  denied = false; fireEvent.click(screen.getByRole('button', { name: 'Refresh source-review access' })); expect(await screen.findByRole('textbox', { name: 'Assertion terminal ID' })).toHaveProperty('value', 'partial-unsaved-terminal');
  fireEvent.click(screen.getByRole('button', { name: 'Save source review' })); await waitFor(() => expect(posts).toHaveLength(1)); expect(posts[0]?.operation).toBe('pcb_disagreement.create'); expect(posts[0]?.payload.value.coverage_basis).toBe('Reviewed preserved drawing'); expect(posts[0]?.payload.value.source).toEqual({ source_revision_id: source, manifest_sha256: 'b'.repeat(64), path: 'board.kicad_pcb', sha256: 'c'.repeat(64), rights: 'Synthetic rights' });
});
