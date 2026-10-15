import { Alert, Group, SegmentedControl, Select, Stack, Text } from "@mantine/core";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { CONNECTOR_GEOMETRIES, ConnectorFace, GEOMETRY_BASE_KEYS, geometryForBody, type ConnectorFacePin, type ConnectorGeometry } from "../../../../packages/connector-art/src";
import { SbUnknown } from "../../components/sb";
import { read, type Body, type Contact, type Electrical, type Inspection, type PinSignal } from "./api";

export function faceForBody(body: Body): ConnectorGeometry | null {
  const numbered = body.contacts.filter(c => c.physical_role === "contact").length;
  return geometryForBody({ family: body.family, pin_count: numbered, geometry: body.geometry_key ?? null, mating_role: body.mating_role });
}

/**
 * The body's connector face, drawn from its declared face key (or an unambiguous family),
 * with each contact's label or signal on its pin. Presentation only: the drawing never
 * establishes mating, fit or contact identity.
 */
export function BodyFace({ body, pins, caption }: { body: Body; pins?: ConnectorFacePin[]; caption?: string }) {
  const [view, setView] = useState<"mating" | "solder">("mating");
  const [selected, setSelected] = useState<string | null>(null);
  const geometry = faceForBody(body);
  if (!geometry) return <Text size="sm">Face drawing: <SbUnknown what="face geometry" /></Text>;
  const drawn = new Set(geometry.pins.map(p => p.id));
  const missing = body.contacts.filter(c => !drawn.has(c.contact_id)).map(c => c.contact_id);
  const shown = pins ?? body.contacts.map(c => ({ id: c.contact_id, label: c.label && c.label !== c.contact_id ? c.label : undefined }));
  const chosen = selected ? shown.find(p => p.id === selected) : undefined;
  return <Stack gap="xs" className="sb-body-face">
    <Group gap="xs" align="center">
      <Text className="sb-silk">{caption ?? "Connector face"}</Text>
      <SegmentedControl size="xs" aria-label="Face view" value={view} onChange={v => setView(v as "mating" | "solder")} data={[{ value: "mating", label: "Mating face" }, { value: "solder", label: "Solder side" }]} />
    </Group>
    <ConnectorFace geometry={geometry} view={view} pins={shown} selectedPinId={selected} onPinClick={id => setSelected(id === selected ? null : id)} size={260} />
    <Text size="xs" c="dimmed">{geometry.label} {geometry.gender === "ungendered" ? "" : geometry.gender === "male" ? "plug" : "socket"} · {geometry.numbering}</Text>
    <Text size="xs" c="dimmed">Geometry: {geometry.verification.positions} positions, numbering {geometry.verification.numbering.replace("-", " ")}. {geometry.source}</Text>
    {selected && <Text size="sm">Pin {selected}: {chosen?.label ?? <SbUnknown what="label" />}</Text>}
    {missing.length > 0 && <Text size="xs">Contacts not on this face: {missing.join(", ")}</Text>}
  </Stack>;
}

const FACE_OPTIONS = GEOMETRY_BASE_KEYS.map(key => ({ value: key, label: CONNECTOR_GEOMETRIES[key]?.label ?? key }));

/** Picks the standard face a body is drawn with; blank keeps it unknown (or inferred from an unambiguous family). */
export function FaceKeySelect({ value, onChange }: { value: string | null; onChange: (v: string | null) => void }) {
  const known = value === null || FACE_OPTIONS.some(o => o.value === value);
  return <Select label="Connector face drawing (blank = from family, else unknown)" searchable clearable value={value} data={known ? FACE_OPTIONS : [...FACE_OPTIONS, { value: value!, label: `${value} (not in this library)` }]} onChange={v => onChange(v || null)} />;
}

/** A pinout's signals drawn on its exact body's face; contacts without a declared signal are unknown. */
export function PinoutFace({ bodyRevisionId, contacts, signals }: { bodyRevisionId: string; contacts: (Contact & { electrical: Electrical | null })[]; signals: Record<string, PinSignal> }) {
  const body = useQuery({ queryKey: ["interface-inspect", bodyRevisionId], queryFn: () => read<Inspection>(`interfaces/revisions/${bodyRevisionId}`) });
  if (body.isError) return <Alert color="red">{body.error.message}</Alert>;
  if (!body.data || body.data.interface.kind !== "connector_body") return null;
  const pins: ConnectorFacePin[] = contacts.map(c => {
    const row = signals[c.contact_id];
    const label = row?.signal?.name ?? c.electrical?.signal ?? undefined;
    const declared = label !== undefined || (c.electrical?.role ?? "unknown") !== "unknown";
    return { id: c.contact_id, label: row?.status === "conditional" ? `${label ?? "conditional"} (conditional)` : label, state: declared || c.physical_role !== "contact" ? undefined : "unknown" };
  });
  return <BodyFace body={body.data.interface} pins={pins} caption="Pinout on the body face" />;
}
