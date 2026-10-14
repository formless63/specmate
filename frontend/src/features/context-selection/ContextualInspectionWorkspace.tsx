import { Alert, Button, Group, Select, Stack, Text, TextInput, Title } from '@mantine/core';
import { useEffect, useRef, useState } from 'react';
import { request } from '../sources/api';
import type { SceneChoices } from '../shared-scene/api';
import { ContextSelectionProvider, useContextSelection } from './ContextSelectionProvider';
import { ConnectedViews } from './views';

/** A bounded group of connected views. Ordinary reusable-revision tools remain independent. */
export function ContextualInspectionWorkspace({ projectId, principalKey }: {
  projectId?: string | null; principalKey: string;
}) {
  return <Workspace key={JSON.stringify([projectId ?? 'library', principalKey])} projectId={projectId} principalKey={principalKey} />;
}
function Workspace({ projectId = null, principalKey }: { projectId?: string | null; principalKey: string }) {
  const [choices, setChoices] = useState<SceneChoices['assemblies']>([]);
  const [root, setRoot] = useState<string | null>(null), [exact, setExact] = useState('');
  const [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const generation = useRef(0), mounted = useRef(false);
  async function refreshChoices() {
    const ticket = ++generation.current; setChoices([]); setBusy(true); setError('');
    try {
      const result = await request<SceneChoices>('shared-scenes/workspace', { cache: 'no-store' });
      if (mounted.current && ticket === generation.current) setChoices(result.assemblies);
    } catch (reason) {
      if (mounted.current && ticket === generation.current) { setChoices([]); setRoot(null); setError(reason instanceof Error ? reason.message : 'Scene choices unavailable.'); }
    } finally { if (mounted.current && ticket === generation.current) setBusy(false); }
  }
  useEffect(() => { mounted.current = true; void refreshChoices(); return () => { mounted.current = false; generation.current += 1; }; }, [projectId]);
  const unavailable = () => { generation.current += 1; setChoices([]); setBusy(false); };
  return <Stack>
    <Title order={2}>Contextual inspection</Title>
    <Text>Select one exact frozen root. Tree, board, cable, scene, inspector, schematic context and BOM context retain the same occurrence and optional stable feature. Repeated labels and shared geometry preserve separate uses.</Text>
    <Button loading={busy} onClick={() => void refreshChoices()}>Refresh contextual scene choices</Button>
    {error && <Alert color="red" role="alert">{error}</Alert>}
    <Select label="Contextual frozen root" searchable clearable value={root} data={choices.map(c => ({ value: c.snapshot_id, label: `${c.name} · revision ${c.number}` }))} onChange={setRoot} />
    <Group align="end"><TextInput label="Exact contextual root snapshot ID" value={exact} onChange={e => setExact(e.currentTarget.value)} /><Button disabled={!exact.trim()} onClick={() => setRoot(exact.trim())}>Open contextual root</Button></Group>
    {root && <ContextSelectionProvider scope={{ project_id: projectId ?? 'library', principal_key: principalKey, snapshot_id: root }} onUnavailable={unavailable} authorityPending={busy}><RootViews /></ContextSelectionProvider>}
  </Stack>;
}
function RootViews() {
  const { state, refresh } = useContextSelection();
  return <Stack><Button onClick={() => void refresh()}>Refresh all connected view access</Button>
    {state.status === 'unavailable' && <Alert color="red" role="alert">{state.error}</Alert>}
    {state.status === 'checking' && <Text>Checking current root, source and model access…</Text>}
    {state.status === 'ready' && <ConnectedViews />}
  </Stack>;
}
