import { Alert, Button, Drawer, Group, Stack, Table, Text, TextInput, Title } from '@mantine/core';
import { useCallback, useEffect, useRef, useState } from 'react';
import { JOB_LED, SbJobCard, SbProvenance, SbStatus, type JobState, type SbLed } from '../../components/sb';
import { randomUUID } from '../../lib/random-id';
import { ReadOnlyNote, usePermission } from '../../lib/permissions';
import { SourceError } from "../sources/api";
import { ReusableResultOffer } from './ReusableResultOffer';
import { abandonBuild, cancelBuild, listBuilds, readHistory, reproduceBuild, retryBuild, type BuildHistory, type BuildList, type PinnedTool, type ReproducibilityLevel } from './api';

const EXPLAIN: Record<string, string> = {
  waiting_dispatch: 'Recorded; not yet offered to a runner.',
  queued: 'Waiting for a runner to lease it.',
  leased: 'Leased to a runner; no process activity has been observed yet.',
  running: 'A runner reports the process is running.',
  cancellation_requested: 'Cancellation requested. This is not cancelled until the runner confirms the process stopped.',
  interrupted: 'The lease was lost. This is not final: the tool is not rerun automatically, and the original runner can still reconcile the same execution and report its real outcome, including success.',
  succeeded: 'Verified outputs were accepted. This is not engineering or physical qualification.',
  failed: 'Ended without success. Failure details and any verified partial outputs are retained.',
  cancelled: 'A runner confirmed the process stopped after a cancellation request.',
};
export const pretty = (value: string) => value.replaceAll('_', ' ');
// Weakest first. Only independent repeated outputs move a build past provenance.
const LEVEL: Record<ReproducibilityLevel, { words: string; led: SbLed; explain: string }> = {
  provenance: { words: 'provenance only', led: 'not-evaluated', explain: 'Exact inputs, tool pin and outputs are recorded. No repeated execution has been compared, so nothing about reproducibility is established.' },
  rerun_recorded: { words: 'rerun recorded', led: 'review', explain: 'Another accepted attempt over the identical inputs exists, but its outputs differ and no declared comparator found them equal.' },
  semantic_equality: { words: 'semantic equality', led: 'info', explain: 'Repeated outputs differ in bytes but are equal under a declared comparator.' },
  byte_reproducible: { words: 'byte-identical', led: 'active', explain: 'Independent repeated attempts over the identical inputs produced byte-identical outputs.' },
};
export function ReproLevel({ level }: { level: ReproducibilityLevel | null | undefined }) {
  // Missing evidence is shown as not recorded, never as a level.
  if (!level) return <SbStatus dimension='reproducibility' value='not recorded' led='off' />;
  return <SbStatus dimension='reproducibility' value={LEVEL[level].words} led={LEVEL[level].led} />;
}
const bytes = (value: number) => value >= 1024 ** 2 ? `${(value / 1024 ** 2).toFixed(0)} MiB` : `${value} bytes`;
function ToolPin({ pinned }: { pinned: PinnedTool | undefined }) {
  if (!pinned) return <Text size="xs">The tool pin was not reported for this build.</Text>;
  const l = pinned.limits;
  return <SbProvenance label='Tool pin' summary={`${pinned.image_digest.slice(0, 19)}… · ${l.cpus} CPU · ${bytes(l.memory_bytes)} · ${l.timeout_seconds}s · network ${pinned.network} · ${pinned.resolved_image_id ? `resolved image ${pinned.resolved_image_id.slice(0, 19)}…` : 'resolved image not reported'}`}
    pins={[{ label: 'Image', value: pinned.image }, { label: 'Image digest', value: pinned.image_digest },
      { label: 'Resolved image ID', value: pinned.resolved_image_id ?? 'not reported by the runner' },
      { label: 'Arguments', value: JSON.stringify(pinned.argv) },
      { label: 'Limits', value: `cpus ${l.cpus}, memory ${l.memory_bytes} bytes, timeout ${l.timeout_seconds} s, pids ${l.pids}, output ${l.max_output_bytes} bytes` }]} />;
}
// Only the runner-confirmed states map to terminal looks; interrupted and requested-cancellation stay in review.
const JOB_STATE: Record<string, JobState> = { waiting_dispatch: 'queued', queued: 'queued', leased: 'running', running: 'running', succeeded: 'succeeded', failed: 'failed', cancelled: 'cancelled', interrupted: 'review', cancellation_requested: 'review' };
export const jobState = (state: string): JobState => JOB_STATE[state] ?? 'review';
// Attempts are numbered from the first request of a retry chain.
const attemptLabel = (lineage: { build_id: string }[], id: string | null) => {
  const index = id ? lineage.findIndex(a => a.build_id === id) : -1;
  return index >= 0 ? `#${index + 1}` : null;
};

