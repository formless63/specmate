import { Alert, Button, Group, Select, Stack, Text, TextInput, Textarea, Title } from "@mantine/core";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { InspectionScope, ReadOnlyNote, usePermission } from "../../lib/permissions";
import { randomUUID } from "../../lib/random-id";
import { read, recordSubjectTest, type SubjectTestInput, type TestCalibration, type TestCondition } from "./api";

type Unit = { unit_id: string; serial: string; revision_id: string };
type Batch = { work_batch_id: string; label: string; revision_id: string };
const KEY = /^[a-z][a-z0-9_]{0,79}$/;

/** Builds the command body, or the reason the record is incomplete. Unknown stays unknown. */
export function buildSubjectTest(form: Record<string, string>, conditions: TestCondition[]): SubjectTestInput | string {
  if (!form.subject) return "Choose the exact unit or batch that was tested.";
  if (!KEY.test(form.test_kind ?? "")) return "Test kind is a lowercase key such as continuity.";
  if (!form.procedure?.trim() || !form.criterion?.trim() || !form.instrument?.trim()) return "Procedure, instrument and criterion are required.";
  if (!form.finding) return "Choose a finding; inconclusive is a valid finding.";
  const at = new Date(form.observed_at ?? "");
  if (Number.isNaN(at.getTime())) return "Observation time is required.";
  if (form.calibration === "calibrated" && !form.calibration_reference?.trim()) return "A calibrated instrument needs a calibration reference.";
  const sample = form.sample_size?.trim() ? Number(form.sample_size) : undefined;
  if (sample !== undefined && (!Number.isInteger(sample) || sample < 1)) return "Sample size is a whole number of units, or left empty when unknown.";
  const calibration = (form.calibration || "unknown") as TestCalibration;
  return {
    subject: form.kind === "work_batch" ? { kind: "work_batch", work_batch_id: form.subject, ...(sample ? { sample_size: sample } : {}) } : { kind: "physical_unit", unit_id: form.subject },
    ...(form.configuration_id?.trim() ? { configuration_id: form.configuration_id.trim() } : {}),
    test_kind: form.test_kind ?? "", procedure: form.procedure.trim(), criterion: form.criterion.trim(),
    instruments: [{ name: form.instrument.trim(), ...(form.identifier?.trim() ? { identifier: form.identifier.trim() } : {}), calibration, ...(calibration === "calibrated" ? { calibration_reference: (form.calibration_reference ?? "").trim() } : {}) }],
    conditions, observed_at: at.toISOString(), finding: form.finding as SubjectTestInput["finding"], ...(form.summary?.trim() ? { summary: form.summary.trim() } : {}),
  };
}

