import { MantineProvider } from '@mantine/core';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { PermissionsProvider } from '../../lib/permissions';
import { OptionSetAuthoring } from './OptionSetEditor';

const sha = 'a'.repeat(64);
const population = { revision_id: 'pop-rev', definition_id: 'pop', kind: 'pcb_population', name: 'Synthetic board population', number: 1, snapshot_sha256: sha,
  population_options: [{ local_id: 'default', name: 'Fitted' }, { local_id: 'bare', name: 'Bare board' }] };
const definitions = [
  { definition_id: 'set', kind: 'option_set', name: 'Synthetic options' },
  { definition_id: 'asm', kind: 'assembly', name: 'Synthetic node' },
  { definition_id: 'pop', kind: 'pcb_population', name: 'Synthetic board population' },
];
const stored = { option_set: { schema_version: '0.1', target_revision_id: 'asm-rev', options: [
  { key: 'pop', label: 'Population', domain: 'population', path: ['board'], required: true, default_choice: null,
    choices: [{ key: 'fitted', label: 'Fitted', revision_id: 'pop-rev', population_option_id: 'default', value: null }] },
] } };
function response(value: unknown, status = 200) { return new Response(JSON.stringify(value), { status }); }

beforeEach(() => { vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} }); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function setup(permissions: string[]) {
  const bodies: Record<string, any>[] = [];
  let updates = 0;
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith('/catalog/definitions/set')) return response({ definition_id: 'set', kind: 'option_set', name: 'Synthetic options', drafts: [{ draft_id: 'set-draft', state: 'draft-v1', dependencies: [] }], revisions: [] });
    if (url.endsWith('/catalog/definitions/asm')) return response({ definition_id: 'asm', kind: 'assembly', name: 'Synthetic node', drafts: [], revisions: [{ revision_id: 'asm-rev', number: 1 }] });
    if (url.endsWith('/catalog/definitions/pop')) return response({ definition_id: 'pop', kind: 'pcb_population', name: 'Synthetic board population', drafts: [], revisions: [{ revision_id: 'pop-rev', number: 1 }] });
    if (url.endsWith('/drafts/set-draft')) return response({ definition_id: 'set', draft_id: 'set-draft', state: 'draft-v1', content: stored });
    if (url.endsWith('/operations')) {
      const body = JSON.parse(String(init?.body)); bodies.push(body);
      if (body.operation === 'configuration.authoring_context') {
        if (body.payload.target_revision_id) return response({ result: { revisions: [], target: { revision_id: 'asm-rev', definition_id: 'asm', kind: 'assembly', name: 'Synthetic node', number: 1, snapshot_sha256: sha,
          occurrences: [{ path: ['board'], display_ref: 'A1', revision: population, firmware_revision_id: null }] } } });
        return response({ result: { target: null, revisions: body.payload.revision_ids.includes('pop-rev') ? [population] : [] } });
      }
      if (body.operation === 'draft.update') {
        updates += 1;
        if (updates === 1) return response({ error: { message: 'Draft changed since expected state.' } }, 409);
        return response({ result: { draft_id: 'set-draft', state: 'draft-v2' } });
      }
      if (body.operation === 'draft.freeze') return response({ result: { number: 1, draft: { state: 'draft-v3' } } });
    }
    throw new Error(`Unexpected request ${url}`);
  }));
  render(<MantineProvider><PermissionsProvider permissions={permissions}><OptionSetAuthoring projectId="project-a" definitions={definitions} onCreated={() => {}} /></PermissionsProvider></MantineProvider>);
  return bodies;
}

async function openSet() {
  fireEvent.change(await screen.findByLabelText('Option set to edit'), { target: { value: 'set' } });
  await screen.findByLabelText('Label of Population');
  await waitFor(() => expect((screen.getByLabelText('Population option for Fitted') as HTMLSelectElement).value).toBe('default'));
}

