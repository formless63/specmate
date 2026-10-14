import { grants } from "../../test/grants";
import { PermissionsProvider } from "../../lib/permissions";
import { MantineProvider } from '@mantine/core';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createHash } from 'node:crypto';
import { Blob as NodeBlob } from 'node:buffer';
import { StrictMode } from 'react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { PreparationDocumentsPanel } from './PreparationDocumentsPanel';
import { download, type Configuration, type Manifest, type Output, type Receipt } from './api';
import { svgSize } from './svg-size';

beforeEach(() => {
  vi.stubGlobal('matchMedia', vi.fn().mockReturnValue({ matches: false, addEventListener() {}, removeEventListener() {} }));
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal('Blob', NodeBlob);
  HTMLElement.prototype.scrollIntoView = vi.fn();
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 320"><text>Original declared diagram</text></svg>';
const bytes = new TextEncoder().encode(svg);
const output: Output = { filename: 'schematic.svg', sha256: createHash('sha256').update(bytes).digest('hex'), size: bytes.length, media_type: 'image/svg+xml', rights: 'unknown', inputs_sha256: 'one-input-hash' };
function manifest(config: Configuration): Manifest {
  return { inputs_sha256: 'one-input-hash', readiness: 'declared_with_unknowns', inputs: { root: { revision_id: config.root_revision_id, snapshot_id: 'root-snapshot', snapshot_sha256: 'root-hash', name: 'Original synthetic assembly', kind: 'assembly' }, generator: 'specmate.preparation-documents/1', format: 'specmate.coordinated-document-set/0.1', configuration: config, physical_test: 'not_performed', physical_continuity: 'not_evaluated', fit: 'not_evaluated', physical_qualification: false, revision_pins: [{ revision_id: 'root-revision', snapshot_id: 'root-snapshot', snapshot_sha256: 'root-hash', name: 'Original frozen root', kind: 'assembly' }], source_pins: [{ bundle_revision_id: 'source-revision', path: 'original.txt', sha256: 'source-hash', rights: 'unknown', source_manifest_sha256: 'source-manifest', ancestry: [] }], rights_reviews: [{ subject: 'design:root-revision', review: { subject: 'design:root-revision', decision: 'unknown', basis: '' } }] }, context_pins: ['left', 'right'].map(side => ({ address: { root_snapshot_id: 'root-snapshot', path: [side], revision_id: 'shared-harness', snapshot_sha256: 'harness-hash' }, kind: 'harness', disposition: side === 'right' ? 'buy' : 'make', sections: [{ section_id: 'shared', stock_revision_id: 'stock-revision', end_ids: ['input-end', 'output-end'] }] })), document_assessments: Object.fromEntries(['specifications.json', 'schematic.svg', 'cut-preparation.csv', 'build-sheet.html', 'terminations.json', 'test-intent.json'].map(n => [n, { status: 'declared_with_unknowns', physical_qualification: 'not_evaluated' }])), issues: [{ path: ['right'], code: 'missing_test_intent', status: 'unknown', message: 'No exact authored test intent is bound.' }], outputs: [output] };
}
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });
function fixture(extraHistory = false) {
  const calls: { operation: string; payload: Configuration; expected_state?: string; idempotency_key?: string }[] = [];
  let deny = false, failGenerate = false, saved: Receipt | null = null;
  const defs = [{ definition_id: 'root', name: 'Original synthetic assembly', kind: 'assembly' }, { definition_id: 'cut', name: 'Original cut profile', kind: 'preparation_profile' }, { definition_id: 'ends', name: 'Original end profile', kind: 'end_preparation_profile' }];
  const fetch = vi.fn(async (url: string, options?: RequestInit) => {
    if (url.endsWith('/operations')) {
      const body = JSON.parse(String(options?.body)); calls.push(body);
      if (deny) return json({ error: { message: 'Source unavailable.' } }, 404);
      if (body.operation === 'preparation_documents.authority') return json({ result: { authorized: true } });
      if (body.operation === 'preparation_documents.review') return json({ result: { manifest: manifest(body.payload), state: 'review-original-token' } });
      if (body.operation === 'preparation_documents.generate') {
        if (failGenerate) { failGenerate = false; return json({ error: { message: 'Original lost response.' } }, 503); }
        saved = { document_set_id: 'set-original', manifest: manifest(body.payload), sha256: 'one-input-hash', generator: 'specmate.preparation-documents/1', created_at: '2026-01-01', created_by_id: 1 };
        return json({ result: saved });
      }
      return json({ result: saved });
    }
    if (url.endsWith('/preparation-documents/download')) return deny ? json({ error: { message: 'Source unavailable.' } }, 404) : new Response(bytes);
    if (url.includes('/catalog/definitions/')) {
      const name = url.split('/definitions/')[1]!.split('?')[0]!;
      const d = defs.find(d => d.definition_id === name)!;
      return json({ ...d, revisions: [{ revision_id: `${name}-revision`, number: 1 }], drafts: [] });
    }
    if (url.endsWith('/definitions')) return json(defs);
    return json({ document_sets: saved ? [saved, ...(extraHistory ? [{ ...saved, document_set_id: 'set-secondary', created_at: '2026-01-02' }] : [])] : [] });
  });
  vi.stubGlobal('fetch', fetch);
  return { calls, fetch, deny: () => { deny = true; }, restore: () => { deny = false; }, failGenerate: () => { failGenerate = true; } };
}
function panel(projectId = 'project', principalKey = 'owner', canGenerate = true) { return <MantineProvider><PermissionsProvider permissions={grants({ edit: canGenerate })}><PreparationDocumentsPanel projectId={projectId} principalKey={principalKey} /></PermissionsProvider></MantineProvider>; }
async function choose(label: string, option: string) {
  const input = await screen.findByRole('combobox', { name: label });
  await waitFor(() => expect(input.hasAttribute('disabled')).toBe(false));
  fireEvent.focus(input); fireEvent.keyDown(input, { key: 'ArrowDown' });
  const listbox = document.querySelector(`[role="listbox"][aria-labelledby="${input.id}-label"]`);
  expect(listbox).not.toBeNull();
  fireEvent.click(await within(listbox as HTMLElement).findByRole('option', { name: option, hidden: true }));
}
async function root() { await choose('Document root definition', 'Original synthetic assembly (assembly)'); await choose('Document root revision', 'Original synthetic assembly · r1'); }
async function review() { fireEvent.click(screen.getByRole('button', { name: 'Review coordinated documents' })); await screen.findByRole('heading', { name: 'Current reviewed document inputs' }); }
async function generate() { fireEvent.click(screen.getByRole('button', { name: 'Generate reviewed document set' })); await screen.findByRole('heading', { name: 'Retained immutable document set' }); }

