import { MantineProvider } from '@mantine/core';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { PermissionsProvider } from '../../lib/permissions';
import type { AdoptionReview, AdoptionRow } from './api';
import { AdoptionReviewPanel } from './AdoptionReview';

const pin = (id: string, name: string, number = 1) => ({ revision_id: id, definition_id: `${id}-def`, kind: 'component', name, number, snapshot_sha256: 'a'.repeat(64) });
const target = pin('asm-rev', 'Synthetic node');
function row(key: string, label: string, action: AdoptionRow['action'], extra: Partial<AdoptionRow> = {}): AdoptionRow {
  return { option_key: key, label, domain: 'part', path: [key], decision_status: 'resolved', source: 'selected', choice: null, action, reason: `${label} reason`, selected: false, before: null, display_ref: null, population_option_before: null, ...extra };
}
function review(payload: { draft_id?: string; option_keys?: string[] }, nested = false): AdoptionReview {
  const keys = payload.option_keys ?? (nested ? ['fitted', 'module-board'] : ['firmware', 'sensor']);
  const rows = [
    row('sensor', 'Sensor part', 'replace_revision', { before: pin('part-a', 'Sensor A'), choice: { key: 'b', label: 'B', revision: pin('part-b', 'Sensor B'), population_option_id: null, value: null }, display_ref: 'S1' }),
    row('firmware', 'Controller firmware', 'assign_firmware', { domain: 'firmware', path: ['board'], before: null, choice: { key: 'fast', label: 'Fast', revision: pin('fw-fast', 'Fast blink'), population_option_id: null, value: null } }),
    row('finish', 'Enclosure finish', 'not_applicable', { domain: 'process', path: null, choice: { key: 'paint', label: 'Painted', revision: null, population_option_id: null, value: 'powder-coat' } }),
    row('sealing', 'Sealing', 'not_applicable', { domain: 'requirement', path: null, decision_status: 'unresolved' }),
    ...(nested ? [
      row('module-board', 'Left module board', 'propagate_revision', { path: ['left', 'board'], before: pin('board-a', 'Board A'), choice: { key: 'alt', label: 'Alt', revision: pin('board-b', 'Board B'), population_option_id: null, value: null }, display_ref: 'A1' }),
      row('fitted', 'Right board population', 'assign_population_option', { domain: 'population', path: ['right', 'board'], before: pin('board-a', 'Board A'), choice: { key: 'bare', label: 'Bare', revision: pin('board-a', 'Board A'), population_option_id: 'no-mcu', value: null } }),
    ] : []),
  ].map((item) => ({ ...item, selected: keys.includes(item.option_key) }));
  const direct = rows.filter((item) => item.selected && (item.action === 'replace_revision' || item.action === 'assign_firmware'));
  const changes: AdoptionReview['changes'] = direct.map((item) => ({ option_keys: [item.option_key], path: item.path!, display_ref: item.display_ref, field: item.action === 'replace_revision' ? 'revision_id' as const : 'firmware' as const, before: item.before, after: item.choice!.revision! }));
  const module = pin('module-rev', 'Synthetic module');
  const propagation: AdoptionReview['propagation'] = nested && keys.includes('module-board') ? [{ path: ['left'], display_ref: 'M1', pinned: module, option_keys: ['module-board'],
    draft: { mode: 'new_draft', base_revision_id: 'module-rev', content_sha256: 'd'.repeat(64) }, result: 'freeze_new_revision',
    changes: [{ local_id: 'board', path: ['left', 'board'], display_ref: 'A1', field: 'revision_id', before: pin('board-a', 'Board A'), after: pin('board-b', 'Board B') }] }] : [];
  if (propagation.length) changes.push({ option_keys: ['module-board'], path: ['left'], display_ref: 'M1', field: 'revision_id', before: module, after: { proposed: true, definition_id: 'module-rev-def', kind: 'assembly', name: 'Synthetic module', path: ['left'] } });
  if (nested && keys.includes('fitted')) changes.push({ option_keys: ['fitted'], path: ['right', 'board'], display_ref: null, field: 'population_option_id', before: null, after: 'no-mcu' });
  return {
    resolved_configuration_id: 'resolved-1', resolution_sha256: 'e'.repeat(64), resolution_status: 'complete', configuration_snapshot_sha256: 'f'.repeat(64), target,
    owner: payload.draft_id ? { mode: 'existing_draft', definition_id: 'asm', draft_id: payload.draft_id, state: 'draft-v2', base_revision_id: 'asm-rev', content_sha256: 'c'.repeat(64) }
      : { mode: 'new_draft', definition_id: 'asm', draft_id: null, state: null, base_revision_id: 'asm-rev', content_sha256: 'c'.repeat(64) },
    option_keys: [...keys].sort(), rows, changes, propagation, requires: propagation.length ? ['design.edit', 'design.freeze'] : ['design.edit'], warnings: [], eligible: changes.length > 0, message: `${changes.length} reviewed change(s) to the owning draft.`,
    review_sha256: `${payload.draft_id ?? 'new'}-${keys.join('-')}`, adoptions: [], history_truncated: false,
  };
}
function response(value: unknown, status = 200) { return new Response(JSON.stringify(value), { status }); }

