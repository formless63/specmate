import { MantineProvider } from '@mantine/core';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { PermissionsProvider } from '../../lib/permissions';
import { configurationConfig } from './ConfigurationRecords';
import { SecondaryRecordPage } from '../records/SecondaryRecordPage';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const sha = 'a'.repeat(64);
const population = { revision_id: 'pop-rev', definition_id: 'pop', kind: 'pcb_population', name: 'Synthetic board population', number: 1, snapshot_sha256: sha,
  population_options: [{ local_id: 'default', name: 'Fitted' }, { local_id: 'bare', name: 'Bare board' }] };
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
    if(url.includes('/record?'))return response({definition_id:'set',workspace_id:'ws-1',kind:'option_set',name:'Synthetic options',selected:{kind:'draft',draft_id:'set-draft',state:'draft-v1',content:stored,base_revision_id:null}});
    if(url.includes('revision-labels')){const params=new URL(url,'http://synthetic').searchParams;return response({labels:params.getAll('revision_ids').map(revision_id=>({revision_id,readable:true,name:'Synthetic pin',number:1})),source_labels:[]});}
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
        return response({ result: { draft_id: 'set-draft', state: 'draft-v2',content:body.payload.changes } });
      }
      if (body.operation === 'draft.freeze') return response({ result: { number: 1, draft: { draft_id:'set-draft',state: 'draft-v3',content:stored } } });
    }
    throw new Error(`Unexpected request ${url}`);
  }));
  render(<MantineProvider env="test"><QueryClientProvider client={new QueryClient({defaultOptions:{queries:{retry:false}}})}><PermissionsProvider permissions={permissions}><SecondaryRecordPage {...configurationConfig('option_set','owner:ws-1')} active principalKey="owner" workspaceId="ws-1" definitionId="set" revisionNumber={null} draftRequested onBack={()=>{}} onSelect={()=>{}} onCreated={()=>{}}/></PermissionsProvider></QueryClientProvider></MantineProvider>);
  return bodies;
}

async function openSet() {
  await screen.findByLabelText('Label of Population');
  await waitFor(() => expect(screen.getByRole('option',{name:'Bare board'})).toBeTruthy());
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
  expect((screen.getByRole('button', { name: 'Freeze saved draft' }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: 'Save draft' }));
  expect(bodies.some((body) => body.operation === 'draft.update')).toBe(false);

  fireEvent.change(screen.getByLabelText('Key of option-2'), { target: { value: 'finish' } });
  fireEvent.change(screen.getByLabelText('Label of finish'), { target: { value: 'Enclosure finish' } });
  fireEvent.change(screen.getByLabelText('Choice key of choice-1'), { target: { value: 'paint' } });
  fireEvent.change(screen.getByLabelText('Choice label of paint'), { target: { value: 'Painted' } });
  fireEvent.change(screen.getByLabelText('Value for Painted'), { target: { value: 'powder-coat' } });
  fireEvent.change(screen.getByLabelText('Default of Enclosure finish'), { target: { value: 'paint' } });
  await waitFor(() => expect(screen.queryByText('Not yet valid')).toBeNull());

  fireEvent.click(screen.getByRole('button', { name: 'Save draft' }));
  await screen.findByText('Draft changed since expected state.');
  expect((screen.getByLabelText('Label of Enclosure finish') as HTMLInputElement).value).toBe('Enclosure finish');
  fireEvent.click(screen.getByRole('button', { name: 'Save draft' }));
  await screen.findByText('Saved working draft.');
  const saves = bodies.filter((body) => body.operation === 'draft.update');
  expect(saves.map((body) => body.expected_state)).toEqual(['draft-v1', 'draft-v1']);
  expect(saves[1]!.payload.changes.option_set).toEqual({ schema_version: '0.1', target_revision_id: 'asm-rev', options: [
    { key: 'pop', label: 'Population', domain: 'population', path: ['board'], required: true, default_choice: null,
      choices: [{ key: 'fitted', label: 'Fitted', revision_id: 'pop-rev', population_option_id: 'default', value: null }] },
    { key: 'finish', label: 'Enclosure finish', domain: 'process', path: null, required: true, default_choice: 'paint',
      choices: [{ key: 'paint', label: 'Painted', revision_id: null, population_option_id: null, value: 'powder-coat' }] },
  ], constraints: [] });

  fireEvent.click(screen.getByRole('button', { name: 'Freeze saved draft' }));
  await screen.findByText('Frozen r1.');
  const frozen = bodies.find((body) => body.operation === 'draft.freeze')!;
  expect(frozen).toMatchObject({ expected_state: 'draft-v2', payload: { draft_id: 'set-draft' } });
  expect(frozen.idempotency_key).toBeTruthy();
});

test('read-only principals inspect option sets without authoring controls', async () => {
  const bodies = setup(['workspace.read']);
  await openSet();
  // Authoring fields render as inspection; structural edit controls are withheld.
  await waitFor(() => expect((screen.getByLabelText('Key of Population') as HTMLInputElement).readOnly).toBe(true));
  expect(screen.queryByRole('button', { name: 'Add option' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Remove option' })).toBeNull();
  expect((screen.getByRole('button', { name: 'Save draft' }) as HTMLButtonElement).disabled).toBe(true);
  expect((screen.getByRole('button', { name: 'Freeze saved draft' }) as HTMLButtonElement).disabled).toBe(true);
  expect(bodies.every((body) => body.operation === 'configuration.authoring_context')).toBe(true);
});

test('authors a fact-limit constraint and saves it with the option set', async () => {
  const bodies = setup(['workspace.read', 'item.create', 'design.edit', 'design.freeze']);
  await openSet();
  expect(screen.getByText('No constraints declared.')).toBeTruthy();
  expect((screen.getByRole('button', { name: 'Add requires rule' }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: 'Add fact limit' }));
  await screen.findByText('Constraint rule-1: label is required.');
  fireEvent.change(screen.getByLabelText('Fact property of rule-1'), { target: { value: 'current_rating' } });
  fireEvent.change(screen.getByLabelText('Fact role of rule-1'), { target: { value: 'upper_bound' } });
  fireEvent.change(screen.getByLabelText('Limit of rule-1'), { target: { value: '1500' } });
  fireEvent.change(screen.getByLabelText('Limit unit of rule-1'), { target: { value: 'mA' } });
  fireEvent.change(screen.getByLabelText('Basis of rule rule-1'), { target: { value: 'Synthetic supply demand.' } });
  fireEvent.change(screen.getByLabelText('Label of rule rule-1'), { target: { value: 'Board current' } });
  await waitFor(() => expect(screen.queryByText('Not yet valid')).toBeNull());
  fireEvent.click(screen.getByRole('button', { name: 'Save draft' }));
  await screen.findByText('Draft changed since expected state.');
  fireEvent.click(screen.getByRole('button', { name: 'Save draft' }));
  await screen.findByText('Saved working draft.');
  const saved = bodies.filter((body) => body.operation === 'draft.update')[1]!;
  expect(saved.payload.changes.option_set.constraints).toEqual([{ kind: 'fact_limit', key: 'rule-1', label: 'Board current', basis: 'Synthetic supply demand.', when: null, option_key: 'pop',
    property: 'current_rating', purpose: 'rating', role: 'upper_bound', comparison: 'at_least', limit: { kind: 'quantity', dimension: 'current', unit: 'mA', magnitude: '1500' } }]);
});