export function SubjectTestForm({ workspaceId }: { workspaceId: string }) {
  const gate = usePermission("inventory.manage");
  const cache = useQueryClient();
  const [form, setForm] = useState<Record<string, string>>({ kind: "physical_unit", calibration: "unknown" });
  const [conditions, setConditions] = useState<TestCondition[]>([]);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const attempt = useRef<{ body: string; key: string } | null>(null);
  const units = useQuery({ queryKey: ["evidence-test-units", workspaceId], queryFn: () => read<{ units: Unit[] }>(`physical-units/workspaces/${workspaceId}?offset=0&limit=50`) });
  const batches = useQuery({ queryKey: ["evidence-test-batches", workspaceId], queryFn: () => read<{ work_batches?: Batch[] }>(`inventory/workspaces/${workspaceId}?offset=0&limit=50`) });
  const set = (name: string) => (value: string | null) => setForm((current) => ({ ...current, [name]: value ?? "", ...(name === "kind" ? { subject: "" } : {}) }));
  const input = (name: string, label: string, props: object = {}) => <TextInput label={label} value={form[name] ?? ""} onChange={(event) => set(name)(event.currentTarget.value)} {...props} />;
  const data = form.kind === "work_batch"
    ? (batches.data?.work_batches ?? []).map((b) => ({ value: b.work_batch_id, label: `${b.label} · revision ${b.revision_id}` }))
    : (units.data?.units ?? []).map((u) => ({ value: u.unit_id, label: `${u.serial} · revision ${u.revision_id}` }));
  async function submit() {
    const body = buildSubjectTest(form, conditions);
    if (typeof body === "string") { setMessage({ ok: false, text: body }); return; }
    const text = JSON.stringify(body);
    if (attempt.current?.body !== text) attempt.current = { body: text, key: randomUUID() };
    setBusy(true); setMessage(null);
    try {
      const saved = await recordSubjectTest(body, attempt.current.key);
      setMessage({ ok: true, text: `Recorded test ${saved.test_id} at ${saved.recorded_at}. It applies to this subject only and is not qualification.` });
      void cache.invalidateQueries({ queryKey: ["evidence"] });
    } catch (failure) { setMessage({ ok: false, text: (failure as Error).message }); } finally { setBusy(false); }
  }
  return <Stack gap="xs">
    <Title order={3}>Record a test on an actual subject</Title>
    <Text size="sm">Names the procedure, instruments, conditions and the exact unit or batch tested. A test of one unit says nothing about another unit of the same revision, and a batch test says nothing about its individual units.</Text>
    <InspectionScope permission="inventory.manage">
      <Group align="flex-end" grow>
        <Select label="Subject kind" allowDeselect={false} data={[{ value: "physical_unit", label: "Physical unit" }, { value: "work_batch", label: "Work batch (as a whole)" }]} value={form.kind} onChange={set("kind")} />
        <Select label={form.kind === "work_batch" ? "Tested work batch" : "Tested unit"} searchable data={data} value={form.subject || null} onChange={set("subject")} />
        {form.kind === "work_batch" && input("sample_size", "Units tested (empty = unknown)")}
        {input("configuration_id", "Resolved configuration id (empty = unknown)")}
      </Group>
      <Group align="flex-end" grow>
        {input("test_kind", "Test kind", { placeholder: "continuity" })}
        {input("observed_at", "Observed at", { type: "datetime-local" })}
        <Select label="Finding" data={[{ value: "criterion_met", label: "Criterion met" }, { value: "criterion_not_met", label: "Criterion not met" }, { value: "inconclusive", label: "Inconclusive" }]} value={form.finding || null} onChange={set("finding")} />
      </Group>
      <Textarea label="Procedure" rows={2} value={form.procedure ?? ""} onChange={(event) => set("procedure")(event.currentTarget.value)} />
      <Textarea label="Criterion the finding is judged against" rows={1} value={form.criterion ?? ""} onChange={(event) => set("criterion")(event.currentTarget.value)} />
      <Group align="flex-end" grow>
        {input("instrument", "Instrument")}{input("identifier", "Instrument identifier")}
        <Select label="Calibration" allowDeselect={false} data={[{ value: "unknown", label: "Unknown" }, { value: "calibrated", label: "Calibrated" }, { value: "uncalibrated", label: "Uncalibrated" }]} value={form.calibration} onChange={set("calibration")} />
        {form.calibration === "calibrated" && input("calibration_reference", "Calibration reference")}
      </Group>
      {conditions.map((condition, index) => <Group key={index} align="flex-end" grow>
        <TextInput label="Condition" placeholder="ambient_temperature" value={condition.property} onChange={(event) => setConditions(conditions.map((c, i) => i === index ? { ...c, property: event.currentTarget.value } : c))} />
        <Select label="Condition status" allowDeselect={false} data={[{ value: "known", label: "Known" }, { value: "unknown", label: "Unknown" }]} value={condition.status} onChange={(value) => setConditions(conditions.map((c, i) => i === index ? (value === "known" ? { property: c.property, status: "known", value: { kind: "text", text: "" } } : { property: c.property, status: "unknown" }) : c))} />
        {condition.status === "known" && <TextInput label="Condition value" value={condition.value?.text ?? ""} onChange={(event) => setConditions(conditions.map((c, i) => i === index ? { ...c, value: { kind: "text", text: event.currentTarget.value } } : c))} />}
        <Button variant="quiet" onClick={() => setConditions(conditions.filter((_, i) => i !== index))}>Remove condition</Button>
      </Group>)}
      <Button variant="quiet" onClick={() => setConditions([...conditions, { property: "", status: "unknown" }])}>Add condition</Button>
      {input("summary", "Observed result summary (optional)")}
    </InspectionScope>
    <Group><Button loading={busy} onClick={() => { void submit(); }} {...gate.props}>Record test</Button><ReadOnlyNote permission="inventory.manage">Recording tests is unavailable.</ReadOnlyNote></Group>
    {message && <Alert color={message.ok ? "green" : "red"}>{message.text}</Alert>}
  </Stack>;
}
