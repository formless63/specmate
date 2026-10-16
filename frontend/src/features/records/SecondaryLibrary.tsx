import { Button, Group } from '@mantine/core';
import { useEffect, useRef, useState } from 'react';
import { LibraryList } from '../../components/library/LibraryList';
import { usePermission } from '../../lib/permissions';
import { useNewRequest } from '../library-gallery/newRequest';
import { useNavigation } from '../navigation';
import { useProbe } from '../probe';
import { LIBRARY_VIEWS } from '../shell/scope';
import type { LibraryRecord, Project } from '../workspace/api';
import { SecondaryRecordPage, type SecondaryRecordProps } from './SecondaryRecordPage';

export type SecondaryConfig = Pick<SecondaryRecordProps, 'title' | 'collectionLabel' | 'viewLabel' | 'initial' | 'allowedKinds' | 'freezeOperation' | 'authorizeContent' | 'contentSignature' | 'renderContent' | 'renderInspection' | 'inspector'>;
export type SecondaryLibraryProps = {
  active: boolean; principalKey: string; workspaceId: string; toolId: string;
  projectFilterId: string | null; projects: Project[];
  onOpenInProject: (id: string, record: LibraryRecord) => void; onAccessLost?: () => void;
  config: SecondaryConfig;
};
/** Retained visits belong to their own definition, independent of project list filters. */
export function SecondaryLibrary(props: SecondaryLibraryProps) { return <SecondaryLibrarySession key={`${props.principalKey}:${props.workspaceId}:${props.toolId}`} {...props} />; }
function SecondaryLibrarySession({ active, principalKey, workspaceId, toolId, projectFilterId, projects, onOpenInProject, onAccessLost, config }: SecondaryLibraryProps) {
  const nav = useNavigation(), probe = useProbe(), create = usePermission('item.create');
  const filters = nav?.location.filters ?? {}, object = active ? probe?.probe?.object ?? null : null, creating = active && filters.status === 'new';
  const [visits, setVisits] = useState<{ key: string; id: string | null }[]>([]), [pending, setPending] = useState('new:0');
  const count = useRef(0), targets = useRef(new Map<string, { number: number | null; working: boolean }>()), listFilters = useRef<Record<string, string>>({});
  const chosen = creating ? pending : object ? visits.find(v => v.id === object)?.key ?? object : null;
  if (active && !chosen) listFilters.current = Object.fromEntries(Object.entries(filters).filter(([key]) => !['status', 'view'].includes(key)));
  if (chosen) targets.current.set(chosen, { number: probe?.probe?.rev ?? null, working: filters.status === 'draft' });
  useEffect(() => { if (chosen) setVisits(current => current.some(v => v.key === chosen) ? current : [...current, { key: chosen, id: creating ? null : object }]); }, [chosen, creating, object]);
  const go = (id: string | null, number: number | null = null, working?: string) => nav?.navigate({ area: 'library', lens: toolId, probe: id ? { object: id, rev: number, path: id === probe?.probe?.object ? probe.probe.path : [] } : null, filters: { ...listFilters.current, ...(working ? { status: working } : {}) } });
  useNewRequest(LIBRARY_VIEWS[toolId]!, active && !!chosen && create.allowed, () => go(null, null, 'new'));
  return <>
    {active && !chosen && <LibraryList toolId={toolId} principalKey={principalKey} projectFilterId={projectFilterId} projects={projects} onOpenInProject={onOpenInProject} editor={{ reveal: startNew => { if (startNew) go(null, null, 'new'); } }} />}
    {creating && visits.filter(v => !v.id).length > 1 && <Group aria-label="Unsaved records">{visits.filter(v => !v.id).map((v, index) => <Button key={v.key} variant="quiet" aria-pressed={pending === v.key} onClick={() => setPending(v.key)}>New {config.title.toLowerCase()} {index + 1}</Button>)}</Group>}
    {visits.map(visit => <div hidden={chosen !== visit.key} inert={chosen !== visit.key || undefined} key={visit.key}><SecondaryRecordPage {...config} active={active && chosen === visit.key} principalKey={principalKey} workspaceId={workspaceId} definitionId={visit.id} revisionNumber={targets.current.get(visit.key)?.number ?? null} draftRequested={targets.current.get(visit.key)?.working ?? false} onAccessLost={onAccessLost} onBack={() => go(null)} onSelect={(number, working) => go(visit.id, number, working ? 'draft' : undefined)} onCreated={(id, open) => { setVisits(current => current.map(v => v.key === visit.key ? { ...v, id } : v)); setPending(value => value === visit.key ? `new:${++count.current}` : value); if (open) go(id, null, 'draft'); }} /></div>)}
  </>;
}
