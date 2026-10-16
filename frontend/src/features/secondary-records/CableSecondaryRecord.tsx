import { Alert, Button, Group, MantineThemeProvider, MultiSelect, Select, Stack, Text, TextInput } from '@mantine/core';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { usePermission } from '../../lib/permissions';
import { PlanEditor, PlanInspector } from '../cable-test-intent/PlanEditor';
import { initialPlan, inspectTarget, type TestPlan } from '../cable-test-intent/api';
import { authorizeConnectorReferences } from '../interfaces/connector-api';
import { IntentEditor, IntentInspector } from '../intents/IntentEditor';
import { emptyIntent, type CableIntent } from '../intents/api';
import { listLibraryTable } from '../library-gallery/table-api';
import { useNavigation } from '../navigation';
import { areaOfTool } from '../shell/areas';
import { type Content } from '../parts/api';
import { SecondaryRecordPage, type SecondaryContext } from '../records/SecondaryRecordPage';
import { useProbe } from '../probe';
import { type LibraryRecord } from '../workspace/api';

type Kind = 'cable_intent' | 'cable_test_plan';
type Props = { kind: Kind; record?: LibraryRecord; active: boolean; principalKey: string; workspaceId: string };
const toolFor = (kind: Kind) => kind === 'cable_intent' ? 'intents' : 'cable-test-intent';
const labelFor = (kind: Kind) => kind === 'cable_intent' ? 'Recipe' : 'Test plan';
const initial = (kind: Kind) => kind === 'cable_intent' ? { interface: emptyIntent() } : { test_plan: initialPlan() };

