import { Alert, Button, Card, Group, NativeSelect, Stack, Text, TextInput, Title } from "@mantine/core";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import type { Definition, Identity } from "../identity/api";
import { read, type Detail, type Submit, type WorkBatch, type WorkDetail } from "./api";

const quantityUnits: Record<string, string[]> = { count: ["ea"], length: ["m", "cm", "mm"], mass: ["kg", "g"] };
const statuses = ["declared", "observed", "measured"];
const positiveCount = (value: string) => /^\d+$/.test(value) && Number.isSafeInteger(Number(value)) && Number(value) > 0 && Number(value) <= 1000000;

function useWork(id: string, offset = 0) {
  return useQuery({ queryKey: ["inventory-work", id, offset], enabled: !!id,
    queryFn: () => read<WorkDetail>(`inventory/work-batches/${id}?offset=${offset}&limit=50`) });
}

export function WorkPanel({ projectId, batches, pending, submit }: { projectId: string; batches: WorkBatch[]; pending: boolean; submit: Submit }) {
  const [definition, setDefinition] = useState("");
  const [revision, setRevision] = useState("");
  const [revisionOffset, setRevisionOffset] = useState(0);
  const [kind, setKind] = useState("batch");
  const [label, setLabel] = useState("");
  const [planned, setPlanned] = useState("");
  const [selected, setSelected] = useState("");
  const definitions = useQuery({ queryKey: ["identity-definitions", projectId], queryFn: () => read<Definition[]>(`projects/${projectId}/definitions`) });
  const identity = useQuery({ queryKey: ["identity", definition, revisionOffset], enabled: !!definition, queryFn: () => read<Identity>(`catalog/definitions/${definition}?offset=${revisionOffset}`) });
  return <Card withBorder><Stack>
    <Title order={3}>Planned jobs and batches</Title>
    <Text size="sm">Pin intended work to an exact frozen revision. Material usage and reported completion counts remain separate. Actual subjects can be linked to this plan in Physical units; neither record establishes qualification.</Text>
    {definitions.isError && <Alert color="red">{definitions.error.message}</Alert>}
    {identity.isError && <Alert color="red">{identity.error.message}</Alert>}
    <NativeSelect label="Work target definition" value={definition} onChange={(e) => { setDefinition(e.currentTarget.value); setRevision(""); setRevisionOffset(0); }} data={[{ value: "", label: "Choose definition" }, ...(definitions.data ?? []).map((d) => ({ value: d.definition_id, label: d.name }))]} />
    <NativeSelect label="Work target exact revision" value={revision} onChange={(e) => setRevision(e.currentTarget.value)} data={[{ value: "", label: "Choose frozen revision" }, ...(identity.data?.revisions ?? []).map((r) => ({ value: r.revision_id, label: `Revision ${r.number} · ${r.revision_id}` }))]} />
    {definition && <Group><Button disabled={revisionOffset === 0} onClick={() => { setRevision(""); setRevisionOffset(Math.max(0, revisionOffset - 50)); }}>Previous work revisions</Button><Button disabled={(identity.data?.revisions.length ?? 0) < 50} onClick={() => { setRevision(""); setRevisionOffset(revisionOffset + 50); }}>Next work revisions</Button></Group>}
    <NativeSelect label="Work kind" value={kind} onChange={(e) => setKind(e.currentTarget.value)} data={["job", "batch"]} />
    <TextInput label="Work label" value={label} onChange={(e) => setLabel(e.currentTarget.value)} />
    <TextInput label="Planned unit count (blank means unknown)" value={planned} onChange={(e) => setPlanned(e.currentTarget.value)} />
    <Button loading={pending} disabled={!revision || !label.trim() || (!!planned && !positiveCount(planned))} onClick={() => submit("inventory.create_work_batch", { revision_id: revision, kind, label, planned_units: planned ? Number(planned) : null })}>Register planned work</Button>
    {batches.map((batch) => <Group key={batch.work_batch_id}><Text>{batch.label} · {batch.kind} · reported {batch.reported_completed_units} / {batch.planned_units ?? "Unknown planned count"} · {batch.progress}</Text><Button size="xs" onClick={() => setSelected(batch.work_batch_id)}>Inspect work {batch.label}</Button></Group>)}
    {selected && <WorkHistory key={selected} workId={selected} pending={pending} submit={submit} />}
  </Stack></Card>;
}

