import { Button, Group } from '@mantine/core';
import type { StockSpecification } from '../../../../packages/section-layout/src';
import { useEffect, useRef, useState } from 'react';
import { usePermission } from '../../lib/permissions';
import { useNewRequest } from '../library-gallery/newRequest';
import { LIBRARY_VIEWS } from '../shell/scope';
import { LibraryList } from '../../components/library/LibraryList';
import { useNavigation } from '../navigation';
import { useProbe } from '../probe';
import type { LibraryRecord, Project } from '../workspace/api';
import { StockRecordPage } from './StockRecordPage';

type Visit = { key: string; definitionId: string | null; initial?: { name: string; stock: StockSpecification } };
/** Collection and record are separate surfaces. Visited controllers retain unsaved buffers. */
type StockLibraryProps = {
  active: boolean; principalKey: string; workspaceId: string; projectFilterId: string | null; projects: Project[];
  onOpenInProject: (projectId: string, record: LibraryRecord) => void;
};
export function StockLibrary(props: StockLibraryProps) {
  return <StockLibrarySession key={props.principalKey} {...props} />;
}
function StockLibrarySession({ active, principalKey, workspaceId, projectFilterId, projects, onOpenInProject }: StockLibraryProps) {
  const navigation = useNavigation();
  const probe = useProbe();
  const filters = navigation?.location.filters ?? {};
  const object = active ? probe?.probe?.object ?? null : null;
  const creating = active && filters.status === 'new';
  const [visits, setVisits] = useState<Visit[]>([]);
  const [pending, setPending] = useState('new:0');
  const counter = useRef(0);
  const targets = useRef(new Map<string, { revision: number | null; draft: boolean }>());
  const listFilters = useRef<Record<string, string>>(Object.fromEntries(Object.entries(filters).filter(([key]) => !['view', 'status'].includes(key))));
  const chosen = creating ? pending : object ? visits.find(visit => visit.definitionId === object)?.key ?? object : null;
  if (active && !chosen) listFilters.current = filters;
  if (chosen) targets.current.set(chosen, { revision: probe?.probe?.rev ?? null, draft: filters.status === 'draft' });
  useEffect(() => {
    if (!chosen) return;
    setVisits(current => current.some(visit => visit.key === chosen) ? current : [...current, { key: chosen, definitionId: creating ? null : object }]);
  }, [chosen, creating, object]);
  const go = (definitionId: string | null, revision: number | null = null, status?: string) => {
    navigation?.navigate({ area: 'library', lens: 'wire-stock', probe: definitionId ? { object: definitionId, rev: revision, path: [] } : null, filters: status ? { ...listFilters.current, status } : listFilters.current });
  };
  const create = usePermission('item.create');
  useNewRequest(LIBRARY_VIEWS['wire-stock']!, !!chosen && create.allowed, () => go(null, null, 'new'));
  const duplicate = (name: string, stock: StockSpecification) => {
    counter.current += 1; const key = `new:${counter.current}`; setPending(key);
    setVisits(current => [...current, { key, definitionId: null, initial: { name: `${name} copy`, stock: structuredClone(stock) } }]); go(null, null, 'new');
  };
  const newBuffers = visits.filter(visit => !visit.definitionId);
  return <>
    {creating && newBuffers.length > 1 && <Group gap="xs" aria-label="Unsaved stocks">{newBuffers.map((visit, index) => <Button key={visit.key} variant="quiet" size="xs" aria-pressed={pending === visit.key} onClick={() => setPending(visit.key)}>{visit.initial?.name ?? `New stock ${index + 1}`}</Button>)}</Group>}
    {!chosen && <LibraryList toolId="wire-stock" principalKey={principalKey} projects={projects} projectFilterId={projectFilterId} onOpenInProject={onOpenInProject}
      editor={{ reveal: startNew => { if (startNew) go(null, null, 'new'); } }} />}
    {visits.map(visit => <div key={visit.key} hidden={chosen !== visit.key}><StockRecordPage active={active && chosen === visit.key} principalKey={principalKey} workspaceId={workspaceId}
      initial={visit.initial} onDuplicate={duplicate} projects={projects} definitionId={visit.definitionId} revisionNumber={targets.current.get(visit.key)?.revision ?? null} draftRequested={targets.current.get(visit.key)?.draft ?? false}
      onBack={() => go(null)} onSelect={(number, draft = false) => go(visit.definitionId, number, draft ? 'draft' : undefined)} onOpenInProject={onOpenInProject}
      onCreated={(id, open) => { setVisits(current => current.map(item => item.key === visit.key ? { ...item, definitionId: id } : item)); counter.current += 1; const next = `new:${counter.current}`; setPending(current => current === visit.key ? next : current); if (open) go(id, null, 'draft'); }} /></div>)}
  </>;
}
