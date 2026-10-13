import { MantineProvider } from '@mantine/core';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import coax from '../../../../tests/fixtures/wire-stock-coax.json';
import { WorkshopProfilePanel } from './WorkshopProfilePanel';

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
