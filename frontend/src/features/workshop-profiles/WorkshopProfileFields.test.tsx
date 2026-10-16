import { MantineProvider } from '@mantine/core';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useState } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import coax from '../../../../tests/fixtures/wire-stock-coax.json';
import { WorkshopProfileFields, blankProfile } from './WorkshopProfileFields';
import type { WorkshopProfile } from './api';
const revision = '11111111-1111-4111-8111-111111111111';
let latest: WorkshopProfile;
beforeEach(() => {
 Element.prototype.scrollIntoView = vi.fn();
 vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
 vi.stubGlobal('fetch', vi.fn(async (url: string, options?: RequestInit) => {
  if (options?.method === 'POST') throw new Error('Fields never save without the record action.');
  if (url.includes('/snapshot')) return new Response(JSON.stringify({ content: { stock: coax.stock } }));
  return new Response(JSON.stringify({ labels: [], results: [] }));
 }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
function Fields({ profile = blankProfile(revision), editable = true }: { profile?: WorkshopProfile; editable?: boolean }) {
 const [value, setValue] = useState(profile); latest = value;
 return <WorkshopProfileFields profile={value} onChange={setValue} editable={editable} active stateLabel={editable ? 'Working draft' : 'Frozen revision 1'} />;
}
function show(profile?: WorkshopProfile, editable = true) { return render(<MantineProvider><QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><Fields profile={profile} editable={editable} /></QueryClientProvider></MantineProvider>); }
async function choose(label: string, value: string) { fireEvent.click(screen.getByRole('combobox', { name: label })); fireEvent.click(await screen.findByRole('option', { name: value, hidden: true })); }

test('authors independent sourced display and per-end suggestions without inventing dimensions or saving', async () => {
 show(); await screen.findByLabelText('stock.jacket end a cutback mm');
 fireEvent.change(screen.getByLabelText('Basis note or citation'), { target: { value: 'Illustration for bench training' } });
 await choose('Foil visibility', 'hide');
 fireEvent.change(screen.getByLabelText('Illustration lay length mm'), { target: { value: '24' } });
 await choose('Illustration lay direction', 'negative');
 fireEvent.change(screen.getByLabelText('stock.jacket end a cutback mm'), { target: { value: '12' } });
 expect(latest.stock_revision_id).toBe(revision);
 expect(latest.foil_visibility).toMatchObject({ value: 'hide', basis: 'preference', note: 'Illustration for bench training' });
 expect(latest.illustration_lay_length_mm.value).toBe(24);
 expect(latest.illustration_lay_direction).toMatchObject({ value: 'negative', basis: 'preference' });
 expect(latest.element_rules['stock.jacket']!.a.cutback_mm.value).toBe(12);
 expect(latest.element_rules['stock.jacket']!.b.cutback_mm.value).toBeNull();
 expect(JSON.stringify(latest)).not.toMatch(/bond|rating|measured/);
});

test('frozen suggestion provenance stays distinct from new-edit defaults', async () => {
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
 show(frozenProfile, false); await screen.findByLabelText('stock.jacket end a cutback mm');
  const provenance = screen.getByRole('region', { name: 'Recorded workshop practices' });
  expect(provenance.textContent).toContain('Cutback: 40 mm · Basis: documented');
  expect(provenance.textContent).toContain('Unverified citation: Synthetic preparation illustration citation');
  expect(provenance.textContent).toContain('Illustration lay length: Unknown · Basis: unknown');
  expect(provenance.textContent).toContain('Illustration lay direction: positive · Basis: documented');
  expect(provenance.textContent).toContain('Unverified citation: Synthetic direction instruction');
  expect(provenance.textContent).toContain('Omit occluded material: No · Basis: documented');
  expect(provenance.textContent).toContain(revision);
  expect(provenance.textContent).toContain('path “ instructions/occlusion.txt ”');
  expect(provenance.textContent).toContain(`SHA-256 ${'b'.repeat(64)} · rights “ synthetic-test ”`);
  expect(provenance.textContent).toContain('Locator: line 2');
  expect(provenance.textContent).toContain('Prepend cut: 3 mm · Basis: inferred');
  expect(provenance.textContent).toContain('Illustrated lead extent: 8 mm · Basis: preference');
  expect(provenance.textContent).toContain('Illustrated lead diameter: Unknown · Basis: unknown');
  expect(provenance.textContent).toContain('Lead depiction: Unknown (no rule recorded)');
  expect(screen.queryByRole('combobox', { name: 'Basis for new edits' })).toBeNull();
 expect(latest.element_rules['stock.jacket']!.a.cutback_mm.value).toBe(40);
});

test('registered source paths and rights remain exact when authoring a documented suggestion', async () => {
 show(); await screen.findByLabelText('stock.jacket end a cutback mm');
 await choose('Basis for new edits', 'Documented');
 fireEvent.change(screen.getByLabelText('Source bundle revision ID (optional)'), { target: { value: revision } });
 fireEvent.change(screen.getByLabelText('Source file path'), { target: { value: ' instructions/strip.txt ' } });
 fireEvent.change(screen.getByLabelText('Registered source SHA-256'), { target: { value: 'a'.repeat(64) } });
 fireEvent.change(screen.getByLabelText('Registered source rights'), { target: { value: ' synthetic-test ' } });
 await choose('Foil visibility', 'hide');
 expect(latest.foil_visibility.source).toEqual({ kind: 'source_file', bundle_revision_id: revision, path: ' instructions/strip.txt ', locator: '', sha256: 'a'.repeat(64), rights: ' synthetic-test ' });
 expect(screen.getByRole('region', { name: 'Recorded workshop practices' }).textContent).toContain('rights “ synthetic-test ”');
});

test('read-only suggestion fields reject local changes and omit authoring basis inputs', async () => {
 show(undefined, false); const field = await screen.findByLabelText('stock.jacket end a cutback mm');
 fireEvent.change(field, { target: { value: '30' } });
 expect(latest.element_rules).toEqual({});
 expect(screen.queryByLabelText('Basis note or citation')).toBeNull();
 expect((screen.getByRole('combobox', { name: 'Foil visibility' }) as HTMLInputElement).disabled).toBe(true);
});
