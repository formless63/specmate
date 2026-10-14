import { MantineProvider } from '@mantine/core';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { PermissionsProvider } from '../../lib/permissions';
import type { BuildInput, ConstraintEvaluation, DraftResolution } from './api';
import { ConfigurationsPanel } from './ConfigurationsPanel';

function constraints(finish: string | null): ConstraintEvaluation {
  return {
    outcome: 'unknown', scope: 'declared_rules_and_recorded_facts_of_exact_revisions', limitations: ['A valid outcome is a declaration check, not physical qualification.'],
    counts: { valid: finish ? 1 : 0, invalid: 0, unknown: finish ? 1 : 2, not_evaluated: 0 },
    results: [
      { key: 'sensor-current', label: 'Sensor carries the supply current', kind: 'fact_limit', basis: 'Synthetic supply demand.', rule: {}, outcome: 'unknown', facts: [],
        reasons: [{ level: 'rule', code: 'fact_limit', message: 'Requires current_rating (rating, upper_bound) at least 2000 mA on the revision chosen for sensor.' },
          { level: 'fact', code: 'decision_resolved', message: 'Option sensor is resolved to choice a (default).' },
          { level: 'fact', code: 'fact_missing', message: 'Synthetic sensor A rev 1 records no current_rating (rating, upper_bound); compatibility is not assumed.' }] },
      { key: 'paint-sealing', label: 'Painted finish needs a primer', kind: 'requires', basis: 'Synthetic process note.', rule: {}, outcome: finish ? 'valid' : 'unknown', facts: [],
        reasons: finish ? [{ level: 'rule', code: 'applicable', message: 'Applies because finish is paint.' }, { level: 'fact', code: 'decision_resolved', message: 'Option sensor is resolved to choice a (default).', assertion_ids: ['assertion-1234567'] }]
          : [{ level: 'rule', code: 'applicability_unknown', message: 'Applies when finish is paint; that option is unresolved, so applicability is unknown.' }] },
    ],
  };
}
const pin = (name: string, number: number) => ({ revision_id: `${name}-rev`, definition_id: name, kind: 'component', name, number, snapshot_sha256: 'a'.repeat(64) });
function resolution(finish: string | null): DraftResolution {
  return {
    draft_id: 'cfg-draft', state: finish ? 'draft-v2' : 'draft-v1', content_sha256: 'c'.repeat(64), review_sha256: 'r'.repeat(64),
    configuration: { schema_version: '0.1', option_set_revision_id: 'set-rev', selections: finish ? [{ option_key: 'finish', choice_key: finish }] : [] },
    available: [
      { option_key: 'sensor', label: 'Sensor part', domain: 'part', required: true, default_choice: 'a', choices: [{ key: 'a', label: 'Sensor A' }, { key: 'b', label: 'Sensor B' }] },
      { option_key: 'finish', label: 'Enclosure finish', domain: 'process', required: true, default_choice: null, choices: [{ key: 'paint', label: 'Painted' }] },
    ],
    resolved: finish ? [{ resolved_configuration_id: 'resolved-1', status: 'complete', snapshot_id: 'snap-1', resolution_sha256: 'e'.repeat(64), draft_version: 2, basis: 'Synthetic review', created_at: '2026-01-01T00:00:00Z' }] : [],
    history_truncated: false,
    resolution: {
      option_set: pin('Synthetic options', 1), target: null, invalid_selections: [], compatibility: 'not_evaluated', constraints: constraints(finish),
      status: finish ? 'complete' : 'incomplete', counts: { resolved: finish ? 2 : 1, none: 0, unresolved: finish ? 0 : 1, invalid: 0 },
      decisions: [
        { option_key: 'sensor', label: 'Sensor part', domain: 'part', path: null, required: true, status: 'resolved', source: 'default', reason: 'Default declared by option-set revision 1.', compatibility: 'not_evaluated', base: null,
          choice: { key: 'a', label: 'Sensor A', value: null, revision: pin('Synthetic sensor A', 1) } },
        { option_key: 'finish', label: 'Enclosure finish', domain: 'process', path: null, required: true, status: finish ? 'resolved' : 'unresolved', source: finish ? 'selected' : 'not_selected',
          reason: finish ? 'Explicitly selected.' : 'No selection and no declared default.', compatibility: 'not_evaluated', base: null,
          choice: finish ? { key: 'paint', label: 'Painted', value: 'powder-coat', revision: null } : null },
      ],
    },
  };
}
const buildInput: BuildInput = { resolved_configuration_id: 'resolved-1', snapshot_id: 'snap-1', snapshot_sha256: 'f'.repeat(64), resolution_sha256: 'e'.repeat(64), option_set_revision_id: 'set-rev',
  pins: [{ revision_id: 'set-rev', sha256: 'a'.repeat(64) }], choices: [{ option_key: 'sensor', domain: 'part', path: null, status: 'resolved', source: 'default', revision_id: 'Synthetic sensor A-rev', population_option_id: null, value: null }],
  constraints: { outcome: 'unknown', counts: { valid: 1, invalid: 0, unknown: 1, not_evaluated: 0 }, unknown: ['sensor-current'], invalid: [] } };
