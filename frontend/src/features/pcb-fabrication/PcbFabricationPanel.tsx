import { Alert, Anchor, Button, Card, Group, Stack, Table, Text, Title } from '@mantine/core';
import { useCallback, useEffect, useRef, useState } from 'react';
import { command } from '../pcb/api';
import { options, outputUrl, review, type Options, type Review } from './api';

export function PcbFabricationPanel({ intakeId, canExecute = false }: { intakeId: string; canExecute?: boolean }) {
  const [state, setState] = useState<{ intakeId: string; options?: Options; review?: Review; error?: string }>({ intakeId });
  const [busy, setBusy] = useState(false);
  const active = useRef<AbortController | null>(null);
  const scope = useRef(intakeId);
  scope.current = intakeId;
  const visible = state.intakeId === intakeId ? state : undefined;
  const selected = useRef<string | null>(null);

  const refresh = useCallback(async (buildId: string | null = selected.current) => {
    active.current?.abort();
    const controller = new AbortController(); active.current = controller;
    setBusy(true); setState({ intakeId });
    try {
      const [available, evidence] = await Promise.all([
        options(intakeId, controller.signal),
        buildId ? review(intakeId, buildId, controller.signal) : Promise.resolve(undefined),
      ]);
      if (controller.signal.aborted || scope.current !== intakeId) return;
      selected.current = buildId;
      setState({ intakeId, options: available, review: evidence });
    } catch (error) {
      if (controller.signal.aborted || scope.current !== intakeId) return;
      selected.current = null;
      setState({ intakeId, error: error instanceof Error ? error.message : 'Fabrication review failed.' });
    } finally {
      if (!controller.signal.aborted && scope.current === intakeId) setBusy(false);
    }
  }, [intakeId]);

  useEffect(() => {
    selected.current = null;
    void refresh(null);
    const focus = () => void refresh();
    window.addEventListener('focus', focus);
    return () => { active.current?.abort(); window.removeEventListener('focus', focus); };
  }, [refresh]);

  async function request() {
    const recipeId = visible?.options?.available_recipe_id;
    if (!recipeId) return;
    active.current?.abort();
    const controller = new AbortController(); active.current = controller;
    setBusy(true); setState({ intakeId }); selected.current = null;
    try {
      await command('pcb_fabrication.request', { intake_id: intakeId, recipe_id: recipeId }, controller.signal);
      if (!controller.signal.aborted && scope.current === intakeId) await refresh(null);
    } catch (error) {
      if (!controller.signal.aborted && scope.current === intakeId) {
        setState({ intakeId, error: error instanceof Error ? error.message : 'Fabrication request failed.' });
        setBusy(false);
      }
    }
  }

  return <Card withBorder><Stack><Title order={3}>Native fabrication evidence</Title>
    <Text>Generate DRC diagnostics and fixed Gerber/drill outputs from the exact original board. Export completion and DRC findings are separate. No manufacturing approval or physical qualification is implied.</Text>
    <Text size="sm">Qualified subset: KiCad 10.0.6, two copper layers, closed line outlines, straight tracks, circle/rectangle pads and circular through drills. Native DNP, zones, vias, slots, custom rules, source editing and routing remain unsupported.</Text>
    <Group><Button variant="subtle" loading={busy} onClick={() => void refresh()}>Refresh fabrication evidence</Button>
      {canExecute && <Button disabled={busy || !visible?.options?.available_recipe_id} onClick={() => void request()}>Request native fabrication outputs</Button>}</Group>
    {visible?.error && <Alert color="red">{visible.error}</Alert>}
    {visible?.options?.unavailable_reason && <Text>{visible.options.unavailable_reason}</Text>}
    {visible?.options && <Text size="xs">Latest {visible.options.limit} builds at most.</Text>}
    {visible?.options?.builds.map(build => <Group key={build.build_id}><Text>{build.build_id} · {build.state.replaceAll('_', ' ')}</Text><Button variant="light" disabled={busy || build.state !== 'succeeded'} onClick={() => void refresh(build.build_id)}>Inspect fabrication build {build.build_id}</Button></Group>)}
    {visible?.review && <FabricationReview item={visible.review} />}
  </Stack></Card>;
}

function FabricationReview({ item }: { item: Review }) {
  const counts = item.report.drc_counts;
  return <Stack><Title order={4}>Registered export evidence</Title>
    <Text>Native export completed. DRC: {counts.violations} violations, {counts.unconnected_items} unconnected items. Schematic parity was not checked.</Text>
    <Text size="sm">Exact source: {item.source.path} · {item.source.sha256} · Rights: {item.source.rights}</Text>
    <Text size="xs">Source revision: {item.source.source_revision_id} · Manifest: {item.source.manifest_sha256}</Text>
    <Text size="xs">Recipe: {item.recipe_id} · Image: {item.image} · Report: {item.report_sha256}</Text>
    <Text size="sm">Gerber layers: {item.report.layers.join(', ')}. Drill format: {item.report.drill_format}.</Text>
    <Table><Table.Thead><Table.Tr><Table.Th>Registered output</Table.Th><Table.Th>SHA-256 / rights</Table.Th></Table.Tr></Table.Thead><Table.Tbody>{item.outputs.map(output => <Table.Tr key={output.output_id}><Table.Td><Anchor href={outputUrl(item, output.output_id)}>{output.path}</Anchor><Text size="xs">{output.size} bytes · {output.media_type}</Text></Table.Td><Table.Td><Text size="xs">{output.sha256}</Text><Text size="xs">{output.rights}</Text></Table.Td></Table.Tr>)}</Table.Tbody></Table>
    {item.report.unsupported.map(text => <Text size="sm" key={text}>{text}</Text>)}
  </Stack>;
}
