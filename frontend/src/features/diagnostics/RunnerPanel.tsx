import { Alert, Button, Card, Group, SimpleGrid, Stack, Text, Title } from "@mantine/core";
import { useEffect } from "react";
import { ApiError } from "../workspace/api";
import { useQuery } from "@tanstack/react-query";
import { SbStatus, SbUnknown } from "../../components/sb";
import { RUNNER_LABEL, downloadLabel, readWorkspaceStatus } from "./status";

/** Reported runner/tool availability is separate from permission to request an execution. */
export function RunnerPanel({ workspaceId, principalKey, active = true, onAccessLost }: { workspaceId: string; principalKey: string; active?: boolean; onAccessLost?: () => void }) {
  const result = useQuery({ queryKey: ["jobs-runner", principalKey, workspaceId], queryFn: () => readWorkspaceStatus(workspaceId), enabled: active, retry: false });
  useEffect(() => { if (result.error instanceof ApiError && [401, 403, 404].includes(result.error.status)) onAccessLost?.(); }, [result.error, onAccessLost]);
  const status = result.isError ? null : result.data;
  return <Stack>
    <Group justify="space-between"><Title order={2}>Runner</Title><Button size="xs" variant="quiet" loading={result.isFetching} onClick={() => void result.refetch()}>Refresh runner availability</Button></Group>
    <Text size="sm" c="dimmed">Tool configuration and reported runner state. Enabling a tool does not grant permission to execute it; an execution needs an approved recipe and current authority.</Text>
    {result.isError && <Alert color="red" role="alert">{result.error.message} Runner availability is not evaluated until this read succeeds.</Alert>}
    {result.isPending && <Text role="status">Reading runner availability…</Text>}
    {status && <>
      <Group gap="md"><SbStatus led={status.runner.state === "working" ? "active" : status.runner.state === "credential_unusable" || status.runner.state === "lease_expired" ? "failed" : "not-evaluated"} dimension="runner" value={RUNNER_LABEL[status.runner.state] ?? "Runner state unknown"} />
        <Text size="sm">Your execution permission: {status.can_execute ? "granted" : "not granted"}</Text></Group>
      <Text size="xs" c="dimmed">Read {new Date(status.evaluated_at).toLocaleString()} · {status.runner.credentials_usable} usable runner credentials · {status.runner.stages_holding_lease} held leases. Enrolled runners without observed activity have unknown liveness.</Text>
      <Text size="sm">Cached image availability, native tool compatibility and physical qualification are not checked here.</Text>
      {!status.tool_catalog ? <Text>Tool catalog was not reported.</Text> : status.tool_catalog.tools.length === 0 ? <Text>No optional tools were reported.</Text> : <SimpleGrid cols={{ base: 1, md: 2 }} role="list" aria-label="Tool capabilities">
        {status.tool_catalog.tools.map(tool => <Card key={tool.id} withBorder padding="sm" role="listitem"><Stack gap={6}>
          <Title order={3} size="h5">{tool.title}</Title>
          <SbStatus led={tool.enabled === true ? "info" : "not-evaluated"} dimension="configuration" value={tool.enabled === null ? "not gated" : tool.enabled ? "enabled" : "not enabled"} />
          <Text size="sm">Reported availability: {tool.state.replaceAll("_", " ")}</Text>
          <Text size="sm">Platforms: {tool.platforms.length ? tool.platforms.join(", ") : "not reported"}</Text>
          <Text size="sm">Download: {downloadLabel(tool.download_bytes) ?? <SbUnknown what="download size" />}</Text>
          <Text size="sm">Image: {tool.image_state.replaceAll("_", " ")}</Text>
          <Text size="sm">{tool.approved_recipe_ids.length} approved recipe{tool.approved_recipe_ids.length === 1 ? "" : "s"}</Text>
          {tool.approved_recipe_ids.length > 0 && <Text size="xs" style={{ overflowWrap: "anywhere" }}>{tool.approved_recipe_ids.join(", ")}</Text>}
        </Stack></Card>)}
      </SimpleGrid>}
    </>}
  </Stack>;
}