function response(value: unknown, status = 200) { return new Response(JSON.stringify(value), { status }); }

beforeEach(() => { vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} }); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function setup(permissions: string[]) {
  const bodies: Record<string, any>[] = [];
  let saved: string | null = null;
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (url.includes('/catalog/definitions?')) return response({ workspace_id: 'ws-1', project_id: 'project-a', results: [], next_after: null });
    if (url.includes('/access/projects/project-a')) return response({ project_id: 'project-a', state: 'project-v1' });
    if (url.endsWith('/definitions')) return response([{ definition_id: 'cfg', name: 'Synthetic configuration', kind: 'configuration' }, { definition_id: 'set', name: 'Synthetic options', kind: 'option_set' }]);
    if (url.includes('/catalog/definitions/cfg')) return response({ definition_id: 'cfg', name: 'Synthetic configuration', kind: 'configuration', drafts: [{ draft_id: 'cfg-draft', state: 'draft-v1', dependencies: [] }], revisions: [] });
    if (url.includes('/catalog/definitions/set')) return response({ definition_id: 'set', name: 'Synthetic options', kind: 'option_set', drafts: [], revisions: [{ revision_id: 'set-rev', number: 1 }] });
    if (url.endsWith('/operations')) {
      const body = JSON.parse(String(init?.body)); bodies.push(body);
      if (body.operation === 'configuration.resolve') return response({ result: resolution(saved) });
      if (body.operation === 'draft.update') { saved = body.payload.changes.configuration.selections[0]?.choice_key ?? null; return response({ result: {} }); }
      if (body.operation === 'configuration.capture') return response({ result: { resolved_configuration_id: 'resolved-1' } });
      if (body.operation === 'configuration.build_input') return response({ result: buildInput });
      if (body.operation === 'definition.create') return response({ result: { definition_id: 'cfg' } });
      if (body.operation === 'project.add_reference') return response({ result: {} });
    }
    throw new Error(`Unexpected request ${url}`);
  }));
  render(<MantineProvider><PermissionsProvider permissions={permissions}><ConfigurationsPanel projectId="project-a" /></PermissionsProvider></MantineProvider>);
  return bodies;
}

async function openDraft() {
  fireEvent.change(await screen.findByLabelText('Configuration'), { target: { value: 'cfg' } });
  fireEvent.change(await screen.findByLabelText('Configuration draft'), { target: { value: 'cfg-draft' } });
  await screen.findByText('Default declared by option-set revision 1.');
}

