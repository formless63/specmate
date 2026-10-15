import { ReadOnlyNote, usePermission } from '../../lib/permissions';
import { Alert, Button, Card, Group, Select, Stack, Text, Title } from '@mantine/core';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { AssertionTable, SourcePicker } from './Editors';
import { blankSource, command, isUuid, label, read, type Frozen, type NativeAccepted, type NativeAttempts } from './api';

export function NativeExtraction({ workspaceId, active = true }: { workspaceId: string; active?: boolean }) {
  const cache = useQueryClient();
  const executeGate = usePermission('build.execute');
  const acceptGate = usePermission('source.register');
  const [source, setSource] = useState(blankSource());
  const [role, setRole] = useState<'schematic' | 'netlist'>('schematic');
  const [denied, setDenied] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [blocked, setBlocked] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState('');
  const available = useQuery({ queryKey: ['pcb-native-options', source.source_revision_id, source.path, role], queryFn: () => read<{ available_recipe_id: string | null }>(`pcb-disagreement/native-options?${new URLSearchParams({ source_revision_id: source.source_revision_id, path: source.path, role })}`), enabled: active && isUuid(source.source_revision_id) && !!source.path && !denied });
  const attempts = useQuery({ queryKey: ['pcb-native-attempts', workspaceId], enabled: active, queryFn: () => read<NativeAttempts>(`pcb-disagreement/native?workspace_id=${workspaceId}`) });
  async function clearEvidence(failedSourceId = source.source_revision_id) {
    const keys = [
      ['pcb-native-attempts', workspaceId],
      ['pcb-native-options', source.source_revision_id, source.path, role],
    ];
    const sourceIds = new Set([source.source_revision_id, failedSourceId].filter(Boolean));
    const nativeIds = new Set([
      ...(selected ? [selected] : []),
      ...(attempts.data?.attempts ?? []).filter(a => sourceIds.has(a.source.source_revision_id)).flatMap(a => a.interpretation ? [a.interpretation.interpretation_id] : []),
      ...cache.getQueriesData<NativeAccepted>({ queryKey: ['pcb-native-interpretation'] }).flatMap(([, value]) => value && sourceIds.has(value.source.source_revision_id) ? [value.interpretation_id] : []),
    ]);
    // Comparison selectors share these exact evidence queries. Recheck only the
    // affected native sources, preserving unsaved comparison values and tokens.
    const authorityKeys = [
      ...Array.from(sourceIds, id => ['pcb-review-source', id]),
      ...Array.from(nativeIds, id => ['pcb-native-interpretation', id]),
      ...cache.getQueriesData<Frozen>({ queryKey: ['pcb-review-frozen'] }).flatMap(([key, value]) =>
        value?.projection.inputs && Object.values(value.projection.inputs).some(input =>
          ['native_schematic_export', 'preserved_netlist_parser'].includes(input.method) && sourceIds.has(input.source.source_revision_id)
        ) ? [key] : []),
    ];
    setBlocked(true); setSelected(null); setSource(blankSource());
    await Promise.all([...keys, ...authorityKeys].map(queryKey => cache.cancelQueries({ queryKey, exact: true })));
    keys.forEach(queryKey => cache.removeQueries({ queryKey, exact: true }));
    await Promise.all(authorityKeys.map(queryKey => cache.invalidateQueries({ queryKey, exact: true, refetchType: 'all' })));
  }
  async function refreshStatus() {
    if (!active) return;
    setRefreshing(true); setRefreshError('');
    try {
      await Promise.all([
        attempts.refetch({ throwOnError: true }),
        ...(isUuid(source.source_revision_id) && source.path ? [available.refetch({ throwOnError: true })] : []),
        ...(selected ? [cache.fetchQuery({ queryKey: ['pcb-native-interpretation', selected], queryFn: () => read<NativeAccepted>(`pcb-disagreement/native/${selected}`), staleTime: 0 })] : []),
      ]);
      setBlocked(false);
    } catch (error) {
      setRefreshError(error instanceof Error ? error.message : 'Extraction refresh failed.');
      await clearEvidence();
    } finally { setRefreshing(false); }
  }
  const request = useMutation({ mutationFn: () => command('pcb_disagreement.request_native', { workspace_id: workspaceId, source, source_role: role, recipe_id: available.data?.available_recipe_id }), onMutate: () => source.source_revision_id, onError: (_error, _variables, failedSourceId) => clearEvidence(failedSourceId), onSuccess: () => cache.invalidateQueries({ queryKey: ['pcb-native-attempts', workspaceId] }) });
  const accept = useMutation({ mutationFn: (attempt_id: string) => command<NativeAccepted>('pcb_disagreement.accept_native', { attempt_id }), onMutate: attemptId => attempts.data?.attempts.find(a => a.attempt_id === attemptId)?.source.source_revision_id, onError: (_error, _attemptId, failedSourceId) => clearEvidence(failedSourceId), onSuccess: result => { setSelected(result.interpretation_id); void cache.invalidateQueries({ queryKey: ['pcb-native-attempts', workspaceId] }); } });
  if (!active) return null;
  return <Card withBorder><Stack><Title order={3}>Independent native source extraction</Title><Text>Extract reported schematic nets or parse preserved KiCad XML using an installed approved extractor. Acceptance retains evidence; it does not choose a correct source or establish schematic parity.</Text>
    <SourcePicker value={source} onChange={setSource} onDenied={setDenied} />
    <Select label="Native source role" value={role} data={[{ value: 'schematic', label: 'Standalone KiCad schematic' }, { value: 'netlist', label: 'Preserved KiCad XML netlist' }]} onChange={v => setRole(v as typeof role)} />
    {available.isError && <Alert color="red">{available.error.message}</Alert>}{available.data && !available.isError && !denied && !available.data.available_recipe_id && <Text>No approved extractor is installed for this exact source selection.</Text>}
    <Button disabled={blocked || refreshing || denied || attempts.isError || available.isError || !available.data?.available_recipe_id} loading={request.isPending} onClick={() => request.mutate()} {...executeGate.props}>Request native source extraction</Button><ReadOnlyNote permission="build.execute">Requesting native extraction is unavailable.</ReadOnlyNote>
    {request.isError && <Alert color="red">{request.error.message}</Alert>}{accept.isError && <Alert color="red">{accept.error.message}</Alert>}{attempts.isError && <Alert color="red">{attempts.error.message}</Alert>}
    {blocked && <Text>Cached native evidence was cleared. Refresh extraction status to recheck access before continuing.</Text>}{refreshError && <Alert color="red">{refreshError}</Alert>}
    <Button variant="subtle" loading={refreshing} disabled={request.isPending || accept.isPending} onClick={() => void refreshStatus()}>Refresh extraction status</Button>
    {!blocked && !refreshing && !attempts.isError && !attempts.isFetching && !denied && !available.isError && (attempts.data?.attempts ?? []).map(attempt => <Card key={attempt.attempt_id} withBorder><Stack gap="xs"><Text>{attempt.source.path} · {attempt.source_role} · {label(attempt.state)}</Text>{attempt.diagnostic && <Text size="sm" c="red">{attempt.diagnostic}</Text>}<Text size="sm">Exact source SHA-256: {attempt.source.sha256}</Text><Group>{attempt.interpretation ? <Button onClick={() => setSelected(attempt.interpretation!.interpretation_id)}>Inspect accepted extraction {attempt.interpretation.interpretation_id}</Button> : <Button disabled={attempt.state !== 'succeeded' || request.isPending} loading={accept.isPending} {...acceptGate.props} onClick={() => accept.mutate(attempt.attempt_id)}>Accept extraction {attempt.attempt_id}</Button>}</Group></Stack></Card>)}
    {selected && !blocked && !refreshing && !attempts.isError && !attempts.isFetching && !denied && !available.isError && <NativeInspector interpretationId={selected} />}
  </Stack></Card>;
}

