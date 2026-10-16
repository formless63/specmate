import { useState } from 'react';
import { SideSheet } from '../../components/record/SideSheet';
import { ConnectorRecordPage } from '../interfaces/ConnectorRecordPage';
import { blankConnector } from '../interfaces/useConnectorSession';
import type { ConnectorKind, ConnectorValue } from '../interfaces/connector-api';

export type FrozenPick = { definition_id: string; revision_id: string; number: number; kind: ConnectorKind; name: string };
/** The connector controller owns validation/CAS/authority; only its returned freeze is picked. */
type Props = { kind: 'port' | 'end_assembly'; active: boolean; opened: boolean; workspaceId: string; principalKey: string; onClose: () => void; onPick: (value: FrozenPick) => void; initial?: ConnectorValue };
export function ConnectorCreation(props: Props) {
  return <ConnectorCreationSession key={`${props.principalKey}:${props.workspaceId}:${props.kind}`} {...props} />;
}
function ConnectorCreationSession({ kind, active, opened, workspaceId, principalKey, onClose, onPick, initial }: Props) {
  const [definitionId, setDefinitionId] = useState<string | null>(null);
  const title = kind === 'port' ? 'New device port' : 'New saved end stack';
  return <SideSheet title={title} active={active} opened={opened} onClose={onClose}><ConnectorRecordPage active={active && opened} workspaceId={workspaceId} principalKey={principalKey} definitionId={definitionId} revisionNumber={null} draftRequested initial={{ kind, value: initial ?? blankConnector(kind) }} projects={[]} onCreated={id => setDefinitionId(id)} onSelect={() => {}} onBack={onClose} onNew={() => {}} onOpen={() => {}} onOpenInProject={() => {}} onFrozen={value => { onPick(value); onClose(); }} /></SideSheet>;
}
