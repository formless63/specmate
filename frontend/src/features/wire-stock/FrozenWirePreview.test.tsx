import { MantineProvider } from '@mantine/core';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { FrozenWirePreview } from './FrozenWirePreview';
import { WireStockPanel } from './WireStockPanel';
import { stockPresets } from './presets';
import { profileRevision } from './profile-test-fixtures';

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  Element.prototype.scrollIntoView = vi.fn();
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const choose = async (label: string, text: RegExp) => {
  const select = await screen.findByRole('combobox', { name: label });
  await waitFor(() => expect((select as HTMLInputElement).disabled).toBe(false));
  fireEvent.click(select); fireEvent.click(await screen.findByText(text));
};
function installApi(exactProfile = profileRevision(), frozenStock = stockPresets.coax!) {
  const draft = structuredClone(stockPresets.coax!);
  const jacket = draft.structure.children[3]!;
  if (jacket.kind !== 'group' && jacket.kind !== 'web') jacket.outer_diameter_mm = 8;
  const fetcher = vi.fn(async (url: string, _options?: RequestInit) => {
    if (url.includes('/api/v0/stocks')) return new Response(JSON.stringify([{ name: 'Editable stock', definition_id: 'stock-definition', draft_id: 'draft1', state: 'draft-v1', content: { stock: draft } }]));
    if (url.includes('/catalog/definitions?')) return new Response(JSON.stringify({ workspace_id: 'workspace', project_id: null, next_after: null, results: [
      { definition_id: 'stock-definition', name: 'Synthetic stock', kind: 'wire_stock' },
      { definition_id: 'profile-definition', name: 'Synthetic profile', kind: 'workshop_profile' },
    ] }));
    if (url.includes('/catalog/definitions/')) return new Response(JSON.stringify({ kind: 'wire_stock', revisions: [{ revision_id: 'stock-r1', number: 1 }, { revision_id: 'stock-r2', number: 2 }] }));
    if (url.endsWith('/snapshot')) return new Response(JSON.stringify({ content: { stock: url.includes('stock-r1') ? frozenStock : draft } }));
    if (url.includes('/workshop-profile-definitions/')) return new Response(JSON.stringify([profileRevision(), profileRevision('stock-r2', 'profile-r2')]));
    if (url.includes('/workshop-profile-revisions/')) return new Response(JSON.stringify(exactProfile));
    throw new Error(`Unexpected URL ${url}`);
  });
  vi.stubGlobal('fetch', fetcher); return fetcher;
}
test('shows pinned construction independently of the edited draft and locks frozen profile suggestions', async () => {
  const fetcher = installApi();
  render(<MantineProvider><WireStockPanel projectId="project1" /></MantineProvider>);
  await choose('Saved stock', /Editable stock/);
  expect(screen.getByText(/Section: 8 mm × 8 mm/)).toBeTruthy();
  await choose('Frozen stock definition', /Synthetic stock/);
  await choose('Exact stock revision', /Synthetic stock · r1/);
  await screen.findByText(/Section: 3 × 3 mm/); expect(screen.getAllByText('stock-r1', { selector: 'code' }).length).toBeGreaterThan(0);
  await choose('Matching frozen profile', /Synthetic stripping · revision 1 · profile-r1/);
  await screen.findAllByText('profile-r1', { selector: 'code' });
  const frozen = within(screen.getByRole('region', { name: 'Frozen stock profile viewer' }));
  const elementSelect = frozen.getByRole('combobox', { name: 'Preview element' });
  fireEvent.click(elementSelect);
  const options = document.getElementById(elementSelect.getAttribute('aria-controls')!)!;
  fireEvent.click(within(options).getByText('stock.jacket'));
  const cut = frozen.getByLabelText('End A cut mm') as HTMLInputElement;
  expect(cut.value).toBe('12'); expect(cut.closest('fieldset')!.disabled).toBe(true);
  expect(frozen.queryByRole('button', { name: 'Reset preview profile' })).toBeNull();
  fireEvent.change(screen.getByLabelText('stock.jacket outer diameter mm'), { target: { value: '9' } });
  expect(screen.getByText(/Section: 9 mm × 9 mm/)).toBeTruthy();
  expect(screen.getByText(/Section: 3 × 3 mm/)).toBeTruthy(); expect(screen.getAllByText('stock-r1', { selector: 'code' }).length).toBeGreaterThan(0);
  expect(fetcher.mock.calls.every(([, options]) => !(options as RequestInit | undefined)?.method)).toBe(true);
  await choose('Exact stock revision', /Synthetic stock · r2/);
  await screen.findByText(/Section: 8 × 8 mm/); expect(screen.getAllByText('stock-r2', { selector: 'code' }).length).toBeGreaterThan(0);
  expect(screen.queryAllByText('profile-r1', { selector: 'code' })).toHaveLength(0);
});
test('rejects mismatching profile reads without drawing them against selected stock', async () => {
  installApi(profileRevision('stock-r2'));
  render(<MantineProvider><FrozenWirePreview projectId="project1" /></MantineProvider>);
  await choose('Frozen stock definition', /Synthetic stock/);
  await choose('Exact stock revision', /Synthetic stock · r1/);
  await choose('Matching frozen profile', /profile-r1/);
  await screen.findByText('Profile and selected stock revision do not match.');
  expect(screen.queryByRole('button', { name: 'Open 3D preview' })).toBeNull();
});
test('project changes clear selected snapshots and do not retain the prior frozen view', async () => {
  installApi();
  const view = render(<MantineProvider><FrozenWirePreview projectId="project1" /></MantineProvider>);
  await choose('Frozen stock definition', /Synthetic stock/); await choose('Exact stock revision', /Synthetic stock · r1/);
  await screen.findAllByText('stock-r1', { selector: 'code' });
  view.rerender(<MantineProvider><FrozenWirePreview projectId="project2" /></MantineProvider>);
  await waitFor(() => expect(screen.queryAllByText('stock-r1', { selector: 'code' })).toHaveLength(0));
});

