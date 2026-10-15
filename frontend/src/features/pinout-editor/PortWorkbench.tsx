import { Alert, Checkbox, Group, NumberInput, SegmentedControl, Select, Stack, Text, TextInput } from "@mantine/core";
import { useQuery } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
import { SbUnknown } from "../../components/sb";
import { useCan } from "../../lib/permissions";
import { faceForBody } from "../interfaces/BodyFace";
import { DeclaredValue, SignalTypeChip } from "../interfaces/SignalSetPanel";
import { CONDITIONING, read, unknownPortPin, type CableEnd, type DeclaredQuantity, type EndRow, type Inspection, type Port, type PortPin } from "../interfaces/api";
import { FaceLegend, FaceStage, type StripPin } from "./FaceStage";
import { familyColor, signalFamily } from "./palette";
import { portFacePins, portRow, statedFacts } from "./model";
import type { WorkbenchMode } from "./PinoutWorkbench";
import "./pinout-editor.css";

export const BEHAVIOR = [{ value: "unknown", label: "unknown" }, { value: "drives", label: "Drives" }, { value: "accepts", label: "Accepts" }, { value: "passes", label: "Passes" }, { value: "none", label: "None" }];
export const COUPLING = [{ value: "unknown", label: "unknown" }, { value: "dc", label: "DC" }, { value: "ac", label: "AC" }];
export const TERMINATION = [{ value: "unknown", label: "unknown" }, { value: "source_terminated", label: "Source terminated" }, { value: "load_terminated", label: "Load terminated" }, { value: "none", label: "None" }];
export const NEED_LABELS: Record<string, string> = { series_resistor: "Series resistor", series_capacitor: "Series capacitor", shunt_resistor: "Shunt resistor", attenuator: "Attenuator", other: "Other part" };

/** Sets a port pin's facts, keeping the pin list in contact order. */
export function putPortPin(value: Port, rows: readonly EndRow[], contactId: string, patch: Partial<PortPin>): Port {
  const current = value.pins.find((p) => p.contact_id === contactId) ?? unknownPortPin(contactId);
  const order = new Map(rows.map((r, i) => [r.contact_id, i]));
  return { ...value, pins: [...value.pins.filter((p) => p.contact_id !== contactId), { ...current, ...patch }].sort((a, b) => (order.get(a.contact_id) ?? 1e9) - (order.get(b.contact_id) ?? 1e9)) };
}

/**
 * The port drawn on its body's face: each pin colored by the signal its variant gives it, the
 * device's must-not-connect pins ringed, and per-pin device facts in the inspector. A table
 * remains as the dense fallback (`table`).
 */
