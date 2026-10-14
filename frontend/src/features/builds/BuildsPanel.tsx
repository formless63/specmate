import { Alert, Badge, Button, Card, Group, Stack, Table, Text, TextInput, Title } from '@mantine/core';
import { useCallback, useEffect, useRef, useState } from 'react';
import { randomUUID } from '../../lib/random-id';
import { ReadOnlyNote, usePermission } from '../../lib/permissions';
import { abandonBuild, cancelBuild, listBuilds, readHistory, retryBuild, type BuildHistory, type BuildList } from './api';

const EXPLAIN: Record<string, string> = {
  waiting_dispatch: 'Recorded; not yet offered to a runner.',
  queued: 'Waiting for a runner to lease it.',
  leased: 'Leased to a runner; no process activity has been observed yet.',
  running: 'A runner reports the process is running.',
  cancellation_requested: 'Cancellation requested. This is not cancelled until the runner confirms the process stopped.',
  interrupted: 'The lease was lost. The tool is not rerun automatically; the original runner can reconcile the same execution.',
  succeeded: 'Verified outputs were accepted. This is not engineering or physical qualification.',
  failed: 'Ended without success. Failure details and any verified partial outputs are retained.',
  cancelled: 'A runner confirmed the process stopped after a cancellation request.',
};
const pretty = (value: string) => value.replaceAll('_', ' ');
// Attempts are numbered from the first request of a retry chain.
const attemptLabel = (lineage: { build_id: string }[], id: string | null) => {
  const index = id ? lineage.findIndex(a => a.build_id === id) : -1;
  return index >= 0 ? `#${index + 1}` : null;
};
const badge = (state: string) => state === 'succeeded' ? 'frozen' : state === 'failed' || state === 'cancelled' ? 'occurrence' : 'draft';

