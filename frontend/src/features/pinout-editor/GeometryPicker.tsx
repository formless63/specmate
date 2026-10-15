import { Button, Group, Stack, Text } from "@mantine/core";
import { CONNECTOR_GEOMETRIES, ConnectorFace, GEOMETRY_BASE_KEYS, geometryByKey } from "../../../../packages/connector-art/src";
import type { Body, Contact } from "../interfaces/api";
import "./pinout-editor.css";

const genderFor = (role: string) => (role === "plug" ? "male" : role === "receptacle" ? "female" : null);

/** Library faces with exactly `count` numbered positions (all drawn faces when the body has no contacts yet). */
export function geometryChoices(count: number, matingRole: string): { key: string; label: string }[] {
  return GEOMETRY_BASE_KEYS.map((key) => ({ key, geometry: geometryByKey(key, genderFor(matingRole)) ?? CONNECTOR_GEOMETRIES[key] }))
    .filter(({ geometry }) => geometry && !geometry.outlineOnly && (count === 0 || geometry.pinCount === count))
    .map(({ key, geometry }) => ({ key, label: geometry!.label }));
}

/**
 * Picks the face a body is drawn with, as thumbnails filtered by the body's numbered contact
 * count. A draft edit only: choosing a face never establishes fit or mating. With no contacts
 * yet, a face's numbered positions can be added as contacts.
 */
export function GeometryPicker({ body, onChange }: { body: Body; onChange: (next: Body) => void }) {
  const count = body.contacts.filter((c) => c.physical_role === "contact").length;
  const choices = geometryChoices(count, body.mating_role);
  const chosen = body.geometry_key ? geometryByKey(body.geometry_key, genderFor(body.mating_role)) : null;
  return <Stack gap={6}>
    <Text className="sb-silk">Face drawing</Text>
    <Text size="xs" c="dimmed">{count ? `Faces with ${count} numbered positions` : "No contacts yet: every drawn face is offered, and its positions can become the contacts"}. Choosing one only sets how the body is drawn.</Text>
    {choices.length === 0 ? <Text size="sm" c="dimmed">No face in the library has {count} positions; the body stays without a drawing.</Text>
      : <div className="pwb-geo" role="group" aria-label="Face drawings">{choices.map((c) => {
        const geometry = geometryByKey(c.key, genderFor(body.mating_role))!;
        return <button type="button" key={c.key} className="pwb-geo-card" aria-pressed={body.geometry_key === c.key} aria-label={`Draw as ${c.label}`} onClick={() => onChange({ ...body, geometry_key: body.geometry_key === c.key ? null : c.key })}>
          <ConnectorFace geometry={geometry} size={96} title={c.label} />
          <span>{c.label}</span>
        </button>;
      })}</div>}
    {body.geometry_key && !choices.some((c) => c.key === body.geometry_key) && <Group gap={6}><Text size="xs">Face {chosen?.label ?? body.geometry_key} {chosen ? `has ${chosen.pinCount} positions, not ${count}` : "is not in this library"}.</Text><Button size="compact-xs" variant="subtle" onClick={() => onChange({ ...body, geometry_key: null })}>Clear face</Button></Group>}
    {chosen && count === 0 && <Group gap={6}><Button size="compact-xs" variant="default" onClick={() => onChange({ ...body, contacts: contactsFor(chosen) })}>Add its {chosen.pinCount} positions as contacts</Button></Group>}
  </Stack>;
}

/** Numbered positions (and a shell contact when the face draws one) as contacts without measured positions. */
function contactsFor(geometry: NonNullable<ReturnType<typeof geometryByKey>>): Contact[] {
  const ids = geometry.pins.filter((p) => /^\d+$/.test(p.id)).map((p) => p.id).sort((a, b) => Number(a) - Number(b));
  const numbered: Contact[] = ids.map((id) => ({ contact_id: id, number: id, physical_role: "contact", label: "", position_mm: null }));
  const shells: Contact[] = geometry.pins.filter((p) => p.role === "shell" && !/^\d+$/.test(p.id)).map((p) => ({ contact_id: p.id, number: null, physical_role: "shell", label: "Shell", position_mm: null }));
  return [...numbered, ...shells];
}
