import { Group, Select, Stack, TextInput } from "@mantine/core";
import { SbUnknown } from "../../components/sb";
import { ElectricalConditionsEditor } from "../interfaces/InterfaceConditions";
import { OperatingNumberInput } from "../interfaces/declaration-inputs";
import type { Electrical } from "../interfaces/api";

const ROLES = ["unknown", "signal", "power", "return", "shield", "chassis", "unused"];
const DIRECTIONS = ["unknown", "input", "output", "bidirectional", "passive"];

/** A contact's further electrical declaration (note, role, direction, limits, basis) in the inspector. */
export function PinElectricalFields({ pin, value, onChange }: { pin: string; value: Electrical; onChange: (patch: Partial<Electrical>) => void }) {
  return <Stack gap={6}>
    <Group gap={6} grow>
      <Select size="xs" label="Logical role" aria-label={`Logical role of pin ${pin}`} value={value.role} data={ROLES} onChange={(v) => onChange({ role: v ?? "unknown" })} />
      <Select size="xs" label="Direction from device" aria-label={`Direction of pin ${pin}`} value={value.direction} data={DIRECTIONS} onChange={(v) => onChange({ direction: v ?? "unknown" })} />
    </Group>
    <TextInput size="xs" label="Signal note" value={value.signal ?? ""} onChange={(e) => onChange({ signal: e.currentTarget.value || null })} />
    <Group gap={6} grow>
      {([["voltage_min_v", "Min V"], ["voltage_max_v", "Max V"], ["current_max_a", "Max A"]] as const).map(([key, label]) =>
        <OperatingNumberInput key={key} label={`${label} (blank = unknown)`} value={value[key] ?? ""} onChange={(v) => onChange({ [key]: v })} />)}
    </Group>
    <Group gap={6} grow>
      <TextInput size="xs" label="Protocol" value={value.protocol ?? ""} onChange={(e) => onChange({ protocol: e.currentTarget.value || null })} />
      <TextInput size="xs" label="Applicable condition" value={value.condition ?? ""} onChange={(e) => onChange({ condition: e.currentTarget.value || null })} />
    </Group>
    <TextInput size="xs" label="Declaration basis" value={value.basis ?? ""} onChange={(e) => onChange({ basis: e.currentTarget.value || null })} />
    <ElectricalConditionsEditor value={value} onChange={onChange} />
  </Stack>;
}

/** The same declaration, read-only: one fact per cell, unknowns stay visibly unknown. */
export function PinElectricalFacts({ value }: { value: Electrical | null }) {
  const cell = (label: string, text: string | null | undefined, what: string) => <div className="sb-cell"><dt className="sb-silk">{label}</dt><dd data-unknown={!text || text === "unknown" || undefined}>{text && text !== "unknown" ? text : <SbUnknown what={what} />}</dd></div>;
  const range = (min: number | null | undefined, max: number | null | undefined, unit: string) => (min == null && max == null ? null : `${min ?? "…"} to ${max ?? "…"} ${unit}`);
  return <dl className="pwb-facts">
    {cell("Role", value?.role, "Role")}
    {cell("Direction", value?.direction, "Direction")}
    {cell("Polarity", value?.polarity, "Polarity")}
    {cell("Voltage", range(value?.voltage_min_v, value?.voltage_max_v, "V"), "Voltage")}
    {cell("Current", value?.current_max_a == null ? null : `≤ ${value.current_max_a} A`, "Current")}
    {cell("Basis", value?.basis, "Basis")}
  </dl>;
}