test('shows explicit decisions, saves selections under CAS and captures a reviewed snapshot', async () => {
  const bodies = setup(['workspace.read', 'item.create', 'design.edit']);
  await openDraft();
  expect(screen.getByText('incomplete')).toBeTruthy();
  expect(screen.getByText('unresolved')).toBeTruthy();
  expect(screen.getByText('Option-set default')).toBeTruthy();
  fireEvent.change(screen.getByLabelText('Selection for Enclosure finish'), { target: { value: 'paint' } });
  expect((screen.getByRole('button', { name: 'Capture resolved snapshot' }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: 'Save selections' }));
  await screen.findByText('Explicitly selected.');
  const update = bodies.find((body) => body.operation === 'draft.update')!;
  expect(update.expected_state).toBe('draft-v1');
  expect(update.payload.changes.configuration).toEqual({ schema_version: '0.1', option_set_revision_id: 'set-rev', selections: [{ option_key: 'finish', choice_key: 'paint' }] });
  fireEvent.change(screen.getByLabelText('Capture basis'), { target: { value: 'Synthetic review' } });
  fireEvent.click(screen.getByRole('button', { name: 'Capture resolved snapshot' }));
  await waitFor(() => expect(bodies.some((body) => body.operation === 'configuration.capture')).toBe(true));
  const captured = bodies.find((body) => body.operation === 'configuration.capture')!;
  expect(captured).toMatchObject({ expected_state: 'draft-v2', payload: { draft_id: 'cfg-draft', review_sha256: 'r'.repeat(64), basis: 'Synthetic review' } });
  expect(captured.idempotency_key).toBeTruthy();
  fireEvent.click(await screen.findByRole('button', { name: 'Inspect build input' }));
  await screen.findByText('1 exact revision pins', { exact: false });
  expect(screen.getByText('Unknown: sensor-current')).toBeTruthy();
  expect(screen.getByText('captured constraints')).toBeTruthy();
});

test('shows each constraint outcome with rule and fact reasons; a missing rating stays unknown', async () => {
  setup(['workspace.read']);
  await openDraft();
  const table = screen.getByRole('table', { name: 'Constraint outcomes' });
  const rows = table.querySelectorAll('tbody tr');
  expect(rows).toHaveLength(2);
  expect(rows[0]!.getAttribute('data-outcome')).toBe('unknown');
  expect(rows[0]!.textContent).toContain('records no current_rating');
  expect(rows[0]!.textContent).toContain('Requires current_rating');
  expect(rows[1]!.textContent).toContain('applicability is unknown');
  // The overall outcome is unknown, never shown as valid or OK.
  expect(screen.getByText('overall').parentElement!.textContent).toContain('unknown');
  expect(screen.queryByText('valid')).toBeNull();
});

test('read-only principals review resolutions without mutating controls', async () => {
  const bodies = setup(['workspace.read']);
  await openDraft();
  expect(screen.queryByLabelText('Selection for Enclosure finish')).toBeNull();
  expect(screen.queryByRole('button', { name: 'Capture resolved snapshot' })).toBeNull();
  expect((screen.getByRole('button', { name: 'Create configuration' }) as HTMLButtonElement).disabled).toBe(true);
  expect(screen.getAllByText('Read-only access: requires Edit').length).toBeGreaterThan(0);
  expect(bodies.every((body) => body.operation === 'configuration.resolve')).toBe(true);
});

test('creates a configuration in the workspace library and references it from the project', async () => {
  const bodies = setup(['workspace.read', 'item.create', 'design.edit']);
  fireEvent.change(await screen.findByLabelText('Option set'), { target: { value: 'set' } });
  await screen.findByRole('option', { name: 'Revision 1' });
  fireEvent.change(screen.getByLabelText('Frozen option-set revision'), { target: { value: 'set-rev' } });
  fireEvent.change(screen.getByLabelText('Configuration name'), { target: { value: 'Synthetic build' } });
  fireEvent.click(screen.getByRole('button', { name: 'Create configuration' }));
  await waitFor(() => expect(bodies.some((body) => body.operation === 'project.add_reference')).toBe(true));
  const created = bodies.find((body) => body.operation === 'definition.create')!;
  expect(created.payload).toEqual({ workspace_id: 'ws-1', kind: 'configuration', name: 'Synthetic build', content: { configuration: { option_set_revision_id: 'set-rev', selections: [] } } });
  expect(bodies.find((body) => body.operation === 'project.add_reference')!.payload).toMatchObject({ project_id: 'project-a', kind: 'definition', target_id: 'cfg' });
});
