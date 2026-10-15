import { Alert, Button, Group, Stack, Text } from "@mantine/core";
import { useEffect, useRef, useState } from "react";
import { DocumentFields } from "./DocumentFields";
import { readSettings, type DocumentSettingsSnapshot } from "./api";

/** Explicit copy: a retained document never reads live workspace settings. */
export function DocumentDefaults({ workspaceId, value, onChange, active = true }: { active?: boolean; workspaceId: string; value?: DocumentSettingsSnapshot; onChange: (value: DocumentSettingsSnapshot | undefined) => void }) {
  const [busy, setBusy] = useState(false); const [error, setError] = useState("");
  const alive = useRef(false); const epoch = useRef(0);
  useEffect(() => { alive.current = active; epoch.current += 1; setBusy(false); return () => { alive.current = false; epoch.current += 1; }; }, [workspaceId, active]);
  async function copy() { if (!active || busy) return; const version = epoch.current; setBusy(true); setError(""); try { const settings = await readSettings(workspaceId); if (!alive.current || version !== epoch.current) return; onChange({ ...settings.values.documents, source_settings_version: settings.version }); } catch (reason) { if (alive.current && version === epoch.current) setError(reason instanceof Error ? reason.message : "Document defaults are unavailable."); } finally { if (alive.current && version === epoch.current) setBusy(false); } }
  return <Stack gap="xs"><Group><Button disabled={busy || !active} variant="quiet" loading={busy} onClick={() => void copy()}>Copy workspace document defaults</Button>{value && <Button disabled={busy || !active} variant="subtle" onClick={() => onChange(undefined)}>Use generic document title block</Button>}</Group>
    {error && <Alert color="red">{error}</Alert>}
    {value && <><Text size="sm">Copied defaults, reviewed values · declared settings version {value.source_settings_version}. Edit these fields before reviewing; later settings changes cannot alter this copy.</Text><DocumentFields designerLabel="Designer" disabled={busy || !active} value={value} onChange={fields => { if (!busy && active) onChange({ ...fields, source_settings_version: value.source_settings_version }); }} /></>}
  </Stack>;
}
