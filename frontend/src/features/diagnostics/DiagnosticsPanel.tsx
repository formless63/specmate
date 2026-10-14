import { Alert, Badge, Button, Group, Stack, Table, Text, Title } from "@mantine/core";
import { useCallback, useEffect, useState } from "react";
import { ReadOnlyNote, usePermission } from "../../lib/permissions";
import { runOperation } from "../workspace/api";
import { CATEGORY_LABEL, RUNNER_LABEL, readWorkspaceStatus, type Finding, type WorkspaceStatus, type StatusBuild } from "./status";

const ACTIVE_FOR_CANCEL = new Set(["waiting_dispatch", "queued", "leased", "running"]);

function FindingRow({ finding }: { finding: Finding }) {
  const buildIds = Array.isArray(finding.evidence.build_ids) ? (finding.evidence.build_ids as string[]) : [];
  return <Alert variant="light" title={`${CATEGORY_LABEL[finding.category]} · ${finding.severity}`} data-category={finding.category}>
    <Stack gap={4}>
      <Text>{finding.summary}</Text>
      <Text><b>Recovery:</b> {finding.recovery}</Text>
      {buildIds.length > 0 && <Text size="sm" className="sb-mono">Builds: {buildIds.join(", ")}</Text>}
    </Stack>
  </Alert>;
}

export function DiagnosticsPanel({ workspaceId, active = true, onChanged }: { workspaceId: string; active?: boolean; onChanged?: () => void }) {
  const [status, setStatus] = useState<WorkspaceStatus | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const execute = usePermission("build.execute");

  const load = useCallback(async () => {
    try { setStatus(await readWorkspaceStatus(workspaceId)); setFailure(null); }
    catch (reason) { setStatus(null); setFailure(reason instanceof Error ? reason.message : "Unavailable."); }
  }, [workspaceId]);
  useEffect(() => { if (active) void load(); }, [active, load]);

  async function cancel(build: StatusBuild) {
    setBusy(build.build_id); setNotice(null);
    try {
      const result = await runOperation<{ state: string }>("build.cancel", { build_id: build.build_id }, { expectedState: build.state_token });
      setNotice(result.result.state === "cancelled"
        ? "Cancelled before it started."
        : "Cancellation requested. The build stays listed until its runner confirms it stopped.");
    } catch (reason) {
      setNotice(reason instanceof Error ? reason.message : "Cancellation failed.");
    } finally { setBusy(null); await load(); onChanged?.(); }
  }

  if (failure) return <Alert color="red" title="Status unavailable" role="alert">{failure} Status is not evaluated until this read succeeds.</Alert>;
  if (!status) return <Text>Reading status…</Text>;

  return <Stack gap="md">
    <Group justify="space-between">
      <Title order={3}>Status and recovery</Title>
      <Button variant="quiet" onClick={() => void load()}>Refresh</Button>
    </Group>
    <Text size="sm">Read {new Date(status.evaluated_at).toLocaleTimeString()} · Closing the browser never cancels work; only an explicit cancellation or an operator stop does. Workflow engine: {status.workflow_engine.state.replace(/_/g, " ")}.</Text>
    <Group gap="xs" aria-label="State summary">
      <Badge variant="draft">Work: {status.work.mode}{status.work.reason ? ` (${status.work.reason})` : ""}</Badge>
      <Badge variant="draft">{RUNNER_LABEL[status.runner.state] ?? status.runner.state}</Badge>
      <Badge variant="draft">Storage: {status.storage.state.replace(/_/g, " ")}</Badge>
      <Badge variant="draft">{status.queue.pending} queued · {status.queue.active} active</Badge>
    </Group>
    {status.findings.length === 0
      ? <Text>No problems detected by the checks that ran. Native tool compatibility and physical qualification are not evaluated here.</Text>
      : <Stack gap="xs" role="list" aria-label="Findings">{status.findings.map((finding, index) => <div role="listitem" key={`${finding.code}-${index}`}><FindingRow finding={finding} /></div>)}</Stack>}
    {notice && <Alert role="status">{notice}</Alert>}
    <Title order={4}>Unfinished builds</Title>
    <ReadOnlyNote permission="build.execute" />
    {status.builds.length === 0 ? <Text>No unfinished builds in this workspace.</Text> : <Table>
      <Table.Thead><Table.Tr><Table.Th>Build</Table.Th><Table.Th>Recipe</Table.Th><Table.Th>State</Table.Th><Table.Th /></Table.Tr></Table.Thead>
      <Table.Tbody>{status.builds.map((build) => <Table.Tr key={build.build_id}>
        <Table.Td className="sb-mono">{build.build_id}</Table.Td>
        <Table.Td>{build.recipe_id}</Table.Td>
        <Table.Td>{build.state.replace(/_/g, " ")}{build.lease_expired ? " · lease expired, outcome unknown" : ""}{build.cancellation_requested ? " · cancellation requested" : ""}</Table.Td>
        <Table.Td>{ACTIVE_FOR_CANCEL.has(build.state) && !build.cancellation_requested && <Button variant="risk" size="xs" {...execute.props}
          disabled={!execute.allowed || busy === build.build_id} onClick={() => void cancel(build)}>Cancel build</Button>}</Table.Td>
      </Table.Tr>)}</Table.Tbody>
    </Table>}
  </Stack>;
}