function WorkHistory({ workId, pending, submit }: { workId: string; pending: boolean; submit: Submit }) {
  const [offset, setOffset] = useState(0);
  const work = useWork(workId, offset);
  const [count, setCount] = useState("");
  const [reason, setReason] = useState("");
  const [source, setSource] = useState("");
  const [status, setStatus] = useState("declared");
  const batch = work.data?.work_batch;
  return <Stack>
    {work.isError && <Alert color="red">{work.error.message}</Alert>}
    {batch && <>
      <Text>Work target revision: {batch.revision_id}. Reported {batch.reported_completed_units}; planned {batch.planned_units ?? "Unknown"}.</Text>
      <TextInput label="Additional reported completed units" value={count} onChange={(e) => setCount(e.currentTarget.value)} />
      <TextInput label="Completion reason" value={reason} onChange={(e) => setReason(e.currentTarget.value)} />
      <TextInput label="Completion assertion source" value={source} onChange={(e) => setSource(e.currentTarget.value)} />
      <NativeSelect label="Completion assertion status" value={status} onChange={(e) => setStatus(e.currentTarget.value)} data={statuses} />
      <Button loading={pending} disabled={!positiveCount(count) || !reason.trim() || !source.trim()} onClick={() => submit("inventory.record_work_completion", { work_batch_id: workId, units_completed: Number(count), reason, assertion_source: source, assertion_status: status }, batch.state)}>Record partial completion</Button>
      <Title order={4}>Work assertions</Title>
      {work.data!.completions.map((c) => <Text key={c.completion_id}>{c.units_completed} reported units · {c.reason} · {c.assertion_status}: {c.assertion_source} · {new Date(c.created_at).toLocaleString()}</Text>)}
      <Title order={4}>Material usage</Title>
      {work.data!.usage.map((entry) => <Text key={entry.entry_id}>{entry.kind}: {entry.amount} {entry.unit} · {entry.reason} · {entry.assertion_status}: {entry.assertion_source}{entry.consumption_origin_id ? ` · return of ${entry.consumption_origin_id}` : ""}</Text>)}
      <Group><Button disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - 50))}>Previous work history</Button><Button disabled={Math.max(work.data!.usage.length, work.data!.completions.length) < 50} onClick={() => setOffset(offset + 50)}>Next work history</Button></Group>
    </>}
  </Stack>;
}

