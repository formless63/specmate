import { Alert, Button, Group, Stack, Text } from '@mantine/core';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { LibraryList } from '../../components/library/LibraryList';
import { usePermission } from '../../lib/permissions';
import { useNewRequest } from '../library-gallery/newRequest';
import { useNavigation } from '../navigation';
import { useProbe } from '../probe';
import { LIBRARY_VIEWS } from '../shell/scope';
import { PcbPanel } from '../pcb/PcbPanel';
import { requestJson, type LibraryRecord, type Project } from '../workspace/api';
import { BoardRecordPage } from './BoardRecordPage';
import type { Board } from './api';

type Props = { active: boolean; principalKey: string; workspaceId: string; projectFilterId: string | null; projects: Project[]; onOpenInProject: (id: string, record: LibraryRecord) => void };
type Visit = { key: string; definitionId: string | null; initial?: { name: string; board: Board } };
export function BoardLibrary(props: Props) { return <BoardSession key={`${props.principalKey}:${props.workspaceId}`} {...props} />; }
function BoardSession({ active, principalKey, workspaceId, projectFilterId, projects, onOpenInProject }: Props) {
  const navigation = useNavigation(); const probe = useProbe(); const create = usePermission('item.create');
  const filters = navigation?.location.filters ?? {};
  const object = active ? probe?.probe?.object ?? null : null; const creating = active && filters.status === 'new';
  const importing = active && filters.view === 'intake' && !object && !creating;
  const [importVisits, setImportVisits] = useState<string[]>([]);
  useEffect(() => { if (importing) setImportVisits(current => current.includes(filters.intake ?? '') ? current : [...current, filters.intake ?? '']); }, [importing, filters.intake]);
  const [visits, setVisits] = useState<Visit[]>([]); const [pending, setPending] = useState('new:0'); const counter = useRef(0);
  const targets = useRef(new Map<string, { revision: number | null; draft: boolean }>());
  const listFilters = useRef<Record<string, string>>({});
  const chosen = creating ? pending : object ? visits.find(visit => visit.definitionId === object)?.key ?? object : null;
  if (active && !chosen && !importing) listFilters.current = Object.fromEntries(Object.entries(filters).filter(([key]) => !['status', 'view', 'intake'].includes(key)));
  if (chosen) targets.current.set(chosen, { revision: probe?.probe?.rev ?? null, draft: filters.status === 'draft' });
  useEffect(() => { if (chosen) setVisits(current => current.some(visit => visit.key === chosen) ? current : [...current, { key: chosen, definitionId: creating ? null : object }]); }, [chosen, creating, object]);
  const go = (id: string | null, revision: number | null = null, status?: string) => navigation?.navigate({ area: 'library', lens: 'pcb', probe: id ? { object: id, rev: revision, path: [] } : null, filters: status ? { ...listFilters.current, status } : listFilters.current });
  useNewRequest(LIBRARY_VIEWS.pcb!, !!chosen && create.allowed, () => go(null, null, 'new'));
  const duplicate = (name: string, board: Board) => { counter.current += 1; const key = `new:${counter.current}`; setPending(key); setVisits(current => [...current, { key, definitionId: null, initial: { name: `${name} copy`, board: structuredClone(board) } }]); go(null, null, 'new'); };
  return <>
    {importVisits.map(id => <Stack key={id} hidden={!importing || (filters.intake ?? '') !== id} inert={!importing || (filters.intake ?? '') !== id}><Button size="xs" variant="quiet" onClick={() => go(null)}>Back to Boards</Button><PcbPanel workspaceId={workspaceId} initialIntakeId={id || undefined} standalone active={importing && (filters.intake ?? '') === id} /></Stack>)}
    {!chosen && !importing && <LibraryList toolId="pcb" principalKey={principalKey} projectFilterId={projectFilterId} projects={projects} onOpenInProject={onOpenInProject} editor={{ reveal: startNew => { if (startNew) go(null, null, 'new'); } }} />}
    {creating && visits.filter(visit => !visit.definitionId).length > 1 && <Group gap="xs" aria-label="Unsaved boards">{visits.filter(visit => !visit.definitionId).map((visit, index) => <Button size="xs" variant="quiet" key={visit.key} aria-pressed={pending === visit.key} onClick={() => setPending(visit.key)}>{visit.initial?.name ?? `New board ${index + 1}`}</Button>)}</Group>}
    {visits.map(visit => <div key={visit.key} hidden={chosen !== visit.key || importing}><RecordHost active={active && chosen === visit.key && !importing} principalKey={principalKey} workspaceId={workspaceId} projects={projects}
      definitionId={visit.definitionId} revisionNumber={targets.current.get(visit.key)?.revision ?? null} draftRequested={targets.current.get(visit.key)?.draft ?? false} initial={visit.initial} onDuplicate={duplicate}
      onBack={() => go(null)} onSelect={(number, draft) => go(visit.definitionId, number, draft ? 'draft' : undefined)} onOpenInProject={onOpenInProject}
      onCreated={(id, open) => { setVisits(current => current.map(item => item.key === visit.key ? { ...item, definitionId: id } : item)); counter.current += 1; const next = `new:${counter.current}`; setPending(value => value === visit.key ? next : value); if (open) go(id, null, 'draft'); }} /></div>)}
  </>;
}
type RecordProps = Omit<Parameters<typeof BoardRecordPage>[0], 'kind'>;
function RecordHost(props: RecordProps) {
  const knownKind = useRef<'board' | 'pcb_population' | null>(props.definitionId ? null : 'board');
  const metadata = useQuery({ queryKey: ['board-record', props.principalKey, props.definitionId, 'metadata'], enabled: props.active && !!props.definitionId, retry: false,
    queryFn: ({ signal }) => requestJson<LibraryRecord>(`/api/v0/workspace/library/${props.definitionId}`, { signal }) });
  if (metadata.data?.kind === 'board' || metadata.data?.kind === 'pcb_population') knownKind.current = metadata.data.kind;
  // Keep the controller mounted while its own authority query withdraws the surface.
  if (knownKind.current) return <BoardRecordPage {...props} kind={knownKind.current} />;
  if (metadata.isError) return <Stack><Button size="xs" variant="quiet" onClick={props.onBack}>Back to Boards</Button><Alert color="red">Board unavailable. Retained record details are hidden.</Alert><Button size="xs" onClick={() => void metadata.refetch()}>Refresh board</Button></Stack>;
  if (!metadata.data || metadata.isFetching) return <Text role="status">Reading selected board identity…</Text>;
  if (metadata.data.kind !== 'board' && metadata.data.kind !== 'pcb_population') return <Alert color="red">This definition is not a declared board or PCB population.</Alert>;
  return <Text role="status">Reading selected board state…</Text>;
}
