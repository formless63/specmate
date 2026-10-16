import { DefinitionSelect } from '../../components/library/DefinitionSelect';
import { Alert, Card, Checkbox, Group, NumberInput, Select, Stack, Table, Text, TextInput, Title } from "@mantine/core";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { SbStatus, SbUnknown } from "../../components/sb";
import { RevisionLabel } from "../../lib/IdentityLabel";
import { revisionOptionLabel, newestFirst } from "../../lib/revision-labels";
import { CONDITIONING, read, unknownPortPin, type CableEnd, type DeclaredQuantity, type Definition, type EndRow, type Identity, type Inspection, type Pinout, type PinoutRole, type Port, type PortPin } from "./api";
import { DeclaredValue, SignalTypeChip } from "./SignalSetPanel";
import "./signals.css";
import { BEHAVIOR, COUPLING, NEED_LABELS, PortWorkbench, TERMINATION } from "../pinout-editor/PortWorkbench";
import type { WorkbenchMode } from "../pinout-editor/PinoutWorkbench";
import { useLatestRevisionDefault } from '../../lib/useLatestRevisionDefault';

const ROLES: { value: PinoutRole; label: string }[] = [
  { value: "unknown", label: "Role unknown" }, { value: "source", label: "Source" }, { value: "sink", label: "Sink" }, { value: "bidirectional", label: "Bidirectional" },
];
export function PortEditor({ value, onChange, definitions, mode = "draft" }: { value: Port; onChange: (v: Port) => void; definitions?: Definition[]; mode?: WorkbenchMode }) {
  const [variantDefinition, setVariantDefinition] = useState<string | null>(null);
  const identity = useQuery({ queryKey: ["port-variant-identity", variantDefinition], queryFn: () => read<Identity>(`catalog/definitions/${variantDefinition}`), enabled: !!variantDefinition });
  useLatestRevisionDefault(variantDefinition, identity.isError ? undefined : identity.data, (identity.data?.revisions.length ?? 50) < 50, value.pinout_revision_id, (id) => onChange({ ...value, pinout_revision_id: id, selected_conditions: {} }));
  const variant = useQuery({ queryKey: ["interface-inspect", value.pinout_revision_id], queryFn: () => read<Inspection>(`interfaces/revisions/${value.pinout_revision_id}`), enabled: !!value.pinout_revision_id });
  const end = useQuery({ queryKey: ["interface-end", value.pinout_revision_id], queryFn: () => read<CableEnd>(`interfaces/revisions/${value.pinout_revision_id}/end`), enabled: !!value.pinout_revision_id });
  const pinout = variant.data?.interface.kind === "pinout" ? variant.data.interface as Pinout : null;
  const pin = (contactId: string) => value.pins.find((p) => p.contact_id === contactId);
  const put = (contactId: string, patch: Partial<PortPin>) => {
    const current = pin(contactId) ?? unknownPortPin(contactId);
    const next = { ...current, ...patch };
    const order = new Map((end.data?.rows ?? []).map((r, i) => [r.contact_id, i]));
    onChange({ ...value, pins: [...value.pins.filter((p) => p.contact_id !== contactId), next].sort((a, b) => (order.get(a.contact_id) ?? 1e9) - (order.get(b.contact_id) ?? 1e9)) });
  };
  return <Stack gap="xs">
    <Group align="end">
      <TextInput label="Device" description="The device this socket or plug belongs to" value={value.device_label} onChange={(e) => onChange({ ...value, device_label: e.currentTarget.value })} />
      <Select label="Port role" value={value.role} data={ROLES} onChange={(v) => onChange({ ...value, role: (v ?? "unknown") as PinoutRole })} />
    </Group>
    <Group align="end">
      <DefinitionSelect label="Pinout variant" kind="pinout" definitions={definitions} value={variantDefinition} onChange={setVariantDefinition} />
      {identity.data && <Select label="Pinout variant revision" value={value.pinout_revision_id || null} onChange={(v) => onChange({ ...value, pinout_revision_id: v ?? "", selected_conditions: {} })} data={newestFirst(identity.data.revisions).map((r) => ({ value: r.revision_id, label: revisionOptionLabel(identity.data.name, r.number) }))} />}
      {value.pinout_revision_id && <Text size="xs"><RevisionLabel id={value.pinout_revision_id} role="Variant" /></Text>}
    </Group>
    {variant.isError && <Alert color="red">{variant.error.message}</Alert>}
    {pinout && <Text size="sm">Variant {pinout.variant_label ?? "unnamed"} · {pinout.role === "unknown" || !pinout.role ? "role unknown" : pinout.role} · {pinout.standard ?? "standard not stated"}{pinout.role && pinout.role !== "unknown" && value.role !== "unknown" && value.role !== pinout.role ? " · port role contradicts the variant" : ""}</Text>}
    {(pinout?.conditions ?? []).map((c) => <Select key={c.key} label={c.name} placeholder="Not selected (pins depending on it stay unknown)" clearable value={value.selected_conditions[c.key] ?? null}
      data={c.choices.map((x) => ({ value: x.key, label: x.name }))} onChange={(choice) => {
        const next = { ...value.selected_conditions };
        if (choice) next[c.key] = choice; else delete next[c.key];
        onChange({ ...value, selected_conditions: next });
      }} />)}
    {end.data && <PortWorkbench value={value} onChange={onChange} mode={mode} table={<Table.ScrollContainer minWidth={1100}><Table withTableBorder verticalSpacing={4} className="sb-signal-table">
      <Table.Thead><Table.Tr><Table.Th>Contact</Table.Th><Table.Th>Signal</Table.Th><Table.Th>Device</Table.Th><Table.Th>Level</Table.Th><Table.Th>Unit</Table.Th><Table.Th>Impedance (ohm)</Table.Th><Table.Th>Coupling</Table.Th><Table.Th>Termination</Table.Th><Table.Th>Cable must add</Table.Th><Table.Th>Must not connect</Table.Th><Table.Th>Basis</Table.Th></Table.Tr></Table.Thead>
      <Table.Tbody>{end.data.rows.map((row) => {
        const p = pin(row.contact_id) ?? unknownPortPin(row.contact_id);
        const who = row.number ?? row.contact_id;
        const quantity = (q: DeclaredQuantity, nominal: number | null): DeclaredQuantity => nominal === null ? { status: "unknown", nominal: null, minimum: null, maximum: null, basis: null, unit: q.unit } : { ...q, status: "known", nominal, basis: p.basis };
        const need = p.needs_in_cable[0];
        return <Table.Tr key={row.contact_id}>
          <Table.Td className="sb-mono">{who}</Table.Td>
          <Table.Td><EndSignal row={{ ...row, ...conditionalRow(row, value.selected_conditions) }} /></Table.Td>
          <Table.Td><Select size="xs" aria-label={`Device behavior at contact ${who}`} value={p.behavior} data={BEHAVIOR} onChange={(v) => put(row.contact_id, { behavior: (v ?? "unknown") as PortPin["behavior"] })} /></Table.Td>
          <Table.Td><NumberInput size="xs" aria-label={`Level at contact ${who} (blank = unknown)`} placeholder="unknown" value={p.level.nominal ?? ""} onChange={(raw) => { const n = raw === "" ? null : Number(raw); put(row.contact_id, { level: { ...quantity(p.level, Number.isFinite(n) ? n : null), unit: n === null ? "unknown" : p.level.unit && p.level.unit !== "unknown" ? p.level.unit : "V" } }); }} /></Table.Td>
          <Table.Td><Select size="xs" aria-label={`Level unit at contact ${who}`} disabled={p.level.status !== "known"} placeholder="unknown" value={p.level.status === "known" ? p.level.unit ?? "V" : null} data={["V", "Vpp", "dBu", "dBV"]} onChange={(unit) => put(row.contact_id, { level: { ...p.level, unit: unit ?? "V" } })} /></Table.Td>
          <Table.Td><NumberInput size="xs" aria-label={`Impedance at contact ${who} (blank = unknown)`} placeholder="unknown" value={p.impedance.nominal ?? ""} onChange={(raw) => { const n = raw === "" ? null : Number(raw); put(row.contact_id, { impedance: { ...quantity(p.impedance, Number.isFinite(n) ? n : null), unit: "ohm" } }); }} /></Table.Td>
          <Table.Td><Select size="xs" aria-label={`Coupling at contact ${who}`} value={p.coupling} data={COUPLING} onChange={(v) => put(row.contact_id, { coupling: (v ?? "unknown") as PortPin["coupling"] })} /></Table.Td>
          <Table.Td><Select size="xs" aria-label={`Termination at contact ${who}`} value={p.termination} data={TERMINATION} onChange={(v) => put(row.contact_id, { termination: (v ?? "unknown") as PortPin["termination"] })} /></Table.Td>
          <Table.Td><Group gap={4} wrap="nowrap"><Select size="xs" clearable aria-label={`Part the cable must add at contact ${who}`} placeholder="none stated" value={need?.conditioning ?? null} data={CONDITIONING.map((c) => ({ value: c, label: NEED_LABELS[c]! }))} onChange={(v) => put(row.contact_id, { needs_in_cable: v ? [{ conditioning: v as typeof CONDITIONING[number], value: need?.value ?? null, basis: p.basis ?? "" }] : [] })} />
            {need && <TextInput size="xs" aria-label={`Value of the part at contact ${who}`} placeholder="value" value={need.value ?? ""} onChange={(e) => put(row.contact_id, { needs_in_cable: [{ ...need, value: e.currentTarget.value || null }] })} />}</Group></Table.Td>
          <Table.Td><Group gap={4} wrap="nowrap"><Checkbox aria-label={`Must not connect contact ${who}`} checked={p.must_not_connect} onChange={(e) => put(row.contact_id, { must_not_connect: e.currentTarget.checked, must_not_connect_reason: e.currentTarget.checked ? p.must_not_connect_reason ?? "" : null })} />
            {p.must_not_connect && <TextInput size="xs" aria-label={`Reason contact ${who} must not connect`} placeholder="Reason (required)" value={p.must_not_connect_reason ?? ""} onChange={(e) => put(row.contact_id, { must_not_connect_reason: e.currentTarget.value })} />}</Group></Table.Td>
          <Table.Td><TextInput size="xs" aria-label={`Basis at contact ${who}`} placeholder="Required for stated facts" value={p.basis ?? ""} onChange={(e) => {
            const basis = e.currentTarget.value || null;
            put(row.contact_id, { basis, level: p.level.status === "known" ? { ...p.level, basis } : p.level, impedance: p.impedance.status === "known" ? { ...p.impedance, basis } : p.impedance, needs_in_cable: p.needs_in_cable.map((n) => ({ ...n, basis: basis ?? "" })) });
          }} /></Table.Td>
        </Table.Tr>;
      })}</Table.Tbody>
    </Table></Table.ScrollContainer>} />}
    <Group><Select label="Port review" value={value.review} data={["unreviewed", "reviewed"]} onChange={(v) => onChange({ ...value, review: (v ?? "unreviewed") as Port["review"] })} /><TextInput label="Review basis" value={value.review_basis ?? ""} onChange={(e) => onChange({ ...value, review_basis: e.currentTarget.value || null })} /></Group>
  </Stack>;
}

