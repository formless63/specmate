import { Alert, Button, Checkbox, Group, NativeSelect, Select, Stack, Table, Text, Textarea, TextInput, Title } from "@mantine/core";
import { useCallback, useEffect, useState } from "react";
import { InspectionScope, ReadOnlyNote, useCan, usePermission } from "../../lib/permissions";
import { Chooser, useRevisionChoice } from "../inventory/SourcingPanel";
import { listIntegrations, readHistory, run, type ExportResult, type History, type ImportRun, type Integration } from "./api";

const FIELDS = [
  { id: "supplier_offer", label: "Supplier offers (owned by the external system, import only)", owner: "external" },
  { id: "stock_observation", label: "Stock counts (owned by the external system, import only)", owner: "external" },
  { id: "needs", label: "Needs / BOM (owned here, export only)", owner: "specmate" },
];

function parseColumns(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split("\n").map((l) => l.trim()).filter(Boolean)) {
    const [canonical, ...rest] = line.split("=");
    if (!canonical || !rest.length) throw new Error(`Column mapping "${line}" must be canonical=external.`);
    out[canonical.trim()] = rest.join("=").trim();
  }
  return out;
}
const columnsText = (c: Record<string, string>) => Object.entries(c).map(([k, v]) => `${k}=${v}`).join("\n");

function download(result: ExportResult) {
  const url = URL.createObjectURL(new Blob([result.content], { type: result.file_format === "json" ? "application/json" : "text/csv" }));
  const link = document.createElement("a");
  link.href = url; link.download = `needs-${result.export_id}.${result.file_format}`; link.click();
  URL.revokeObjectURL(url);
}

/**
 * Optional business integrations: which external system owns which field. Imported values are
 * dated observations, never engineering facts or stock; exports are explicit and recorded.
 */
