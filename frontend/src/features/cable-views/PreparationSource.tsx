import { useEffect } from 'react';
import { Alert, Stack, Text } from '@mantine/core';
import { useQuery } from '@tanstack/react-query';
import { read, type Definition, type Frozen } from '../end-preparation/api';
import { RevisionPicker } from '../cables/RevisionPicker';
import type { SidePreparation } from './SideView';

/**
 * Choose a frozen end preparation profile for the side view. Only a profile pinned to this exact
 * stock revision is applied; any other is refused rather than drawn against the wrong construction.
 */
export function PreparationSource({ stockRevisionId, revisionId, onRevision, onChange }: { stockRevisionId: string; revisionId: string; onRevision: (id: string) => void; onChange: (value: SidePreparation | null) => void }) {
  const definitions = useQuery({ queryKey: ['side-view-definitions'], queryFn: () => read<Definition[]>('workspace/definitions'), retry: false });
  const frozen = useQuery({ queryKey: ['end-preparation-frozen', revisionId], queryFn: () => read<Frozen>(`end-preparation/revisions/${revisionId}`), enabled: !!revisionId, retry: false });
  const mismatch = !!frozen.data && frozen.data.profile.stock_revision_id !== stockRevisionId;
  const usable = frozen.data && !frozen.isError && !mismatch && frozen.data.revision_id === revisionId ? frozen.data : null;
  useEffect(() => { onChange(usable ? { profile: usable.profile, label: `end preparation revision ${usable.revision_id}`, stockRevisionId: usable.profile.stock_revision_id } : null); }, [usable, onChange]);
  return <Stack gap="xs" aria-label="Side view end preparation">
    <Text size="sm">Prepared ends come from a frozen end preparation profile pinned to this stock revision.</Text>
    {definitions.error && <Alert color="red">{definitions.error.message}</Alert>}
    <RevisionPicker label="Side view end preparation" kind="end_preparation_profile" definitions={definitions.data ?? []} value={revisionId} onChange={onRevision} />
    {frozen.error && <Alert color="red">{frozen.error.message}</Alert>}
    {mismatch && <Alert color="yellow">This profile is pinned to a different stock revision and is not drawn.</Alert>}
  </Stack>;
}