test('shows readable frozen material dimensions, unknowns and fact sources without raw JSON', async () => {
  const stock = structuredClone(stockPresets.coax!);
  const screenElement = stock.structure.children[2]!;
  if (screenElement.kind !== 'group' && screenElement.kind !== 'web') screenElement.inner_diameter_mm = null;
  installApi(profileRevision(), stock);
  render(<MantineProvider><FrozenWirePreview projectId="project1" /></MantineProvider>);
  await choose('Frozen stock definition', /Synthetic stock/); await choose('Exact stock revision', /Synthetic stock · r1/);
  const table = await screen.findByRole('table', { name: 'Frozen construction materials' });
  const rows = within(table).getAllByRole('row');
  expect(rows).toHaveLength(5);
  const jacket = rows.find(row => row.textContent?.includes('stock.jacket'))!;
  expect(jacket.textContent).toContain('Outer diameter: 3 mm');
  expect(jacket.textContent).toContain('Inner diameter: 2.4 mm');
  expect(jacket.textContent).toContain('Original synthetic arithmetic fixture');
  const shield = rows.find(row => row.textContent?.includes('stock.screen'))!;
  expect(shield.textContent).toContain('Inner diameter: Unknown');
  expect(shield.textContent).toContain('Material: Unknown');
  expect(shield.textContent).toContain('Color: Unknown');
  expect(screen.getByRole('table', { name: 'Frozen construction facts' }).textContent).toContain('Unknown');
  expect(document.querySelector('pre')).toBeNull();
});

test('renders recorded frozen suggestion basis and registered source details directly', async () => {
  const profile = profileRevision();
  profile.content.profile.foil_visibility = {
    value: 'show', basis: 'documented', note: 'Synthetic foil instruction', source: {
      kind: 'source_file', bundle_revision_id: 'source-r1', path: 'synthetic/strip-guide.txt',
      locator: 'Section 4', sha256: 'c'.repeat(64), rights: 'CC0-1.0',
    },
  };
  installApi(profile);
  render(<MantineProvider><FrozenWirePreview projectId="project1" /></MantineProvider>);
  await choose('Frozen stock definition', /Synthetic stock/); await choose('Exact stock revision', /Synthetic stock · r1/);
  await choose('Matching frozen profile', /profile-r1/);
  const recorded = await screen.findByRole('region', { name: 'Recorded workshop practices' });
  expect(recorded.textContent).toContain('Basis: documented');
  expect(recorded.textContent).toContain('Synthetic foil instruction');
  expect(recorded.textContent).toContain('source-r1');
  expect(recorded.textContent).toContain('synthetic/strip-guide.txt');
  expect(recorded.textContent).toContain('Section 4');
  expect(recorded.textContent).toContain('c'.repeat(64));
  expect(recorded.textContent).toContain('CC0-1.0');
  expect(recorded.textContent).toContain('Unknown');
  expect(document.querySelector('pre')).toBeNull();
});