test('exact contextual binding preserves physical end IDs, null quantity and six unresolved assessments', async () => {
  const f = fixture(); render(panel()); await root(); await review();
  fireEvent.click(screen.getByRole('button', { name: 'Bind right · harness' }));
  await choose('Cut profile shared definition', 'Original cut profile (preparation_profile)');
  await choose('Cut profile shared revision', 'Original cut profile · r1');
  await choose('End profile shared definition', 'Original end profile (end_preparation_profile)');
  await choose('End profile shared revision', 'Original end profile · r1');
  await choose('Profile A physical end shared', 'output-end');
  await choose('Profile B physical end shared', 'input-end');
  fireEvent.change(screen.getByLabelText('End mapping basis shared'), { target: { value: 'Original reversed exact end mapping' } });
  fireEvent.change(screen.getByLabelText('Document quantity (blank means unknown)'), { target: { value: '' } });
  expect(screen.getByRole('button', { name: 'Generate reviewed document set' }).hasAttribute('disabled')).toBe(true);
  await review(); await generate();
  const sent = f.calls.find(c => c.operation === 'preparation_documents.generate')!;
  expect(sent.payload.quantity).toBeNull();
  expect(sent.payload.bindings).toEqual([{ occurrence_path: ['right'], cut_profiles: [{ section_id: 'shared', profile_revision_id: 'cut-revision' }], end_profiles: [{ section_id: 'shared', profile_revision_id: 'ends-revision', a_end_id: 'output-end', b_end_id: 'input-end', mapping_review: 'unreviewed', mapping_basis: 'Original reversed exact end mapping' }], test_plan_revision_id: null }]);
  expect(sent.expected_state).toBe('review-original-token');
  expect(screen.getAllByText('cut-preparation.csv')).toHaveLength(2);
  expect(screen.getAllByText(/Physical test not_performed/)).toHaveLength(2);
});

