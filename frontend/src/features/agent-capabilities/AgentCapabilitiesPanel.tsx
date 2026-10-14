import { Alert, Badge, Group, Select, Stack, Table, Text, TextInput, Title } from "@mantine/core";
import { useEffect, useMemo, useState } from "react";
import { requestJson } from "../workspace/api";

type Availability = { status: string; reasons: string[]; missing?: string; requires?: string };
type OperationRow = {
  operation: string; summary: string; requires_expected_state: boolean; supports_idempotency: boolean;
  attachments: string[]; async: boolean; generic_http_invocation: boolean;
  access: { kind: string; minimum_project_permission: string | null; basis: string };
  availability: Availability;
};
type Capabilities = {
  instance: { version: string; registry_sha256: string };
  transports: Record<string, { status: string; reason?: string; invoke?: string }>;
  scope: { project_id: string; role: string; permissions: string[] } | null;
  capabilities: { native_execution: { status: string; reasons: string[]; approved_recipes: number } };
  notes: string[];
  operations: OperationRow[];
};

const STATUS_FILTERS = ["all", "available", "degraded", "unavailable", "not_permitted", "not_applicable", "unknown"];
const statusColor: Record<string, string> = {
  available: "green", degraded: "yellow", unavailable: "red", not_permitted: "gray", not_applicable: "gray", unknown: "orange", scope_required: "gray",
};
const label = (value: string) => value.replace(/_/g, " ");

/** Read-only view of what this instance exposes and what the signed-in actor may call here. */
export function AgentCapabilitiesPanel({ projectId }: { projectId: string }) {
  const [data, setData] = useState<Capabilities | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [status, setStatus] = useState<string | null>("all");

  useEffect(() => {
    let active = true;
    setData(null); setError(null);
    void requestJson<Capabilities>(`/api/v0/discovery/capabilities?project_id=${encodeURIComponent(projectId)}`)
      .then((result) => { if (active) setData(result); })
      .catch((reason: unknown) => { if (active) setError(reason instanceof Error ? reason.message : "Unable to read capabilities."); });
    return () => { active = false; };
  }, [projectId]);

  const rows = useMemo(() => (data?.operations ?? []).filter((row) =>
    (status === "all" || row.availability.status === status) &&
    (!filter || row.operation.includes(filter.toLowerCase()) || row.summary.toLowerCase().includes(filter.toLowerCase()))), [data, filter, status]);

  return <Stack>
    <Title order={2}>Agent access</Title>
    <Text c="dimmed">Reported by this instance from its live operation registry and your project permissions. It is not a promise that a specific request will succeed.</Text>
    {error && <Alert color="red">{error}</Alert>}
    {!data && !error && <Text role="status">Reading capabilities…</Text>}
    {data && <>
      <Group>
        <Badge variant="light">Role: {data.scope?.role ?? "unknown"}</Badge>
        {Object.entries(data.transports).map(([name, transport]) =>
          <Badge key={name} color={transport.status === "available" ? "green" : "gray"} variant="light">{label(name)}: {transport.status}{transport.reason ? ` (${label(transport.reason)})` : ""}</Badge>)}
        <Badge color={statusColor[data.capabilities.native_execution.status] ?? "gray"} variant="light">
          Native execution: {data.capabilities.native_execution.status}{data.capabilities.native_execution.reasons.length ? ` (${data.capabilities.native_execution.reasons.map(label).join(", ")})` : ""}
        </Badge>
      </Group>
      <Text size="sm">Permissions: {data.scope?.permissions.join(", ") || "none"}</Text>
      <Text size="sm" c="dimmed">Registry {data.instance.registry_sha256.slice(0, 12)} - {data.operations.length} operations</Text>
      <Group align="end">
        <TextInput label="Find operation" value={filter} onChange={(event) => setFilter(event.currentTarget.value)} />
        <Select label="Availability" data={STATUS_FILTERS} value={status} onChange={setStatus} allowDeselect={false} />
      </Group>
      <Table>
        <Table.Thead><Table.Tr><Table.Th>Operation</Table.Th><Table.Th>Availability</Table.Th><Table.Th>Requires</Table.Th><Table.Th>Behavior</Table.Th></Table.Tr></Table.Thead>
        <Table.Tbody>{rows.map((row) => <Table.Tr key={row.operation}>
          <Table.Td><Text ff="monospace" size="sm">{row.operation}</Text><Text size="xs" c="dimmed">{row.summary}</Text></Table.Td>
          <Table.Td><Badge color={statusColor[row.availability.status] ?? "gray"}>{label(row.availability.status)}</Badge>
            {row.availability.reasons.length > 0 && <Text size="xs">{row.availability.reasons.map(label).join(", ")}</Text>}</Table.Td>
          <Table.Td>{row.access.minimum_project_permission ?? label(row.access.kind)}<Text size="xs" c="dimmed">{row.access.basis}</Text></Table.Td>
          <Table.Td><Text size="xs">{[row.requires_expected_state && "needs expected state", row.supports_idempotency && "idempotent", row.async && "asynchronous", row.attachments.length > 0 && "upload"].filter(Boolean).join(", ") || "fresh evaluation"}</Text></Table.Td>
        </Table.Tr>)}</Table.Tbody>
      </Table>
      {rows.length === 0 && <Text>No operations match.</Text>}
      {data.notes.map((note) => <Text key={note} size="xs" c="dimmed">{note}</Text>)}
    </>}
  </Stack>;
}
