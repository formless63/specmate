import { Stack, Text } from '@mantine/core';
import { useState } from 'react';
import { RecordSections } from '../../components/record';
import { RevisionLabel } from '../../lib/IdentityLabel';
import { configurationConfig } from '../configurations/ConfigurationRecords';
import { FirmwareAssignmentReview } from '../firmware/FirmwareAssignmentReview';
import { FirmwareRecords } from '../firmware/FirmwareRecords';
import { FirmwareOccurrencesPanel } from '../firmware-occurrences/FirmwareOccurrencesPanel';
import { FirmwareImpactPanel } from '../firmware-impact/FirmwareImpactPanel';
import { interfaceConfig } from '../interfaces/InterfaceRecords';
import { EmbeddedRecords } from './EmbeddedRecords';
import { MechanicalProposalFields } from '../mechanical-proposals/MechanicalProposalFields';
import { ProbeProvider } from '../probe';
import type { ProbeTarget } from '../navigation/url';
import { SceneDrawingFields } from '../scene-drawings/SceneDrawingFields';
export type DeviceSectionProps = { section: 'interfaces' | 'options' | 'enclosure' | 'drawings' | 'firmware'; active: boolean; principalKey: string; workspaceId: string; definitionId: string | null; revisionId: string | null; snapshotId: string | null; draftId?: string | null; draftDirty?: boolean };
/** Secondary engineering records keep their own selection, draft and concurrency token. */
export function DeviceSections(props: DeviceSectionProps) {
  const [probe, setProbe] = useState<ProbeTarget | null>(null);
  return <ProbeProvider probe={probe} onProbe={setProbe}><div hidden={!props.active} inert={!props.active}><Stack gap="xs">
    {props.revisionId && <RevisionLabel id={props.revisionId} role="Open device basis" snapshotId={props.snapshotId ?? undefined} />}
    <Text size="xs">These tools manage separate records with their own exact inputs and editing tokens. Choose the target in each tool; opening a device does not change those records.</Text>
    {props.section === 'interfaces' && <EmbeddedRecords active={props.active} principalKey={props.principalKey} workspaceId={props.workspaceId} choices={[{kind:'interface_map',label:'Interface mapping',config:interfaceConfig('interface_map')},{kind:'interface_assessment',label:'Interface assessment',config:interfaceConfig('interface_assessment')}]}/>}
    {props.section === 'options' && <EmbeddedRecords active={props.active} principalKey={props.principalKey} workspaceId={props.workspaceId} choices={[{kind:'option_set',label:'Option set',config:configurationConfig('option_set',`${props.principalKey}:${props.workspaceId}`)},{kind:'configuration',label:'Configuration',config:configurationConfig('configuration',`${props.principalKey}:${props.workspaceId}`)}]}/>}
    {props.section === 'enclosure' && <MechanicalProposalFields active={props.active} workspaceId={props.workspaceId} principalKey={props.principalKey} />}
    {props.section === 'drawings' && <><Text size="sm">Drawing generation uses an explicitly chosen frozen scene snapshot. Captured draft previews are not frozen drawing inputs.</Text><SceneDrawingFields workspaceId={props.workspaceId} principalKey={props.principalKey} active={props.active} /></>}
    {props.section === 'firmware' && <RecordSections sections={[
      { id: 'declarations', label: 'Firmware declarations and builds', content: () => <FirmwareRecords embedded active={props.active} principalKey={props.principalKey} workspaceId={props.workspaceId} /> },
      { id: 'occurrences', label: 'Review firmware on repeated boards', content: () => <FirmwareOccurrencesPanel active={props.active} principalKey={props.principalKey} owner={props.draftDirty ? null : props.draftId ? { draft_id: props.draftId } : props.snapshotId ? { snapshot_id: props.snapshotId } : null} /> },
      { id: 'assigned-targets', label: 'Review assigned firmware targets', content: () => <FirmwareAssignmentReview snapshotId={props.snapshotId} principalKey={props.principalKey} active={props.active} /> },
      { id: 'impact', label: 'Compare exact firmware impact', content: () => <FirmwareImpactPanel active={props.active} principalKey={props.principalKey} workspaceId={props.workspaceId} ownerSnapshotId={props.snapshotId} /> },
    ]} />}
  </Stack></div></ProbeProvider>;
}
