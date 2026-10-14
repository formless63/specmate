import { Alert, Badge, Button, Group, NativeSelect, Stack, Table, Text, TextInput, Title } from "@mantine/core";
import { useEffect, useState, type FormEvent } from "react";
import { InspectionScope, ReadOnlyNote, usePermission } from "../../lib/permissions";
import { SbUnknown } from "../../components/sb";
import { LIST_KEYS, readPreferences, savePreferences, type Layer, type Preferences } from "./api";

const LABELS: Record<string, string> = {
  preferred_suppliers: "Preferred suppliers", wire_colours: "Wire colours", connector_families: "Connector families",
  default_length_unit: "Default length unit", default_wire_gauge_system: "Wire gauge system",
};
const LENGTH = ["mm", "cm", "m", "in", "ft"];
const GAUGE = [{ value: "awg", label: "AWG" }, { value: "mm2", label: "mm²" }];

const split = (text: string) => text.split(",").map((item) => item.trim()).filter(Boolean);

/** Workspace maker preferences and the member's own override. Defaults only, never engineering facts. */
export function PreferencesPanel({ workspaceId }: { workspaceId: string }) {
  const [data, setData] = useState<Preferences | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let live = true;
    setData(null); setError("");
    readPreferences(workspaceId).then((result) => { if (live) setData(result); }, (reason: unknown) => { if (live) setError(reason instanceof Error ? reason.message : "Unable to read preferences."); });
    return () => { live = false; };
  }, [workspaceId]);

  return <Stack gap="sm">
    <Title order={2}>Maker preferences</Title>
    <Text c="dimmed" size="sm">Defaults for forms and agents. A preference is not a rating, tolerance or compatibility; anything without evidence stays unknown.</Text>
    {error && <Alert color="red">{error}</Alert>}
    {!data && !error && <Text role="status">Reading preferences…</Text>}
    {data && <>
      <Table aria-label="Effective preferences">
        <Table.Thead><Table.Tr><Table.Th>Preference</Table.Th><Table.Th>Effective default</Table.Th><Table.Th>From</Table.Th></Table.Tr></Table.Thead>
        <Table.Tbody>{Object.entries(data.effective).map(([key, item]) => <Table.Tr key={key}>
          <Table.Td>{LABELS[key] ?? key}</Table.Td>
          <Table.Td>{item.value === null ? <SbUnknown what="Preference" /> : Array.isArray(item.value) ? item.value.join(", ") : item.value}</Table.Td>
          <Table.Td><Badge variant="light" color={item.source === "none" ? "gray" : "blue"}>{item.source === "none" ? "unset" : `preference · ${item.source}`}</Badge></Table.Td>
        </Table.Tr>)}</Table.Tbody>
      </Table>
      <LayerForm key={`w-${data.workspace.state_token}`} title="Workspace defaults" scope="workspace" layer={data.workspace} workspaceId={workspaceId} onSaved={setData} />
      <LayerForm key={`u-${data.user.state_token}`} title="My override" scope="user" layer={data.user} workspaceId={workspaceId} onSaved={setData} />
    </>}
  </Stack>;
}

function LayerForm({ title, scope, layer, workspaceId, onSaved }: { title: string; scope: "workspace" | "user"; layer: Layer; workspaceId: string; onSaved: (value: Preferences) => void }) {
  const admin = usePermission("workspace.admin");
  const editable = scope === "user" || admin.allowed;
  const [lists, setLists] = useState<Record<string, string>>(() => Object.fromEntries(LIST_KEYS.map((key) => [key, (layer.values[key] ?? []).join(", ")])));
  const [length, setLength] = useState(layer.values.default_length_unit ?? "");
  const [gauge, setGauge] = useState(layer.values.default_wire_gauge_system ?? "");
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true); setStatus("");
    try {
      const values: Record<string, string[] | string | null> = { default_length_unit: length || null, default_wire_gauge_system: gauge || null };
      for (const key of LIST_KEYS) values[key] = split(lists[key] ?? "").length ? split(lists[key] ?? "") : null;
      onSaved(await savePreferences(workspaceId, scope, values, layer.state_token));
      setStatus("Saved.");
    } catch (reason) {
      setStatus(reason instanceof Error ? reason.message : "Save failed.");
    } finally { setBusy(false); }
  }

  return <form onSubmit={submit} aria-label={title}>
    <Stack gap="xs">
      <Title order={3}>{title}</Title>
      {scope === "workspace" && <ReadOnlyNote permission="workspace.admin">Workspace defaults are set by administrators</ReadOnlyNote>}
      <InspectionScope permission={scope === "workspace" ? "workspace.admin" : "workspace.read"}>
        <Group align="end" grow>
          {LIST_KEYS.map((key) => <TextInput key={`${scope}-${key}`} label={`${LABELS[key]} (${title})`} description="Comma separated" value={lists[key] ?? ""} onChange={(event) => { const value = event.currentTarget.value; setLists((current) => ({ ...current, [key]: value })); }} />)}
        </Group>
        <Group align="end">
          <NativeSelect label={`${LABELS.default_length_unit} (${title})`} data={[{ value: "", label: "No preference" }, ...LENGTH]} value={length} onChange={(event) => setLength(event.currentTarget.value)} />
          <NativeSelect label={`${LABELS.default_wire_gauge_system} (${title})`} data={[{ value: "", label: "No preference" }, ...GAUGE]} value={gauge} onChange={(event) => setGauge(event.currentTarget.value)} />
        </Group>
      </InspectionScope>
      <Group>
        <Button type="submit" size="xs" disabled={!editable || busy} {...(editable ? {} : admin.props)}>{`Save ${title.toLowerCase()}`}</Button>
        {status && <Text role="status" size="sm">{status}</Text>}
      </Group>
    </Stack>
  </form>;
}
