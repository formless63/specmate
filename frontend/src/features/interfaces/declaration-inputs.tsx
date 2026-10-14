import { Group, NumberInput, Select, Stack, TextInput } from "@mantine/core";
import { useEffect, useRef, useState } from "react";
import type { Evidence } from "./assessment-api";

/** Keep decimal points and signs while editing; persisted inputs remain finite numbers or null. */
export function OperatingNumberInput({ value, onChange, ...props }: { label: string; min?: number; max?: number; disabled?: boolean; value: number | string; onChange: (value: number | null) => void }) {
  const numeric = typeof value === "number" ? value : null;
  const [input, setInput] = useState<number | string>(value);
  const reported = useRef<number | null>(numeric);
  useEffect(() => {
    if (!Object.is(numeric, reported.current)) {
      reported.current = numeric;
      setInput(numeric ?? "");
    }
  }, [numeric]);
  return <NumberInput {...props} value={input} onChange={raw => {
    setInput(raw);
    const parsed = raw === "" ? null : typeof raw === "number" ? raw : Number(raw);
    const next = parsed !== null && Number.isFinite(parsed) ? parsed : null;
    reported.current = next;
    onChange(next);
  }} />;
}

export function EvidenceEditor({ label, value, onChange }: { label: string; value: Evidence; onChange: (value: Evidence) => void }) {
  return <Stack gap="xs"><Select label={`${label} evidence`} value={value.status} data={[{ value: "unknown", label: "Unknown" }, { value: "unverified_citation", label: "Unverified citation" }, { value: "registered_file", label: "Exact registered file" }]} onChange={status => onChange({ status: status as Evidence["status"] })} />
    {value.status === "unverified_citation" && <TextInput label={`${label} citation`} value={value.citation ?? ""} onChange={e => onChange({ ...value, citation: e.currentTarget.value })} />}
    {value.status === "registered_file" && <Group><TextInput label={`${label} evidence bundle revision`} value={value.source_bundle_revision_id ?? ""} onChange={e => onChange({ ...value, source_bundle_revision_id: e.currentTarget.value })} /><TextInput label={`${label} evidence file path`} value={value.source_path ?? ""} onChange={e => onChange({ ...value, source_path: e.currentTarget.value })} /></Group>}
  </Stack>;
}
