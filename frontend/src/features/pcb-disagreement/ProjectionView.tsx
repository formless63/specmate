import { Alert, Button, Card, Group, Select, Stack, Text, TextInput, Title } from '@mantine/core';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { RevisionLabel } from '../../lib/IdentityLabel';
import { AssertionTable, SourceSummary } from './Editors';
import { label, read, terminalLabel, type Finding, type Review, type Comparison, type Projection, type Frozen } from './api';
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
