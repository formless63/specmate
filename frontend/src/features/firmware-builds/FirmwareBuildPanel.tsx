import { Alert, Anchor, Button, Card, Checkbox, Group, Select, Stack, Table, Text, TextInput, Title } from '@mantine/core';
import { useCallback, useEffect, useRef, useState } from 'react';
import { randomUUID } from '../../lib/random-id';
import { command } from '../sources/api';
import { compileOptions, compileOutputUrl, compileReview, listResolvedConfigurations, type CompileOptions, type CompileReview, type FirmwareBuildRef, type ResolvedChoices } from './api';
import { Lineage, jobState, pretty } from '../builds/BuildsPanel';
import { SbJobCard, SbUnknown } from '../../components/sb';
import { cancelBuild, readHistory, retryBuild } from '../builds/api';
import { RevisionLabel } from "../../lib/IdentityLabel";
import { useCan } from "../../lib/permissions";
import type { ResolvedSummary } from '../configurations/api';

/** Invalid constraints are refused by the server; unknown and not-evaluated stay selectable. */
const buildable = (row: ResolvedSummary) => row.status === 'complete' && row.constraint_outcome !== 'invalid';
function constraintLabel(row: ResolvedSummary) {
  const outcome = row.constraint_outcome ?? 'not_evaluated';
  return outcome === 'invalid' ? 'constraints invalid, cannot be built' : `constraints ${outcome.replace('_', ' ')}`;
}

