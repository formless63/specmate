import { useEffect, useRef, useState } from 'react';
import { DesignList } from '../designs/DesignList';
import { useNavigation } from '../navigation';
import { useProbe } from '../probe';
import { toolForKind } from '../shell/scope';
import type { LibraryRecord, Project } from '../workspace/api';
import { DeviceRecordPage } from './DeviceRecordPage';

type Props = { active: boolean; principalKey: string; workspaceId: string; projectFilterId: string | null; projects: Project[]; creating?: boolean; onOpenInProject: (id: string, record: LibraryRecord) => void };
type Visit = { key: string; definitionId: string | null };
export function DeviceLibrary(props: Props) { return <DeviceSession key={`${props.principalKey}:${props.workspaceId}`} {...props} />; }
function DeviceSession({ active, principalKey, workspaceId, projectFilterId, projects, creating: creationRoute = false, onOpenInProject }: Props) {
  const navigation = useNavigation(), shared = useProbe(); const filters = navigation?.location.filters ?? {};
  const creating = active && (creationRoute || filters.status === 'new');
  const object = active && !creating ? shared?.probe?.object ?? null : null;
  const [visits, setVisits] = useState<Visit[]>([]); const pending = useRef('new:0');
  const targets = useRef(new Map<string, { revision: number | null; draft: boolean }>());
  const listFilters = useRef<Record<string, string>>({});
  const chosen = creating ? pending.current : object ? visits.find(visit => visit.definitionId === object)?.key ?? object : null;
  if (active && !chosen) listFilters.current = Object.fromEntries(Object.entries(filters).filter(([key]) => !['status', 'view', 'section'].includes(key)));
  if (active && chosen) targets.current.set(chosen, { revision: shared?.probe?.rev ?? null, draft: filters.status === 'draft' });
  useEffect(() => { if (chosen) setVisits(prior => prior.some(visit => visit.key === chosen) ? prior : [...prior, { key: chosen, definitionId: creating ? null : object }]); }, [chosen, creating, object]);
  const go = (id: string | null, revision: number | null = null, draft = false) => navigation?.navigate({ area: 'designs', lens: id ? 'assemblies' : 'designs', probe: id ? { object: id, rev: revision, path: [] } : null, filters: draft ? { ...listFilters.current, status: 'draft' } : listFilters.current });
  return <>
    {!chosen && <DesignList active={active} principalKey={principalKey} projectFilterId={projectFilterId} projects={projects} onOpen={record => navigation?.navigate({ area: 'designs', lens: toolForKind(record.kind), probe: { object: record.record_id, rev: null, path: [] } })} onCreate={() => navigation?.navigate({ area: 'designs', lens: 'new-design', probe: null, filters: {} })} />}
    {visits.map(visit => <div key={visit.key} hidden={chosen !== visit.key} inert={chosen !== visit.key}><DeviceRecordPage active={active && chosen === visit.key} principalKey={principalKey} workspaceId={workspaceId} definitionId={visit.definitionId} revisionNumber={targets.current.get(visit.key)?.revision ?? null} draftRequested={targets.current.get(visit.key)?.draft ?? false} projects={projects}
      onBack={() => go(null)} onSelect={(number, draft) => go(visit.definitionId, number, draft)} onOpenInProject={onOpenInProject}
      onCreated={(id, open) => { setVisits(prior => prior.map(item => item.key === visit.key ? { ...item, definitionId: id } : item)); pending.current = `new:${Date.now()}`; if (open) go(id, null, true); }} /></div>)}
  </>;
}
