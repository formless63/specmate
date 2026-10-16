import { Group, NativeSelect, Stack, Textarea, TextInput } from '@mantine/core';
import type { Evidence } from './api';
export function EvidenceEditor({ label, value, onChange, disabled }: { label: string; value: Evidence; onChange: (e: Evidence) => void; disabled: boolean }) {
  return <Stack gap="xs"><NativeSelect label={`${label} evidence status`} value={value.status} disabled={disabled} data={[{ value: "unknown", label: "Unknown" }, { value: "unverified_citation", label: "Unverified citation" }, { value: "registered_file", label: "Exact registered source file" }]} onChange={(e) => onChange({ status: e.currentTarget.value as Evidence["status"] })} />
    {value.status === "unverified_citation" && <Textarea label={`${label} citation`} value={value.citation ?? ""} disabled={disabled} onChange={(e) => onChange({ ...value, citation: e.currentTarget.value })} />}
    {value.status === "registered_file" && <Group grow><TextInput label={`${label} source bundle revision ID`} value={value.source_bundle_revision_id ?? ""} disabled={disabled} onChange={(e) => onChange({ ...value, source_bundle_revision_id: e.currentTarget.value })} /><TextInput label={`${label} exact source path`} value={value.source_path ?? ""} disabled={disabled} onChange={(e) => onChange({ ...value, source_path: e.currentTarget.value })} /></Group>}
  </Stack>;
}
