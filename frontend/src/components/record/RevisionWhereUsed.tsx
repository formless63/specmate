import { Alert, Button, Group, Stack, Text, Title } from '@mantine/core';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { ExactPins, RevisionLabel } from '../../lib/IdentityLabel';
import { whereUsed } from '../../features/discovery/api';

type Props = { revisionId: string; principalKey: string; active: boolean };
/** Engineering parents are captured snapshots. Project references are a different relationship. */
export function RevisionWhereUsed(props: Props) {
  return <SelectedUses key={`${props.principalKey}:${props.revisionId}`} {...props} />;
}
function SelectedUses({ revisionId, principalKey, active }: Props) {
  const [after, setAfter] = useState<string | undefined>();
  const query = useQuery({ queryKey: ['record-where-used', principalKey, revisionId, after], enabled: active, retry: false, refetchOnWindowFocus: 'always',
    queryFn: () => whereUsed(revisionId, after) });
  useEffect(() => { if (!active) return; const refresh = () => { void query.refetch(); }; window.addEventListener('focus', refresh); return () => window.removeEventListener('focus', refresh); }, [active, query.refetch]);
  if (!active) return null;
  if (query.isPending || query.isFetching) return <Text role="status">Reading current exact uses…</Text>;
  if (query.isError || !query.data || query.data.revision_id !== revisionId) return <Stack gap="xs"><Alert color="yellow">Exact uses unavailable. Retained parent and project rows are hidden.</Alert><Button size="xs" variant="quiet" onClick={() => void query.refetch()}>Refresh exact uses</Button></Stack>;
  const page = query.data;
  return <Stack gap="xs"><RevisionLabel id={revisionId} role="Selected child" />
    <Title order={4}>Engineering parents</Title>
    <Text size="xs">Captured parent snapshots pin this exact revision. They are not occurrence counts, compatibility or project membership.</Text>
    {!page.results.length && <Text>No parent snapshots pin this revision on this page.</Text>}
    {page.results.map(parent => <Stack key={parent.snapshot_id} gap={2}><Text fw={500}>{parent.label}<Text component="span" size="xs"> · {parent.definition_kind?.replaceAll('_', ' ') ?? 'Kind unknown'}</Text></Text><Text size="xs">Captured snapshot · exact revision pin</Text><ExactPins summary="Captured parent identity" pins={[{ label: 'Parent snapshot ID', value: parent.snapshot_id }, { label: 'Parent definition ID', value: parent.definition_id }]} /></Stack>)}
    <Group gap="xs"><Button size="xs" variant="quiet" disabled={!after} onClick={() => setAfter(undefined)}>First parent page</Button><Button size="xs" variant="quiet" disabled={!page.next_after} onClick={() => setAfter(page.next_after ?? undefined)}>More parent snapshots</Button></Group>
    <Title order={4}>Project references</Title>
    {!page.project_references.length && <Text>No project references this revision or its definition.</Text>}
    {page.project_references.map(reference => <Stack gap={0} key={reference.reference_id}><Text>{reference.project_name}{reference.archived ? ' · archived' : ''}</Text><Text size="xs">{reference.relation === 'project_reference_exact' ? 'Exact revision reference' : 'Floating definition reference'} · {reference.role || 'Role not declared'}</Text><ExactPins pins={[{ label: 'Project ID', value: reference.project_id }, { label: 'Project reference ID', value: reference.reference_id }]} /></Stack>)}
    {page.project_references_truncated && <Text size="xs">Only the first project references are listed.</Text>}
    <Text size="xs">A project reference declares use; it is separate from a captured engineering pin.</Text>
    <Button size="xs" variant="quiet" onClick={() => void query.refetch()}>Refresh exact uses</Button>
  </Stack>;
}