test('authors options with exact pins, keeps edits across a stale save and freezes under CAS', async () => {
  const bodies = setup(['workspace.read', 'item.create', 'design.edit', 'design.freeze']);
  await openSet();
  expect(screen.getByText('Synthetic node · rev 1')).toBeTruthy();
  expect((screen.getByLabelText('Occurrence of Population') as HTMLSelectElement).value).toBe('board');
  expect(screen.getByRole('option', { name: 'Bare board' })).toBeTruthy();

  fireEvent.click(screen.getByRole('button', { name: 'Add option' }));
  await screen.findByText('Not yet valid');
  expect(screen.getByText('option-2: label is required.')).toBeTruthy();
  expect(screen.getByText('option-2 / choice-1: declare a value.')).toBeTruthy();
  expect((screen.getByRole('button', { name: 'Freeze option set' }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: 'Save option set' }));
  expect(bodies.some((body) => body.operation === 'draft.update')).toBe(false);

  fireEvent.change(screen.getByLabelText('Key of option-2'), { target: { value: 'finish' } });
  fireEvent.change(screen.getByLabelText('Label of finish'), { target: { value: 'Enclosure finish' } });
  fireEvent.change(screen.getByLabelText('Choice key of choice-1'), { target: { value: 'paint' } });
  fireEvent.change(screen.getByLabelText('Choice label of paint'), { target: { value: 'Painted' } });
  fireEvent.change(screen.getByLabelText('Value for Painted'), { target: { value: 'powder-coat' } });
  fireEvent.change(screen.getByLabelText('Default of Enclosure finish'), { target: { value: 'paint' } });
  await waitFor(() => expect(screen.queryByText('Not yet valid')).toBeNull());

  fireEvent.click(screen.getByRole('button', { name: 'Save option set' }));
  await screen.findByText('Draft changed since expected state. Your unsaved edits are kept.');
  expect((screen.getByLabelText('Label of Enclosure finish') as HTMLInputElement).value).toBe('Enclosure finish');
  fireEvent.click(screen.getByRole('button', { name: 'Save option set' }));
  await screen.findByText('Saved option-set draft.');
  const saves = bodies.filter((body) => body.operation === 'draft.update');
  expect(saves.map((body) => body.expected_state)).toEqual(['draft-v1', 'draft-v1']);
  expect(saves[1]!.payload.changes.option_set).toEqual({ schema_version: '0.1', target_revision_id: 'asm-rev', options: [
    { key: 'pop', label: 'Population', domain: 'population', path: ['board'], required: true, default_choice: null,
      choices: [{ key: 'fitted', label: 'Fitted', revision_id: 'pop-rev', population_option_id: 'default', value: null }] },
    { key: 'finish', label: 'Enclosure finish', domain: 'process', path: null, required: true, default_choice: 'paint',
      choices: [{ key: 'paint', label: 'Painted', revision_id: null, population_option_id: null, value: 'powder-coat' }] },
  ] });

  fireEvent.click(screen.getByRole('button', { name: 'Freeze option set' }));
  await screen.findByText('Frozen as option-set revision 1. Configurations pin that exact revision.');
  const frozen = bodies.find((body) => body.operation === 'draft.freeze')!;
  expect(frozen).toMatchObject({ expected_state: 'draft-v2', payload: { draft_id: 'set-draft' } });
  expect(frozen.idempotency_key).toBeTruthy();
});

test('read-only principals inspect option sets without authoring controls', async () => {
  const bodies = setup(['workspace.read']);
  await openSet();
  expect((screen.getByLabelText('Key of Population') as HTMLInputElement).disabled).toBe(true);
  expect((screen.getByRole('button', { name: 'Add option' }) as HTMLButtonElement).disabled).toBe(true);
  expect((screen.getByRole('button', { name: 'Save option set' }) as HTMLButtonElement).disabled).toBe(true);
  expect((screen.getByRole('button', { name: 'Freeze option set' }) as HTMLButtonElement).disabled).toBe(true);
  expect((screen.getByRole('button', { name: 'Create option set' }) as HTMLButtonElement).disabled).toBe(true);
  expect(screen.getByText('Read-only access: requires Freeze')).toBeTruthy();
  expect(bodies.every((body) => body.operation === 'configuration.authoring_context')).toBe(true);
});