test('retry retains stable reviewed token/key and denial recovery retains prepared declarations', async () => {
  const f = fixture(); render(panel()); await root();
  fireEvent.change(screen.getByLabelText('Generated output rights basis'), { target: { value: 'Original prepared rights basis' } });
  await review(); f.failGenerate();
  fireEvent.click(screen.getByRole('button', { name: 'Generate reviewed document set' }));
  await screen.findByText('Original lost response.');
  await generate();
  const attempts = f.calls.filter(c => c.operation === 'preparation_documents.generate');
  expect(attempts[0]!.idempotency_key).toBe(attempts[1]!.idempotency_key);
  expect(attempts[0]!.expected_state).toBe(attempts[1]!.expected_state);
  f.deny(); fireEvent.click(screen.getByRole('button', { name: 'Download schematic.svg' }));
  await screen.findByText(/Document metadata and staged fields are hidden/);
  expect(screen.queryByText(/source-revision \/ original.txt/)).toBeNull();
  expect(screen.getByLabelText('Generated output rights basis').closest('fieldset')?.hasAttribute('inert')).toBe(true);
  expect(screen.getByLabelText('Generated output rights basis').closest('fieldset')?.style.display).toBe('none');
  f.restore(); fireEvent.click(screen.getByRole('button', { name: 'Refresh document access and choices' }));
  await waitFor(() => expect(screen.getByLabelText('Generated output rights basis').closest('fieldset')?.style.display).not.toBe('none'));
  expect((screen.getByLabelText('Generated output rights basis') as HTMLTextAreaElement).value).toBe('Original prepared rights basis');
  fireEvent.click(screen.getByRole('button', { name: 'Generate reviewed document set' }));
  await waitFor(() => expect(f.calls.filter(c => c.operation === 'preparation_documents.generate')).toHaveLength(3));
  expect(f.calls.filter(c => c.operation === 'preparation_documents.generate')[2]!.idempotency_key).toBe(attempts[0]!.idempotency_key);
});

test('viewer review never enables engineering generation and downloaded preview is sandboxed', async () => {
  fixture(); const view = render(panel('project', 'viewer', false)); await root(); await review();
  expect(screen.getByRole('button', { name: 'Generate reviewed document set' }).hasAttribute('disabled')).toBe(true);
  view.rerender(panel('project', 'owner', true)); await root(); await review(); await generate();
  fireEvent.click(screen.getByRole('button', { name: 'Preview declared schematic' }));
  const iframe = await screen.findByTitle('Declared schematic preview');
  expect(iframe.getAttribute('sandbox')).toBe('');
  expect(iframe.getAttribute('srcdoc')).toBe(svg);
  expect(iframe.getAttribute('style')).toContain('800 / 320');
});

test('held review cannot leak through principal/project reset or StrictMode disposal', async () => {
  const f = fixture(); const view = render(<StrictMode>{panel()}</StrictMode>); await root();
  let resolve!: (r: Response) => void;
  const original = f.fetch.getMockImplementation()!;
  f.fetch.mockImplementation((url: string, options?: RequestInit) => url.endsWith('/operations') ? new Promise<Response>(r => { resolve = r; }) : original(url, options));
  fireEvent.click(screen.getByRole('button', { name: 'Review coordinated documents' }));
  await waitFor(() => expect(resolve).toBeTypeOf('function'));
  view.rerender(panel('other-project', 'other-principal'));
  resolve(json({ result: { manifest: manifest({ root_revision_id: 'OLD-PRIVATE-ROOT' } as Configuration), state: 'old-token' } }));
  await waitFor(() => expect(screen.getByLabelText('Document quantity (blank means unknown)')).toBeTruthy());
  expect(screen.queryByText(/OLD-PRIVATE-ROOT/)).toBeNull();
  expect(screen.queryByRole('heading', { name: 'Current reviewed document inputs' })).toBeNull();
  expect(screen.getByRole('button', { name: 'Generate reviewed document set' }).hasAttribute('disabled')).toBe(true);
});

test('independent byte corruption blocks download; licensed viewBox helper retains explicit unknowns', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response('changed original bytes')));
  await expect(download('set', output)).rejects.toThrow('hash or size mismatch');
  expect(svgSize(svg)).toEqual({ width: 800, height: 320 });
  expect(svgSize('<svg viewBox="0,0,5,7"></svg>')).toEqual({ width: 5, height: 7 });
  for (const content of ['<svg></svg>', '<svg viewBox="0 0 Infinity 7">', '<svg viewBox="0 0 -2 7">', '<svg viewBox="0 0 0 7">', '<svg><g viewBox="0 0 5 7"></g></svg>']) expect(svgSize(content)).toBeUndefined();
});

