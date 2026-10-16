import { Button, Group } from '@mantine/core';
import { useEffect, useRef, useState } from 'react';
import { LibraryList } from '../../components/library/LibraryList';
import { usePermission } from '../../lib/permissions';
import { useNavigation } from '../navigation';
import { useProbe } from '../probe';
import { useNewRequest } from '../library-gallery/newRequest';
import { LIBRARY_VIEWS } from '../shell/scope';
import type { LibraryRecord, Project } from '../workspace/api';
import { PartRecordPage } from './PartRecordPage';
import { blankKit, blankPart, type Content } from './api';

type Props = { active: boolean; principalKey: string; workspaceId: string; toolId: string; projectFilterId: string | null; projects: Project[]; onOpenInProject: (project: string, record: LibraryRecord) => void; onAccessLost?: () => void };
type Visit = { key: string; definitionId: string | null; initial: { kind: string; content: Content; name?: string } };
const toolFor = (kind: string, previous: string) => kind === 'kit' ? 'kits' : kind === 'mechanical_source' ? 'mechanical-sources' : kind === 'hardware' || previous === 'hardware' ? 'hardware' : 'identity';
export function PartsLibrary(props: Props) { return <PartsSession key={`${props.principalKey}:${props.workspaceId}`} {...props} />; }
function PartsSession({ active, principalKey, workspaceId, toolId, projectFilterId, projects, onOpenInProject, onAccessLost }: Props) {
  const nav = useNavigation(), probe = useProbe(), create = usePermission('item.create');
  const filters = nav?.location.filters ?? {}, object = active ? probe?.probe?.object ?? null : null, creating = active && filters.status === 'new';
  const newKind = toolId === 'kits' ? 'kit' : 'part';
  const [visits, setVisits] = useState<Visit[]>([]), [pending, setPending] = useState<Record<string, string>>({ part: 'new:part', kit: 'new:kit' });
  const count = useRef(0), selected = useRef(new Map<string, { revision: number | null; draft: boolean; add?: string }>()), listFilters = useRef<Record<string, string>>({});
  const chosen = creating ? pending[newKind]! : object ? visits.find(visit => visit.definitionId === object)?.key ?? object : null;
  if (active && !chosen) listFilters.current = Object.fromEntries(Object.entries(filters).filter(([key]) => !['status', 'view', 'from'].includes(key)));
  if (chosen) selected.current.set(chosen, { revision: probe?.probe?.rev ?? null, draft: filters.status === 'draft', add: filters.from });
  useEffect(() => { if (chosen) setVisits(current => current.some(visit => visit.key === chosen) ? current : [...current, { key: chosen, definitionId: creating ? null : object, initial: { kind: newKind, content: newKind === 'kit' ? blankKit() : blankPart(toolId === 'hardware') } }]); }, [chosen, creating, object, newKind, toolId]);
  const go = (id: string | null, tool = toolId, revision: number | null = null, status?: string, add?: string) => nav?.navigate({ area: 'library', lens: tool, probe: id ? { object: id, rev: revision, path: id === probe?.probe?.object ? probe.probe.path : [] } : null, filters: { ...listFilters.current, ...(status ? { status } : {}), ...(add ? { from: add } : {}) } });
  const newVisit = (kind: string, content: Content, name?: string) => { if (!create.allowed) return; const key = `new:${++count.current}`; setPending(current => ({ ...current, [kind === 'kit' ? 'kit' : 'part']: key })); setVisits(current => [...current, { key, definitionId: null, initial: { kind, content: structuredClone(content), name } }]); go(null, toolFor(kind, toolId), null, 'new'); };
  useNewRequest(LIBRARY_VIEWS[toolId] ?? LIBRARY_VIEWS.identity!, active && !!chosen && create.allowed, () => go(null, toolId, null, 'new'));
  return <>
    {creating && visits.filter(visit => !visit.definitionId).length > 1 && <Group aria-label="Unsaved parts and kits">{visits.filter(visit => !visit.definitionId).map((visit, index) => <Button variant="quiet" size="xs" key={visit.key} aria-pressed={chosen === visit.key} onClick={() => { setPending(current => ({ ...current, [visit.initial.kind === 'kit' ? 'kit' : 'part']: visit.key })); go(null, toolFor(visit.initial.kind, toolId), null, 'new'); }}>{visit.initial.name || `New ${visit.initial.kind} ${index + 1}`}</Button>)}</Group>}
    {active && !chosen && <>{toolId === 'hardware' && <Group><Button size="xs" variant="quiet" {...create.props} onClick={() => newVisit('mechanical_source', { mechanical_source: { schema_version: '1', item_role: 'enclosure', sources: [], targets: [], models: [], limitations: [] } })}>New enclosure or mechanical source</Button></Group>}<LibraryList toolId={toolId === 'mechanical-sources' ? 'hardware' : toolId} principalKey={principalKey} projectFilterId={projectFilterId} projects={projects} onOpenInProject={onOpenInProject} editor={{ reveal: startNew => { if (startNew) go(null, toolId === 'mechanical-sources' ? 'hardware' : toolId, null, 'new'); } }} /></>}
    {visits.map(visit => <div hidden={chosen !== visit.key} key={visit.key}><PartRecordPage collectionLabel={['hardware', 'mechanical-sources'].includes(toolId) ? 'Shells & hardware' : toolId === 'kits' ? 'Kits' : 'Parts'} active={active && chosen === visit.key} principalKey={principalKey} workspaceId={workspaceId} definitionId={visit.definitionId} initial={visit.initial} projects={projects} revisionNumber={selected.current.get(visit.key)?.revision ?? null} draftRequested={selected.current.get(visit.key)?.draft ?? false} addRevision={selected.current.get(visit.key)?.add} onAccessLost={onAccessLost}
      onBack={() => go(null, toolId === 'mechanical-sources' ? 'hardware' : toolId)} onSelect={(number, working) => go(visit.definitionId, toolId, number, working ? 'draft' : undefined)} onDuplicate={newVisit} onOpenKit={(id, revision, add) => go(id, 'kits', revision, add ? 'draft' : undefined, add)} onOpenInProject={onOpenInProject}
      onCreated={(id, shouldOpen) => { setVisits(current => current.map(item => item.key === visit.key ? { ...item, definitionId: id } : item)); const key = visit.initial.kind === 'kit' ? 'kit' : 'part'; setPending(current => current[key] === visit.key ? { ...current, [key]: `new:${++count.current}` } : current); if (shouldOpen) go(id, toolFor(visit.initial.kind, toolId), null, 'draft'); }} /></div>)}
  </>;
}
