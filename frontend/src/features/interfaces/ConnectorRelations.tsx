import { Alert, Button, Group, Stack, Text } from '@mantine/core';
import { useEffect, useRef, useState } from 'react';
import { usePermission } from '../../lib/permissions';
import { ApiError } from '../workspace/api';
import { readConnectorRelations, type Relation, type RelationPage } from './connector-api';

type Props = { bodyRevisionId: string; kind: Relation['kind']; active: boolean; onOpen: (relation: Relation) => void; onAccessLost?: () => void; onNewPort?: (relation: Relation) => void; onNewStack?: (relation: Relation) => void };
/** One bounded metadata page. Record content is read only after a deliberate open. */
export function ConnectorRelations({ bodyRevisionId, kind, active, onOpen, onAccessLost, onNewPort, onNewStack }: Props) {
  const [positions, setPositions] = useState<(string | null)[]>([null]), [page, setPage] = useState<RelationPage | null>(null);
  const [error, setError] = useState(''), [confirmed, setConfirmed] = useState(false), [pending, setPending] = useState(false), [tick, setTick] = useState(0);
  const epoch = useRef(0), lost = useRef(onAccessLost); lost.current = onAccessLost;
  const create = usePermission('item.create');
  const after = positions.at(-1) ?? null;
  useEffect(() => {
    const version = ++epoch.current; setConfirmed(false);
    if (!active) return;
    async function refresh() {
      const read = ++epoch.current; setConfirmed(false); setPending(true); setError('');
      try { const value = await readConnectorRelations(bodyRevisionId, after, kind); if (read === epoch.current) { setPage(value); setConfirmed(true); } }
      catch (reason) { if (read === epoch.current) { setError(reason instanceof Error ? reason.message : 'Related records are unavailable.'); if (reason instanceof ApiError && [401, 403, 404].includes(reason.status)) lost.current?.(); } }
      finally { if (read === epoch.current) setPending(false); }
    }
    void refresh(); window.addEventListener('focus', refresh);
    return () => { if (epoch.current >= version) epoch.current += 1; window.removeEventListener('focus', refresh); };
  }, [bodyRevisionId, kind, active, after, tick]);
  if (!active) return null;
  return <Stack gap="xs">
    <Text size="sm">Latest frozen records at this page's anchor. Pins stay exact; sharing a body does not establish compatibility.</Text>
    {error && <Alert color="red">{error}</Alert>}
    {!confirmed && !error && <Text role="status">Confirming related records…</Text>}
    {confirmed && page && <>
      {page.results.length === 0 && <Text>No readable {kind === 'pinout' ? 'pinouts' : kind === 'port' ? 'device ports' : 'saved end stacks'} on this page.</Text>}
      {page.results.map(row => <div key={row.definition_id} className="connector-relation"><Group gap="xs"><Button variant="quiet" onClick={() => onOpen(row)}>Open {row.name} r{row.number}</Button><Text size="xs">{row.uses_selected_body_revision ? 'Pins this exact body revision' : 'Pins another body revision'}</Text></Group>
        {row.uses_other_body_revision && <Text size="xs">Another body revision is pinned. Compatibility with this selected revision is not evaluated.</Text>}
        {kind === 'pinout' && create.allowed && <Group gap="xs">{onNewPort && <Button variant="quiet" size="xs" onClick={() => onNewPort(row)}>New device port from {row.name} r{row.number}</Button>}{onNewStack && <Button variant="quiet" size="xs" onClick={() => onNewStack(row)}>New end stack from {row.name} r{row.number}</Button>}</Group>}
      </div>)}
      {page.scan_limit_reached && <Text size="xs">This bounded scan ended; continue for more readable records. Unavailable records are omitted.</Text>}
    </>}
    <Group gap="xs"><Button variant="quiet" size="xs" disabled={pending || positions.length === 1} onClick={() => setPositions(values => values.slice(0, -1))}>Previous related records</Button><Button variant="quiet" size="xs" disabled={pending || !confirmed || !page?.next_after} onClick={() => setPositions(values => [...values, page!.next_after])}>Next related records</Button><Button variant="quiet" size="xs" disabled={pending} onClick={() => { setPositions([null]); setTick(value => value + 1); }}>Refresh related records</Button></Group>
  </Stack>;
}

/** S8 picker contract: an explicitly chosen connector body scopes device-port choices. */
export function ConnectorPortPicker(props: Omit<Props, 'kind'>) { return <ConnectorRelations {...props} kind="port" />; }