export function BuildsPanel({ workspaceId }: { workspaceId: string }) {
  const execute = usePermission('build.execute');
  const [list, setList] = useState<BuildList>();
  const [detail, setDetail] = useState<BuildHistory>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [basis, setBasis] = useState('');
  const selected = useRef<string | null>(null);
  const generation = useRef(0);
  const alive = useRef(true);
  const keys = useRef(new Map<string, string>());

  const load = useCallback(async (buildId: string | null = selected.current) => {
    const token = ++generation.current;
    setBusy(true); setError(''); setList(undefined); setDetail(undefined);
    try {
      const [builds, history] = await Promise.all([listBuilds(workspaceId), buildId ? readHistory(buildId) : Promise.resolve(undefined)]);
      if (!alive.current || token !== generation.current) return;
      selected.current = buildId; setList(builds); setDetail(history);
    } catch (reason) {
      // A denied or failed read drops everything retained so removed access leaves nothing visible.
      if (!alive.current || token !== generation.current) return;
      selected.current = null; setError(reason instanceof Error ? reason.message : 'Build evidence unavailable.');
    } finally { if (alive.current && token === generation.current) setBusy(false); }
  }, [workspaceId]);

  useEffect(() => {
    alive.current = true; selected.current = null; keys.current.clear(); void load(null);
    const focus = () => void load();
    window.addEventListener('focus', focus);
    return () => { alive.current = false; generation.current += 1; window.removeEventListener('focus', focus); };
  }, [load]);

  // A retried request after a lost response reuses its key; a changed build state needs a new one.
  const keyFor = (action: string, id: string, state: string) => {
    const name = `${action}:${id}:${state}`;
    if (!keys.current.has(name)) keys.current.set(name, randomUUID());
    return keys.current.get(name) as string;
  };
  // The original requester may cancel their own build; anyone else needs the build.execute grant.
  // The server decides; this only avoids offering a control it would refuse.
  const canCancel = execute.allowed || Boolean(detail?.requested_by_viewer);
  async function act(action: 'cancel' | 'retry' | 'abandon') {
    if (!detail) return;
    const { build_id: id, state_token: token } = detail;
    const key = keyFor(action, id, token);
    setBusy(true); setError('');
    try {
      let next: string | null = id;
      if (action === 'cancel') await cancelBuild(id, token, key);
      else if (action === 'retry') next = (await retryBuild(id, token, key)).build_id;
      else await abandonBuild(id, basis.trim(), token, key);
      keys.current.delete(`${action}:${id}:${token}`); setBasis('');
      await load(next);
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : 'Build action failed.';
      // The state may have moved; reread rather than act on a stale token, keeping the reason visible.
      await load(id);
      if (alive.current) setError(current => current || message);
    }
  }

  return <Card withBorder><Stack>
    <Title order={3}>Builds, cancellation and recovery</Title>
    <Text size="sm">Cancellation is a request until the runner confirms the process stopped. Interrupted work is never rerun automatically and is never relabelled cancelled or successful. A retry is a new attempt over the same exact source revision and approved recipe.</Text>
    <ReadOnlyNote permission="build.execute">Builds can be inspected but not changed</ReadOnlyNote>
    <Group><Button variant="quiet" loading={busy} onClick={() => void load()}>Refresh builds</Button></Group>
    {error && <Alert color="red">{error}</Alert>}
    {list && list.builds.length === 0 && <Text>No builds have been requested in this project.</Text>}
    {list && list.builds.length > 0 && <Table><Table.Thead><Table.Tr><Table.Th>Build</Table.Th><Table.Th>State</Table.Th><Table.Th>Recipe</Table.Th><Table.Th /></Table.Tr></Table.Thead><Table.Tbody>
      {list.builds.map(b => <Table.Tr key={b.build_id}>
        <Table.Td><Text size="xs">{b.build_id}</Text>{b.retry_of && <Text size="xs">Retry of {b.retry_of}</Text>}</Table.Td>
        <Table.Td><Badge variant={badge(b.state)}>{pretty(b.state)}</Badge></Table.Td>
        <Table.Td><Text size="xs">{b.recipe_id}</Text></Table.Td>
        <Table.Td><Button variant="quiet" disabled={busy} onClick={() => void load(b.build_id)}>Inspect build {b.build_id}</Button></Table.Td>
      </Table.Tr>)}</Table.Tbody></Table>}
    {list?.truncated && <Text size="xs">Showing the latest 100 builds; earlier history is retained.</Text>}
    {detail && <Stack aria-label="Build history">
      <Title order={4}>Build {detail.build_id}</Title>
      <Group><Badge variant={badge(detail.state)}>{pretty(detail.state)}</Badge><Text size="sm">{EXPLAIN[detail.state] ?? ''}</Text></Group>
      <Text size="xs">Recipe {detail.recipe_id} · Source revision {detail.source_revision_id} · Requested {detail.requested_at}</Text>
      <Lineage lineage={detail.lineage} retryOf={detail.retry_of} />
      {detail.receipt && <Stack gap={2}><Text size="sm">Receipt: {detail.receipt.outcome}{detail.receipt.exit_code !== null ? ` · exit code ${detail.receipt.exit_code}` : ' · no exit code observed'} · {detail.receipt.message}</Text>
        {detail.receipt.resolution && <Text size="sm">Resolved without runner confirmation ({pretty(detail.receipt.resolution)}); process termination is unconfirmed. Basis: {detail.receipt.basis}</Text>}</Stack>}
      {detail.outputs.length > 0 && <Table><Table.Thead><Table.Tr><Table.Th>Verified output</Table.Th><Table.Th>SHA-256</Table.Th><Table.Th>Status</Table.Th></Table.Tr></Table.Thead><Table.Tbody>
        {detail.outputs.map(o => <Table.Tr key={o.path}><Table.Td>{o.path}<Text size="xs">{o.size} bytes</Text></Table.Td><Table.Td><Text size="xs">{o.sha256}</Text></Table.Td><Table.Td>{o.accepted ? 'Accepted' : 'Retained evidence only; not an accepted artifact'}</Table.Td></Table.Tr>)}</Table.Tbody></Table>}
      <Text size="sm">History</Text>
      <ol aria-label="Build events">{detail.events.map((e, i) => <li key={i}><Text size="xs">{e.at} · {pretty(e.kind)}{typeof e.detail.reason === 'string' ? ` · ${pretty(e.detail.reason)}` : ''}</Text></li>)}</ol>
      <Group>
        {detail.cancel_available && <Button variant="risk" {...(canCancel ? {} : execute.props)} disabled={!canCancel || busy} onClick={() => void act('cancel')}>Request cancellation</Button>}
        {detail.retry_available && <Button variant="primary" {...execute.props} disabled={!execute.allowed || busy} onClick={() => void act('retry')}>Retry as a new attempt</Button>}
        {detail.retried_by && <Button variant="quiet" disabled={busy} onClick={() => void load(detail.retried_by)}>Open retry {detail.retried_by}</Button>}
      </Group>
      {detail.awaiting_runner_confirmation && !detail.abandon_available && <Text size="sm">Waiting for the runner to confirm termination or reconcile.</Text>}
      {detail.abandon_available && <Stack gap="xs">
        <Text size="sm">The leasing runner credential is no longer valid, so nothing can confirm this process stopped. Resolving it records a failure with termination unconfirmed.</Text>
        <TextInput label="Basis for resolving without runner confirmation" value={basis} onChange={e => setBasis(e.currentTarget.value)} maxLength={500} />
        <Group><Button variant="risk" {...execute.props} disabled={!execute.allowed || busy || !basis.trim()} onClick={() => void act('abandon')}>Resolve as failed, termination unconfirmed</Button></Group>
      </Stack>}
    </Stack>}
  </Stack></Card>;
}

export function Lineage({ lineage, retryOf }: { lineage: BuildHistory['lineage']; retryOf: string | null }) {
  if (lineage.length < 2 && !retryOf) return null;
  const parent = attemptLabel(lineage, retryOf);
  return <Stack gap={2} aria-label="Retry chain">
    {retryOf && <Text size="sm">Retry of {parent ?? 'earlier attempt'} ({retryOf})</Text>}
    <ol aria-label="Build attempts" style={{ margin: 0 }}>{lineage.map(a => <li key={a.build_id}><Text size="xs">Attempt #{lineage.indexOf(a) + 1} · {a.build_id}{a.current ? ' (this)' : ''} · {pretty(a.state)}</Text></li>)}</ol>
  </Stack>;
}