test('held review hides cached protected manifests and SVG until input and selected receipt authority complete', async () => {
  const f = fixture(); render(panel()); await root(); await review(); await generate();
  fireEvent.click(screen.getByRole('button', { name: 'Preview declared schematic' }));
  await screen.findByTitle('Declared schematic preview');
  const original = f.fetch.getMockImplementation()!;
  let finish!: (response: Response) => void;
  f.fetch.mockImplementation((url: string, options?: RequestInit) => {
    if (!finish && url.endsWith('/operations') && JSON.parse(String(options?.body)).operation === 'preparation_documents.review') return new Promise<Response>(r => { finish = r; });
    return original(url, options);
  });
  fireEvent.click(screen.getByRole('button', { name: 'Review coordinated documents' }));
  await waitFor(() => expect(finish).toBeTypeOf('function'));
  expect(screen.queryByRole('heading', { name: 'Retained coordinated provenance' })).toBeNull();
  expect(screen.queryByRole('heading', { name: 'Current reviewed document inputs' })).toBeNull();
  expect(screen.queryByTitle('Declared schematic preview')).toBeNull();
  finish(json({ result: { manifest: manifest(f.calls.find(c => c.operation === 'preparation_documents.generate')!.payload), state: 'review-original-token' } }));
  await screen.findByRole('heading', { name: 'Retained coordinated provenance' });
  expect(f.calls.some(c => c.operation === 'preparation_documents.read')).toBe(true);
});

test('held download and historic receipt reads hide all earlier protected review evidence', async () => {
  const f = fixture(true); render(panel()); await root(); await review(); await generate();
  const original = f.fetch.getMockImplementation()!;
  let finish!: (response: Response) => void;
  f.fetch.mockImplementation((url: string, options?: RequestInit) => url.endsWith('/preparation-documents/download') ? new Promise<Response>(r => { finish = r; }) : original(url, options));
  fireEvent.click(screen.getByRole('button', { name: 'Preview declared schematic' }));
  await waitFor(() => expect(finish).toBeTypeOf('function'));
  expect(screen.queryByRole('heading', { name: 'Current reviewed document inputs' })).toBeNull();
  finish(new Response(bytes));
  await screen.findByTitle('Declared schematic preview');
  f.fetch.mockImplementation((url: string, options?: RequestInit) => url.endsWith('/operations') && JSON.parse(String(options?.body)).operation === 'preparation_documents.read' ? new Promise<Response>(r => { finish = r; }) : original(url, options));
  finish = undefined as unknown as (response: Response) => void;
  await choose('Retained document history', 'Original synthetic assembly · 2026-01-02 · set-secondary');
  await waitFor(() => expect(finish).toBeTypeOf('function'));
  expect(screen.queryByRole('heading', { name: 'Current reviewed document inputs' })).toBeNull();
  expect(screen.queryByTitle('Declared schematic preview')).toBeNull();
});

test('blur/focus and inactive/return preserve staging and original retry token/key behind fresh closure fences', async () => {
  const f = fixture(); const view = render(panel()); await root();
  fireEvent.change(screen.getByLabelText('Generated output rights basis'), { target: { value: 'Original staged scope recovery basis' } });
  await review(); await generate();
  const packet = f.calls.find(c => c.operation === 'preparation_documents.generate')!;
  fireEvent.blur(window);
  expect(screen.queryByRole('heading', { name: 'Retained coordinated provenance' })).toBeNull();
  expect(screen.getByLabelText('Generated output rights basis').closest('fieldset')?.hasAttribute('inert')).toBe(true);
  expect(screen.getByLabelText('Generated output rights basis').closest('fieldset')?.style.display).toBe('none');
  fireEvent.focus(window);
  await waitFor(() => expect(screen.getByLabelText('Generated output rights basis').closest('fieldset')?.style.display).not.toBe('none'));
  expect((screen.getByLabelText('Generated output rights basis') as HTMLTextAreaElement).value).toBe('Original staged scope recovery basis');
  view.rerender(<MantineProvider><PermissionsProvider permissions={grants({ edit: true })}><PreparationDocumentsPanel projectId="project" principalKey="owner" active={false} /></PermissionsProvider></MantineProvider>);
  expect(screen.queryByRole('heading', { name: 'Retained coordinated provenance' })).toBeNull();
  view.rerender(<MantineProvider><PermissionsProvider permissions={grants({ edit: true })}><PreparationDocumentsPanel projectId="project" principalKey="owner" active /></PermissionsProvider></MantineProvider>);
  await waitFor(() => expect(screen.getByLabelText('Generated output rights basis').closest('fieldset')?.style.display).not.toBe('none'));
  expect((screen.getByLabelText('Generated output rights basis') as HTMLTextAreaElement).value).toBe('Original staged scope recovery basis');
  fireEvent.click(screen.getByRole('button', { name: 'Generate reviewed document set' }));
  await waitFor(() => expect(f.calls.filter(c => c.operation === 'preparation_documents.generate')).toHaveLength(2));
  const replay = f.calls.filter(c => c.operation === 'preparation_documents.generate')[1]!;
  expect(replay.idempotency_key).toBe(packet.idempotency_key);
  expect(replay.expected_state).toBe(packet.expected_state);
  expect(f.calls.filter(c => c.operation === 'preparation_documents.read').length).toBeGreaterThanOrEqual(2);
});

