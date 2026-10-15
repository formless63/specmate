import { Alert, Button, Card, Group, Stack, Table, Text, Textarea, Title } from "@mantine/core";
import { useEffect, useRef, useState } from "react";
import { InspectionScope, ReadOnlyNote, usePermission } from "../../lib/permissions";
import { ApiError } from "../workspace/api";
import { DocumentFields } from "./DocumentFields";
import { NumberingFields } from "./NumberingFields";
import { readSettings, saveSettings, type SettingsValues, type WorkspaceSettings } from "./api";
import { schemeFromConfig } from "./part-numbers";

type Props = { workspaceId: string; principalKey?: string; active?: boolean; onAccessLost?: () => void | Promise<void>; section: string };
const titles: Record<string, string> = { "settings-documents": "Documents", "settings-engineering": "Engineering", "part-numbering": "Part numbering", "validation-rules": "Validation rules", webhooks: "Webhooks" };
const denied = (reason: unknown) => reason instanceof ApiError && [401, 403, 404].includes(reason.status);

export function SettingsPanel(props: Props) {
  const { section } = props;
  if (["settings-engineering", "validation-rules", "webhooks"].includes(section)) return <Stack><Title order={2}>{titles[section]}</Title>
    {section === "settings-engineering" ? <Text>Engineering ratings, dimensions and test intent belong to their records and exact revisions. Maker defaults are under Preferences; they never establish compatibility or evidence.</Text> : section === "validation-rules" ? <Text>Built-in record checks report invalid declarations and unknown inputs in each editor. Configurable workspace validation policies are not available yet.</Text> : <Text>Webhook delivery is not available yet. Integrations provides reviewed imports and observations without outbound event delivery.</Text>}
  </Stack>;
  return <SettingsWorkspace key={`${props.principalKey ?? ''}:${props.workspaceId}`} {...props} />;
}

function SettingsWorkspace({ workspaceId, active = true, onAccessLost, section }: Props) {
  const [current, setCurrent] = useState<WorkspaceSettings | null>(null);
  const [values, setValues] = useState<SettingsValues>({ documents: {}, numbering: null });
  const [text, setText] = useState("null"); const [samples, setSamples] = useState(""); const [report, setReport] = useState<string[]>([]);
  const [error, setError] = useState(""); const [notice, setNotice] = useState(""); const [busy, setBusy] = useState(false); const [blocked, setBlocked] = useState(false);
  const alive = useRef(false); const epoch = useRef(0);
  const gate = usePermission("workspace.admin");
  const valid = (version: number) => alive.current && version === epoch.current;
  function adopt(result: WorkspaceSettings) { setCurrent(result); setValues(result.values); setText(JSON.stringify(result.values.numbering ?? null, null, 2)); setReport([]); }
  function fail(reason: unknown) { setError(reason instanceof Error ? reason.message : "Settings are unavailable."); if (denied(reason)) { setBlocked(true); void onAccessLost?.(); } }
  useEffect(() => {
    alive.current = true; const version = ++epoch.current;
    readSettings(workspaceId).then(result => { if (valid(version)) adopt(result); }, reason => { if (valid(version)) fail(reason); });
    return () => { alive.current = false; epoch.current += 1; };
  }, [workspaceId]);
  async function refresh(discard: boolean) {
    if (busy) return; const version = ++epoch.current; setBusy(true); setError("");
    try { const result = await readSettings(workspaceId); if (!valid(version)) return;
      if (!current || discard) adopt(result);
      else if (result.state_token !== current.state_token) setNotice("Saved settings changed elsewhere. Prepared values and their original save token are retained; reload saved settings to discard them.");
      setBlocked(false);
    } catch (reason) { if (valid(version)) fail(reason); } finally { if (valid(version)) setBusy(false); }
  }
  async function save() {
    if (!current || busy || blocked || !gate.allowed) return; const version = epoch.current; setBusy(true); setError(""); setNotice("");
    try {
      const numbering = section === "part-numbering" ? JSON.parse(text) : values.numbering ?? null;
      if (numbering !== null) schemeFromConfig(numbering);
      const result = await saveSettings(workspaceId, { ...values, numbering }, current.state_token);
      if (!valid(version)) return; adopt(result); setNotice("Workspace settings saved. Existing records and documents are unchanged.");
    } catch (reason) { if (valid(version)) fail(reason); } finally { if (valid(version)) setBusy(false); }
  }
  function preview() {
    try { const config = JSON.parse(text); if (config === null) { setReport(["Numbering is off. Existing identifiers remain unchanged."]); return; }
      const scheme = schemeFromConfig(config); setReport(samples.split(/\s+/).filter(Boolean).slice(0, 20).map(value => `${value}: ${scheme.check(value).map(issue => issue.message).join('; ') || 'Matches this scheme'}`)); setError("");
    } catch (reason) { fail(reason); }
  }
  const locked = busy || blocked || !active;
  return <Stack><Title order={2}>{titles[section]}</Title>
    {error && <Alert color="red" role="alert">{error}</Alert>}{notice && !blocked && <Alert role="status">{notice}</Alert>}
    {blocked && <Alert color="red">Current workspace settings access must be confirmed. Prepared values and their original save token stay retained. <Button variant="quiet" disabled={busy} onClick={() => void refresh(false)}>Refresh settings access</Button></Alert>}
    {!current && !blocked && <Text>Reading workspace settings…</Text>}
    {current && <div hidden={blocked || !active} inert={blocked || !active || undefined}>
      <Text size="sm">Workspace defaults · version {current.version}. Only workspace admins change these settings.</Text>
      <fieldset disabled={locked} style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}><Card withBorder><Stack><InspectionScope permission="workspace.admin">
        {section === "settings-documents" ? <><Text size="sm">Copy these defaults into a new document review, then edit or confirm them. Retained documents keep their own reviewed fields.</Text><DocumentFields disabled={locked || !gate.allowed} value={values.documents} onChange={documents => { if (!locked && gate.allowed) setValues(previous => ({ ...previous, documents })); }} /></> : <NumberingFields disabled={locked || !gate.allowed} text={text} onChange={value => { if (!locked && gate.allowed) { setText(value); setReport([]); } }} />}
      </InspectionScope><ReadOnlyNote permission="workspace.admin">Changing workspace settings is unavailable.</ReadOnlyNote>
      <Group><Button disabled={!gate.allowed || locked} loading={busy} onClick={() => void save()} {...gate.props}>Save {titles[section]!.toLowerCase()} settings</Button><Button variant="subtle" disabled={locked} onClick={() => void refresh(true)}>Reload saved settings</Button></Group>
      </Stack></Card></fieldset>
      {section === "part-numbering" && <><Textarea maxLength={4096} label="Numbers to check" description="Checks the first 20 entered numbers. No identifiers are assigned." value={samples} onChange={event => setSamples(event.currentTarget.value)} /><Button variant="quiet" disabled={locked} onClick={preview}>Check proposed numbers</Button><Table aria-label="Numbering report"><Table.Tbody>{report.map((line, index) => <Table.Tr key={index}><Table.Td>{line}</Table.Td></Table.Tr>)}</Table.Tbody></Table></>}
    </div>}
  </Stack>;
}
