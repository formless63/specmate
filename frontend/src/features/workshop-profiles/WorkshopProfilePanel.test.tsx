import { MantineProvider } from '@mantine/core';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import coax from '../../../../tests/fixtures/wire-stock-coax.json';
import { WorkshopProfilePanel } from './WorkshopProfilePanel';
import type { WorkshopProfile } from './api';

const revision = '11111111-1111-4111-8111-111111111111';
const stock = { definition_id: 'stock-definition', draft_id: 'stock-draft', name: 'Synthetic coax', base_revision_id: revision };
let savedProfile: Record<string, unknown> | null;
let calls: Array<{ operation: string; payload: Record<string, unknown>; expected_state: string | null }>;

beforeEach(() => {
  savedProfile = null; calls = [];
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  Element.prototype.scrollIntoView = vi.fn();
  vi.stubGlobal('fetch', vi.fn().mockImplementation(async (url: string, options?: RequestInit) => {
    if (url.endsWith('/stocks')) return new Response(JSON.stringify([stock]));
    if (url.endsWith('/workshop-profiles')) return new Response(JSON.stringify(savedProfile ? [savedProfile] : []));
    if (url.endsWith(`/revisions/${revision}/snapshot`)) return new Response(JSON.stringify({ content: { stock: coax.stock } }));
    if (url.endsWith('/revisions')) return new Response('[]');
    if (url === '/api/v0/operations' && options?.method === 'POST') {
      const command = JSON.parse(options.body as string);
      calls.push(command);
      if (command.operation === 'workshop_profile.create') {
        savedProfile = { definition_id: 'profile-definition', draft_id: 'profile-draft', name: command.payload.name,
          state: 'draft-v1', base_revision_id: null, content: { profile: command.payload.profile } };
        return new Response(JSON.stringify({ result: savedProfile }));
      }
      if (command.operation === 'workshop_profile.freeze') {
        return new Response(JSON.stringify({ result: { revision_id: 'profile-revision', number: 1, draft: { state: 'draft-v2' } } }));
      }
    }
    throw new Error(`Unexpected URL ${url}`);
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const show = () => render(<MantineProvider><WorkshopProfilePanel projectId="project-1" /></MantineProvider>);

test('saves independent sourced display and per-end cut suggestions, then freezes exact profile', async () => {
  show();
  fireEvent.click(await screen.findByRole('combobox', { name: 'Start from frozen stock' }));
  fireEvent.click(await screen.findByText(`Synthetic coax · ${revision}`));
  await screen.findByLabelText('stock.jacket end a cutback mm');
  fireEvent.change(screen.getByLabelText('Profile name'), { target: { value: 'Synthetic strip drawing' } });
  fireEvent.change(screen.getByLabelText('Basis note or citation'), { target: { value: 'Illustration for bench training' } });
  fireEvent.click(screen.getByRole('combobox', { name: 'Foil visibility' }));
  fireEvent.click(await screen.findByText('hide'));
  fireEvent.change(screen.getByLabelText('Illustration lay length mm'), { target: { value: '24' } });
  fireEvent.click(screen.getByRole('combobox', { name: 'Illustration lay direction' }));
  fireEvent.click(await screen.findByText('negative'));
  fireEvent.change(screen.getByLabelText('stock.jacket end a cutback mm'), { target: { value: '12' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save profile' }));
  await screen.findByText('Saved Synthetic strip drawing (draft-v1).');
  const created = calls[0]!;
  expect(created.operation).toBe('workshop_profile.create');
  expect(created.payload.project_id).toBe('project-1');
  const profile = created.payload.profile as Record<string, any>;
  expect(profile.stock_revision_id).toBe(revision);
  expect(profile.foil_visibility).toMatchObject({ value: 'hide', basis: 'preference', note: 'Illustration for bench training' });
  expect(profile.illustration_lay_length_mm.value).toBe(24);
  expect(profile.illustration_lay_direction).toMatchObject({ value: 'negative', basis: 'preference', note: 'Illustration for bench training' });
  expect(profile.element_rules['stock.jacket'].a.cutback_mm.value).toBe(12);
  expect(profile.element_rules['stock.jacket'].b.cutback_mm.value).toBeNull();
  expect(JSON.stringify(profile)).not.toMatch(/bond|rating|measured/);
  fireEvent.click(screen.getByRole('button', { name: 'Freeze profile' }));
  await waitFor(() => expect(calls[1]).toMatchObject({ operation: 'workshop_profile.freeze', expected_state: 'draft-v1' }));
});

test('without a frozen stock revision, no profile can be saved', async () => {
  show();
  await screen.findByRole('combobox', { name: 'Start from frozen stock' });
  expect(screen.getByText('Select a frozen stock revision to prepare a profile.')).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Save profile' })).toBeNull();
});

test('fresh selection shows frozen suggestion provenance instead of new-edit defaults', async () => {
  const unknown = { value: null, basis: 'unknown', source: null, note: null } as const;
  const frozenProfile: WorkshopProfile = {
    schema_version: '1', stock_revision_id: revision,
    foil_visibility: { value: 'hide', basis: 'documented', note: null,
      source: { kind: 'citation', citation: 'Synthetic preparation illustration citation' } },
    illustration_lay_length_mm: unknown,
    illustration_lay_direction: { value: 'positive', basis: 'documented', note: null,
      source: { kind: 'citation', citation: 'Synthetic direction instruction' } },
    omit_occluded: { value: false, basis: 'documented', note: null,
      source: { kind: 'source_file', bundle_revision_id: revision, path: ' instructions/occlusion.txt ',
        locator: 'line 2', sha256: 'b'.repeat(64), rights: ' synthetic-test ' } },
    hidden_element_paths: ['stock.screen'],
    element_rules: { 'stock.jacket': {
      a: { cutback_mm: { value: 40, basis: 'documented', note: null,
        source: { kind: 'citation', citation: 'Synthetic preparation illustration citation' } },
        prepend_cut_mm: { value: 3, basis: 'inferred', note: 'Illustrative extension.', source: null },
        lead: { length_mm: { value: 8, basis: 'preference', note: 'Show separate strands.', source: null },
          diameter_mm: unknown, reach_mm: unknown, angle_deg: unknown } },
      b: { cutback_mm: unknown, prepend_cut_mm: unknown, lead: null },
    } },
  };
  const draftProfile = structuredClone(frozenProfile);
  draftProfile.element_rules['stock.jacket']!.a.cutback_mm = {
    value: 12, basis: 'preference', note: 'New draft only.', source: null,
  };
  const record = { definition_id: 'profile-definition', draft_id: 'profile-draft', name: 'Synthetic preparation',
    state: 'draft-v3', base_revision_id: 'profile-revision', content: { profile: draftProfile } };
  const exact = { revision_id: 'profile-revision', definition_id: 'profile-definition', name: record.name,
    number: 1, sha256: 'a'.repeat(64), content: { profile: frozenProfile } };
  vi.stubGlobal('fetch', vi.fn().mockImplementation(async (url: string, options?: RequestInit) => {
    if (options?.method === 'POST') throw new Error('Viewing must not save.');
    if (url.endsWith('/stocks')) return new Response(JSON.stringify([stock]));
    if (url.endsWith('/workshop-profiles')) return new Response(JSON.stringify([record]));
    if (url.endsWith(`/revisions/${revision}/snapshot`)) return new Response(JSON.stringify({ content: { stock: coax.stock } }));
    if (url.endsWith('/workshop-profile-definitions/profile-definition/revisions')) return new Response(JSON.stringify([exact]));
    if (url.endsWith('/workshop-profile-revisions/profile-revision')) return new Response(JSON.stringify(exact));
    throw new Error(`Unexpected URL ${url}`);
  }));
  show();
  fireEvent.click(await screen.findByRole('combobox', { name: 'Saved profile' }));
  fireEvent.click(await screen.findByText('Synthetic preparation'));
  await screen.findByText(/New draft only/);
  expect(screen.getByLabelText('Basis note or citation')).toHaveProperty('value', '');
  expect(screen.getByRole('combobox', { name: 'Basis for new edits' })).toHaveProperty('value', 'Workshop preference');
  fireEvent.click(screen.getByRole('combobox', { name: 'Frozen profile revision' }));
  fireEvent.click(await screen.findByText(/Revision 1/));
  await screen.findByText(/Viewing immutable revision 1/);
  const provenance = screen.getByRole('region', { name: 'Recorded workshop practices' });
  expect(provenance.textContent).toContain('Cutback: 40 mm · Basis: documented');
  expect(provenance.textContent).toContain('Unverified citation: Synthetic preparation illustration citation');
  expect(provenance.textContent).toContain('Illustration lay length: Unknown · Basis: unknown');
  expect(provenance.textContent).toContain('Illustration lay direction: positive · Basis: documented');
  expect(provenance.textContent).toContain('Unverified citation: Synthetic direction instruction');
  expect(provenance.textContent).toContain('Omit occluded material: No · Basis: documented');
  expect(provenance.textContent).toContain(`bundle revision ${revision} · path “ instructions/occlusion.txt ”`);
  expect(provenance.textContent).toContain(`SHA-256 ${'b'.repeat(64)} · rights “ synthetic-test ”`);
  expect(provenance.textContent).toContain('Locator: line 2');
  expect(provenance.textContent).toContain('Prepend cut: 3 mm · Basis: inferred');
  expect(provenance.textContent).toContain('Illustrated lead extent: 8 mm · Basis: preference');
  expect(provenance.textContent).toContain('Illustrated lead diameter: Unknown · Basis: unknown');
  expect(provenance.textContent).toContain('Lead depiction: Unknown (no rule recorded)');
  expect(screen.queryByRole('combobox', { name: 'Basis for new edits' })).toBeNull();
  expect(calls).toHaveLength(0);
  expect(record.content.profile.element_rules['stock.jacket']!.a.cutback_mm.value).toBe(12);
});

test('keeps registered source path and rights exact when authoring a documented suggestion', async () => {
  show();
  fireEvent.click(await screen.findByRole('combobox', { name: 'Start from frozen stock' }));
  fireEvent.click(await screen.findByText(`Synthetic coax · ${revision}`));
  await screen.findByRole('combobox', { name: 'Foil visibility' });
  fireEvent.change(screen.getByLabelText('Profile name'), { target: { value: 'Synthetic documented practice' } });
  fireEvent.click(screen.getByRole('combobox', { name: 'Basis for new edits' }));
  fireEvent.click(await screen.findByText('Documented'));
  fireEvent.change(screen.getByLabelText('Source bundle revision ID (optional)'), { target: { value: revision } });
  fireEvent.change(screen.getByLabelText('Source file path'), { target: { value: ' instructions/strip.txt ' } });
  fireEvent.change(screen.getByLabelText('Registered source SHA-256'), { target: { value: 'a'.repeat(64) } });
  fireEvent.change(screen.getByLabelText('Registered source rights'), { target: { value: ' synthetic-test ' } });
  fireEvent.click(screen.getByRole('combobox', { name: 'Foil visibility' }));
  fireEvent.click(await screen.findByText('hide'));
  fireEvent.click(screen.getByRole('button', { name: 'Save profile' }));
  await screen.findByText('Saved Synthetic documented practice (draft-v1).');
  const source = (calls[0]!.payload.profile as WorkshopProfile).foil_visibility.source;
  expect(source).toEqual({ kind: 'source_file', bundle_revision_id: revision,
    path: ' instructions/strip.txt ', locator: '', sha256: 'a'.repeat(64), rights: ' synthetic-test ' });
  const provenance = screen.getByRole('region', { name: 'Recorded workshop practices' });
  expect(provenance.textContent).toContain('path “ instructions/strip.txt ”');
  expect(provenance.textContent).toContain('rights “ synthetic-test ”');
});
