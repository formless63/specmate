import { ReadOnlyNote, usePermission, InspectionScope } from '../../lib/permissions';
import { Alert, Button, Card, Group, Select, Stack, Text, TextInput, Title } from '@mantine/core';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { NativeExtraction } from './NativeExtraction';
import { AssertionEditor, AssertionTable, ComparisonEditor, SourceSummary } from './Editors';
import { blankAssertion, blankComparison, command, label, read, terminalLabel, type Comparison, type Definition, type Draft, type Finding, type Frozen, type Identity, type Projection, type Review, type Value } from './api';
import { revisionOptionLabel } from "../../lib/revision-labels";
import { RevisionLabel } from "../../lib/IdentityLabel";

export function PcbDisagreementPanel({ workspaceId }: { workspaceId: string }) { return <Workspace key={workspaceId} workspaceId={workspaceId} />; }
function Workspace({ workspaceId }: { workspaceId: string }) {
  const cache = useQueryClient();
  const createGate = usePermission('item.create');
  const freezeGate = usePermission('design.freeze');
  const [name, setName] = useState(''); const [value, setValue] = useState<Value>(blankAssertion());
  const [definition, setDefinition] = useState<string | null>(null), [draftId, setDraftId] = useState<string | null>(null), [revision, setRevision] = useState<string | null>(null);
  const [offset, setOffset] = useState(0), [createDenied, setCreateDenied] = useState(false), [draftDenied, setDraftDenied] = useState(false);
  const definitions = useQuery({ queryKey: ['pcb-review-definitions', workspaceId], queryFn: () => read<Definition[]>(`workspaces/${workspaceId}/definitions`) });
  const identity = useQuery({ queryKey: ['pcb-review-identity', definition, offset], queryFn: () => read<Identity>(`catalog/definitions/${definition}?offset=${offset}`), enabled: !!definition });
  const draft = useQuery({ queryKey: ['pcb-review-draft', draftId], queryFn: () => read<Draft>(`pcb-disagreement/drafts/${draftId}`), enabled: !!draftId });
  const create = useMutation({ mutationFn: () => command<Draft>('pcb_disagreement.create', { workspace_id: workspaceId, name, value }), onSuccess: async result => { setDefinition(result.definition_id); setDraftId(result.draft_id); setRevision(null); setOffset(0); await cache.invalidateQueries({ queryKey: ['pcb-review-definitions', workspaceId] }); } });
  const freeze = useMutation({ mutationFn: () => command<{ revision_id: string }>('pcb_disagreement.freeze', { draft_id: draftId }, draft.data?.state), onSuccess: async result => { setRevision(result.revision_id); await cache.invalidateQueries({ queryKey: ['pcb-review-draft', draftId] }); await cache.invalidateQueries({ queryKey: ['pcb-review-identity', definition] }); } });
  const rows = definitions.isError ? [] : definitions.data ?? [];
  const denied = definitions.isError || identity.isError;
  return <Stack><Title order={2}>PCB source disagreement</Title><Text>Compare independent exact-source assertions without choosing a correct source. Manual statements, accepted native board extraction, unresolved coverage and human review remain distinct.</Text>
    <NativeExtraction workspaceId={workspaceId} />
    <Card withBorder><Stack><Title order={3}>New assertion or comparison</Title><InspectionScope permission="item.create"><TextInput label="Source review definition name" value={name} onChange={e => setName(e.currentTarget.value)} /><Select label="New source review kind" value={value.kind} data={[{ value: 'pcb_assertion', label: 'Human source assertion' }, { value: 'pcb_comparison', label: 'Independent source comparison' }]} onChange={kind => { setValue(kind === 'pcb_assertion' ? blankAssertion() : blankComparison()); setCreateDenied(false); }} />
      {value.kind === 'pcb_assertion' ? <AssertionEditor value={value} onChange={setValue} onDenied={setCreateDenied} /> : <ComparisonEditor workspaceId={workspaceId} value={value} onChange={setValue} definitions={rows} sourcePinsCurrent={false} onDenied={setCreateDenied} />}</InspectionScope>
      <Button disabled={!name || definitions.isError || createDenied} loading={create.isPending} onClick={() => create.mutate()} {...createGate.props}>Create source review draft</Button><ReadOnlyNote permission="item.create">Creating source review drafts is unavailable.</ReadOnlyNote>{create.isError && <Alert color="red">{create.error.message}</Alert>}
    </Stack></Card>
    {definitions.isError && <Alert color="red">{definitions.error.message}</Alert>}{identity.isError && <Alert color="red">{identity.error.message}</Alert>}{draft.isError && <Alert color="red">{draft.error.message}</Alert>}
    <Select label="Existing source review definition" searchable value={denied ? null : definition} disabled={definitions.isError} data={rows.filter(d => ['pcb_assertion', 'pcb_comparison'].includes(d.kind)).map(d => ({ value: d.definition_id, label: `${d.name} (${d.kind})` }))} onChange={id => { setDefinition(id); setDraftId(null); setRevision(null); setOffset(0); }} />
    {identity.data && !denied && <><Select label="Source review draft" value={draftId} data={identity.data.drafts.map(d => ({ value: d.draft_id, label: `${d.draft_id} · ${d.state}` }))} onChange={setDraftId} /><Select label="Frozen source review revision" value={revision} data={identity.data.revisions.map((r) => ({ value: r.revision_id, label: revisionOptionLabel(identity.data.name, r.number) }))} onChange={setRevision} /><Group><Button disabled={!offset} onClick={() => setOffset(Math.max(0, offset - 50))}>Earlier source reviews</Button><Button disabled={Math.max(identity.data.revisions.length, identity.data.drafts.length) < 50} onClick={() => setOffset(offset + 50)}>Later source reviews</Button></Group></>}
    {draft.data && !draft.isError && !denied && <><DraftEditor key={`${draft.data.draft_id}:${draft.data.state}`} draft={draft.data} workspaceId={workspaceId} definitions={rows} onDenied={setDraftDenied} onSaved={async () => { await cache.invalidateQueries({ queryKey: ['pcb-review-draft', draftId] }); }} /><Button disabled={draftDenied} loading={freeze.isPending} onClick={() => freeze.mutate()} {...freezeGate.props}>Freeze source review revision</Button></>}
    {freeze.isError && <Alert color="red">{freeze.error.message}</Alert>}
    {revision && !denied && !draft.isError && <PcbDisagreementInspector key={revision} revisionId={revision} />}
  </Stack>;
}
function DraftEditor({ draft, workspaceId, definitions, onDenied, onSaved }: { draft: Draft; workspaceId: string; definitions: Definition[]; onDenied: (v: boolean) => void; onSaved: () => Promise<void> }) {
  const initial = draft.content.pcb_assertion ?? draft.content.pcb_comparison!;
  const editGate = usePermission('design.edit');
  const [value, setValue] = useState<Value>(initial); const [denied, setDenied] = useState(false);
  useEffect(() => onDenied(denied), [denied, onDenied]);
  const save = useMutation({ mutationFn: () => command('pcb_disagreement.update', { draft_id: draft.draft_id, value }, draft.state), onSuccess: onSaved });
  const pinsCurrent = value.kind === 'pcb_comparison' && initial.kind === 'pcb_comparison' && JSON.stringify([value.left, value.right]) === JSON.stringify([initial.left, initial.right]);
  const findingsCurrent = pinsCurrent && value.kind === "pcb_comparison" && initial.kind === "pcb_comparison" && JSON.stringify(value.correspondences) === JSON.stringify(initial.correspondences);
  return <Card withBorder><Stack><Title order={3}>Edit source review draft</Title><Text>{draft.state}</Text>
    <InspectionScope permission="design.edit">{value.kind === 'pcb_assertion' ? <AssertionEditor value={value} onChange={setValue} onDenied={setDenied} /> : <ComparisonEditor workspaceId={workspaceId} value={value} onChange={setValue} definitions={definitions} projection={draft.projection} sourcePinsCurrent={pinsCurrent} onDenied={setDenied} />}</InspectionScope>
    {!denied && <>{value.kind === "pcb_comparison" && !findingsCurrent && <Text>Save input and correspondence changes before reviewing findings. Findings below describe the saved draft.</Text>}<ProjectionView projection={draft.projection} reviewValue={value.kind === 'pcb_comparison' && findingsCurrent ? value : undefined} onReviewChange={setValue} /></>}
    <Button disabled={denied} loading={save.isPending} onClick={() => save.mutate()} {...editGate.props}>Save source review draft</Button><ReadOnlyNote permission="design.edit">Saving source review drafts is unavailable.</ReadOnlyNote>{save.isError && <Alert color="red">{save.error.message}</Alert>}
  </Stack></Card>;
}
function FindingSide({ value }: { value: Finding['left'] }) { return <Text>{value === null ? 'No counterpart declared' : 'members' in value ? `Correspondence members: ${value.members.join(', ')}` : `${terminalLabel(value)} · ${label(value.net_state)} · ${value.net_name ?? 'no net name'}`}</Text>; }
function FindingCard({ finding, review, onChange }: { finding: Finding; review?: Review; onChange?: (v: Review | null) => void }) {
  const [status, setStatus] = useState<Review['status']>(review?.status ?? 'acknowledged'); const [basis, setBasis] = useState(review?.basis ?? '');
  return <Card withBorder><Stack gap="xs"><Text fw={600}>{label(finding.kind)}</Text><Text>{finding.explanation}</Text><Text>Left assertion</Text><FindingSide value={finding.left} /><Text>Right assertion</Text><FindingSide value={finding.right} />
    <Text>Review: {review ? `${label(review.status)} · ${review.basis}` : 'unreviewed'}</Text>
    {onChange && <><Select label={`Review decision ${finding.finding_id}`} value={status} data={['acknowledged', 'requires_source_correction', 'not_comparable'].map(v => ({ value: v, label: label(v) }))} onChange={v => setStatus(v as Review['status'])} /><TextInput label={`Review basis ${finding.finding_id}`} value={basis} onChange={e => setBasis(e.currentTarget.value)} /><Button disabled={!basis} onClick={() => onChange({ finding_id: finding.finding_id, status, basis })}>Record decision for {label(finding.kind)}</Button>{review && <Button variant="subtle" onClick={() => onChange(null)}>Remove review {finding.finding_id}</Button>}</>}
    <Text size="xs">Finding identity: {finding.finding_id}</Text>
  </Stack></Card>;
}
export function ProjectionView({ projection, reviewValue, onReviewChange }: { projection: Projection; reviewValue?: Comparison; onReviewChange?: (v: Comparison) => void }) {
  const [page, setPage] = useState(0);
  const findings = projection.findings ?? [];
  return <Stack><Text>Parity: {projection.parity}. Physical qualification: {projection.physical_qualification}.</Text>
    {projection.assertion && <><SourceSummary value={projection.assertion} /><AssertionTable terminals={projection.assertion.terminals} /></>}
    {projection.inputs && <><Title order={4}>Independent source evidence</Title><Card withBorder><Text>Left</Text><SourceSummary value={projection.inputs.left} /></Card><Card withBorder><Text>Right</Text><SourceSummary value={projection.inputs.right} /></Card></>}
    {projection.comparison_status && <><Title order={4}>Reviewable findings</Title><Text>{findings.length} findings · {label(projection.comparison_status)}</Text><Text>A review decision does not choose the correct source, repair originals, or establish parity.</Text>
      {findings.slice(page * 25, page * 25 + 25).map(f => <FindingCard key={f.finding_id} finding={f} review={reviewValue ? reviewValue.reviews.find(r => r.finding_id === f.finding_id) : f.review ?? undefined} onChange={reviewValue && onReviewChange ? r => onReviewChange({ ...reviewValue, reviews: [...reviewValue.reviews.filter(old => old.finding_id !== f.finding_id), ...(r ? [r] : [])] }) : undefined} />)}
      <Group><Button disabled={!page} onClick={() => setPage(page - 1)}>Previous findings</Button><Button disabled={(page + 1) * 25 >= findings.length} onClick={() => setPage(page + 1)}>Next findings</Button></Group>
    </>}{projection.limitations?.map(text => <Text size="sm" key={text}>{text}</Text>)}
  </Stack>;
}
export function PcbDisagreementInspector({ revisionId }: { revisionId: string }) {
  const query = useQuery({ queryKey: ['pcb-review-frozen', revisionId], queryFn: () => read<Frozen>(`pcb-disagreement/revisions/${revisionId}`) });
  return <Card withBorder><Stack><Title order={3}>Frozen source review</Title><Text><RevisionLabel id={revisionId} /></Text>{query.isError && <Alert color="red">{query.error.message}</Alert>}{query.data && !query.isError && <ProjectionView projection={query.data.projection} />}</Stack></Card>;
}