test('fresh changed-config review cannot revive a denied old historic receipt', async () => {
  const f = fixture(); render(panel()); await root(); await review(); await generate();
  fireEvent.change(screen.getByLabelText('Document quantity (blank means unknown)'), { target: { value: '2' } });
  const original = f.fetch.getMockImplementation()!;
  f.fetch.mockImplementation((url: string, options?: RequestInit) => url.endsWith('/operations') && JSON.parse(String(options?.body)).operation === 'preparation_documents.read' ? Promise.resolve(json({ error: { message: 'Historical source unavailable.' } }, 404)) : original(url, options));
  fireEvent.click(screen.getByRole('button', { name: 'Refresh document access and choices' }));
  await screen.findByText('Historical source unavailable.');
  expect(screen.queryByRole('heading', { name: 'Retained coordinated provenance' })).toBeNull();
  expect(screen.queryByRole('heading', { name: 'Current reviewed document inputs' })).toBeNull();
});

test('incomplete staged mapping remains editable after tab return without completed review or inherited labels', async () => {
  const f = fixture(); const view = render(panel()); await root(); await review();
  fireEvent.click(screen.getByRole('button', { name: 'Bind right · harness' }));
  await choose('End profile shared definition', 'Original end profile (end_preparation_profile)');
  await choose('End profile shared revision', 'Original end profile · r1');
  fireEvent.change(screen.getByLabelText('End mapping basis shared'), { target: { value: '' } });
  const original = f.fetch.getMockImplementation()!;
  f.fetch.mockImplementation((url: string, options?: RequestInit) => {
    const body = url.endsWith('/operations') ? JSON.parse(String(options?.body)) : null;
    if (body?.operation === 'preparation_documents.review' && body.payload.bindings?.some((b: { end_profiles: { mapping_basis: string }[] }) => b.end_profiles.some(e => e.mapping_basis === ''))) return Promise.resolve(json({ error: { message: 'Incomplete mapping basis.' } }, 422));
    return original(url, options);
  });
  view.rerender(<MantineProvider><PermissionsProvider permissions={grants({ edit: true })}><PreparationDocumentsPanel projectId="project" principalKey="owner" active={false} /></PermissionsProvider></MantineProvider>);
  view.rerender(<MantineProvider><PermissionsProvider permissions={grants({ edit: true })}><PreparationDocumentsPanel projectId="project" principalKey="owner" active /></PermissionsProvider></MantineProvider>);
  await waitFor(() => expect(screen.getByLabelText('End mapping basis shared').closest('fieldset')?.parentElement?.closest('fieldset')?.style.display).not.toBe('none'));
  expect((screen.getByLabelText('End mapping basis shared') as HTMLTextAreaElement).value).toBe('');
  fireEvent.change(screen.getByLabelText('End mapping basis shared'), { target: { value: 'Original explicit mapping recovered' } });
  expect(screen.getByRole('button', { name: 'Generate reviewed document set' }).hasAttribute('disabled')).toBe(true);
  expect(f.calls.some(c => c.operation === 'preparation_documents.authority')).toBe(true);
  await review();
  expect(screen.getByRole('button', { name: 'Generate reviewed document set' }).hasAttribute('disabled')).toBe(false);
});