export function BuildsPanel({ workspaceId, principalKey, active = true, onAccessLost }: { workspaceId: string; principalKey?: string; active?: boolean; onAccessLost?: () => void }) {
  const execute = usePermission('build.execute');
  const [list, setList] = useState<BuildList>();
  const [detail, setDetail] = useState<BuildHistory>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [basis, setBasis] = useState('');
  const selected = useRef<string | null>(null);
  const generation = useRef(0);
  const alive = useRef(true);
  const activeRef = useRef(active); activeRef.current = active;
  const previouslyActive = useRef(active);
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
      if (reason instanceof SourceError && [401, 403, 404].includes(reason.status)) onAccessLost?.();
    } finally { if (alive.current && token === generation.current) setBusy(false); }
  }, [workspaceId, onAccessLost]);

  useEffect(() => {
    alive.current = true; selected.current = null; keys.current.clear(); void load(null);
    const focus = () => { if (activeRef.current) void load(); };
    window.addEventListener('focus', focus);
    return () => { alive.current = false; generation.current += 1; window.removeEventListener('focus', focus); };
  }, [load, principalKey]);
  useEffect(() => {
    if (active && !previouslyActive.current) void load();
    previouslyActive.current = active;
  }, [active, load]);

  // A retried request after a lost response reuses its key; a changed build state needs a new one.
  const keyFor = (action: string, id: string, state: string) => {
    const name = `${action}:${id}:${state}`;
    if (!keys.current.has(name)) keys.current.set(name, randomUUID());
    return keys.current.get(name) as string;
  };
  // The original requester may cancel their own build; anyone else needs the build.execute grant.
  // The server decides; this only avoids offering a control it would refuse.
  const canCancel = execute.allowed || Boolean(detail?.requested_by_viewer);
  async function act(action: 'cancel' | 'retry' | 'abandon' | 'reproduce') {
    if (!detail) return;
    const { build_id: id, state_token: token } = detail;
    const key = keyFor(action, id, token);
    setBusy(true); setError('');
    try {
      let next: string | null = id;
      if (action === 'cancel') await cancelBuild(id, token, key);
      else if (action === 'retry') next = (await retryBuild(id, token, key)).build_id;
      else if (action === 'reproduce') next = (await reproduceBuild(id, token, key)).build_id;
      else await abandonBuild(id, basis.trim(), token, key);
      keys.current.delete(`${action}:${id}:${token}`); setBasis('');
      await load(next);
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : 'Build action failed.';
      if (reason instanceof SourceError && [401, 403, 404].includes(reason.status)) onAccessLost?.();
      // The state may have moved; reread rather than act on a stale token, keeping the reason visible.
      await load(id);
      if (alive.current) setError(current => current || message);
    }
  }

  return <Stack className="jobs-builds">
    <Group justify="space-between"><Title order={2}>Builds</Title><Button variant="quiet" loading={busy} onClick={() => void load()}>Refresh builds</Button></Group>
    <Text size="sm" c="dimmed">Requests, attempts and retained receipts. Closing this page does not stop work.</Text>
    <ReadOnlyNote permission="build.execute">Builds can be inspected but not changed</ReadOnlyNote>
    {busy && !list && <Text role="status">Reading builds…</Text>}
    {error && <Alert color="red">{error}</Alert>}
    {list && list.builds.length === 0 && <Text>No builds have been requested in this workspace.</Text>}
    {list && list.builds.length > 0 && <Table.ScrollContainer minWidth={760}><Table highlightOnHover aria-label="Builds">
      <Table.Thead><Table.Tr>{['When', 'Kind', 'Job', 'By', 'State'].map(label => <Table.Th key={label}>{label}</Table.Th>)}</Table.Tr></Table.Thead>
      <Table.Tbody>{list.builds.map(build => <Table.Tr key={build.build_id} tabIndex={0} aria-selected={selected.current === build.build_id}
        onClick={() => { if (!busy) void load(build.build_id); }} onKeyDown={event => { if (event.target === event.currentTarget && event.key === 'Enter' && !busy) { event.preventDefault(); void load(build.build_id); } }}>
        <Table.Td><time dateTime={build.requested_at}>{new Date(build.requested_at).toLocaleString()}</time></Table.Td>
        <Table.Td>Build</Table.Td>
        <Table.Td><Button size="compact-xs" variant="quiet" disabled={busy} aria-label={`Inspect build ${build.build_id}`} onClick={event => { event.stopPropagation(); void load(build.build_id); }}>{build.recipe_id}</Button><Text size="xs" c="dimmed" title={build.build_id}>{build.build_id.slice(0, 12)}</Text>{build.retry_of && <Text size="xs">Retry of {build.retry_of}</Text>}</Table.Td>
        <Table.Td>{build.requested_by ?? (build.requested_by_viewer ? 'You' : 'Not reported')}</Table.Td>
        <Table.Td><SbStatus dimension="build" value={pretty(build.state)} {...JOB_LED[jobState(build.state)]} /></Table.Td>
      </Table.Tr>)}</Table.Tbody>
    </Table></Table.ScrollContainer>}
    {list?.truncated && <Text size="xs">Showing the latest 100 builds; earlier history is retained.</Text>}
    <Drawer keepMounted transitionProps={{ duration: active ? 150 : 0 }} opened={!!detail && active} onClose={() => { selected.current = null; setDetail(undefined); }} title="Build details" position="right" size="min(680px, 100vw)" closeButtonProps={{ "aria-label": "Close build details" }} styles={{ body: { overflowWrap: "anywhere" }, inner: { display: active ? undefined : "none" }, overlay: { display: active ? undefined : "none" } }}>
    {detail && <Stack aria-label="Build history">
      <Title order={4}>Build {detail.build_id}</Title>
      <SbJobCard title={detail.recipe_id} state={jobState(detail.state)} stateWords={pretty(detail.state)} dimension='build' detail={EXPLAIN[detail.state] ?? ''} />
      <SbProvenance label='Request' summary={`Recipe ${detail.recipe_id} · requested ${detail.requested_at}`} pins={[{ label: 'Source revision', value: detail.source_revision_id }]} />
      <ToolPin pinned={detail.pinned} />
      {detail.reproduction_of && <Text size="sm">Reproducibility check of {detail.reproduction_of}</Text>}
      <Lineage lineage={detail.lineage} retryOf={detail.retry_of} />
      {detail.configuration
        ? <SbProvenance label='Configuration' summary={`Resolved configuration · ${detail.configuration.choices.length} choices · ${detail.configuration.pins.length} pinned revisions`}
          pins={[{ label: 'Resolved configuration', value: detail.configuration.resolved_configuration_id }, { label: 'Option set revision', value: detail.configuration.option_set_revision_id }, { label: 'Configuration snapshot SHA-256', value: detail.configuration.snapshot_sha256 }, { label: 'Resolution SHA-256', value: detail.configuration.resolution_sha256 }]} />
        : <Text size="xs">No configuration pinned: this build consumed only its source revision.</Text>}
      {detail.receipt && <Stack gap={2}><Text size="sm">Receipt: {detail.receipt.outcome}{detail.receipt.exit_code !== null ? ` · exit code ${detail.receipt.exit_code}` : ' · no exit code observed'} · {detail.receipt.message}</Text>
        {detail.receipt.resolution && <Text size="sm">Resolved without runner confirmation ({pretty(detail.receipt.resolution)}); process termination is unconfirmed. Basis: {detail.receipt.basis}{detail.receipt.resolved_by ? ` · resolved by ${detail.receipt.resolved_by}` : ''}</Text>}</Stack>}
      {detail.staged_inputs
        ? <Table.ScrollContainer minWidth={560}><Table><Table.Thead><Table.Tr><Table.Th>Staged input</Table.Th><Table.Th>SHA-256</Table.Th><Table.Th>Rights</Table.Th></Table.Tr></Table.Thead><Table.Tbody>
          {detail.staged_inputs.map(i => <Table.Tr key={i.path}><Table.Td>{i.path}<Text size="xs">{i.bytes} bytes</Text></Table.Td><Table.Td><Text size="xs">{i.sha256}</Text></Table.Td><Table.Td>{i.rights}</Table.Td></Table.Tr>)}</Table.Tbody></Table></Table.ScrollContainer>
        : <Text size="xs">Per-file input rights were not recorded for this older build; output rights are unknown.</Text>}
      {detail.state === 'succeeded' && <Stack gap={2} aria-label="Reproducibility">
        <ReproLevel level={detail.reproducibility?.level} />
        <Text size="xs">{detail.reproducibility ? LEVEL[detail.reproducibility.level].explain : 'Reproducibility evidence was not reported.'} A tool success is not engineering or physical qualification.</Text>
        {(detail.comparisons ?? []).length > 0 && <Table.ScrollContainer minWidth={640}><Table><Table.Thead><Table.Tr><Table.Th>Compared output</Table.Th><Table.Th>Other attempt</Table.Th><Table.Th>Bytes</Table.Th><Table.Th>Comparator</Table.Th></Table.Tr></Table.Thead><Table.Tbody>
          {(detail.comparisons ?? []).map(c => <Table.Tr key={`${c.path}:${c.other_build_id}`}><Table.Td>{c.path}</Table.Td><Table.Td><Text size="xs">{c.other_build_id}</Text></Table.Td>
            <Table.Td>{c.byte_identical ? 'identical' : 'differ'}</Table.Td>
            <Table.Td>{c.byte_identical ? 'not needed' : c.comparator ? `${c.comparator}: ${pretty(c.result)}` : 'none declared for this type'}</Table.Td></Table.Tr>)}</Table.Tbody></Table></Table.ScrollContainer>}
      </Stack>}
      <Text size="xs">Output rights: {detail.output_rights.rights} ({detail.output_rights.basis === 'uniform' ? 'all inputs share these rights' : detail.output_rights.basis === 'most_restrictive' ? 'most restrictive input' : 'cannot be determined from the inputs'}).</Text>
      {detail.outputs.length > 0 && <Table.ScrollContainer minWidth={760}><Table><Table.Thead><Table.Tr><Table.Th>Verified output</Table.Th><Table.Th>SHA-256</Table.Th><Table.Th>Rights</Table.Th><Table.Th>Status</Table.Th><Table.Th>Reproducibility</Table.Th></Table.Tr></Table.Thead><Table.Tbody>
        {detail.outputs.map(o => <Table.Tr key={o.path}><Table.Td>{o.path}<Text size="xs">{o.size} bytes</Text></Table.Td><Table.Td><Text size="xs">{o.sha256}</Text></Table.Td><Table.Td>{o.rights}</Table.Td><Table.Td>{o.accepted ? 'Accepted' : 'Retained evidence only; not an accepted artifact'}</Table.Td>
          <Table.Td>{o.accepted ? <ReproLevel level={o.reproducibility} /> : <Text size="xs">not applicable</Text>}</Table.Td></Table.Tr>)}</Table.Tbody></Table></Table.ScrollContainer>}
      <Text size="sm">History</Text>
      <ol aria-label="Build events">{detail.events.map((e, i) => <li key={i}><Text size="xs">{e.at} · {pretty(e.kind)}{typeof e.detail.reason === 'string' ? ` · ${pretty(e.detail.reason)}` : ''}</Text></li>)}</ol>
      <ReusableResultOffer excludeBuildId={detail.build_id} onInspect={id => void load(id)}
        request={{ workspace_id: workspaceId, source_revision_id: detail.source_revision_id, recipe_id: detail.recipe_id, resolved_configuration_id: detail.configuration?.resolved_configuration_id ?? null }} />
      <Group>
        {detail.cancel_available && <Button variant="risk" {...(canCancel ? {} : execute.props)} disabled={!canCancel || busy} onClick={() => void act('cancel')}>Request cancellation</Button>}
        {detail.retry_available && <Button variant="primary" {...execute.props} disabled={!execute.allowed || busy} onClick={() => void act('retry')}>Retry as a new attempt</Button>}
        {detail.reproduce_available && <Button variant="quiet" {...execute.props} disabled={!execute.allowed || busy} onClick={() => void act('reproduce')}>Request reproducibility check</Button>}
        {detail.retried_by && <Button variant="quiet" disabled={busy} onClick={() => void load(detail.retried_by)}>Open retry {detail.retried_by}</Button>}
      </Group>
      {detail.awaiting_runner_confirmation && !detail.abandon_available && <Text size="sm">Waiting for the runner to confirm termination or reconcile.</Text>}
      {detail.abandon_available && <Stack gap="xs">
        <Text size="sm">The leasing runner credential is no longer valid, so nothing can confirm this process stopped. Resolving it records a failure with termination unconfirmed.</Text>
        <TextInput label="Basis for resolving without runner confirmation" value={basis} onChange={e => setBasis(e.currentTarget.value)} maxLength={500} />
        <Group><Button variant="risk" {...execute.props} disabled={!execute.allowed || busy || !basis.trim()} onClick={() => void act('abandon')}>Resolve as failed, termination unconfirmed</Button></Group>
      </Stack>}
    </Stack>}
    </Drawer>
  </Stack>;
}

export function Lineage({ lineage, retryOf }: { lineage: BuildHistory['lineage']; retryOf: string | null }) {
  if (lineage.length < 2 && !retryOf) return null;
  const parent = attemptLabel(lineage, retryOf);
  return <Stack gap={2} aria-label="Retry chain">
    {retryOf && <Text size="sm">Retry of {parent ?? 'earlier attempt'} ({retryOf})</Text>}
    <ol aria-label="Build attempts" style={{ margin: 0 }}>{lineage.map(a => <li key={a.build_id}><Text size="xs">Attempt #{lineage.indexOf(a) + 1} · {a.build_id}{a.current ? ' (this)' : ''} · {pretty(a.state)}</Text></li>)}</ol>
  </Stack>;
}