/** In the editor the variant's own end has no selections; show the port's choice for conditional rows. */
function conditionalRow(row: EndRow, selections: Record<string, string>): Partial<EndRow> {
  if (!row.condition_key || !row.alternatives) return {};
  const chosen = row.alternatives.find((a) => a.choice === selections[row.condition_key!]);
  return chosen ? { status: "declared", signal: chosen.signal_ref, role: chosen.role, hazards: [], reason: undefined } : {};
}

/** The resolved signal at one contact of a cable end; an unselected condition is unknown and may be power. */
export function EndSignal({ row }: { row: EndRow }) {
  if (row.status === "declared" && row.signal) return <Group gap={6} wrap="nowrap" miw={170}><Text size="sm">{row.signal.name}</Text><SignalTypeChip type={row.signal.type} /></Group>;
  if (row.status === "declared") return <Text size="sm">{row.note ?? row.role}</Text>;
  return <Stack gap={2}>
    <SbUnknown what="Signal" />
    {row.reason && <Text size="xs" c="dimmed">{row.reason}</Text>}
    {row.alternatives && <Text size="xs" c="dimmed">Could be {row.alternatives.map((a) => a.signal_ref?.name ?? a.signal ?? a.role).join(" or ")}</Text>}
    {row.hazards?.includes("may_be_power") && <SbStatus led="failed" dimension="hazard" value="may be power" />}
  </Stack>;
}