export function IntegrationsPanel({ workspaceId }: { workspaceId: string }) {
  const admin = usePermission("workspace.admin");
  const canImport = useCan("item.create");
  const canExport = useCan("inventory.manage");
  const [items, setItems] = useState<Integration[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [history, setHistory] = useState<History | null>(null);
  const [name, setName] = useState("");
  const [owned, setOwned] = useState<string[]>(["supplier_offer"]);
  const [columns, setColumns] = useState("");
  const [enabled, setEnabled] = useState(true);
  const [field, setField] = useState("supplier_offer");
  const [format, setFormat] = useState("csv");
  const [content, setContent] = useState("");
  const [fileName, setFileName] = useState("pasted");
  const [last, setLast] = useState<ImportRun | null>(null);
  const plan = useRevisionChoice(workspaceId, ["bom_plan", "material_plan"]);
  const [purpose, setPurpose] = useState("procurement");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const current = items.find((i) => i.integration_id === selected) ?? null;
  const reload = useCallback(async (keep?: string | null) => {
    const { integrations } = await listIntegrations(workspaceId);
    setItems(integrations);
    const id = keep ?? integrations[0]?.integration_id ?? null;
    setSelected(id);
    setHistory(id ? await readHistory(id) : null);
  }, [workspaceId]);
  useEffect(() => { void reload().catch((e: unknown) => setError(e instanceof Error ? e.message : "Unable to read integrations.")); }, [reload]);
  useEffect(() => {
    if (!current) return;
    setName(current.name); setEnabled(current.enabled); setColumns(columnsText(current.columns));
    setOwned(Object.keys(current.ownership));
  }, [current?.integration_id, current?.state]); // eslint-disable-line react-hooks/exhaustive-deps

  async function act(work: () => Promise<void>) {
    setBusy(true); setError(null); setNotice(null);
    try { await work(); } catch (reason) { setError(reason instanceof Error ? reason.message : "The action failed."); } finally { setBusy(false); }
  }
  const ownership = () => Object.fromEntries(FIELDS.filter((f) => owned.includes(f.id)).map((f) => [f.id, f.owner]));

  return <Stack className="sb-dash">
    <Title order={2} className="sb-dash-title">Integrations</Title>
    <Text className="sb-dash-note">Optional. Nothing here is needed for engineering work. Imported values are dated observations attributed to a file and a person; they never change engineering facts or the stock ledger.</Text>
    {error && <Alert color="red" role="alert">{error}</Alert>}
    {notice && <Alert color="green" role="status">{notice}</Alert>}
    {items.length > 0 && <Select label="Integration" size="xs" data={items.map((i) => ({ value: i.integration_id, label: `${i.name}${i.enabled ? "" : " (disabled)"}` }))}
      value={selected} allowDeselect={false} onChange={(id) => { setSelected(id); setLast(null); if (id) void readHistory(id).then(setHistory); }} />}
    {items.length === 0 && <Text>No integration is configured.</Text>}

    <Title order={3} size="h5">{current ? "Field ownership" : "New integration"}</Title>
    <InspectionScope permission="workspace.admin"><Stack maw={560} gap={6}>
      <TextInput label="Integration name" size="xs" value={name} onChange={(e) => setName(e.currentTarget.value)} disabled={!!current} />
      {FIELDS.map((f) => <Checkbox key={f.id} size="xs" label={f.label} checked={owned.includes(f.id)}
        onChange={(e) => setOwned(e.currentTarget.checked ? [...owned, f.id] : owned.filter((x) => x !== f.id))} />)}
      <Textarea label="Column names (canonical=external, one per line)" size="xs" value={columns} onChange={(e) => setColumns(e.currentTarget.value)} minRows={2} />
      {current && <Checkbox size="xs" label="Enabled" checked={enabled} onChange={(e) => setEnabled(e.currentTarget.checked)} />}
    </Stack></InspectionScope>
    <Group>
      <Button size="xs" loading={busy} {...admin.props} onClick={() => void act(async () => {
        if (current) {
          const next = await run<Integration>("integration.update", { integration_id: current.integration_id, ownership: ownership(), columns: parseColumns(columns), enabled }, current.state);
          await reload(next.integration_id); setNotice("Integration updated.");
        } else {
          const made = await run<Integration>("integration.create", { workspace_id: workspaceId, name, ownership: ownership(), columns: parseColumns(columns) });
          await reload(made.integration_id); setNotice("Integration created.");
        }
      })}>{current ? "Save integration" : "Create integration"}</Button>
      {current && <Button size="xs" variant="quiet" onClick={() => { setSelected(null); setName(""); setColumns(""); setOwned(["supplier_offer"]); }}>New integration</Button>}
    </Group>
    <ReadOnlyNote permission="workspace.admin">Only workspace admins configure integrations.</ReadOnlyNote>

    {current && <>
      <Title order={3} size="h5">Import a file</Title>
      {!canImport ? <Text size="sm">Importing needs contributor access.</Text> : <Stack maw={560} gap={6}>
        <NativeSelect label="Imported field" size="xs" value={field} onChange={(e) => setField(e.currentTarget.value)} data={[{ value: "supplier_offer", label: "Supplier offers" }, { value: "stock_observation", label: "Stock observations (needs inventory management)" }]} />
        <NativeSelect label="File format" size="xs" value={format} onChange={(e) => setFormat(e.currentTarget.value)} data={["csv", "json"]} />
        <input aria-label="Import file" type="file" accept=".csv,.json,text/csv,application/json" onChange={(e) => {
          const file = e.currentTarget.files?.[0]; if (!file) return;
          setFileName(file.name); setFormat(file.name.toLowerCase().endsWith(".json") ? "json" : "csv");
          void file.text().then(setContent);
        }} />
        <Textarea label="File content" size="xs" value={content} onChange={(e) => setContent(e.currentTarget.value)} minRows={4} />
        <Button size="xs" loading={busy} disabled={!content.trim()} onClick={() => void act(async () => {
          const result = await run<ImportRun>("integration.import", { integration_id: current.integration_id, field, file_name: fileName, file_format: format, content });
          setLast(result); setHistory(await readHistory(current.integration_id));
        })}>Import as observations</Button>
      </Stack>}
      {last && <Stack gap={4} role="status">
        <Text size="sm">{last.duplicate_of_earlier_run ? "This exact file was already imported; nothing new was recorded. " : ""}{last.accepted_count} of {last.row_count} rows recorded as observations; {last.rejected_count} rejected.</Text>
        {last.rejections.length > 0 && <Table><Table.Thead><Table.Tr><Table.Th>Row</Table.Th><Table.Th>Reason</Table.Th></Table.Tr></Table.Thead>
          <Table.Tbody>{last.rejections.map((r) => <Table.Tr key={`${r.row}-${r.reason}`}><Table.Td>{r.row}</Table.Td><Table.Td>{r.reason}</Table.Td></Table.Tr>)}</Table.Tbody></Table>}
      </Stack>}

      <Title order={3} size="h5">Export needs</Title>
      {!canExport ? <Text size="sm">Exporting needs inventory management.</Text> : <Group align="flex-end">
        <Chooser label="Plan" choice={plan} />
        <NativeSelect label="Purpose" size="xs" value={purpose} onChange={(e) => setPurpose(e.currentTarget.value)} data={["procurement", "pcb_fabrication", "pcb_population", "consumables"]} />
        <Button size="xs" loading={busy} disabled={!plan.revision} onClick={() => void act(async () => {
          const result = await run<ExportResult>("integration.export_needs", { integration_id: current.integration_id, revision_id: plan.revision, purpose, file_format: format });
          download(result); setHistory(await readHistory(current.integration_id));
          setNotice(`Exported ${result.row_count} rows${result.unresolved.length ? `; ${result.unresolved.length} plan decision(s) unresolved` : ""}. The exact file is recorded.`);
        })}>Export needs</Button>
      </Group>}

      <Title order={3} size="h5">History</Title>
      {history && <Table><Table.Thead><Table.Tr><Table.Th>When</Table.Th><Table.Th>Action</Table.Th><Table.Th>By</Table.Th><Table.Th>Result</Table.Th></Table.Tr></Table.Thead>
        <Table.Tbody>
          {history.runs.map((r) => <Table.Tr key={r.run_id}><Table.Td>{r.created_at.slice(0, 16)}</Table.Td><Table.Td>Import {r.field}</Table.Td><Table.Td>{r.actor.username}</Table.Td><Table.Td>{r.accepted_count}/{r.row_count} accepted</Table.Td></Table.Tr>)}
          {history.exports.map((e) => <Table.Tr key={e.export_id}><Table.Td>{e.created_at.slice(0, 16)}</Table.Td><Table.Td>Export {e.purpose}</Table.Td><Table.Td>{e.actor.username}</Table.Td><Table.Td>{e.row_count} rows</Table.Td></Table.Tr>)}
        </Table.Tbody></Table>}
    </>}
  </Stack>;
}
