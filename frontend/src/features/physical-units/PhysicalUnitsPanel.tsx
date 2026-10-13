import { Alert, Button, Card, Group, NativeSelect, Stack, Text, TextInput, Title } from "@mantine/core";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import type { Catalog, Definition, Identity } from "../identity/api";
import { read } from "../identity/api";
import { command, request, type Command, type Inventory, type WorkBatch } from "../inventory/api";

type Unit = {
  unit_id: string; project_id: string; revision_id: string; serial: string;
  origin: "obtained" | "assembled"; lot_id: string | null; variant_id: string | null;
  assertion_source: string; assertion_status: string; work_batch_id: string | null;
  physical_qualification: false;
};
type UnitPage = { units: Unit[]; offset: number; limit: number };
type WorkUnits = { work_batch: WorkBatch; linked_unit_count: number; units: Unit[] };
type UnitDetail = { unit: Unit; work_link: { assertion_source: string; assertion_status: string } | null;
  usage: { entry_id: string; kind: string; amount: string; unit: string; reason: string }[] };

export function PhysicalUnitsPanel({ projectId }: { projectId: string }) {
  const cache = useQueryClient();
  const [offset, setOffset] = useState(0);
  const [definitionId, setDefinitionId] = useState("");
  const [revisionId, setRevisionId] = useState("");
  const [revisionOffset, setRevisionOffset] = useState(0);
  const [serial, setSerial] = useState("");
  const [origin, setOrigin] = useState("assembled");
  const [lotId, setLotId] = useState("");
  const [variantId, setVariantId] = useState("");
  const [source, setSource] = useState("");
  const [status, setStatus] = useState("declared");
  const [selectedUnit, setSelectedUnit] = useState("");
  const [usageOffset, setUsageOffset] = useState(0);
  const [selectedWork, setSelectedWork] = useState("");
  const [linkSource, setLinkSource] = useState("");
  const [linkStatus, setLinkStatus] = useState("declared");
  const [pendingRequest, setPendingRequest] = useState<Command | null>(null);
  const definitions = useQuery({ queryKey: ["identity-definitions", projectId], queryFn: () => read<Definition[]>(`projects/${projectId}/definitions`) });
  const identity = useQuery({ queryKey: ["identity", definitionId, revisionOffset], enabled: !!definitionId,
    queryFn: () => read<Identity>(`catalog/definitions/${definitionId}?offset=${revisionOffset}&limit=50`) });
  const catalog = useQuery({ queryKey: ["physical-catalog", revisionId], enabled: !!revisionId,
    queryFn: () => read<Catalog>(`catalog/revisions/${revisionId}`) });
  const units = useQuery({ queryKey: ["physical-units", projectId, offset],
    queryFn: () => read<UnitPage>(`physical-units/projects/${projectId}?offset=${offset}&limit=50`) });
  const inventory = useQuery({ queryKey: ["inventory", projectId, 0],
    queryFn: () => read<Inventory>(`inventory/projects/${projectId}?offset=0&limit=50`) });
  const selected = units.data?.units.find((unit) => unit.unit_id === selectedUnit);
  const exactWork = (inventory.data?.work_batches ?? []).filter((work) => work.revision_id === selected?.revision_id);
  const work = exactWork.find((batch) => batch.work_batch_id === selectedWork);
  const workUnits = useQuery({ queryKey: ["physical-work-units", selectedWork], enabled: !!selectedWork,
    queryFn: () => read<WorkUnits>(`physical-units/work-batches/${selectedWork}`) });
  const detail = useQuery({ queryKey: ["physical-unit", selectedUnit, usageOffset], enabled: !!selectedUnit,
    queryFn: () => read<UnitDetail>(`physical-units/units/${selectedUnit}?offset=${usageOffset}&limit=50`) });
  const mutation = useMutation({ mutationFn: command, onSuccess: async () => {
    setPendingRequest(null);
    await cache.invalidateQueries({ queryKey: ["physical-units", projectId] });
    await cache.invalidateQueries({ queryKey: ["physical-unit"] });
    await cache.invalidateQueries({ queryKey: ["physical-work-units"] });
    await cache.invalidateQueries({ queryKey: ["inventory", projectId] });
  }, onError: async () => {
    await cache.invalidateQueries({ queryKey: ["physical-units", projectId] });
    await cache.invalidateQueries({ queryKey: ["inventory", projectId] });
  } });
  function submit(operation: string, payload: object, state?: string) {
    const envelope = request(operation, payload, state);
    setPendingRequest(envelope);
    mutation.mutate(envelope);
  }
  const failure = [definitions, identity, catalog, units, inventory, detail, workUnits].find((query) => query.isError);
  return <Stack>
    <Title order={2}>Physical units</Title>
    <Text>Record an actual obtained or assembled subject at one exact design revision. Its serial is unique within this project. A physical lot identifies an actual batch; a work link associates the unit with a plan. Neither record reports completion, changes stock, or qualifies the unit.</Text>
    {failure?.error && <Alert color="red">{failure.error.message}</Alert>}
    {mutation.isError && <Alert color="red"><Stack><Text>{mutation.error.message}</Text>{pendingRequest && <Button loading={mutation.isPending} onClick={() => mutation.mutate(pendingRequest)}>Retry same request</Button>}</Stack></Alert>}
    {mutation.isSuccess && <Alert color="green">Physical record saved.</Alert>}
    <Card withBorder><Stack>
      <Title order={3}>Register actual unit</Title>
      <NativeSelect label="Definition" value={definitionId} onChange={(e) => { setDefinitionId(e.currentTarget.value); setRevisionId(""); setLotId(""); setVariantId(""); setRevisionOffset(0); }}
        data={[{ value: "", label: "Choose definition" }, ...(definitions.data ?? []).map((d) => ({ value: d.definition_id, label: d.name }))]} />
      <NativeSelect label="Exact frozen revision" value={revisionId} onChange={(e) => { setRevisionId(e.currentTarget.value); setLotId(""); setVariantId(""); }}
        data={[{ value: "", label: "Choose revision" }, ...(identity.data?.revisions ?? []).map((r) => ({ value: r.revision_id, label: `Revision ${r.number} · ${r.revision_id}` }))]} />
      {definitionId && <Group><Button disabled={revisionOffset === 0} onClick={() => setRevisionOffset(Math.max(0, revisionOffset - 50))}>Previous revisions</Button><Button disabled={(identity.data?.revisions.length ?? 0) < 50} onClick={() => setRevisionOffset(revisionOffset + 50)}>Next revisions</Button></Group>}
      <TextInput label="Unit serial" value={serial} onChange={(e) => setSerial(e.currentTarget.value)} />
      <NativeSelect label="Actual origin" value={origin} onChange={(e) => setOrigin(e.currentTarget.value)} data={["obtained", "assembled"]} />
      <NativeSelect label="Actual physical lot (optional)" value={lotId} onChange={(e) => setLotId(e.currentTarget.value)}
        data={[{ value: "", label: "No lot asserted" }, ...(catalog.data?.lots ?? []).map((lot) => ({ value: lot.lot_id, label: lot.label }))]} />
      <NativeSelect label="Manufacturer variant (optional)" value={variantId} onChange={(e) => setVariantId(e.currentTarget.value)}
        data={[{ value: "", label: "No variant asserted" }, ...(catalog.data?.variants ?? []).filter((variant) => !lotId || !catalog.data?.lots.find((lot) => lot.lot_id === lotId)?.variant_id || catalog.data?.lots.find((lot) => lot.lot_id === lotId)?.variant_id === variant.variant_id).map((variant) => ({ value: variant.variant_id, label: `${variant.manufacturer} ${variant.part_number}` }))]} />
      <TextInput label="Assertion source" value={source} onChange={(e) => setSource(e.currentTarget.value)} />
      <NativeSelect label="Assertion status" value={status} onChange={(e) => setStatus(e.currentTarget.value)} data={["declared", "observed", "measured"]} />
      <Button loading={mutation.isPending} disabled={!revisionId || !serial.trim() || !source.trim()} onClick={() => submit("physical_units.register", {
        revision_id: revisionId, serial, origin, lot_id: lotId || null, variant_id: variantId || null,
        assertion_source: source, assertion_status: status,
      })}>Register unit</Button>
    </Stack></Card>
    <Card withBorder><Stack>
      <Title order={3}>Actual subjects</Title>
      {(units.data?.units ?? []).map((unit) => <Group key={unit.unit_id}><Text>{unit.serial} · {unit.origin} · revision {unit.revision_id} · {unit.work_batch_id ? "linked to work" : "no work link"}</Text><Button size="xs" onClick={() => { setSelectedUnit(unit.unit_id); setSelectedWork(""); setUsageOffset(0); }}>Inspect</Button></Group>)}
      <Group><Button disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - 50))}>Previous units</Button><Text>Page {offset / 50 + 1}</Text><Button disabled={(units.data?.units.length ?? 0) < 50} onClick={() => setOffset(offset + 50)}>Next units</Button></Group>
      {selected && <Stack>
        <Title order={4}>{selected.serial}</Title>
        <Text>Assertion: {selected.assertion_status} · {selected.assertion_source}. Lot: {selected.lot_id ?? "Unspecified"}. Qualification: not established.</Text>
        {!selected.work_batch_id && <>
          <NativeSelect label="Exact planned work" value={selectedWork} onChange={(e) => setSelectedWork(e.currentTarget.value)}
            data={[{ value: "", label: "Choose planned work" }, ...exactWork.map((batch) => ({ value: batch.work_batch_id, label: `${batch.label} · ${batch.work_batch_id}` }))]} />
          <TextInput label="Work link assertion source" value={linkSource} onChange={(e) => setLinkSource(e.currentTarget.value)} />
          <NativeSelect label="Work link assertion status" value={linkStatus} onChange={(e) => setLinkStatus(e.currentTarget.value)} data={["declared", "observed", "measured"]} />
          {workUnits.data && <Text>Planned {workUnits.data.work_batch.planned_units ?? "unknown"}; reported complete {workUnits.data.work_batch.reported_completed_units}; actual linked units {workUnits.data.linked_unit_count}.</Text>}
          <Button loading={mutation.isPending} disabled={!work || !linkSource.trim()} onClick={() => submit("physical_units.link_work", {
            unit_id: selected.unit_id, work_batch_id: selectedWork,
            assertion_source: linkSource, assertion_status: linkStatus,
          }, work?.state)}>Link actual unit to planned work</Button>
        </>}
        {selected.work_batch_id && <Text>Linked planned work: {selected.work_batch_id}. Reported completions remain separate.</Text>}
        {detail.data && <><Title order={4}>Attributed material usage</Title>{detail.data.usage.length === 0 && <Text>No material usage on this page.</Text>}{detail.data.usage.map((entry) => <Text key={entry.entry_id}>{entry.kind}: {entry.amount} {entry.unit} · {entry.reason}</Text>)}<Group><Button disabled={usageOffset === 0} onClick={() => setUsageOffset(Math.max(0, usageOffset - 50))}>Previous usage</Button><Button disabled={detail.data.usage.length < 50} onClick={() => setUsageOffset(usageOffset + 50)}>Next usage</Button></Group></>}
      </Stack>}
    </Stack></Card>
  </Stack>;
}
