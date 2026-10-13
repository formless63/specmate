import { Alert, Anchor, Button, Card, Checkbox, Group, Stack, Table, Text, TextInput, Title } from '@mantine/core';
import { useCallback, useEffect, useRef, useState } from 'react';
import { randomUUID } from '../../lib/random-id';
import { command } from '../sources/api';
import { compileOptions, compileOutputUrl, compileReview, type CompileOptions, type CompileReview, type FirmwareBuildRef } from './api';

type Props = FirmwareBuildRef & { canExecute?: boolean };
export function FirmwareBuildPanel({ firmware_revision_id, assembly_snapshot_id = null, path = [], canExecute = false }: Props) {
  const scopeKey = JSON.stringify([firmware_revision_id, assembly_snapshot_id, path]);
  return <CompilerWorkspace key={scopeKey} reference={{ firmware_revision_id, assembly_snapshot_id, path }} canExecute={canExecute} />;
}
function CompilerWorkspace({ reference, canExecute }: { reference: FirmwareBuildRef; canExecute: boolean }) {
  const [available, setAvailable] = useState<CompileOptions>();
  const [review, setReview] = useState<CompileReview>();
  const [error, setError] = useState('');
  const [consent, setConsent] = useState(false);
  const [basis, setBasis] = useState('');
  const [busy, setBusy] = useState(false);
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
      selected.current = null; setConsent(false);
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
  async function compile() {
    const recipeId = available?.available_recipe_id;
    if (!recipeId || !consent || !basis.trim()) return;
    const payload = { ...reference, recipe_id: recipeId, source_execution_authorized: true, basis: basis.trim() };
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
      <TextInput label="Source execution review basis" value={basis} onChange={event => setBasis(event.currentTarget.value)} />
      <Button disabled={busy || !consent || !basis.trim()} onClick={() => void compile()}>Request firmware compile</Button>
    </Stack>}
    {available?.builds.map(build => <Group key={build.build_id}><Text>{build.build_id} · {build.state.replaceAll('_', ' ')}{build.failure ? ` · ${build.failure}` : ''}</Text><Button disabled={busy || build.state !== 'succeeded'} onClick={() => void refresh(build.build_id)}>Inspect firmware handoff {build.build_id}</Button></Group>)}
    {available?.truncated && <Text>Showing the latest 100 builds; earlier history is retained.</Text>}
    {review && <Stack><Title order={4}>Registered compiler handoff</Title><CompilerPins inputs={review.inputs} />
      <Text size="xs">Recipe {review.recipe_id} · image {review.image} · report {review.report_sha256}</Text>
      <Text size="sm">Tool packages: {Object.entries(review.report.tool_packages).map(([name, version]) => `${name} ${version}`).join(', ')}</Text>
      <Table><Table.Thead><Table.Tr><Table.Th>Output</Table.Th><Table.Th>Exact bytes / rights</Table.Th></Table.Tr></Table.Thead><Table.Tbody>{review.outputs.map(output => <Table.Tr key={output.output_id}><Table.Td><Anchor href={compileOutputUrl(review, output.output_id)}>{output.path}</Anchor></Table.Td><Table.Td><Text size="xs">{output.sha256} · {output.size} bytes · {output.rights}</Text></Table.Td></Table.Tr>)}</Table.Tbody></Table>
    </Stack>}
  </Stack></Card>;
}
function CompilerPins({ inputs }: { inputs: CompileOptions['inputs'] }) {
  return <Stack gap="xs"><Text size="xs">Firmware {inputs.firmware_revision_id} · snapshot {inputs.firmware_snapshot_sha256}</Text>
    <Text size="sm">Declared compiler {inputs.toolchain.name} {inputs.toolchain.version ?? 'unknown'} · framework {inputs.toolchain.framework ?? 'unknown'} · ABI label {inputs.toolchain.board_id ?? 'unknown'} (hardware identity unevaluated)</Text>
    <Text size="xs">Population {inputs.target.population_revision_id} · option {inputs.target.option_id} · native component {inputs.target.component_id}</Text>
    {inputs.occurrence && <Text size="xs">Assembly {inputs.occurrence.assembly_snapshot_id} · snapshot {inputs.occurrence.assembly_snapshot_sha256} · occurrence {inputs.occurrence.path.join(' / ')}</Text>}
    {inputs.sources.map(source => <Stack gap={2} key={source.local_id}><Text size="xs">Source revision {source.source_revision_id} · manifest {source.source_manifest_sha256}</Text>{source.files.map(file => <Text size="xs" key={file.path}>{file.path} · {file.sha256} · {file.role} · {file.rights}</Text>)}</Stack>)}
    <Text size="sm">Configuration: {inputs.configuration.map(entry => `${entry.key}: ${entry.status === 'known' ? entry.value : entry.status}`).join(', ') || 'none declared'}</Text>
    <Text size="sm">Pin assumptions: {inputs.pins.map(pin => `${pin.signal}: ${pin.pad_id ?? 'unknown pad'} / ${pin.function}`).join(', ') || 'none declared'}</Text>
  </Stack>;
}