export function PortWorkbench({ value, onChange, mode, table }: { value: Port; onChange?: (v: Port) => void; mode: WorkbenchMode; table: ReactNode }) {
  const can = useCan(mode === "create" ? "item.create" : "design.edit");
  const editable = mode !== "frozen" && !!onChange && can;
  const [selected, setSelected] = useState<string | null>(null);
  const [view, setView] = useState<"face" | "table" | null>(null);
  const end = useQuery({ queryKey: ["interface-end", value.pinout_revision_id], queryFn: () => read<CableEnd>(`interfaces/revisions/${value.pinout_revision_id}/end`), enabled: !!value.pinout_revision_id });
  const bodyId = end.data?.body_revision_id;
  const body = useQuery({ queryKey: ["interface-inspect", bodyId], queryFn: () => read<Inspection>(`interfaces/revisions/${bodyId}`), enabled: !!bodyId });
  const geometry = body.data?.interface.kind === "connector_body" ? faceForBody(body.data.interface) : null;
  const rows = (end.data?.rows ?? []).map((r) => portRow(r, value.selected_conditions));
  const pins = portFacePins(rows, value.pins);
  const pinOf = (id: string) => value.pins.find((p) => p.contact_id === id);
  const row = rows.find((r) => r.contact_id === selected);
  const effectiveView = view ?? (geometry ? "face" : "table");
  const mnc = value.pins.filter((p) => p.must_not_connect).length;
  const stated = rows.filter((r) => statedFacts(pinOf(r.contact_id)) > 0).length;
  const unknownSignals = rows.filter((r) => r.status !== "declared").length;
  const strip: StripPin[] = rows.map((r) => ({
    id: r.contact_id, name: r.number ?? r.contact_id, text: r.signal?.name ?? r.note ?? (r.status === "declared" ? r.role ?? "declared" : "unknown"),
    fill: r.signal ? familyColor(signalFamily(r.signal.type)) : undefined, unknown: r.status !== "declared",
    marks: [...(pinOf(r.contact_id)?.must_not_connect ? ["must not connect"] : []), ...(r.hazards?.includes("may_be_power") ? ["may be power"] : [])],
  }));

  if (!value.pinout_revision_id) return null;
  if (end.isError) return <Alert color="red">{end.error.message}</Alert>;
  if (!end.data) return null;
  return <div className="pwb" data-mode={mode}>
    <dl className="pwb-cells">
      {mode !== "frozen" && <>
        <div className="sb-cell"><dt className="sb-silk">Device</dt><dd data-unknown={!value.device_label || undefined}>{value.device_label || <SbUnknown />}</dd></div>
        <div className="sb-cell"><dt className="sb-silk">Variant</dt><dd>{end.data.variant_label ?? "unnamed"}</dd></div>
      </>}
      <div className="sb-cell"><dt className="sb-silk">Facts stated</dt><dd>{stated}/{rows.length}</dd><p className="pwb-sub">pins with any device fact</p></div>
      <div className="sb-cell"><dt className="sb-silk">Must not connect</dt><dd>{mnc}</dd></div>
      <div className="sb-cell"><dt className="sb-silk">Unknown signals</dt><dd>{unknownSignals}</dd><p className="pwb-sub">from the variant</p></div>
    </dl>
    <div className="pwb-tabs">
      <span className="sb-silk">Compatibility not evaluated</span>
      <span className="pwb-tabs-spacer" />
      <SegmentedControl size="xs" aria-label="Port view" value={effectiveView} onChange={(v) => setView(v as "face" | "table")} data={[{ value: "face", label: "Face", disabled: !geometry }, { value: "table", label: "Table" }]} />
    </div>
    {effectiveView === "table" ? <>{!geometry && body.data && <Text size="xs" c="dimmed">This port's body has no face drawing; its pins are listed as a table.</Text>}{table}</> : geometry && <div className="pwb-grid">
      <div className="pwb-main"><FaceStage geometry={geometry} pins={pins} strip={strip} selected={selected} onSelect={setSelected} caption={`${value.device_label || "Port"} · ${end.data.variant_label ?? "variant"}`}
        legend={<FaceLegend marks={["unknown", "conditional", "must-not-connect", "hazard"]} />} /></div>
      <aside className="pwb-inspector" aria-label="Pin inspector">
        {!row ? <Text size="sm" c="dimmed">Pick a pin on the face to {editable ? "state" : "see"} what the device does there.</Text> : <Stack gap={6}>
          <Text fw={600}>Pin {row.number ?? row.contact_id}{row.label && row.label !== row.number ? ` · ${row.label}` : ""}</Text>
          <RowSignal row={row} />
          {editable ? <PortPinFields who={row.number ?? row.contact_id} pin={pinOf(row.contact_id) ?? unknownPortPin(row.contact_id)} onChange={(patch) => onChange?.(putPortPin(value, rows, row.contact_id, patch))} />
            : <PortPinFacts pin={pinOf(row.contact_id) ?? null} />}
        </Stack>}
      </aside>
    </div>}
  </div>;
}

function RowSignal({ row }: { row: EndRow }) {
  if (row.status === "declared" && row.signal) return <Group gap={6} wrap="nowrap"><Text size="sm" fw={600}>{row.signal.name}</Text><SignalTypeChip type={row.signal.type} /></Group>;
  if (row.status === "declared") return <Text size="sm">{row.note ?? row.role}</Text>;
  return <Stack gap={2}><SbUnknown what="Signal" />{row.reason && <Text size="xs" c="dimmed">{row.reason}</Text>}
    {row.alternatives && <Text size="xs" c="dimmed">Could be {row.alternatives.map((a) => a.signal_ref?.name ?? a.signal ?? a.role).join(" or ")}</Text>}
    {row.hazards?.includes("may_be_power") && <Text size="xs" className="pwb-warn" data-kind="hazard">May be power until the condition is selected.</Text>}</Stack>;
}

const quantity = (q: DeclaredQuantity, nominal: number | null, basis: string | null): DeclaredQuantity =>
  nominal === null ? { status: "unknown", nominal: null, minimum: null, maximum: null, basis: null, unit: q.unit } : { ...q, status: "known", nominal, basis };

/** One pin's device facts as inspector fields; blank stays unknown, never zero. */
export function PortPinFields({ who, pin, onChange }: { who: string; pin: PortPin; onChange: (patch: Partial<PortPin>) => void }) {
  const need = pin.needs_in_cable[0];
  const number = (raw: string | number) => { const n = raw === "" ? null : Number(raw); return Number.isFinite(n) ? n : null; };
  return <Stack gap={6}>
    <Stack gap={2}><Text size="xs" c="dimmed">Device at this pin</Text>
      <SegmentedControl size="xs" fullWidth aria-label={`Device behavior at pin ${who}`} value={pin.behavior} data={BEHAVIOR} onChange={(v) => onChange({ behavior: v as PortPin["behavior"] })} /></Stack>
    <Group gap={6} grow>
      <NumberInput size="xs" label="Level (blank = unknown)" placeholder="unknown" value={pin.level.nominal ?? ""} onChange={(raw) => { const n = number(raw); onChange({ level: { ...quantity(pin.level, n, pin.basis), unit: n === null ? "unknown" : pin.level.unit && pin.level.unit !== "unknown" ? pin.level.unit : "V" } }); }} />
      <Select size="xs" label="Level unit" disabled={pin.level.status !== "known"} placeholder="unknown" value={pin.level.status === "known" ? pin.level.unit ?? "V" : null} data={["V", "Vpp", "dBu", "dBV"]} onChange={(unit) => onChange({ level: { ...pin.level, unit: unit ?? "V" } })} />
    </Group>
    <NumberInput size="xs" label="Impedance, ohm (blank = unknown)" placeholder="unknown" value={pin.impedance.nominal ?? ""} onChange={(raw) => onChange({ impedance: { ...quantity(pin.impedance, number(raw), pin.basis), unit: "ohm" } })} />
    <Stack gap={2}><Text size="xs" c="dimmed">Coupling</Text><SegmentedControl size="xs" fullWidth aria-label={`Coupling at pin ${who}`} value={pin.coupling} data={COUPLING} onChange={(v) => onChange({ coupling: v as PortPin["coupling"] })} /></Stack>
    <Select size="xs" label="Termination" value={pin.termination} data={TERMINATION} onChange={(v) => onChange({ termination: (v ?? "unknown") as PortPin["termination"] })} />
    <Group gap={6} grow align="end">
      <Select size="xs" clearable label="Cable must add" placeholder="none stated" value={need?.conditioning ?? null} data={CONDITIONING.map((c) => ({ value: c, label: NEED_LABELS[c]! }))} onChange={(v) => onChange({ needs_in_cable: v ? [{ conditioning: v as typeof CONDITIONING[number], value: need?.value ?? null, basis: pin.basis ?? "" }] : [] })} />
      {need && <TextInput size="xs" label="Part value" placeholder="value" value={need.value ?? ""} onChange={(e) => onChange({ needs_in_cable: [{ ...need, value: e.currentTarget.value || null }] })} />}
    </Group>
    <Checkbox size="xs" label="Must not connect" checked={pin.must_not_connect} onChange={(e) => onChange({ must_not_connect: e.currentTarget.checked, must_not_connect_reason: e.currentTarget.checked ? pin.must_not_connect_reason ?? "" : null })} />
    {pin.must_not_connect && <TextInput size="xs" label="Reason (required)" value={pin.must_not_connect_reason ?? ""} onChange={(e) => onChange({ must_not_connect_reason: e.currentTarget.value })} />}
    <TextInput size="xs" label="Basis" placeholder="Required for stated facts" value={pin.basis ?? ""} onChange={(e) => {
      const basis = e.currentTarget.value || null;
      onChange({ basis, level: pin.level.status === "known" ? { ...pin.level, basis } : pin.level, impedance: pin.impedance.status === "known" ? { ...pin.impedance, basis } : pin.impedance, needs_in_cable: pin.needs_in_cable.map((n) => ({ ...n, basis: basis ?? "" })) });
    }} />
  </Stack>;
}

/** The same facts read-only, one fact per cell. */
export function PortPinFacts({ pin }: { pin: PortPin | null }) {
  const cell = (label: string, content: ReactNode) => <div className="sb-cell"><dt className="sb-silk">{label}</dt><dd>{content}</dd></div>;
  if (!pin) return <Text size="sm"><SbUnknown what="Device facts" /> — the port states nothing about this pin.</Text>;
  return <Stack gap={4}>
    {pin.must_not_connect && <Text size="xs" className="pwb-warn" data-kind="mnc">Must not connect: {pin.must_not_connect_reason}</Text>}
    <dl className="pwb-facts">
      {cell("Device", pin.behavior !== "unknown" ? pin.behavior : <SbUnknown what="Behavior" />)}
      {cell("Level", <DeclaredValue value={pin.level} unit={pin.level.unit ?? ""} what="Level" />)}
      {cell("Impedance", <DeclaredValue value={pin.impedance} unit="ohm" what="Impedance" />)}
      {cell("Coupling", pin.coupling !== "unknown" ? pin.coupling.toUpperCase() : <SbUnknown what="Coupling" />)}
      {cell("Termination", pin.termination !== "unknown" ? pin.termination.replace("_", " ") : <SbUnknown what="Termination" />)}
      {cell("Cable must add", pin.needs_in_cable.length ? pin.needs_in_cable.map((n) => `${NEED_LABELS[n.conditioning]}${n.value ? ` ${n.value}` : ""}`).join(", ") : "None stated")}
    </dl>
    {pin.basis && <Text size="xs" c="dimmed">Basis: {pin.basis}</Text>}
  </Stack>;
}
