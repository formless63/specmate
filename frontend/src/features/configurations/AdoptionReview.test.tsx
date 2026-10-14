import { MantineProvider } from '@mantine/core';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { PermissionsProvider } from '../../lib/permissions';
import type { AdoptionReview, AdoptionRow } from './api';
import { AdoptionReviewPanel } from './AdoptionReview';

const pin = (id: string, name: string, number = 1) => ({ revision_id: id, definition_id: `${id}-def`, kind: 'component', name, number, snapshot_sha256: 'a'.repeat(64) });
const target = pin('asm-rev', 'Synthetic node');
function row(key: string, label: string, action: AdoptionRow['action'], extra: Partial<AdoptionRow> = {}): AdoptionRow {
  return { option_key: key, label, domain: 'part', path: [key], decision_status: 'resolved', source: 'selected', choice: null, action, reason: `${label} reason`, selected: false, before: null, display_ref: null, ...extra };
}
function review(payload: { draft_id?: string; option_keys?: string[] }): AdoptionReview {
  const keys = payload.option_keys ?? ['firmware', 'sensor'];
  const rows = [
    row('sensor', 'Sensor part', 'replace_revision', { before: pin('part-a', 'Sensor A'), choice: { key: 'b', label: 'B', revision: pin('part-b', 'Sensor B'), population_option_id: null, value: null }, display_ref: 'S1' }),
    row('firmware', 'Controller firmware', 'assign_firmware', { domain: 'firmware', path: ['board'], before: null, choice: { key: 'fast', label: 'Fast', revision: pin('fw-fast', 'Fast blink'), population_option_id: null, value: null } }),
    row('finish', 'Enclosure finish', 'not_applicable', { domain: 'process', path: null, choice: { key: 'paint', label: 'Painted', revision: null, population_option_id: null, value: 'powder-coat' } }),
    row('sealing', 'Sealing', 'not_applicable', { domain: 'requirement', path: null, decision_status: 'unresolved' }),
  ].map((item) => ({ ...item, selected: keys.includes(item.option_key) }));
  const changes = rows.filter((item) => item.selected).map((item) => ({ option_key: item.option_key, path: item.path!, display_ref: item.display_ref, field: item.action === 'replace_revision' ? 'revision_id' as const : 'firmware' as const, before: item.before, after: item.choice!.revision! }));
  return {
    resolved_configuration_id: 'resolved-1', resolution_sha256: 'e'.repeat(64), resolution_status: 'complete', configuration_snapshot_sha256: 'f'.repeat(64), target,
    owner: payload.draft_id ? { mode: 'existing_draft', definition_id: 'asm', draft_id: payload.draft_id, state: 'draft-v2', base_revision_id: 'asm-rev', content_sha256: 'c'.repeat(64) }
      : { mode: 'new_draft', definition_id: 'asm', draft_id: null, state: null, base_revision_id: 'asm-rev', content_sha256: 'c'.repeat(64) },
    option_keys: [...keys].sort(), rows, changes, warnings: [], eligible: changes.length > 0, message: `${changes.length} reviewed change(s) to the owning draft.`,
    review_sha256: `${payload.draft_id ?? 'new'}-${keys.join('-')}`, adoptions: [], history_truncated: false,
  };
}
function response(value: unknown, status = 200) { return new Response(JSON.stringify(value), { status }); }

beforeEach(() => { vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} }); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function setup(permissions: string[], { failFirstAdopt = false } = {}) {
  const bodies: Record<string, any>[] = [];
  let adopts = 0;
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith('/catalog/definitions/asm')) return response({ definition_id: 'asm', kind: 'assembly', name: 'Synthetic node', drafts: [{ draft_id: 'asm-draft', state: 'draft-v2', dependencies: [] }], revisions: [{ revision_id: 'asm-rev', number: 1 }] });
    if (url.endsWith('/operations')) {
      const body = JSON.parse(String(init?.body)); bodies.push(body);
      if (body.operation === 'configuration.review_adoption') return response({ result: review(body.payload) });
      if (body.operation === 'configuration.adopt') {
        adopts += 1;
        if (failFirstAdopt && adopts === 1) throw new TypeError('Network unavailable.');
        return response({ result: { draft_id: body.payload.draft_id ?? 'new-draft', state: body.payload.draft_id ? 'draft-v3' : 'draft-v1', definition_id: 'asm', adoption_id: 'adoption-1', created_draft: !body.payload.draft_id, changes: [] } });
      }
    }
    throw new Error(`Unexpected request ${url}`);
  }));
  render(<MantineProvider><PermissionsProvider permissions={permissions}><AdoptionReviewPanel resolvedId="resolved-1" /></PermissionsProvider></MantineProvider>);
  return bodies;
}

