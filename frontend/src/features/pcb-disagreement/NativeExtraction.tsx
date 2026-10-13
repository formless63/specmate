import { Alert, Button, Card, Group, Select, Stack, Text, Title } from '@mantine/core';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { AssertionTable, SourcePicker } from './Editors';
import { blankSource, command, isUuid, label, read, type NativeAccepted, type NativeAttempts } from './api';

export function NativeExtraction({ projectId }: { projectId: string }) {
  const cache = useQueryClient();
  const [source, setSource] = useState(blankSource());
  const [role, setRole] = useState<'schematic' | 'netlist'>('schematic');
  const [denied, setDenied] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const available = useQuery({ queryKey: ['pcb-native-options', source.source_revision_id, source.path, role], queryFn: () => read<{ available_recipe_id: string | null }>(`pcb-disagreement/native-options?${new URLSearchParams({ source_revision_id: source.source_revision_id, path: source.path, role })}`), enabled: isUuid(source.source_revision_id) && !!source.path && !denied });
  const attempts = useQuery({ queryKey: ['pcb-native-attempts', projectId], queryFn: () => read<NativeAttempts>(`pcb-disagreement/native?project_id=${projectId}`) });
  const request = useMutation({ mutationFn: () => command('pcb_disagreement.request_native', { project_id: projectId, source, source_role: role, recipe_id: available.data?.available_recipe_id }), onSuccess: () => cache.invalidateQueries({ queryKey: ['pcb-native-attempts', projectId] }) });
  const accept = useMutation({ mutationFn: (attempt_id: string) => command<NativeAccepted>('pcb_disagreement.accept_native', { attempt_id }), onSuccess: result => { setSelected(result.interpretation_id); void cache.invalidateQueries({ queryKey: ['pcb-native-attempts', projectId] }); } });
  return <Card withBorder><Stack><Title order={3}>Independent native source extraction</Title><Text>Extract reported schematic nets or parse preserved KiCad XML using an installed approved extractor. Acceptance retains evidence; it does not choose a correct source or establish schematic parity.</Text>
    <SourcePicker value={source} onChange={setSource} onDenied={setDenied} />
    <Select label="Native source role" value={role} data={[{ value: 'schematic', label: 'Standalone KiCad schematic' }, { value: 'netlist', label: 'Preserved KiCad XML netlist' }]} onChange={v => setRole(v as typeof role)} />
    {available.isError && <Alert color="red">{available.error.message}</Alert>}{available.data && !available.isError && !denied && !available.data.available_recipe_id && <Text>No approved extractor is installed for this exact source selection.</Text>}
    <Button disabled={denied || attempts.isError || available.isError || !available.data?.available_recipe_id} loading={request.isPending} onClick={() => request.mutate()}>Request native source extraction</Button>
    {request.isError && <Alert color="red">{request.error.message}</Alert>}{accept.isError && <Alert color="red">{accept.error.message}</Alert>}{attempts.isError && <Alert color="red">{attempts.error.message}</Alert>}
    <Button variant="subtle" onClick={() => { void attempts.refetch(); void available.refetch(); }}>Refresh extraction status</Button>
    {!attempts.isError && !denied && !available.isError && (attempts.data?.attempts ?? []).map(attempt => <Card key={attempt.attempt_id} withBorder><Stack gap="xs"><Text>{attempt.source.path} · {attempt.source_role} · {label(attempt.state)}</Text><Text size="sm">Exact source SHA-256: {attempt.source.sha256}</Text><Group>{attempt.interpretation ? <Button onClick={() => setSelected(attempt.interpretation!.interpretation_id)}>Inspect accepted extraction {attempt.interpretation.interpretation_id}</Button> : <Button disabled={attempt.state !== 'succeeded'} loading={accept.isPending} onClick={() => accept.mutate(attempt.attempt_id)}>Accept extraction {attempt.attempt_id}</Button>}</Group></Stack></Card>)}
    {selected && !attempts.isError && !denied && !available.isError && <NativeInspector interpretationId={selected} />}
  </Stack></Card>;
}

export function NativeInspector({ interpretationId }: { interpretationId: string }) {
  const query = useQuery({ queryKey: ['pcb-native-interpretation', interpretationId], queryFn: () => read<NativeAccepted>(`pcb-disagreement/native/${interpretationId}`) });
  const result = query.isError ? undefined : query.data;
  return <Stack><Title order={4}>Accepted independent extraction</Title><Button variant="subtle" onClick={() => void query.refetch()}>Refresh accepted extraction</Button>{query.isError && <Alert color="red">{query.error.message}</Alert>}{result && <><Text>{label(result.report.method)} · {result.report.source_role}</Text><Text>{label(result.report.coverage)}. Unknown memberships remain unknown.</Text><Text size="sm">Source: {result.source.path} · {result.source.sha256} · Rights: {result.source.rights}</Text><Text size="sm">Report SHA-256: {result.report_sha256} · XML SHA-256: {result.report.xml_sha256}</Text><Text size="sm">Extractor {result.report.adapter} · Tool {result.report.tool_version} · Source-reported tool: {result.report.reported_source_tool ?? 'unknown'}</Text><Text>Terminal IDs are derived from exact source and native occurrence fields. Native terminal UUIDs are unknown. No PCB pad correspondence is inferred.</Text><AssertionTable terminals={result.report.terminals} />{result.report.unsupported.map(text => <Text size="sm" key={text}>{text}</Text>)}</>}</Stack>;
}
