import { Button, Group, Stack, Text, Title } from '@mantine/core';
import { useEffect, useState } from 'react';
import { usePermission } from '../../lib/permissions';
import { useNewRequest } from '../library-gallery/newRequest';
import { useNavigation } from '../navigation';
import { useProbe } from '../probe';
import { LIBRARY_VIEWS } from '../shell/scope';
import type { Project } from '../workspace/api';
import { FactLedger } from './FactLedger';
import { FactRegistration } from './FactRegistration';

type Props = { workspaceId: string; principalKey: string; active: boolean; projects?: Project[]; projectId?: string };
export function FactRecords(props: Props) { return <FactsSession key={`${props.principalKey}:${props.workspaceId}`} {...props} />; }
function FactsSession(props: Props) {
  const navigation = useNavigation(), probe = useProbe()?.probe, create = usePermission('item.create');
  const [visited, setVisited] = useState<string[]>([]);
  const subjectId = props.active ? probe?.object ?? null : null;
  const registering = props.active && !subjectId && navigation?.location.filters?.status === 'new';
  useEffect(() => { if (subjectId) setVisited(current => current.includes(subjectId) ? current : [...current, subjectId]); }, [subjectId]);
  const startNew = () => navigation?.navigate({ area: 'library', lens: 'facts', project: null, probe: null, filters: { status: 'new' } });
  useNewRequest(LIBRARY_VIEWS.facts!, props.active && create.allowed, startNew);
  return <Stack><Group><Button variant="quiet" onClick={() => navigation?.navigate({ area: 'library', lens: 'library-home', project: null, probe: null, filters: {} })}>Back to Library</Button>{!registering && <Button {...create.props} onClick={startNew}>New fact ledger</Button>}</Group>
    <div hidden={!registering}><FactRegistration {...props} active={registering} onRegistered={id => navigation?.navigate({ area: 'library', lens: 'facts', project: null, probe: { object: id, rev: null, path: [] }, filters: {} })} /></div>
    {props.active && !subjectId && !registering && <Text>Open a fact ledger from the Library, or register an explicit engineering subject.</Text>}
    {visited.map(id => <section key={id} hidden={subjectId !== id} inert={subjectId !== id || undefined} aria-label="Fact ledger record"><Title order={2}>Fact ledger</Title><FactLedger subjectId={id} principalKey={props.principalKey} active={props.active && subjectId === id} /></section>)}
  </Stack>;
}
