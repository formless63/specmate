import { Alert, MantineThemeProvider, MultiSelect, Select, Text } from '@mantine/core';
import { useState } from 'react';
import { PlanEditor, PlanInspector } from '../cable-test-intent/PlanEditor';
import { initialPlan, inspectTarget, type TestPlan } from '../cable-test-intent/api';
import { authorizeConnectorReferences } from '../interfaces/connector-api';
import { IntentEditor, IntentInspector } from '../intents/IntentEditor';
import { emptyIntent, type CableIntent } from '../intents/api';
import { type Content } from '../parts/api';
import { SecondaryLibrary } from '../records/SecondaryLibrary';
import type { SecondaryContext } from '../records/SecondaryRecordPage';
import { type LibraryRecord, type Project } from '../workspace/api';

type Kind = 'cable_intent' | 'cable_test_plan';
type Props = { kind: Kind; record?: LibraryRecord; active: boolean; principalKey: string; workspaceId: string; projects?: Project[]; onOpenInProject?: (id: string, record: LibraryRecord) => void };
const labelFor = (kind: Kind) => kind === 'cable_intent' ? 'Recipe' : 'Test plan';
async function authorizeContent(content: Content) {
  await authorizeConnectorReferences(content);
  const plan = content.test_plan as TestPlan | undefined;
  if (plan?.root_revision_id && plan.cable_revision_id) await inspectTarget(plan);
}
/** Exact secondary identities retain their own working visit and CAS, separate from the cable. */
export function CableSecondaryRecord(props: Props) { return <CableSecondarySession key={`${props.principalKey}:${props.workspaceId}:${props.kind}`} {...props} />; }
function CableSecondarySession(props: Props) {
  const { kind, principalKey } = props;
  const [targetDenied, setTargetDenied] = useState<Record<string, boolean>>({});
  const targetKey = (context: SecondaryContext) => context.record?.definition_id ?? (context.selected?.kind === 'draft' ? context.selected.draft_id : 'new');
  const validTarget = (context: SecondaryContext) => {
    const intent = context.workingContent.interface as CableIntent | undefined, plan = context.workingContent.test_plan as TestPlan | undefined;
    return intent ? !!intent.from_revision_id && !!intent.to_revision_id : targetDenied[targetKey(context)] === false && !!plan?.root_revision_id && !!plan.cable_revision_id;
  };
  return <MantineThemeProvider theme={{ components: { Select: Select.extend({ defaultProps: { comboboxProps: { withinPortal: false } } }), MultiSelect: MultiSelect.extend({ defaultProps: { comboboxProps: { withinPortal: false } } }) } }}>
    <SecondaryLibrary active={props.active} principalKey={principalKey} workspaceId={props.workspaceId} toolId={kind === 'cable_intent' ? 'intents' : 'cable-test-intent'} projectFilterId={null} projects={props.projects ?? []} onOpenInProject={(id, record) => props.onOpenInProject?.(id, record)} config={{
      title: labelFor(kind), collectionLabel: kind === 'cable_intent' ? 'recipes' : 'Designs', viewLabel: kind === 'cable_intent' ? 'Connection requirements' : 'Expectations & labels',
      allowedKinds: [kind], initial: { kind, content: kind === 'cable_intent' ? { interface: emptyIntent() } : { test_plan: initialPlan() } }, authorizeContent,
      freezeOperation: kind === 'cable_intent' ? 'interface.freeze' : 'cable_test_plan.freeze',
      canSave: validTarget, canFreeze: context => validTarget(context) && !(context.workingContent.interface as CableIntent | undefined)?.rows.some(row => row.question),
      renderContent: context => {
        const intent = context.content.interface as CableIntent | undefined, plan = context.content.test_plan as TestPlan | undefined;
        return intent ? <><IntentEditor active={context.active} value={intent} permission={context.record ? 'design.edit' : 'item.create'} onChange={value => context.change({ ...context.content, interface: value })} />{intent.rows.some(row => row.question) && <Text>Answer the open questions before freezing.</Text>}</>
          : plan ? <PlanEditor active={context.active} principalKey={principalKey} disabled={!context.editable} onAuthorityChange={denied => { const key = targetKey(context); setTargetDenied(current => current[key] === denied ? current : { ...current, [key]: denied }); }} value={plan} onChange={value => context.change({ ...context.content, test_plan: value })} /> : <Alert color="red">Typed content is unavailable.</Alert>;
      },
      renderInspection: context => context.selected?.kind === 'revision' ? kind === 'cable_intent' ? <IntentInspector revisionId={context.selected.revision_id} active={context.active} onAccessDenied={context.refreshAccess} /> : <PlanInspector revisionId={context.selected.revision_id} hidden={!context.active} active={context.active} onAccessDenied={context.refreshAccess} /> : null,
    }} />
  </MantineThemeProvider>;
}
