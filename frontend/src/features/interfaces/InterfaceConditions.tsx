import { Button, Card, Group, Select, Stack, Table, Text, TextInput } from "@mantine/core";
import { useEffect, useRef, useState } from "react";
import type { ConditionalRating, ContactView, Electrical, Temperature } from "./api";
import { formatCoordinates } from "../../lib/format";
import { EvidenceEditor, OperatingNumberInput } from "./declaration-inputs";

export function TemperatureEditor({ label, value, onChange }: { label: string; value: Temperature | null; onChange: (v: Temperature | null) => void }) {
  return <Stack gap="xs"><Text>{label}: {value ? "declared Celsius envelope" : "unknown"}</Text>
    <Group>{(["minimum_c", "maximum_c"] as const).map(key => <OperatingNumberInput key={key} label={`${label} ${key === "minimum_c" ? "minimum" : "maximum"} C (blank = unknown)`} value={value?.[key] ?? ""} onChange={n => {
      const next = { minimum_c: value?.minimum_c ?? null, maximum_c: value?.maximum_c ?? null, [key]: n };
      onChange(next.minimum_c === null && next.maximum_c === null ? null : next);
    }} />)}</Group></Stack>;
}
export function ElectricalConditionsEditor({ value, onChange }: { value: Electrical; onChange: (v: Partial<Electrical>) => void }) {
  const [id, setId] = useState("");
  const ratings = value.conditional_ratings ?? [];
  return <Stack><Group><Select label="Declared polarity" value={value.polarity ?? "unknown"} data={["unknown", "positive", "negative", "reference", "nonpolarized"]} onChange={polarity => onChange({ polarity: polarity as Electrical["polarity"] })} /><TextInput label="Polarity declaration basis" value={value.polarity_basis ?? ""} onChange={e => onChange({ polarity_basis: e.currentTarget.value || null })} /></Group>
    <Text>Conditional voltage and current limits are declarations. Scope uses inclusive Celsius bounds and exact named mode; missing conditions remain unknown. No interpolation, measurement or physical qualification.</Text>
    {ratings.map((r, i) => {
      const change = (patch: Partial<ConditionalRating>) => onChange({ conditional_ratings: ratings.map((v, j) => j === i ? { ...v, ...patch } : v) });
      return <Card withBorder key={r.local_id}><Stack><Text>Conditional rating {r.local_id}</Text><Select label={`${r.local_id} rating dimension`} value={r.dimension} data={["voltage", "current"]} onChange={dimension => change({ dimension: dimension as ConditionalRating["dimension"], minimum: null })} /><Group>
        {r.dimension === "voltage" && <OperatingNumberInput label={`${r.local_id} minimum V (blank = unknown)`} value={r.minimum ?? ""} onChange={minimum => change({ minimum })} />}
        <OperatingNumberInput label={`${r.local_id} maximum ${r.dimension === "voltage" ? "V" : "A"} (blank = unknown)`} value={r.maximum ?? ""} min={r.dimension === "current" ? 0 : undefined} onChange={maximum => change({ maximum })} />
      </Group><TemperatureEditor label={`${r.local_id} scope temperature`} value={r.scope.temperature} onChange={temperature => change({ scope: { ...r.scope, temperature } })} /><TextInput label={`${r.local_id} scope mode (blank = unconstrained)`} value={r.scope.mode ?? ""} onChange={e => change({ scope: { ...r.scope, mode: e.currentTarget.value || null } })} /><TextInput label={`${r.local_id} rating basis`} value={r.basis} onChange={e => change({ basis: e.currentTarget.value })} /><EvidenceEditor label={`${r.local_id} rating`} value={r.evidence} onChange={evidence => change({ evidence })} /><Button variant="subtle" onClick={() => onChange({ conditional_ratings: ratings.filter((_, j) => j !== i) })}>Remove conditional rating {r.local_id}</Button></Stack></Card>;
    })}
    <Group><TextInput label="New conditional rating ID" value={id} onChange={e => setId(e.currentTarget.value)} /><Button disabled={!/^[a-z][a-z0-9_-]{0,79}$/.test(id) || ratings.some(r => r.local_id === id)} onClick={() => { onChange({ conditional_ratings: [...ratings, { local_id: id, dimension: "current", minimum: null, maximum: null, scope: { temperature: null, mode: null }, basis: "", evidence: { status: "unknown" } }] }); setId(""); }}>Add conditional rating</Button></Group>
  </Stack>;
}
export function ContactDrawing({ view }: { view: ContactView }) {
  const positioned = view.contacts.filter(c => c.display_position_mm);
  const span = Math.max(1, ...positioned.flatMap(c => c.display_position_mm!.map(Math.abs)));
  return <Stack><Text>Declared drawing transform · {view.selected_orientation.viewing_side} side · datum {view.selected_orientation.datum ?? "unknown"} · rotation {view.selected_orientation.rotation_degrees ?? "unknown"} degrees · mirrored {view.mirrored === null ? "unknown" : String(view.mirrored)}</Text><Text>Origin is the named datum; x points right, y down. Switching sides reflects x across the vertical datum axis; positive rotation is counterclockwise on screen.</Text>
    {positioned.length > 0 && <svg role="img" aria-label="Declared contact positions with stable identity" viewBox="-1.2 -1.2 2.4 2.4" width="100%" height="240">{positioned.map(c => <g key={c.contact_id}><circle cx={c.display_position_mm![0] / span} cy={c.display_position_mm![1] / span} r={1 / 30} fill="currentColor" /><text x={c.display_position_mm![0] / span} y={c.display_position_mm![1] / span - 1 / 12} fontSize={0.1} textAnchor="middle">{c.contact_id} · {c.number ?? "unknown number"}</text></g>)}</svg>}
    <Table><Table.Thead><Table.Tr>{["Stable contact ID", "Declared number", "Label", "Source x,y mm", "Display x,y mm", "Unresolved reason"].map(v => <Table.Th key={v}>{v}</Table.Th>)}</Table.Tr></Table.Thead><Table.Tbody>{view.contacts.map(c => <Table.Tr key={c.contact_id}><Table.Td>{c.contact_id}</Table.Td><Table.Td>{c.number ?? "unknown"}</Table.Td><Table.Td>{c.label || "unlabelled"}</Table.Td><Table.Td>{formatCoordinates(c.source_position_mm)}</Table.Td><Table.Td>{formatCoordinates(c.display_position_mm)}</Table.Td><Table.Td>{c.reason ?? "declared transform"}</Table.Td></Table.Tr>)}</Table.Tbody></Table>
    {view.limitations.map(text => <Text key={text}>{text}</Text>)}<Text>No contact correspondence, copper identity or physical mating geometry is inferred from this drawing.</Text></Stack>;
}
export function RatingScopeFacts({ value }: { value: unknown }) {
  if (!value || typeof value !== "object") return null;
  const scopes = value as Record<string, { effective_limits: [number | null, number] | null; conditional_ratings: { rating: ConditionalRating; status: string; explanation: string }[] }>;
  return <Stack>{Object.entries(scopes).map(([side, facts]) => <Stack key={side}><Text>{side} effective declared limits: {facts.effective_limits?.map(v => v ?? "no minimum").join(" to ") ?? "unknown"}</Text>{facts.conditional_ratings.map(({ rating, status, explanation }) => <Card withBorder key={rating.local_id}><Text>{side} conditional {rating.local_id} ({rating.dimension}): {status.replaceAll("_", " ")}</Text><Text>{explanation}</Text><Text>Declared {rating.minimum ?? "no minimum"} to {rating.maximum} {rating.dimension === "voltage" ? "V" : "A"} · temperature {rating.scope.temperature ? `${rating.scope.temperature.minimum_c} to ${rating.scope.temperature.maximum_c} C` : "unconstrained"} · mode {rating.scope.mode ?? "unconstrained"}</Text><Text>Basis: {rating.basis}</Text></Card>)}</Stack>)}</Stack>;
}

export function ContactPositionEditor({ contactId, value, onChange }: { contactId: string; value: [number, number] | null; onChange: (v: [number, number] | null) => void }) {
  const [prepared, setPrepared] = useState<[number | null, number | null]>(value ?? [null, null]);
  const reported = useRef(JSON.stringify(value));
  useEffect(() => { if (JSON.stringify(value) !== reported.current) { reported.current = JSON.stringify(value); setPrepared(value ?? [null, null]); } }, [value]);
  return <Group>{([0, 1] as const).map(axis => <OperatingNumberInput key={axis} label={`Contact ${contactId} ${axis === 0 ? "x" : "y"} mm (blank = unknown)`} value={prepared[axis] ?? ""} onChange={n => {
    const next: [number | null, number | null] = [...prepared]; next[axis] = n; setPrepared(next);
    const complete: [number, number] | null = next[0] === null || next[1] === null ? null : [next[0], next[1]];
    reported.current = JSON.stringify(complete); onChange(complete);
  }} />)}<Text size="sm">Both coordinates must be declared; a missing axis remains unknown.</Text></Group>;
}
