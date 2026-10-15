import { Anchor, Group, Paper, Stack, Text } from '@mantine/core';
import type { MouseEvent } from 'react';
import { SbUnknown } from '../../components/sb';
import { RevisionLabel } from '../../lib/IdentityLabel';
import { useRevisionLabel } from '../../lib/revision-labels';
import { useNavigation } from '../navigation/NavigationProvider';
import { formatLocation } from '../navigation/url';
import { areaOfTool } from '../shell/areas';
import type { Cable, Endpoint } from './api';

/** The name a cable end goes by: its own label, else "End" plus its stable ID. */
export const endName = (endpoint: Endpoint) => endpoint.label?.trim() || `End ${endpoint.local_id.toUpperCase()}`;

/** The declared finished length, else the route length; unknown stays unknown. */
function declaredLength(cable: Cable): { text: string; kind: string } | null {
  const finished = cable.lengths?.finished.declaration.amount_mm;
  if (finished) return { text: `${finished} mm`, kind: 'finished' };
  const route = cable.lengths?.route.amount_mm;
  if (route) return { text: `${route} mm`, kind: 'route' };
  return null;
}

/**
 * The cable as an assembled product: End A (connector and pinout), the stock it is built from
 * with its length, End B, and how many conductive elements each end has terminated. It reads
 * the declaration only; it does not evaluate continuity or compatibility.
 */
export function CableSummary({ cable, elementCount = null }: { cable: Cable; elementCount?: number | null }) {
  const length = declaredLength(cable);
  const ends = cable.endpoints;
  return <Paper withBorder p="sm" aria-label="Cable summary" className="sb-cable-summary">
    <Group align="stretch" gap="xs" wrap="wrap">
      {ends[0] && <EndCell cable={cable} endpoint={ends[0]} elementCount={elementCount} />}
      <Stack gap={2} justify="center" align="stretch" style={{ flex: '1 1 9rem', minWidth: 0 }}>
        <Text size="xs" c="dimmed" ta="center">Built from stock</Text>
        <div style={{ textAlign: 'center' }}>{cable.stock_revision_id ? <RevisionLabel id={cable.stock_revision_id} /> : <SbUnknown what="stock" />}</div>
        <div aria-hidden="true" style={{ borderTop: '3px solid var(--mantine-color-dimmed)', margin: '0.25rem 0' }} />
        <Text size="xs" ta="center">{length ? <>{length.kind === 'finished' ? 'Finished length' : 'Route length'} <span className="sb-mono">{length.text}</span></> : <>Length <SbUnknown /></>}</Text>
      </Stack>
      {ends[1] && <EndCell cable={cable} endpoint={ends[1]} elementCount={elementCount} />}
      {ends.slice(2).map(endpoint => <EndCell key={endpoint.local_id} cable={cable} endpoint={endpoint} elementCount={elementCount} />)}
    </Group>
  </Paper>;
}

function EndCell({ cable, endpoint, elementCount }: { cable: Cable; endpoint: Endpoint; elementCount: number | null }) {
  const assigned = cable.assignments.filter(a => a.endpoint_id === endpoint.local_id).length;
  return <Stack gap={2} style={{ flex: '0 1 14rem', minWidth: 0 }} aria-label={`${endName(endpoint)} summary`}>
    <Text fw={600} size="sm">{endName(endpoint)}</Text>
    <div>{endpoint.body_revision_id ? <RevisionLabel id={endpoint.body_revision_id} role="Connector" /> : <SbUnknown what="connector" />}</div>
    <div>{endpoint.pinout_revision_id ? <RevisionLabel id={endpoint.pinout_revision_id} role="Pinout" /> : <SbUnknown what="pinout" />}</div>
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
