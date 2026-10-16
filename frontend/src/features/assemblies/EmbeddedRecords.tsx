import { Button, Group, Select, Stack } from '@mantine/core';
import { useRef, useState } from 'react';
import { DefinitionPickerScope, DefinitionSelect } from '../../components/library/DefinitionSelect';
import { usePermission } from '../../lib/permissions';
import type { SecondaryConfig } from '../records/SecondaryLibrary';
import { SecondaryRecordPage } from '../records/SecondaryRecordPage';

type Choice = { kind: string; label: string; config: SecondaryConfig };
/** A device section selects its own exact records; parent identity never becomes their ID. */
export function EmbeddedRecords(props: { active: boolean; principalKey: string; workspaceId: string; choices: Choice[] }) {
  return <EmbeddedSession key={`${props.principalKey}:${props.workspaceId}`} {...props} />;
}
function EmbeddedSession({ active, principalKey, workspaceId, choices }: { active: boolean; principalKey: string; workspaceId: string; choices: Choice[] }) {
  const [kind, setKind] = useState(choices[0]!.kind), [selected, setSelected] = useState<string | null>(null), [visits, setVisits] = useState<{ key: string; id: string | null; kind: string; number: number | null; working: boolean }[]>([]);
  const count = useRef(0), choice = choices.find(row => row.kind === kind)!, create = usePermission(choice.config.createPermission ?? 'item.create');
  function open(id: string | null) {
    const prior = id ? visits.find(row => row.id === id) : null, key = prior?.key ?? (id || `new:${++count.current}`);
    if (!prior) setVisits(current => [...current, { key, id, kind, number: null, working: !id }]);
    setSelected(key);
  }
  return <DefinitionPickerScope.Provider value={{ key: `${principalKey}:${workspaceId}:secondary`, active }}><Stack gap="xs"><Group align="end"><Select comboboxProps={{ withinPortal: false }} label="Secondary record kind" data={choices.map(row => ({ value: row.kind, label: row.label }))} value={kind} onChange={value => { if (value) { setKind(value); setSelected(null); } }} />
    <DefinitionSelect key={kind} label={`Choose ${choice.label.toLowerCase()}`} kind={kind} value={visits.find(row => row.key === selected)?.id ?? null} onChange={id => { if (id) open(id); }} />
    <Button {...create.props} disabled={!active || !create.allowed} onClick={() => open(null)}>New {choice.label.toLowerCase()}</Button></Group>
    {visits.map(visit => <div key={visit.key} hidden={selected !== visit.key} inert={!active || selected !== visit.key}><SecondaryRecordPage embedded {...choices.find(row => row.kind === visit.kind)!.config} active={active && selected === visit.key} principalKey={principalKey} workspaceId={workspaceId} definitionId={visit.id} revisionNumber={visit.number} draftRequested={visit.working} onBack={() => setSelected(null)} onCreated={(id, show) => { setVisits(current => current.map(row => row.key === visit.key ? { ...row, id } : row)); if (show) setSelected(visit.key); }} onSelect={(number, working) => setVisits(current => current.map(row => row.key === visit.key ? { ...row, number, working } : row))} /></div>)}
  </Stack></DefinitionPickerScope.Provider>;
}
