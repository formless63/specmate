import { Alert, Anchor, Button, Card, Group, Stack, Table, Text, Title } from '@mantine/core';
import { useCallback, useEffect, useRef, useState } from 'react';
import { command } from '../pcb/api';
import { options, outputUrl, review, type Diagnostic, type Options, type Review } from './api';
import { jobState, pretty } from '../builds/BuildsPanel';
import { SbJobCard } from '../../components/sb';
import { RevisionLabel } from "../../lib/IdentityLabel";
import { useCan } from "../../lib/permissions";

/** `blocked` withdraws execution while the caller's access to the intake is lost. */
export function PcbFabricationPanel({ intakeId, blocked = false }: { intakeId: string; blocked?: boolean }) {
  const canExecute = useCan('build.execute') && !blocked;
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

  async function request(recipeId: string) {
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
    <Text size="sm">Supported: KiCad 10.0.6 board format 20260206 with 2 to 32 copper layers, its same-named .kicad_pro project (design rules, text variables) when preserved, zones exported with their stored fills (never refilled), production graphics, arcs and curved outlines with cutouts, through vias and slots. Blind/buried/micro vias, native DNP, embedded files and renamed layers fail with a named check.</Text>
    <Group><Button variant="subtle" loading={busy} onClick={() => void refresh()}>Refresh fabrication evidence</Button>
      {canExecute && <RequestButtons options={visible?.options} busy={busy} request={recipeId => void request(recipeId)} />}</Group>
    {visible?.error && <Alert color="red">{visible.error}</Alert>}
    {visible?.options?.unavailable_reason && <Text>{visible.options.unavailable_reason}</Text>}
    {visible?.options && <Text size="xs">Latest {visible.options.limit} builds at most.</Text>}
    {visible?.options?.builds.map(build => <SbJobCard key={build.build_id} title={build.build_id} state={jobState(build.state)} stateWords={pretty(build.state)} dimension="fabrication"
      detail={build.diagnostic ? <FailureDiagnostic diagnostic={build.diagnostic} /> : build.copper_layers ? `${build.copper_layers} copper layers` : undefined}
      actions={<Button variant="light" disabled={busy || build.state !== 'succeeded'} onClick={() => void refresh(build.build_id)}>Inspect fabrication build {build.build_id}</Button>} />)}
    {visible?.review && <FabricationReview item={visible.review} />}
  </Stack></Card>;
}

function RequestButtons({ options: listed, busy, request }: { options?: Options; busy: boolean; request: (recipeId: string) => void }) {
  const recipes = listed?.available_recipes ?? (listed?.available_recipe_id ? [{ recipe_id: listed.available_recipe_id, copper_layers: 0 }] : []);
  if (recipes.length <= 1) {
    const recipeId = recipes[0]?.recipe_id;
    return <Button disabled={busy || !recipeId} onClick={() => recipeId && request(recipeId)}>Request native fabrication outputs</Button>;
  }
  // The approved recipe declares the copper layer count; a mismatch fails with a named check.
  return <>{recipes.map(item => <Button key={item.recipe_id} disabled={busy} onClick={() => request(item.recipe_id)}>Request native fabrication outputs ({item.copper_layers} copper layers)</Button>)}</>;
}

function FailureDiagnostic({ diagnostic }: { diagnostic: Diagnostic }) {
  const line = { display: 'block' } as const;
  return <span>
    <Text size="sm" span fw={600} style={line}>Failed check: {diagnostic.check.replaceAll('_', ' ')}{diagnostic.code !== null ? ` · exit code ${diagnostic.code}` : ''}</Text>
    <Text size="sm" span style={line}>{diagnostic.message}</Text>
    {diagnostic.detail && <Text size="xs" span style={line}>Detail: {diagnostic.detail}</Text>}
    {diagnostic.stderr_class && <Text size="xs" span style={line}>Native error class: {diagnostic.stderr_class.replaceAll('_', ' ')}</Text>}
    {diagnostic.detail_retained && <Text size="xs" span style={line}>A bounded native error excerpt is retained in the build's registered failure report.</Text>}
  </span>;
}

function FabricationFeatures({ item }: { item: Review }) {
  const { features, project, custom_rules: rules, copper_layer_count: copper } = item.report;
  if (!features) return null;
  return <Stack gap={2}>
    <Text size="sm">{copper} copper layers · {features.through_vias} through vias · {features.slots} slots · {features.outlines} outline{features.outlines === 1 ? '' : 's'} with {features.cutouts} cutout{features.cutouts === 1 ? '' : 's'} · {features.production_graphics} production graphics</Text>
    <Text size="sm">Project: {project ? `${project.path} · ${project.sha256}` : 'none preserved; KiCad default design rules applied'}{rules ? ` · Custom rules: ${rules.path}` : ''}</Text>
    <Text size="sm">Zones: {features.copper_zones} copper, {features.rule_areas} rule areas, exported with stored fills and not refilled.</Text>
    {features.copper_zones_without_stored_copper > 0 && <Alert color="yellow">{features.copper_zones_without_stored_copper} copper zones have no stored copper; their area is absent from the Gerbers. Refill in KiCad if that is not intended.</Alert>}
    {features.unresolved_text_variables > 0 && <Alert color="yellow">{features.unresolved_text_variables} production text items still contain unresolved text variables.</Alert>}
  </Stack>;
}

function FabricationReview({ item }: { item: Review }) {
  const counts = item.report.drc_counts;
  return <Stack><Title order={4}>Registered export evidence</Title>
    <Text>Native export completed. DRC: {counts.violations} violations, {counts.unconnected_items} unconnected items. Schematic parity was not checked.</Text>
    <Text size="sm">Exact source: {item.source.path} · {item.source.sha256} · Rights: {item.source.rights}</Text>
    <Text size="xs"><RevisionLabel kind="source" id={item.source.source_revision_id} role="Source" /> · Manifest: {item.source.manifest_sha256}</Text>
    <Text size="xs">Recipe: {item.recipe_id} · Image: {item.image} · Report: {item.report_sha256}</Text>
    <Text size="sm">Gerber layers: {item.report.layers.join(', ')}. Drill format: {item.report.drill_format}.</Text>
    <FabricationFeatures item={item} />
    <Table><Table.Thead><Table.Tr><Table.Th>Registered output</Table.Th><Table.Th>SHA-256 / rights</Table.Th></Table.Tr></Table.Thead><Table.Tbody>{item.outputs.map(output => <Table.Tr key={output.output_id}><Table.Td><Anchor href={outputUrl(item, output.output_id)}>{output.path}</Anchor><Text size="xs">{output.size} bytes · {output.media_type}</Text></Table.Td><Table.Td><Text size="xs">{output.sha256}</Text><Text size="xs">{output.rights}</Text></Table.Td></Table.Tr>)}</Table.Tbody></Table>
    {item.report.unsupported.map(text => <Text size="sm" key={text}>{text}</Text>)}
  </Stack>;
}