/** A frozen end as a port value for the face view: its device facts per contact. */
function frozenPort(end: CableEnd): Port {
  return { kind: "port", device_label: end.device_label ?? "", pinout_revision_id: end.pinout_revision_id, role: end.role, selected_conditions: end.selected_conditions, pins: end.rows.flatMap((r) => (r.device ? [r.device] : [])), review: "unreviewed", review_basis: null };
}

function needText(pin: PortPin): string {
  return pin.needs_in_cable.map((n) => `${NEED_LABELS[n.conditioning]}${n.value ? ` ${n.value}` : ""}`).join(", ");
}

/** A frozen port or a bare pinout variant as one cable end: one row per contact. */
export function CableEndInspector({ revisionId }: { revisionId: string }) {
  const end = useQuery({ queryKey: ["interface-end", revisionId], queryFn: () => read<CableEnd>(`interfaces/revisions/${revisionId}/end`) });
  const data = end.data;
  return <Card withBorder><Stack gap="xs"><Title order={3}>{data?.kind === "pinout" ? "Pinout variant as a cable end" : "Frozen port"}</Title><Text size="sm"><RevisionLabel id={revisionId} /></Text>
    {end.isError && <Alert color="red">{end.error.message}</Alert>}
    {data && <>
      <Group gap="lg">
        <Stack gap={0}><Text className="sb-silk">Device</Text><Text size="sm">{data.device_label ?? "No device: variant only"}</Text></Stack>
        <Stack gap={0}><Text className="sb-silk">Role</Text><Text size="sm">{data.role === "unknown" ? "unknown" : data.role}</Text></Stack>
        <Stack gap={0}><Text className="sb-silk">Variant</Text><Text size="sm">{data.variant_label ?? "unnamed"}</Text></Stack>
        <Stack gap={0}><Text className="sb-silk">Standard</Text><Text size="sm">{data.standard ?? "not stated"}</Text></Stack>
        <Stack gap={0}><Text className="sb-silk">Compatibility</Text><Text size="sm">not evaluated</Text></Stack>
      </Group>
      <PortWorkbench mode="frozen" value={frozenPort(data)} table={<Table.ScrollContainer minWidth={900}><Table withTableBorder verticalSpacing={4} className="sb-signal-table">
        <Table.Thead><Table.Tr><Table.Th>Contact</Table.Th><Table.Th>Signal</Table.Th><Table.Th>Device</Table.Th><Table.Th>Level</Table.Th><Table.Th>Impedance</Table.Th><Table.Th>Coupling</Table.Th><Table.Th>Termination</Table.Th><Table.Th>Cable must add</Table.Th><Table.Th>Must not connect</Table.Th></Table.Tr></Table.Thead>
        <Table.Tbody>{data.rows.map((row) => {
          const d = row.device;
          return <Table.Tr key={row.contact_id}>
            <Table.Td className="sb-mono">{row.number ?? row.contact_id}</Table.Td>
            <Table.Td><EndSignal row={row} /></Table.Td>
            <Table.Td>{d && d.behavior !== "unknown" ? d.behavior : <SbUnknown what="Behavior" />}</Table.Td>
            <Table.Td>{d ? <DeclaredValue value={d.level} unit={d.level.unit ?? ""} what="Level" /> : <SbUnknown what="Level" />}</Table.Td>
            <Table.Td>{d ? <DeclaredValue value={d.impedance} unit="ohm" what="Impedance" /> : <SbUnknown what="Impedance" />}</Table.Td>
            <Table.Td>{d && d.coupling !== "unknown" ? d.coupling.toUpperCase() : <SbUnknown what="Coupling" />}</Table.Td>
            <Table.Td>{d && d.termination !== "unknown" ? d.termination.replace("_", " ") : <SbUnknown what="Termination" />}</Table.Td>
            <Table.Td>{d ? (d.needs_in_cable.length ? needText(d) : "None stated") : <SbUnknown what="Parts" />}</Table.Td>
            <Table.Td>{d?.must_not_connect ? <Stack gap={2}><SbStatus led="failed" dimension="connect" value="must not" /><Text size="xs">{d.must_not_connect_reason}</Text></Stack> : d ? "Not stated" : <SbUnknown what="Restriction" />}</Table.Td>
          </Table.Tr>;
        })}</Table.Tbody>
      </Table></Table.ScrollContainer>} />
    </>}
  </Stack></Card>;
}