/** Secondary records keep their own identity, selected exact state, buffer and CAS. */
export function CableSecondaryRecord(props: Props) {
  return <RetainedRecords key={`${props.principalKey}:${props.workspaceId}:${props.kind}`} {...props} />;
}
function RetainedRecords(props: Props) {
  const { record, kind, active } = props, probe = useProbe()?.probe, nav = useNavigation(), cache = useQueryClient();
  const [targets, setTargets] = useState<Record<string, { record: LibraryRecord; revision: number | null; working: boolean }>>({});
  const [selected, setSelected] = useState<string | null>(null);
  const working = nav?.location.filters?.status === 'draft';
  useEffect(() => {
    if (active && record?.kind === kind && probe?.object === record.record_id) {
      setTargets(current => ({ ...current, [record.record_id]: { record, revision: probe.rev, working } }));
      setSelected(record.record_id);
    }
  }, [record, kind, active, probe?.object, probe?.rev, working]);
  const unavailable = active && !!probe && (record?.kind !== kind || record.record_id !== probe.object);
  const newRecord = active && !probe && nav?.location.filters?.status === 'new';
  return <>{unavailable && <Stack><Text role="status">This {labelFor(kind).toLowerCase()} is unavailable.</Text><Button onClick={() => void cache.invalidateQueries({ queryKey: ['workspace', 'route-record', props.principalKey, probe?.object] })}>Retry current record access</Button></Stack>}
    {active && !probe && !newRecord && <SecondaryCollection {...props} />}
    <div hidden={!newRecord}><SecondarySession {...props} active={newRecord} definitionId={null} revision={null} working /></div>
    {Object.entries(targets).map(([id, target]) => <div key={id} hidden={!active || unavailable || !!newRecord || !probe || id !== selected}>
      <SecondarySession {...props} active={active && !unavailable && !!probe && id === selected} definitionId={id} revision={target.revision} working={target.working} />
    </div>)}
  </>;
}
function SecondaryCollection({ kind, principalKey, workspaceId, active }: Props) {
  const nav = useNavigation(), gate = usePermission('item.create');
  const [search, setSearch] = useState(''), [after, setAfter] = useState<string | null>(null);
  const page = useQuery({ queryKey: ['secondary-record-list', principalKey, workspaceId, kind, search, after], enabled: active, retry: false,
    queryFn: () => listLibraryTable({ kinds: [kind], query: search, projectFilterId: null, after }) });
  const open = (id: string | null, filters = {}) => nav?.navigate({ area: areaOfTool(toolFor(kind)).id, lens: toolFor(kind), probe: id ? { object: id, rev: null, path: [] } : null, filters });
  return <Stack><Group justify="space-between"><Text component="h1">{labelFor(kind)} records</Text><Button {...gate.props} onClick={() => open(null, { status: 'new' })}>New {labelFor(kind).toLowerCase()}</Button></Group>
    <TextInput label={`Search ${labelFor(kind).toLowerCase()} records`} value={search} onChange={event => { setSearch(event.currentTarget.value); setAfter(null); }} />
    {page.isError && <Alert color="red">{page.error.message}</Alert>}
    {!page.isError && !page.isFetching && page.data?.results.map(row => <Button key={row.record_id} variant="quiet" onClick={() => open(row.record_id)}>{row.label}</Button>)}
    <Group><Button disabled={!after} onClick={() => setAfter(null)}>First page</Button><Button disabled={!page.data?.next_after || page.isFetching || page.isError} onClick={() => setAfter(page.data!.next_after)}>More records</Button></Group>
  </Stack>;
}
async function authorizeContent(content: Content) {
  await authorizeConnectorReferences(content);
  const plan = content.test_plan as TestPlan | undefined;
  if (plan?.root_revision_id && plan.cable_revision_id) await inspectTarget(plan);
}
function SecondarySession({ kind, principalKey, workspaceId, active, definitionId, revision, working }: Props & { definitionId: string | null; revision: number | null; working: boolean }) {
  const nav = useNavigation(), probe = useProbe();
  const select = (number: number | null, draft: boolean) => {
    if (!active || !definitionId) return;
    const filters = { ...nav?.location.filters }; delete filters.status; if (draft) filters.status = 'draft';
    nav?.navigate({ probe: { object: definitionId, rev: number, path: probe?.probe?.path ?? [] }, filters });
  };
  const [targetDenied, setTargetDenied] = useState(kind === 'cable_test_plan');
  const validTarget = (context: SecondaryContext) => {
    const intent = context.workingContent.interface as CableIntent | undefined, plan = context.workingContent.test_plan as TestPlan | undefined;
    return intent ? !!intent.from_revision_id && !!intent.to_revision_id : !targetDenied && !!plan?.root_revision_id && !!plan.cable_revision_id;
  };
  return <MantineThemeProvider theme={{ components: { Select: Select.extend({ defaultProps: { comboboxProps: { withinPortal: false } } }), MultiSelect: MultiSelect.extend({ defaultProps: { comboboxProps: { withinPortal: false } } }) } }}>
    <SecondaryRecordPage active={active} principalKey={principalKey} workspaceId={workspaceId} definitionId={definitionId} revisionNumber={revision} draftRequested={working}
      allowedKinds={[kind]} initial={{ kind, content: initial(kind) }} authorizeContent={authorizeContent} title={labelFor(kind)} collectionLabel={kind === 'cable_intent' ? 'recipes' : 'Designs'} viewLabel={kind === 'cable_intent' ? 'Connection requirements' : 'Expectations & labels'}
      freezeOperation={kind === 'cable_intent' ? 'interface.freeze' : 'cable_test_plan.freeze'}
      onBack={() => nav?.navigate({ area: 'designs', lens: kind === 'cable_intent' ? 'intents' : 'designs', probe: null, filters: {} })}
      onCreated={(id, open) => { if (open) nav?.navigate({ area: areaOfTool(toolFor(kind)).id, lens: toolFor(kind), probe: { object: id, rev: null, path: [] }, filters: { status: 'draft' } }); }} onSelect={select}
      canSave={validTarget} canFreeze={context => validTarget(context) && !(context.workingContent.interface as CableIntent | undefined)?.rows.some(row => row.question)}
      renderContent={context => {
        const intent = context.content.interface as CableIntent | undefined, plan = context.content.test_plan as TestPlan | undefined;
        return intent ? <><IntentEditor active={context.active} value={intent} permission={definitionId ? 'design.edit' : 'item.create'} onChange={value => context.change({ ...context.content, interface: value })} />{intent.rows.some(row => row.question) && <Text>Answer the open questions before freezing.</Text>}</>
          : plan ? <PlanEditor active={context.active} principalKey={principalKey} disabled={!context.editable} onAuthorityChange={setTargetDenied} value={plan} onChange={value => context.change({ ...context.content, test_plan: value })} /> : <Alert color="red">Typed content is unavailable.</Alert>;
      }}
      renderInspection={context => context.selected?.kind === 'revision' ? kind === 'cable_intent' ? <IntentInspector revisionId={context.selected.revision_id} active={context.active} onAccessDenied={context.refreshAccess} /> : <PlanInspector revisionId={context.selected.revision_id} hidden={!context.active} active={context.active} onAccessDenied={context.refreshAccess} /> : null} />
  </MantineThemeProvider>;
}
