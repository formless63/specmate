import { Alert, Button, Stack, Text } from '@mantine/core';
import { useQuery } from '@tanstack/react-query';
import { lazy, Suspense, useRef, useState } from 'react';
import { usePermission } from '../../lib/permissions';
import { randomUUID } from '../../lib/random-id';
import { runOperation } from '../workspace/api';
const FactLedger = lazy(() => import('../facts/FactLedger').then(module => ({ default: module.FactLedger })));
export function PartFacts({ principalKey, workspaceId, active, definitionId, revisionId }: { principalKey: string; workspaceId: string; active: boolean; definitionId: string; revisionId: string | null }) {
  const target = revisionId ? { kind: 'revision', revision_id: revisionId } : { kind: 'definition', definition_id: definitionId };
  const permission = usePermission('item.create'), [busy, setBusy] = useState(false), [error, setError] = useState(''), keys = useRef(new Map<string, string>());
  const identity = `${principalKey}:${workspaceId}:${definitionId}:${revisionId}:${active}`, current = useRef(identity); current.current = identity;
  const subject = useQuery({ queryKey: ['part-facts', principalKey, workspaceId, definitionId, revisionId], enabled: active, retry: false,
    queryFn: async () => (await runOperation<{ subject: { subject_id: string } | null }>('facts.resolve_subject', { target })).result.subject });
  const selected = active && !subject.isError && !subject.isFetching ? subject.data : undefined;
  async function register() { if (!active || !permission.allowed || busy) return; const selected = identity; let key = keys.current.get(identity); if (!key) { key = randomUUID(); keys.current.set(identity, key); } setBusy(true); setError(''); try { await runOperation('facts.register_subject', { target }, { idempotencyKey: key }); if (current.current === selected) void subject.refetch(); } catch (failure) { if (current.current === selected) setError(failure instanceof Error ? failure.message : 'Fact ledger could not be opened.'); } finally { setBusy(false); } }
  return <Stack><Text size="sm">{revisionId ? 'Facts on this exact frozen revision.' : 'Facts on the reusable definition; draft edits do not change its identity.'} Authored values and packages do not establish measured facts.</Text>{subject.isError && <Alert color="red">{subject.error.message}</Alert>}{error && <Alert color="red">{error}</Alert>}
    {selected && <Suspense fallback={<Text>Loading facts…</Text>}><FactLedger key={`${principalKey}:${workspaceId}:${selected.subject_id}`} subjectId={selected.subject_id} /></Suspense>}
    {selected === null && <><Text>No fact ledger is registered for this selected state.</Text>{permission.allowed && <Button loading={busy} onClick={() => void register()}>Register fact ledger</Button>}</>}
    {subject.isFetching && <Text role="status">Checking selected facts…</Text>}
  </Stack>;
}