test('shows the exact draft diff and adopts into a new draft only after explicit confirmation', async () => {
  const bodies = setup(['workspace.read', 'design.edit'], { failFirstAdopt: true });
  const diff = await screen.findByRole('table', { name: 'Draft diff' });
  expect(diff.textContent).toContain('Sensor A · rev 1');
  expect(diff.textContent).toContain('Sensor B · rev 1');
  expect(diff.textContent).toContain('Unassigned');
  expect(screen.getAllByText('Not an assembly field')).toHaveLength(2);
  expect(screen.getByText('No resolved choice (unresolved)')).toBeTruthy();
  const start = screen.getByRole('button', { name: 'Adopt 2 changes…' }) as HTMLButtonElement;
  expect(start.disabled).toBe(true);
  fireEvent.change(screen.getByLabelText('Adoption basis'), { target: { value: 'Synthetic adoption review' } });
  fireEvent.click(start);
  expect(bodies.some((body) => body.operation === 'configuration.adopt')).toBe(false);
  fireEvent.click(screen.getByRole('button', { name: 'Confirm adoption' }));
  await screen.findByText('Network unavailable. Review the diff again if the draft or selection changed.');
  fireEvent.click(screen.getByRole('button', { name: 'Retry same request' }));
  await screen.findByText(/Adopted 0 change\(s\) into draft new-draf/);
  const adopts = bodies.filter((body) => body.operation === 'configuration.adopt');
  expect(adopts).toHaveLength(2);
  expect(adopts[0]!.idempotency_key).toBe(adopts[1]!.idempotency_key);
  expect(adopts[0]!.expected_state).toBeUndefined();
  expect(adopts[0]!.payload).toEqual({ resolved_configuration_id: 'resolved-1', option_keys: ['firmware', 'sensor'], review_sha256: 'new-firmware-sensor', basis: 'Synthetic adoption review' });
});

test('re-reviews explicit selections and applies to a selected draft under compare-and-set', async () => {
  const bodies = setup(['workspace.read', 'design.edit']);
  await screen.findByRole('table', { name: 'Draft diff' });
  fireEvent.click(screen.getByLabelText('Adopt Controller firmware'));
  await screen.findByRole('button', { name: 'Adopt 1 change…' });
  expect(bodies.at(-1)!.payload).toEqual({ resolved_configuration_id: 'resolved-1', option_keys: ['sensor'] });
  await screen.findByRole('option', { name: 'Draft asm-draf · draft-v2' });
  fireEvent.change(screen.getByLabelText('Adopt into'), { target: { value: 'asm-draft' } });
  await waitFor(() => expect(bodies.at(-1)!.payload).toEqual({ resolved_configuration_id: 'resolved-1', draft_id: 'asm-draft', option_keys: ['sensor'] }));
  await screen.findByText('draft-v2');
  fireEvent.change(screen.getByLabelText('Adoption basis'), { target: { value: 'Selected draft adoption' } });
  fireEvent.click(screen.getByRole('button', { name: 'Adopt 1 change…' }));
  expect(screen.getByText(/will change only if it has not moved since this review/)).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Confirm adoption' }));
  await screen.findByText(/Adopted 0 change\(s\) into draft asm-draf/);
  const adopt = bodies.find((body) => body.operation === 'configuration.adopt')!;
  expect(adopt).toMatchObject({ expected_state: 'draft-v2', payload: { draft_id: 'asm-draft', option_keys: ['sensor'], review_sha256: 'asm-draft-sensor' } });
});

test('read-only principals review the diff without adoption controls', async () => {
  const bodies = setup(['workspace.read']);
  await screen.findByRole('table', { name: 'Draft diff' });
  expect((screen.getByLabelText('Adopt Sensor part') as HTMLInputElement).disabled).toBe(true);
  expect((screen.getByLabelText('Adoption basis') as HTMLTextAreaElement).disabled).toBe(true);
  expect((screen.getByRole('button', { name: 'Adopt 2 changes…' }) as HTMLButtonElement).disabled).toBe(true);
  expect(screen.getByText('Read-only access: requires Edit')).toBeTruthy();
  expect(bodies.every((body) => body.operation === 'configuration.review_adoption')).toBe(true);
});
