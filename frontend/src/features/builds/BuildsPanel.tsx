import { Alert, Button, Card, Group, Stack, Table, Text, TextInput, Title } from '@mantine/core';
import { useCallback, useEffect, useRef, useState } from 'react';
import { JOB_LED, SbJobCard, SbProvenance, SbStatus, type JobState } from '../../components/sb';
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
// Only the runner-confirmed states map to terminal looks; interrupted and requested-cancellation stay in review.
const JOB_STATE: Record<string, JobState> = { waiting_dispatch: 'queued', queued: 'queued', leased: 'running', running: 'running', succeeded: 'succeeded', failed: 'failed', cancelled: 'cancelled', interrupted: 'review', cancellation_requested: 'review' };
const jobState = (state: string): JobState => JOB_STATE[state] ?? 'review';

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
        <Table.Td><SbStatus dimension='build' value={pretty(b.state)} {...JOB_LED[jobState(b.state)]} /></Table.Td>
        <Table.Td><Text size="xs">{b.recipe_id}</Text></Table.Td>
        <Table.Td><Button variant="quiet" disabled={busy} onClick={() => void load(b.build_id)}>Inspect build {b.build_id}</Button></Table.Td>
      </Table.Tr>)}</Table.Tbody></Table>}
    {list?.truncated && <Text size="xs">Showing the latest 100 builds; earlier history is retained.</Text>}
    {detail && <Stack aria-label="Build history">
      <Title order={4}>Build {detail.build_id}</Title>
      <SbJobCard title={detail.recipe_id} state={jobState(detail.state)} stateWords={pretty(detail.state)} dimension='build' detail={EXPLAIN[detail.state] ?? ''} />
      <SbProvenance label='Request' summary={`Recipe ${detail.recipe_id} · requested ${detail.requested_at}`} pins={[{ label: 'Source revision', value: detail.source_revision_id }]} />
      {detail.lineage.length > 1 && <Text size="sm">Attempts: {detail.lineage.map(a => `${a.build_id}${a.current ? ' (this)' : ''} ${pretty(a.state)}`).join(' → ')}</Text>}
      {detail.receipt && <Stack gap={2}><Text size="sm">Receipt: {detail.receipt.outcome}{detail.receipt.exit_code !== null ? ` · exit code ${detail.receipt.exit_code}` : ' · no exit code observed'} · {detail.receipt.message}</Text>
        {detail.receipt.resolution && <Text size="sm">Resolved without runner confirmation ({pretty(detail.receipt.resolution)}); process termination is unconfirmed. Basis: {detail.receipt.basis}</Text>}</Stack>}
      {detail.outputs.length > 0 && <Table><Table.Thead><Table.Tr><Table.Th>Verified output</Table.Th><Table.Th>SHA-256</Table.Th><Table.Th>Status</Table.Th></Table.Tr></Table.Thead><Table.Tbody>
        {detail.outputs.map(o => <Table.Tr key={o.path}><Table.Td>{o.path}<Text size="xs">{o.size} bytes</Text></Table.Td><Table.Td><Text size="xs">{o.sha256}</Text></Table.Td><Table.Td>{o.accepted ? 'Accepted' : 'Retained evidence only; not an accepted artifact'}</Table.Td></Table.Tr>)}</Table.Tbody></Table>}
      <Text size="sm">History</Text>
      <ol aria-label="Build events">{detail.events.map((e, i) => <li key={i}><Text size="xs">{e.at} · {pretty(e.kind)}{typeof e.detail.reason === 'string' ? ` · ${pretty(e.detail.reason)}` : ''}</Text></li>)}</ol>
      <Group>
        {detail.cancel_available && <Button variant="risk" {...execute.props} disabled={!execute.allowed || busy} onClick={() => void act('cancel')}>Request cancellation</Button>}
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