export function NativeInspector({ interpretationId }: { interpretationId: string }) {
  const query = useQuery({ queryKey: ['pcb-native-interpretation', interpretationId], queryFn: () => read<NativeAccepted>(`pcb-disagreement/native/${interpretationId}`) });
  const result = query.isError ? undefined : query.data;
  return <Stack><Title order={4}>Accepted independent extraction</Title><Button variant="subtle" onClick={() => void query.refetch()}>Refresh accepted extraction</Button>{query.isError && <Alert color="red">{query.error.message}</Alert>}{result && <><Text>{label(result.report.method)} · {result.report.source_role}</Text><Text>{label(result.report.coverage)}. Unknown memberships remain unknown.</Text><Text size="sm">Source: {result.source.path} · {result.source.sha256} · Rights: {result.source.rights}</Text><Text size="sm">Report SHA-256: {result.report_sha256} · XML SHA-256: {result.report.xml_sha256}</Text><Text size="sm">Extractor {result.report.adapter} · Tool {result.report.tool_version} · Source-reported tool: {result.report.reported_source_tool ?? 'unknown'}</Text><Text>Terminal IDs are derived from exact source and native occurrence fields. Native terminal UUIDs are unknown. No PCB pad correspondence is inferred.</Text><AssertionTable terminals={result.report.terminals} />{result.report.unsupported.map(text => <Text size="sm" key={text}>{text}</Text>)}</>}</Stack>;
}