beforeEach(() => { vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} }); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function setup(permissions: string[], { failFirstAdopt = false, nested = false } = {}) {
  const bodies: Record<string, any>[] = [];
  let adopts = 0;
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith('/catalog/definitions/asm')) return response({ definition_id: 'asm', kind: 'assembly', name: 'Synthetic node', drafts: [{ draft_id: 'asm-draft', state: 'draft-v2', dependencies: [] }], revisions: [{ revision_id: 'asm-rev', number: 1 }] });
    if (url.endsWith('/operations')) {
      const body = JSON.parse(String(init?.body)); bodies.push(body);
      if (body.operation === 'configuration.review_adoption') return response({ result: review(body.payload, nested) });
      if (body.operation === 'configuration.adopt') {
        adopts += 1;
        if (failFirstAdopt && adopts === 1) throw new TypeError('Network unavailable.');
        return response({ result: { draft_id: body.payload.draft_id ?? 'new-draft', state: body.payload.draft_id ? 'draft-v3' : 'draft-v1', definition_id: 'asm', adoption_id: 'adoption-1', created_draft: !body.payload.draft_id, changes: [], propagated: nested ? [{ path: ['left'], definition_id: 'module-rev-def', draft_id: 'module-draft', base_revision_id: 'module-rev', revision_id: 'module-rev-2', number: 2, snapshot_sha256: 'b'.repeat(64) }] : [] } });
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
  // Authoring fields render as inspection: values stay visible but cannot be changed.
  await waitFor(() => expect(screen.getByLabelText('Adopt Sensor part').getAttribute('aria-readonly')).toBe('true'));
  expect((screen.getByLabelText('Adoption basis') as HTMLTextAreaElement).readOnly).toBe(true);
  expect((screen.getByRole('button', { name: 'Adopt 2 changes…' }) as HTMLButtonElement).disabled).toBe(true);
  expect(screen.getByText('Read-only access: requires Edit')).toBeTruthy();
  expect(bodies.every((body) => body.operation === 'configuration.review_adoption')).toBe(true);
});

test('shows a multi-level diff for a nested choice and needs freeze authority to apply it', async () => {
  const bodies = setup(['workspace.read', 'design.edit', 'design.freeze'], { nested: true });
  const diff = await screen.findByRole('table', { name: 'Draft diff' });
  expect(diff.textContent).toContain('New revision of Synthetic module');
  expect(diff.textContent).toContain('Population option');
  expect(diff.textContent).toContain('Not recorded');
  expect(diff.textContent).toContain('Option no-mcu');
  const level = screen.getByRole('table', { name: 'Sub-assembly diff left' });
  expect(level.textContent).toContain('Board A · rev 1');
  expect(level.textContent).toContain('Board B · rev 1');
  expect(screen.getByText(/re-pinned by its parent/).textContent).toContain('Synthetic module · rev 1');
  fireEvent.change(screen.getByLabelText('Adoption basis'), { target: { value: 'Nested synthetic adoption' } });
  fireEvent.click(screen.getByRole('button', { name: 'Adopt 3 changes…' }));
  expect(screen.getByText(/1 containing sub-assembly revision\(s\) will be frozen in the same step/)).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Confirm adoption' }));
  await screen.findByText(/freezing left rev 2/);
  const adopt = bodies.find((body) => body.operation === 'configuration.adopt')!;
  expect(adopt.payload.option_keys).toEqual(['fitted', 'module-board']);
});

test('editors without freeze authority review a nested choice but cannot apply it', async () => {
  setup(['workspace.read', 'design.edit'], { nested: true });
  await screen.findByRole('table', { name: 'Sub-assembly diff left' });
  fireEvent.change(screen.getByLabelText('Adoption basis'), { target: { value: 'Nested synthetic adoption' } });
  expect((screen.getByRole('button', { name: 'Adopt 3 changes…' }) as HTMLButtonElement).disabled).toBe(true);
  expect(document.querySelector('[data-readonly-note="design.freeze"]')).toBeTruthy();
});
