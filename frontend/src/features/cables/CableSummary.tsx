import { Anchor, Group, Paper, Stack, Text } from '@mantine/core';
import type { MouseEvent } from 'react';
import { SbUnknown } from '../../components/sb';
import { RevisionLabel } from '../../lib/IdentityLabel';
import { useRevisionLabel } from '../../lib/revision-labels';
import { useNavigation } from '../navigation/NavigationProvider';
import { formatLocation } from '../navigation/url';
import { areaOfTool } from '../shell/areas';
import type { Cable, Endpoint } from './api';
import { LAYER_LABELS, type ResolvedStack } from '../end-assemblies/api';
import { StackDiagram, resolvedChips } from '../end-assemblies/StackEditor';

/** The name a cable end goes by: its own label, else "End" plus its stable ID. */
export const endName = (endpoint: Endpoint) => endpoint.label?.trim() || `End ${endpoint.local_id.toUpperCase()}`;

/** The declared finished length, else the route length; unknown stays unknown. */
export function declaredLength(cable: Cable): { text: string; kind: string } | null {
  const finished = cable.lengths?.finished.declaration.amount_mm;
  if (finished) return { text: `${finished} mm`, kind: 'finished' };
  const route = cable.lengths?.route.amount_mm;
  if (route) return { text: `${route} mm`, kind: 'route' };
  return null;
}

/**
 * The cable as an assembled product: End A's stack (shell outermost on the left), the stock
 * with its length, End B's stack, and how many conductive elements each end has terminated.
 * It reads the declaration only; it does not evaluate continuity or compatibility.
 */
export function CableSummary({ cable, elementCount = null, stacks = [] }: { cable: Cable; elementCount?: number | null; stacks?: (ResolvedStack | undefined)[] }) {
  const length = declaredLength(cable);
  const ends = cable.endpoints;
  return <Paper withBorder p="sm" aria-label="Cable summary" className="sb-cable-summary">
    <Group align="stretch" gap="xs" wrap="wrap">
      {ends[0] && <EndCell cable={cable} endpoint={ends[0]} elementCount={elementCount} resolved={stacks[0]} mirrored />}
      <Stack gap={2} justify="center" align="stretch" style={{ flex: '1 1 9rem', minWidth: 0 }}>
        <Text size="xs" c="dimmed" ta="center">Built from stock</Text>
        <div style={{ textAlign: 'center' }}>{cable.stock_revision_id ? <RevisionLabel id={cable.stock_revision_id} /> : <SbUnknown what="stock" />}</div>
        <div aria-hidden="true" style={{ borderTop: '3px solid var(--mantine-color-dimmed)', margin: '0.25rem 0' }} />
        <Text size="xs" ta="center">{length ? <>{length.kind === 'finished' ? 'Finished length' : 'Route length'} <span className="sb-mono">{length.text}</span></> : <>Length <SbUnknown /></>}</Text>
      </Stack>
      {ends[1] && <EndCell cable={cable} endpoint={ends[1]} elementCount={elementCount} resolved={stacks[1]} />}
      {ends.slice(2).map((endpoint, i) => <EndCell key={endpoint.local_id} cable={cable} endpoint={endpoint} elementCount={elementCount} resolved={stacks[i + 2]} />)}
    </Group>
  </Paper>;
}

/** Layer chips from the declared stack when it has not been resolved (yet), labels by exact pin. */
function DeclaredLayers({ endpoint, mirrored }: { endpoint: Endpoint; mirrored: boolean }) {
  if (endpoint.end_assembly_revision_id !== null) return endpoint.end_assembly_revision_id ? <div><RevisionLabel id={endpoint.end_assembly_revision_id} role="End assembly" /></div> : <SbUnknown what="end assembly" />;
  const layers = endpoint.stack?.layers ?? [];
  const shown = mirrored ? [...layers].reverse() : layers;
  if (!shown.length) return <SbUnknown what="end stack" />;
  return <>{shown.map(layer => {
    const id = layer.kind === 'connector' ? layer.body_revision_id : layer.kind === 'board' ? layer.board_revision_id : layer.kind === 'shell' ? layer.part_revision_id : null;
    return <div key={layer.layer_id}>{layer.kind === 'inline' ? <Text size="xs">Inline parts · {layer.parts.length}</Text> : id ? <RevisionLabel id={id} role={LAYER_LABELS[layer.kind]} /> : <SbUnknown what={LAYER_LABELS[layer.kind].toLowerCase()} />}</div>;
  })}</>;
}

function EndCell({ cable, endpoint, elementCount, resolved, mirrored = false }: { cable: Cable; endpoint: Endpoint; elementCount: number | null; resolved?: ResolvedStack; mirrored?: boolean }) {
  const assigned = cable.assignments.filter(a => a.endpoint_id === endpoint.local_id).length;
  return <Stack gap={2} style={{ flex: '0 1 16rem', minWidth: 0 }} aria-label={`${endName(endpoint)} summary`}>
    <Text fw={600} size="sm">{endName(endpoint)}</Text>
    <Text size="xs" c="dimmed">{endpoint.stock_end && endpoint.stock_end !== 'unknown' ? `Stock end ${endpoint.stock_end.toUpperCase()}` : <SbUnknown what="stock end" />}</Text>
    {resolved ? <StackDiagram layers={resolvedChips(resolved)} mirrored={mirrored} label={`${endName(endpoint)} layers`} /> : <DeclaredLayers endpoint={endpoint} mirrored={mirrored} />}
    <Text size="xs" data-testid={`terminated-${endpoint.local_id}`}>{elementCount === null ? `${assigned} terminated` : `${assigned} of ${elementCount} terminated`}</Text>
  </Stack>;
}

/** A link to the stock a cable is built from, in the Wire stock lens. */
export function StockLink({ revisionId }: { revisionId: string }) {
  const navigation = useNavigation();
  const label = useRevisionLabel(revisionId).data;
  if (!label?.readable || !label.definition_id) return null;
  const target = { area: areaOfTool('wire-stock').id, lens: 'wire-stock', project: navigation?.location.project ?? null, probe: { object: label.definition_id, rev: label.number, path: [] as string[] } };
  const open = (event: MouseEvent<HTMLAnchorElement>) => {
    if (!navigation || event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
    event.preventDefault();
    navigation.navigate(target);
  };
  return <Anchor href={formatLocation(target)} onClick={open} size="sm">Open {label.name} r{label.number} in Wire stock</Anchor>;
}
