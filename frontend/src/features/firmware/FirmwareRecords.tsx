import { Button, Group, Stack } from '@mantine/core';
import { useEffect, useRef, useState } from 'react';
import { DefinitionPickerScope, DefinitionSelect } from '../../components/library/DefinitionSelect';
import { usePermission } from '../../lib/permissions';
import { useNewRequest } from '../library-gallery/newRequest';
import { useNavigation } from '../navigation';
import { useProbe } from '../probe';
import { LIBRARY_VIEWS } from '../shell/scope';
import type { LibraryRecord, Project } from '../workspace/api';
import { FirmwareRecordPage } from './FirmwareRecordPage';

type Props = { active: boolean; principalKey: string; workspaceId: string; projectFilterId?: string | null; projects?: Project[]; onOpenInProject?: (id: string, record: LibraryRecord) => void; embedded?: boolean };
/** Each declaration keeps its own selected state and working buffer, independent of a parent device. */
export function FirmwareRecords(props: Props) { return <FirmwareVisits key={`${props.principalKey}:${props.workspaceId}`} {...props} />; }
function FirmwareVisits(props: Props) {
  const nav = useNavigation(), probe = useProbe()?.probe, create = usePermission('item.create');
  const [localSelected, setLocalSelected] = useState<string | null>(null), [visits, setVisits] = useState<{ key: string; id: string | null; number: number | null; working: boolean }[]>([]);
  const targets = useRef(new Map<string, { number: number | null; working: boolean }>());
  const count = useRef(0), [pending, setPending] = useState('new:0');
  const creating = !props.embedded && props.active && nav?.location.filters?.status === 'new';
  const chosen = props.embedded ? localSelected : creating ? pending : props.active ? probe?.object ?? null : null;
  useEffect(() => { if (!props.embedded && chosen) setVisits(current => current.some(row => row.key === chosen || row.id === chosen) ? current : [...current, { key: chosen, id: creating ? null : chosen, number: null, working: creating }]); }, [chosen, creating, props.embedded]);
  const chosenKey = visits.find(row => row.id === chosen)?.key ?? chosen;
  if (!props.embedded && chosenKey && props.active) targets.current.set(chosenKey, { number: probe?.rev ?? null, working: creating || nav?.location.filters?.status === 'draft' });
  const go = (id: string | null, number: number | null = null, working?: string) => nav?.navigate({ area: 'designs', lens: !id && !working ? 'designs' : 'occurrence-firmware', probe: id ? { object: id, rev: number, path: id === probe?.object ? probe.path : [] } : null, filters: working ? { status: working, ...(working === 'new' ? { kind: 'firmware' } : {}) } : {} });
  const start = () => { if (props.embedded) open(null); else go(null, null, 'new'); };
  useNewRequest(LIBRARY_VIEWS['occurrence-firmware']!, props.active && create.allowed, start);
  function open(id: string | null) { const prior = id ? visits.find(row => row.id === id) : null, key = prior?.key ?? id ?? `new:${++count.current}`; if (!prior) setVisits(current => [...current, { key, id, number: null, working: !id }]); setLocalSelected(key); }
  return <DefinitionPickerScope.Provider value={{ key: `${props.principalKey}:${props.workspaceId}:firmware`, active: props.active }}><Stack>
    {props.embedded ? <Group align="end"><DefinitionSelect label="Choose firmware declaration" kind="firmware" value={visits.find(row => row.key === chosenKey)?.id ?? null} onChange={id => { if (id) open(id); }} /><Button {...create.props} disabled={!props.active || !create.allowed} onClick={start}>New firmware declaration</Button></Group> : props.active && !chosen && <Button onClick={() => go(null)}>Browse designs</Button>}
    {visits.map(visit => { const active = props.active && chosenKey === visit.key; return <div key={visit.key} hidden={!active} inert={!active || undefined}><FirmwareRecordPage active={active} embedded={props.embedded} principalKey={props.principalKey} workspaceId={props.workspaceId} definitionId={visit.id} revisionNumber={props.embedded ? visit.number : targets.current.get(visit.key)?.number ?? null} working={props.embedded ? visit.working : targets.current.get(visit.key)?.working ?? false} onBack={() => props.embedded ? setLocalSelected(null) : go(null)} onCreated={(id, show) => { setVisits(current => current.map(row => row.key === visit.key ? { ...row, id, working: true } : row)); setPending(`new:${++count.current}`); if (show && !props.embedded) go(id, null, 'draft'); }} onSelect={(number, working) => { setVisits(current => current.map(row => row.key === visit.key ? { ...row, number, working } : row)); if (!props.embedded) go(visit.id, number, working ? 'draft' : undefined); }} /></div>; })}
  </Stack></DefinitionPickerScope.Provider>;
}