type Props = FirmwareBuildRef;
export function FirmwareBuildPanel({ firmware_revision_id, assembly_snapshot_id = null, path = [] }: Props) {
  const scopeKey = JSON.stringify([firmware_revision_id, assembly_snapshot_id, path]);
  return <CompilerWorkspace key={scopeKey} reference={{ firmware_revision_id, assembly_snapshot_id, path }} />;
}
function CompilerWorkspace({ reference }: { reference: FirmwareBuildRef }) {
  const canExecute = useCan('build.execute');
  const [available, setAvailable] = useState<CompileOptions>();
  const [review, setReview] = useState<CompileReview>();
  const [error, setError] = useState('');
  const [consent, setConsent] = useState(false);
  const [basis, setBasis] = useState('');
  const [busy, setBusy] = useState(false);
  const [choices, setChoices] = useState<ResolvedChoices>();
  const [configurationId, setConfigurationId] = useState<string | null>(null);
  const chosen = choices?.resolved.find(row => row.resolved_configuration_id === configurationId);
  const alive = useRef(true);
  const generation = useRef(0);
  const active = useRef<AbortController | null>(null);
  const selected = useRef<string | null>(null);
  const retry = useRef<{ key: string; payload: object } | null>(null);
  const refresh = useCallback(async (buildId = selected.current) => {
    const token = ++generation.current;
    active.current?.abort();
    const controller = new AbortController(); active.current = controller;
    setAvailable(undefined); setReview(undefined); setError(''); setBusy(true);
    try {
      const [options, evidence] = await Promise.all([
        compileOptions(reference, controller.signal),
        buildId ? compileReview(reference, buildId, controller.signal) : Promise.resolve(undefined),
      ]);
      if (!alive.current || token !== generation.current || controller.signal.aborted) return;
      selected.current = buildId; setAvailable(options); setReview(evidence);
    } catch (reason) {
      if (!alive.current || token !== generation.current || controller.signal.aborted) return;
      selected.current = null; setConsent(false); setChoices(undefined); setConfigurationId(null);
      // Retain an uncertain submitted request for an exact keyed retry after
      // authority is restored; the hidden payload never grants execution access.
      setError(reason instanceof Error ? reason.message : 'Compiler review unavailable.');
    } finally { if (alive.current && token === generation.current && !controller.signal.aborted) setBusy(false); }
  }, [reference]);
  useEffect(() => {
    alive.current = true;
    void refresh(null);
    const focus = () => void refresh();
    window.addEventListener('focus', focus);
    return () => { alive.current = false; generation.current += 1; active.current?.abort(); window.removeEventListener('focus', focus); };
  }, [refresh]);
  const workspaceId = available?.workspace_id;
  useEffect(() => {
    // Only complete, same-workspace captures are offered; a failed read offers none rather than guessing.
    setChoices(undefined); setConfigurationId(null);
    if (!canExecute || !workspaceId) return;
    let current = true;
    listResolvedConfigurations(workspaceId).then(found => { if (current) setChoices(found); }, () => undefined);
    return () => { current = false; };
  }, [canExecute, workspaceId]);
  async function compile() {
    const recipeId = available?.available_recipe_id;
    if (!recipeId || !consent || !basis.trim()) return;
    const payload = { ...reference, recipe_id: recipeId, source_execution_authorized: true, basis: basis.trim(), ...(configurationId ? { resolved_configuration_id: configurationId } : {}) };
    if (!retry.current || JSON.stringify(retry.current.payload) !== JSON.stringify(payload)) retry.current = { key: randomUUID(), payload };
    const token = ++generation.current; active.current?.abort();
    setBusy(true); setError(''); setReview(undefined);
    try {
      await command('firmware_build.request', retry.current.payload, { idempotencyKey: retry.current.key });
      if (!alive.current || token !== generation.current) return;
      retry.current = null; setConsent(false); await refresh(null);
    } catch (reason) {
      if (!alive.current || token !== generation.current) return;
      setError(reason instanceof Error ? reason.message : 'Compile request failed.');
      setAvailable(undefined); setReview(undefined); setBusy(false);
    }
  }
  return <Card withBorder><Stack><Title order={3}>Firmware compile and handoff</Title>
    <Text>Compile the exact frozen declaration with an installed approved compiler profile. A completed compile records output bytes; hardware compatibility remains unevaluated, flashing is not performed and device operation is not observed.</Text>
    <Button variant="subtle" loading={busy} onClick={() => void refresh()}>Refresh compiler evidence</Button>
    {error && <Alert color="red">{error}</Alert>}
    {available?.unavailable_reason && <Alert color="yellow">{available.unavailable_reason}</Alert>}
    {available && <CompilerPins inputs={available.inputs} />}
    {canExecute && available?.available_recipe_id && <Stack>
      <Checkbox label="Authorize isolated compiler processing of these exact source files" checked={consent} onChange={event => setConsent(event.currentTarget.checked)} />
      {choices && <Select label="Resolved configuration (optional)" placeholder="None: build without a pinned configuration" clearable value={configurationId} onChange={setConfigurationId} nothingFoundMessage="No resolved configurations in this workspace"
        data={choices.resolved.map(row => ({ value: row.resolved_configuration_id, disabled: !buildable(row), label: `${row.resolved_configuration_id.slice(0, 8)} · ${row.status === 'complete' ? 'complete' : 'incomplete, cannot be built'} · ${constraintLabel(row)} · ${row.basis}` }))}
        description={choices.truncated ? 'Showing the latest 100 captures.' : 'The exact capture is pinned to the build; later option changes never alter it.'} />}
      {chosen?.constraint_outcome === 'unknown' && <Alert color="yellow" title="Constraint outcome unknown">At least one declared constraint of this configuration could not be decided, for example a missing rating. Building does not establish compatibility; review the configuration's constraint reasons.</Alert>}
      <TextInput label="Source execution review basis" value={basis} onChange={event => setBasis(event.currentTarget.value)} />
      <Button disabled={busy || !consent || !basis.trim()} onClick={() => void compile()}>Request firmware compile</Button>
    </Stack>}
    {available?.builds.map(build => <SbJobCard key={build.build_id} title={build.build_id} state={jobState(build.state)} stateWords={pretty(build.state)} dimension="compile"
      detail={<>{build.failure ?? ''}{build.retry_of ? ` retry of ${build.retry_of}` : ''}</>}
      actions={<><Button disabled={busy || build.state !== 'succeeded'} onClick={() => void refresh(build.build_id)}>Inspect firmware handoff {build.build_id}</Button>
      <BuildControls build={build} canExecute={canExecute} onChanged={() => refresh(null)} /></>} />)}
    {available?.truncated && <Text>Showing the latest 100 builds; earlier history is retained.</Text>}
    {review && <Stack><Title order={4}>Registered compiler handoff</Title>
      <Lineage lineage={review.lineage} retryOf={review.retry_of} /><CompilerPins inputs={review.inputs} />
      <Text size="xs">Recipe {review.recipe_id} · image {review.image} · report {review.report_sha256}</Text>
      <Text size="sm">Tool packages: {Object.entries(review.report.tool_packages).map(([name, version]) => `${name} ${version}`).join(', ')}</Text>
      <Table><Table.Thead><Table.Tr><Table.Th>Output</Table.Th><Table.Th>Exact bytes / rights</Table.Th></Table.Tr></Table.Thead><Table.Tbody>{review.outputs.map(output => <Table.Tr key={output.output_id}><Table.Td><Anchor href={compileOutputUrl(review, output.output_id)}>{output.path}</Anchor></Table.Td><Table.Td><Text size="xs">{output.sha256} · {output.size} bytes · {output.rights}</Text></Table.Td></Table.Tr>)}</Table.Tbody></Table>
    </Stack>}
  </Stack></Card>;
}
function CompilerPins({ inputs }: { inputs: CompileOptions['inputs'] }) {
  return <Stack gap="xs"><Text size="xs"><RevisionLabel id={inputs.firmware_revision_id} role="Firmware" snapshotId={inputs.firmware_snapshot_sha256} /></Text>
    <Text size="sm">Declared compiler {inputs.toolchain.name} {inputs.toolchain.version ?? <SbUnknown />} · framework {inputs.toolchain.framework ?? <SbUnknown />} · ABI label {inputs.toolchain.board_id ?? <SbUnknown />} (hardware identity unevaluated)</Text>
    <Text size="xs"><RevisionLabel id={inputs.target.population_revision_id} role="Population" /> · option {inputs.target.option_id} · native component {inputs.target.component_id}</Text>
    {inputs.occurrence && <Text size="xs">Assembly {inputs.occurrence.assembly_snapshot_id} · snapshot {inputs.occurrence.assembly_snapshot_sha256} · occurrence {inputs.occurrence.path.join(' / ')}</Text>}
    {inputs.sources.map(source => <Stack gap={2} key={source.local_id}><Text size="xs"><RevisionLabel kind="source" id={source.source_revision_id} role="Source" /> · manifest {source.source_manifest_sha256}</Text>{source.files.map(file => <Text size="xs" key={file.path}>{file.path} · {file.sha256} · {file.role} · {file.rights}</Text>)}</Stack>)}
    <Text size="sm">Configuration: {inputs.configuration.map(entry => `${entry.key}: ${entry.status === 'known' ? entry.value : entry.status}`).join(', ') || 'none declared'}</Text>
    <Text size="sm">Pin assumptions: {inputs.pins.map(pin => `${pin.signal}: ${pin.pad_id ?? 'unknown pad'} / ${pin.function}`).join(', ') || 'none declared'}</Text>
  </Stack>;
}

/** Offers only what the list row's server-computed flags allow (the rule build.history uses). Cancel needs the
 * requester or build.execute; retry needs build.execute. History is read only on click, for a fresh state token. */
function BuildControls({ build, canExecute, onChanged }: { build: CompileOptions['builds'][number]; canExecute: boolean; onChanged: () => Promise<void> }) {
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const key = useRef<{ name: string; value: string } | null>(null);
  const run = async (action: 'cancel' | 'retry') => {
    setBusy(true); setError('');
    try {
      const fresh = await readHistory(build.build_id);
      if (action === 'cancel' ? !fresh.cancel_available : !fresh.retry_available) { setError('That action is no longer available.'); await onChanged(); return; }
      const name = `${action}:${fresh.state_token}`;
      if (key.current?.name !== name) key.current = { name, value: randomUUID() };
      if (action === 'cancel') await cancelBuild(build.build_id, fresh.state_token, key.current.value);
      else await retryBuild(build.build_id, fresh.state_token, key.current.value);
      key.current = null; await onChanged();
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Build action failed.'); }
    finally { setBusy(false); }
  };
  const canCancel = build.cancel_available && (canExecute || build.requested_by_viewer);
  const canRetry = build.retry_available && canExecute;
  return <Group gap="xs">
    {canCancel && <Button variant="subtle" disabled={busy} onClick={() => void run('cancel')}>Request cancellation of {build.build_id}</Button>}
    {canRetry && <Button variant="subtle" disabled={busy} onClick={() => void run('retry')}>Retry {build.build_id} as a new attempt</Button>}
    {error && <Text size="xs" c="red">{error}</Text>}
  </Group>;
}
