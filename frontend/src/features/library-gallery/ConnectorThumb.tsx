import { ConnectorFace, geometryForBody, type ConnectorFacePin } from "../../../../packages/connector-art/src";

type Json = Record<string, unknown>;
const obj = (value: unknown): Json => (value && typeof value === "object" && !Array.isArray(value) ? value as Json : {});
const arr = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

/** Pin fill per signal type family, matching the signal chips (theme tokens only). */
const FAMILY_FILL: Record<string, string> = {
  analog_video: "var(--sb-accent)", sync: "var(--sb-accent)",
  analog_audio: "var(--sb-state)", digital_audio: "var(--sb-state)",
  power: "var(--sb-invalid)",
  ground_return: "var(--sb-text-tertiary)", shield: "var(--sb-text-tertiary)", chassis: "var(--sb-text-tertiary)",
  data: "var(--sb-focus)", control: "var(--sb-focus)",
};

/** The signal type of each contact of a pinout, from the preview's resolved signal sets; absent when undeclared. */
export function signalTypesByContact(pinout: Json, types: Record<string, string>): Map<string, string> {
  const result = new Map<string, string>();
  for (const assignment of arr(pinout.assignments).map(obj)) {
    const ref = obj(obj(assignment.electrical).signal_ref);
    const type = types[`${String(ref.signal_set_revision_id)}/${String(ref.key)}`];
    if (type) result.set(String(assignment.contact_id), type);
  }
  return result;
}

/**
 * A connector body, pinout or port drawn on its real face (connector-art). Pinout and port
 * pins are filled by signal type; contacts without a declared signal stay hatched unknown,
 * and a port's must-not-connect pins carry the hazard ring. Without a face geometry the
 * card says so instead of inventing a layout.
 */
export function ConnectorThumb({ kind, content, body, pinout, signalTypes, title }: {
  kind: "connector_body" | "pinout" | "port";
  content: Json;
  body: Json | null;
  pinout: Json | null;
  signalTypes: Record<string, string>;
  title: string;
}) {
  const own = obj(content.interface);
  const face = kind === "connector_body" ? own : obj(body);
  const contacts = arr(face.contacts).map(obj);
  const numbered = contacts.filter((c) => c.physical_role === "contact").length;
  const geometry = contacts.length || face.geometry_key || face.family
    ? geometryForBody({ family: (face.family as string | null) ?? null, pin_count: numbered || null, geometry: face.geometry_key ?? null, mating_role: (face.mating_role as string | null) ?? null })
    : null;
  if (!geometry) {
    return <svg viewBox="0 0 240 120" role="img" aria-label={title} className="lg-thumb-svg">
      <rect x={70} y={22} width={100} height={70} rx={10} className="lg-unknown-fill" />
      <text x={120} y={62} textAnchor="middle" className="lg-thumb-note">{kind === "connector_body" ? "face not recorded" : "body face unknown"}</text>
    </svg>;
  }
  let pins: ConnectorFacePin[] | undefined;
  if (kind !== "connector_body") {
    const assigned = kind === "pinout" ? own : obj(pinout);
    const types = signalTypesByContact(assigned, signalTypes);
    const hazards = new Set(kind === "port" ? arr(own.pins).map(obj).filter((p) => p.must_not_connect).map((p) => String(p.contact_id)) : []);
    pins = contacts.map((c) => {
      const id = String(c.contact_id);
      const type = types.get(id);
      if (hazards.has(id)) return { id, label: "must not connect", state: "hazard" };
      if (c.physical_role !== "contact") return { id };
      return type ? { id, label: type.replaceAll("_", " "), fill: FAMILY_FILL[type] } : { id, state: "unknown" };
    });
  }
  return <div className="lg-face"><ConnectorFace geometry={geometry} pins={pins} size={160} title={title} /></div>;
}