export function UsageForm({ detail, batches, pending, submit }: { detail: Detail; batches: WorkBatch[]; pending: boolean; submit: Submit }) {
  const [action, setAction] = useState("consume");
  const [reservation, setReservation] = useState("");
  const [workId, setWorkId] = useState("");
  const [origin, setOrigin] = useState("");
  const [amount, setAmount] = useState("");
  const [unit, setUnit] = useState(detail.account.unit);
  const [remainder, setRemainder] = useState("retain");
  const [reason, setReason] = useState("");
  const [source, setSource] = useState("");
  const [status, setStatus] = useState("declared");
  const [physicalUnitId, setPhysicalUnitId] = useState("");
  const [unitOffset, setUnitOffset] = useState(0);
  const consumption = detail.entries.find((entry) => entry.entry_id === origin && entry.kind === "consumption");
  const target = action === "consume" ? workId : consumption?.work_batch_id ?? "";
  const work = useWork(target);
  const batch = work.data?.work_batch;
  const linkedUnits = useQuery({ queryKey: ["physical-work-units", target, unitOffset], enabled: action === "consume" && !!target,
    queryFn: () => read<{ units: { unit_id: string; serial: string }[]; linked_unit_count: number }>(`physical-units/work-batches/${target}?offset=${unitOffset}&limit=50`) });
  return <Stack>
    <Title order={4}>Consume and return material</Title>
    <Text size="sm">Consumption reduces physical and reserved balances together. A return restores on-hand stock only, never a closed reservation. The selected work target does not imply BOM compatibility with this lot.</Text>
    <NativeSelect label="Material usage operation" value={action} onChange={(e) => setAction(e.currentTarget.value)} data={[{ value: "consume", label: "Consume reserved material" }, { value: "return_unused", label: "Return unused issued material" }]} />
    {action === "consume" ? <>
      <NativeSelect label="Reservation to consume" value={reservation} onChange={(e) => setReservation(e.currentTarget.value)} data={[{ value: "", label: "Choose active reservation" }, ...detail.reservations.filter((r) => r.status === "active").map((r) => ({ value: r.reservation_id, label: `${r.purpose} · remaining ${r.remaining_quantity ?? r.amount} ${detail.account.unit}` }))]} />
      <NativeSelect label="Material work target" value={workId} onChange={(e) => { setWorkId(e.currentTarget.value); setPhysicalUnitId(""); setUnitOffset(0); }} data={[{ value: "", label: "Choose registered work" }, ...batches.map((b) => ({ value: b.work_batch_id, label: `${b.label} · ${b.revision_id}` }))]} />
      <NativeSelect label="Usage attribution" value={physicalUnitId} onChange={(e) => setPhysicalUnitId(e.currentTarget.value)} data={[{ value: "", label: "Batch usage; no individual unit asserted" }, ...(linkedUnits.data?.units ?? []).map((u) => ({ value: u.unit_id, label: `Unit ${u.serial}` }))]} />
      {linkedUnits.isError && <Alert color="red">{linkedUnits.error.message}</Alert>}
      {target && <Group><Button disabled={unitOffset === 0} onClick={() => { setUnitOffset(Math.max(0, unitOffset - 50)); setPhysicalUnitId(""); }}>Previous linked units</Button><Button disabled={(linkedUnits.data?.units.length ?? 0) < 50} onClick={() => { setUnitOffset(unitOffset + 50); setPhysicalUnitId(""); }}>Next linked units</Button></Group>}
      <NativeSelect label="Unused reservation remainder" value={remainder} onChange={(e) => setRemainder(e.currentTarget.value)} data={[{ value: "retain", label: "Retain reservation" }, { value: "release", label: "Release reservation remainder" }]} />
    </> : <><NativeSelect label="Original consumption" value={origin} onChange={(e) => setOrigin(e.currentTarget.value)} data={[{ value: "", label: "Choose issued material" }, ...detail.entries.filter((entry) => entry.kind === "consumption" && entry.returnable_quantity && entry.returnable_quantity !== "0").map((entry) => ({ value: entry.entry_id, label: `${entry.entry_id} · returnable ${entry.returnable_quantity} ${detail.account.unit}` }))]} />{consumption && <Text size="sm">Return keeps original attribution: {consumption.physical_unit_id ? `unit ${consumption.physical_unit_id}` : "batch usage without a unit"}.</Text>}</>}
    {work.isError && <Alert color="red">{work.error.message}</Alert>}
    {batch && <Text size="sm">Exact work revision: {batch.revision_id}</Text>}
    <TextInput label="Material usage quantity" value={amount} onChange={(e) => setAmount(e.currentTarget.value)} />
    <NativeSelect label="Material usage unit" value={unit} onChange={(e) => setUnit(e.currentTarget.value)} data={quantityUnits[detail.account.dimension]} />
    <TextInput label="Material usage reason" value={reason} onChange={(e) => setReason(e.currentTarget.value)} />
    <TextInput label="Material assertion source" value={source} onChange={(e) => setSource(e.currentTarget.value)} />
    <NativeSelect label="Material assertion status" value={status} onChange={(e) => setStatus(e.currentTarget.value)} data={statuses} />
    <Button loading={pending} disabled={!batch || work.isError || (action === "consume" && linkedUnits.isError) || !amount.trim() || !reason.trim() || !source.trim() || (action === "consume" ? !reservation : !consumption)} onClick={() => submit(`inventory.${action}`, { quantity: { amount, unit }, reason, assertion_source: source, assertion_status: status, expected_work_state: batch!.state, ...(action === "consume" ? { reservation_id: reservation, work_batch_id: target, physical_unit_id: physicalUnitId || null, remainder } : { consumption_id: origin }) }, detail.account.state)}>Apply material usage</Button>
  </Stack>;
}
