import { Alert, Button, Group } from '@mantine/core';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { LibraryList } from '../../components/library/LibraryList';
import { usePermission } from '../../lib/permissions';
import { useNavigation } from '../navigation';
import { useProbe } from '../probe';
import { useNewRequest } from '../library-gallery/newRequest';
import { LIBRARY_VIEWS } from '../shell/scope';
import { requestJson, type LibraryRecord, type Project } from '../workspace/api';
import { SecondaryLibrary } from '../records/SecondaryLibrary';
import { interfaceConfig, type SecondaryInterfaceKind } from './InterfaceRecords';
import { ConnectorRecordPage } from './ConnectorRecordPage';
import type { ConnectorKind, ConnectorValue, Relation } from './connector-api';

type Visit = { key: string; definitionId: string | null; kind: ConnectorKind; initial?: { kind: ConnectorKind; value: ConnectorValue; name?: string } };
type Props = { recordKind?: string | null; active: boolean; principalKey: string; workspaceId: string; toolId: string; projectFilterId: string | null; projects: Project[]; onOpenInProject: (project: string, record: LibraryRecord) => void };
const toolFor = (kind: ConnectorKind) => kind === 'port' ? 'ports' : kind === 'end_assembly' ? 'end-assemblies' : 'interfaces';
/** Retention is workspace-library local; project chips only filter the collection. */
export function ConnectorLibrary(props: Props) { return <ConnectorRoute key={`${props.principalKey}:${props.workspaceId}`} {...props} />; }
function ConnectorRoute(props: Props) {
 const nav=useNavigation(),probe=useProbe(),object=props.active?probe?.probe?.object:null,filters=nav?.location.filters??{};
 const kind=useQuery({queryKey:['interface-route-kind',props.principalKey,props.workspaceId,object,probe?.probe?.rev,filters.status],enabled:props.active&&!!object&&!props.recordKind,retry:false,queryFn:()=>{const query=new URLSearchParams({include_content:'false'});if(probe?.probe?.rev!==null&&probe?.probe?.rev!==undefined)query.set('revision_number',String(probe.probe.rev));else if(filters.status==='draft')query.set('working','true');return requestJson<{kind:string}>(`/api/v0/catalog/definitions/${encodeURIComponent(object!)}/record?${query}`,{cache:'no-store'});}});
 const selected=object?props.recordKind??kind.data?.kind:filters.status==='new'?filters.kind:null,secondary=['interface_map','interface_assessment'].includes(selected??''),ready=!object||!!props.recordKind||kind.isSuccess&&!kind.isFetching;
 return <>{props.active&&object&&!ready&&<Alert color={kind.error?'red':'blue'}>{kind.error?.message??'Checking exact interface record…'}{kind.error&&<Button onClick={()=>void kind.refetch()}>Refresh exact interface</Button>}</Alert>}
 <div hidden={secondary||!ready}><ConnectorLibrarySession {...props} active={props.active&&ready&&!secondary}/></div>
 {(['interface_map','interface_assessment'] as SecondaryInterfaceKind[]).map(value=><div key={value} hidden={!ready||selected!==value}><SecondaryLibrary {...props} toolId="interfaces" active={props.active&&ready&&selected===value} config={interfaceConfig(value)}/></div>)}</>;
}
function ConnectorLibrarySession({ active, principalKey, workspaceId, toolId, projectFilterId, projects, onOpenInProject }: Props) {
  const nav = useNavigation(), probe = useProbe();
  const filters = nav?.location.filters ?? {};
  const kind: ConnectorKind = toolId === 'ports' ? 'port' : toolId === 'end-assemblies' ? 'end_assembly' : filters.kind === 'pinout' ? 'pinout' : 'connector_body';
  const object = active ? probe?.probe?.object ?? null : null, creating = active && filters.status === 'new';
  const [visits, setVisits] = useState<Visit[]>([]), [pending, setPending] = useState<Record<string, string>>({ connector_body: 'new:body', pinout: 'new:pinout', port: 'new:port', end_assembly: 'new:stack' });
  const counter = useRef(0), targets = useRef(new Map<string, { revision: number | null; draft: boolean }>());
  const listFilters = useRef<Record<string, string>>({});
  const chosen = creating ? pending[kind]! : object ? visits.find(visit => visit.definitionId === object)?.key ?? object : null;
  if (active && !chosen) listFilters.current = Object.fromEntries(Object.entries(filters).filter(([key]) => !['status', 'view'].includes(key)));
  if (chosen) targets.current.set(chosen, { revision: probe?.probe?.rev ?? null, draft: filters.status === 'draft' });
  useEffect(() => { if (chosen) setVisits(current => current.some(visit => visit.key === chosen) ? current : [...current, { key: chosen, definitionId: creating ? null : object, kind }]); }, [chosen, creating, object, kind]);
  const go = (id: string | null, selectedKind = kind, revision: number | null = null, status?: string) => nav?.navigate({ area: 'library', lens: toolFor(selectedKind), probe: id ? { object: id, rev: revision, path: [] } : null, filters: { ...listFilters.current, kind: selectedKind, ...(status ? { status } : {}) } });
  const create = usePermission('item.create');
  useNewRequest(LIBRARY_VIEWS[toolId]!, active && !!chosen && create.allowed, () => go(null, kind, null, 'new'));
  const newRecord = (nextKind: ConnectorKind, value: ConnectorValue, name?: string) => {
    if (!create.allowed) return;
    const key = `new:${++counter.current}`; setPending(current => ({ ...current, [nextKind]: key })); setVisits(current => [...current, { key, definitionId: null, kind: nextKind, initial: { kind: nextKind, value: structuredClone(value), name } }]); go(null, nextKind, null, 'new');
  };
  const open = (row: Relation) => go(row.definition_id, row.kind, row.number);
  return <>
    {creating && visits.filter(visit => !visit.definitionId).length > 1 && <Group aria-label="Unsaved connectors">{visits.filter(visit => !visit.definitionId).map((visit, index) => <Button variant="quiet" size="xs" key={visit.key} aria-pressed={pending[visit.kind] === visit.key} onClick={() => { setPending(current => ({ ...current, [visit.kind]: visit.key })); go(null, visit.kind, null, 'new'); }}>{visit.initial?.name || `New connector ${index + 1}`}</Button>)}</Group>}
    {active && !chosen && <LibraryList toolId={toolId} principalKey={principalKey} projects={projects} projectFilterId={projectFilterId} onOpenInProject={onOpenInProject} editor={{ reveal: startNew => { if (startNew) go(null, kind, null, 'new'); } }} />}
    {visits.map(visit => <div key={visit.key} hidden={chosen !== visit.key}><ConnectorRecordPage active={active && chosen === visit.key} principalKey={principalKey} workspaceId={workspaceId} definitionId={visit.definitionId} revisionNumber={targets.current.get(visit.key)?.revision ?? null} draftRequested={targets.current.get(visit.key)?.draft ?? false}
      initial={visit.initial ?? { kind: visit.kind }} projects={projects} onBack={() => go(null, visit.kind)} onSelect={(number, draft) => go(visit.definitionId, visit.kind, number, draft ? 'draft' : undefined)} onNew={newRecord} onOpen={open} onOpenInProject={onOpenInProject}
      onCreated={(id, shouldOpen) => { setVisits(current => current.map(item => item.key === visit.key ? { ...item, definitionId: id } : item)); setPending(current => ({ ...current, [visit.kind]: `new:${++counter.current}` })); if (shouldOpen) go(id, visit.kind, null, 'draft'); }} /></div>)}
  </>;
}
