import { Alert, Button, Group, Stack, Table, Text, Title } from "@mantine/core";
import { useCallback, useEffect, useState } from "react";
import { ReadOnlyNote, usePermission } from "../../lib/permissions";
import { SbStatus, SbUnknown, type SbLed } from "../../components/sb";
import { runOperation } from "../workspace/api";
import { CATEGORY_LABEL, RUNNER_LABEL, downloadLabel, readWorkspaceStatus, type Finding, type WorkspaceStatus, type StatusBuild } from "./status";

const WORK_LED: Record<WorkspaceStatus["work"]["mode"], SbLed> = { running: "active", draining: "review", interrupting: "failed", maintenance: "review" };
const RUNNER_LED: Record<string, SbLed> = { working: "active", not_enrolled: "not-evaluated", enrolled_liveness_unknown: "not-evaluated", credential_unusable: "failed", lease_expired: "failed" };
const storageLed = (state: string): SbLed => state === "unavailable" ? "failed" : state === "degraded" ? "review" : "idle";
const BUILD_LED: Record<string, SbLed> = { waiting_dispatch: "review", queued: "active", leased: "active", running: "active", interrupted: "failed" };

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
    <Text size="sm">Read {new Date(status.evaluated_at).toLocaleTimeString()} · Closing the browser never cancels work; only an explicit cancellation or an operator stop does. Workflow engine: {status.workflow_engine.state.replace(/_/g, " ")}{status.workflow_engine.reason ? ` (${status.workflow_engine.reason.replace(/_/g, " ")})` : ""}.</Text>
    <Group gap="xs" aria-label="State summary">
      <SbStatus led={WORK_LED[status.work.mode] ?? "not-evaluated"} dimension="work" value={`${status.work.mode}${status.work.reason ? ` (${status.work.reason})` : ""}`} />
      <SbStatus led={RUNNER_LED[status.runner.state] ?? "not-evaluated"} dimension="runner" value={(RUNNER_LABEL[status.runner.state] ?? status.runner.state).replace(/^Runner /, "")} />
      <SbStatus led={storageLed(status.storage.state)} dimension="storage" value={status.storage.state.replace(/_/g, " ")} />
      <SbStatus led={status.queue.active > 0 ? "active" : status.queue.pending > 0 ? "review" : "idle"} dimension="queue" value={`${status.queue.pending} queued · ${status.queue.active} active`} />
    </Group>
    {status.findings.length === 0
      ? <Text>No problems detected by the checks that ran. Native tool compatibility and physical qualification are not evaluated here.</Text>
      : <Stack gap="xs" role="list" aria-label="Findings">{status.findings.map((finding, index) => <div role="listitem" key={`${finding.code}-${index}`}><FindingRow finding={finding} /></div>)}</Stack>}
    {status.tool_catalog && <Stack gap={4}>
      <Title order={4}>Optional native tools</Title>
      <Text size="sm">Image availability is not evaluated here; the host tool console checks cached images.</Text>
      <Stack gap={2} role="list" aria-label="Optional native tools">{status.tool_catalog.tools.map((tool) => <div role="listitem" key={tool.id}>
        <Group gap="sm">
          <SbStatus led={tool.enabled === null ? "not-evaluated" : tool.enabled ? "active" : "off"} dimension={tool.id}
            value={tool.enabled === null ? "not gated" : tool.enabled ? "enabled" : "not enabled"} />
          <Text size="sm">{tool.platforms.join(", ")}</Text>
          <Text size="sm">download {downloadLabel(tool.download_bytes) ?? <SbUnknown what="size" />}</Text>
          <Text size="sm">{tool.approved_recipe_ids.length} approved recipe{tool.approved_recipe_ids.length === 1 ? "" : "s"}</Text>
          <Text size="sm">image {tool.image_state.replace(/_/g, " ")}</Text>
        </Group>
      </div>)}</Stack>
    </Stack>}
    {notice && <Alert role="status">{notice}</Alert>}
    <Title order={4}>Unfinished builds</Title>
    <ReadOnlyNote permission="build.execute" />
    {status.builds.length === 0 ? <Text>No unfinished builds in this workspace.</Text> : <Table>
      <Table.Thead><Table.Tr><Table.Th>Build</Table.Th><Table.Th>Recipe</Table.Th><Table.Th>State</Table.Th><Table.Th /></Table.Tr></Table.Thead>
      <Table.Tbody>{status.builds.map((build) => <Table.Tr key={build.build_id}>
        <Table.Td className="sb-mono">{build.build_id}</Table.Td>
        <Table.Td>{build.recipe_id}</Table.Td>
        <Table.Td><SbStatus led={build.lease_expired ? "failed" : BUILD_LED[build.state] ?? "not-evaluated"} dimension="build" value={`${build.state.replace(/_/g, " ")}${build.lease_expired ? " · lease expired, outcome unknown" : ""}${build.cancellation_requested ? " · cancellation requested" : ""}`} /></Table.Td>
        <Table.Td>{ACTIVE_FOR_CANCEL.has(build.state) && !build.cancellation_requested && <Button variant="risk" size="xs" {...execute.props}
          disabled={!execute.allowed || busy === build.build_id} onClick={() => void cancel(build)}>Cancel build</Button>}</Table.Td>
      </Table.Tr>)}</Table.Tbody>
    </Table>}
  </Stack>;
}
