import { Alert, Stack } from '@mantine/core';
import { useQuery } from '@tanstack/react-query';
import type { SecondaryConfig } from '../records/SecondaryLibrary';
import type { SecondaryContext } from '../records/SecondaryRecordPage';
import { authorizeSecondary, secondaryPins } from '../assemblies/secondary-authority';
import { InterfaceEditor } from './InterfaceFields';
import { InterfaceInspector } from './InterfaceInspector';
import { AssessmentEditor, AssessmentResults } from './AssessmentFields';
import { initialInterface, type Interface } from './api';
import { initialAssessment, read, type Assessment, type Inspection } from './assessment-api';
import { recordInterfaceAssessment } from '../evidence/api';
import { RecordResult } from '../evidence/RecordResult';

export type SecondaryInterfaceKind = 'interface_map' | 'interface_assessment';
function AssessmentInspection(context: SecondaryContext) {
  const id = context.selected?.kind === 'revision' ? context.selected.revision_id : null;
  const inspection = useQuery({ queryKey: ['secondary-assessment-inspection', id], enabled: context.active && !!id, retry: false, queryFn: () => read<Inspection>(`interfaces/revisions/${id}`) });
  return <Stack><fieldset disabled style={{ border: 0, padding: 0 }}><AssessmentEditor value={(context.content.interface as Assessment | undefined) ?? initialAssessment()} onChange={() => {}} /></fieldset>
    {inspection.error && <Alert color="red">{inspection.error.message}</Alert>}
    {context.active && inspection.data && !inspection.isFetching && !inspection.error && <><AssessmentResults result={inspection.data.assessment} /><RecordResult fingerprint={id!} record={key => recordInterfaceAssessment(id!, key)} /></>}
  </Stack>;
}
export function interfaceConfig(kind: SecondaryInterfaceKind): SecondaryConfig {
  const assessment = kind === 'interface_assessment';
  return {
    title: assessment ? 'Interface assessment' : 'Interface mapping', collectionLabel: 'Interfaces', viewLabel: assessment ? 'Assessment' : 'Mapping', allowedKinds: [kind], freezeOperation: 'interface.freeze',
    initial: { kind, content: { interface: assessment ? initialAssessment() : initialInterface('interface_map') } }, authorizeContent: authorizeSecondary, contentSignature: content => JSON.stringify(secondaryPins(content)),
    renderContent: context => assessment ? <AssessmentEditor value={(context.content.interface as Assessment | undefined) ?? initialAssessment()} onChange={value => context.change({ ...context.content, interface: value })} /> : <InterfaceEditor value={(context.content.interface as Interface | undefined) ?? initialInterface('interface_map')} onChange={value => context.change({ ...context.content, interface: value })} active={context.active} mode="draft" definitionId={context.record?.definition_id ?? null} />,
    renderInspection: context => assessment ? <AssessmentInspection {...context} /> : context.selected?.kind === 'revision' ? <InterfaceInspector revisionId={context.selected.revision_id} /> : null,
  };
}
